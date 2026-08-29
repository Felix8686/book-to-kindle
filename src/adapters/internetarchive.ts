import type { BookCandidate, BookIdentifiers, BookSearchContext, SourceAdapter } from "../domain";

interface OpenLibraryDoc {
  title?: string;
  author_name?: string[];
  language?: string[];
  isbn?: string[];
  ia?: string[];
  ebook_access?: string;
}

interface OpenLibraryResponse {
  docs?: OpenLibraryDoc[];
}

interface ArchiveFile {
  name?: string;
  size?: string;
  private?: boolean | string;
  source?: string;
  format?: string;
}

interface ArchiveMetadata {
  metadata?: Record<string, unknown>;
  files?: ArchiveFile[];
}

interface SourceRef {
  url: string;
  contentType: string;
  identifier: string;
  filename: string;
}

function archiveUrl(identifier: string, filename: string): string {
  return `https://archive.org/download/${encodeURIComponent(identifier)}/${encodeURIComponent(filename)}`;
}

function isAllowedArchiveUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && (url.hostname === "archive.org" || url.hostname.endsWith(".archive.org"));
  } catch {
    return false;
  }
}

function isRestrictedMetadata(metadata?: Record<string, unknown>): boolean {
  const value = metadata?.["access-restricted-item"];
  return value === true || String(value ?? "").toLowerCase() === "true";
}

function fileFormat(file: ArchiveFile): "epub" | "pdf" | null {
  const name = file.name?.toLowerCase() ?? "";
  if (name.endsWith(".epub")) return "epub";
  if (name.endsWith(".pdf")) return "pdf";
  return null;
}

function isPrivateFile(file: ArchiveFile): boolean {
  return file.private === true || String(file.private ?? "").toLowerCase() === "true";
}

function identifiersFor(doc: OpenLibraryDoc): BookIdentifiers {
  const identifiers: BookIdentifiers = {};
  for (const isbn of doc.isbn ?? []) {
    const clean = isbn.replace(/[^0-9X]/gi, "");
    if (clean.length === 10) identifiers.isbn10 = [...new Set([...(identifiers.isbn10 ?? []), clean])];
    if (clean.length === 13) identifiers.isbn13 = [...new Set([...(identifiers.isbn13 ?? []), clean])];
  }
  return identifiers;
}

async function searchOpenLibrary(query: string, preferredLanguage: string): Promise<OpenLibraryDoc[]> {
  const url = new URL("https://openlibrary.org/search.json");
  url.searchParams.set("q", query);
  url.searchParams.set("lang", preferredLanguage);
  url.searchParams.set("limit", "8");
  url.searchParams.set("fields", "title,author_name,language,isbn,ia,ebook_access");
  const response = await fetch(url.toString(), {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error(`Open Library availability search failed with HTTP ${response.status}.`);
  return ((await response.json()) as OpenLibraryResponse).docs ?? [];
}

async function fetchMetadata(identifier: string): Promise<ArchiveMetadata> {
  const response = await fetch(`https://archive.org/metadata/${encodeURIComponent(identifier)}`, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error(`Internet Archive metadata failed with HTTP ${response.status}.`);
  return (await response.json()) as ArchiveMetadata;
}

function limitedStream(body: ReadableStream<Uint8Array>, maxBytes?: number): ReadableStream<Uint8Array> {
  if (!maxBytes) return body;
  let total = 0;
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        total += chunk.byteLength;
        if (total > maxBytes) {
          controller.error(new Error(`Downloaded file exceeded ${maxBytes} bytes.`));
          return;
        }
        controller.enqueue(chunk);
      },
    }),
  );
}

export class InternetArchivePublicSource implements SourceAdapter {
  readonly name = "internet-archive-public";

  async search(context: BookSearchContext): Promise<BookCandidate[]> {
    const queries = context.queryVariants.slice(0, 2).map((title) =>
      [title, context.request.author].filter(Boolean).join(" "),
    );
    const searches = await Promise.allSettled(
      queries.map((query) => searchOpenLibrary(query, context.preferredLanguage)),
    );
    const docs = searches.flatMap((result) => result.status === "fulfilled" ? result.value : []);
    const publicDocs = docs.filter((doc) => doc.ebook_access === "public" && doc.ia?.length).slice(0, 4);
    const metadataResults = await Promise.allSettled(
      publicDocs.map(async (doc) => ({ doc, identifier: doc.ia![0], metadata: await fetchMetadata(doc.ia![0]) })),
    );

    const seen = new Set<string>();
    const candidates: BookCandidate[] = [];

    for (const result of metadataResults) {
      if (result.status !== "fulfilled") continue;
      const { doc, identifier, metadata } = result.value;
      if (isRestrictedMetadata(metadata.metadata)) continue;
      const picked = new Map<string, ArchiveFile>();

      for (const file of metadata.files ?? []) {
        if (!file.name || isPrivateFile(file)) continue;
        const format = fileFormat(file);
        if (!format) continue;
        if (!picked.has(format)) picked.set(format, file);
      }

      for (const [format, file] of picked) {
        const filename = file.name!;
        const id = `internet-archive:${identifier}:${format}`;
        if (seen.has(id)) continue;
        seen.add(id);
        const url = archiveUrl(identifier, filename);
        if (!isAllowedArchiveUrl(url)) continue;
        const contentType = format === "epub" ? "application/epub+zip" : "application/pdf";
        const ref: SourceRef = { url, contentType, identifier, filename };
        const parsedSize = Number(file.size);

        candidates.push({
          id,
          title: doc.title ?? context.identity.canonicalTitle,
          author: doc.author_name?.join(", ") || undefined,
          language: doc.language?.[0],
          format,
          sizeBytes: Number.isFinite(parsedSize) && parsedSize > 0 ? parsedSize : undefined,
          source: this.name,
          sourceRef: JSON.stringify(ref),
          identifiers: identifiersFor(doc),
          editionKey: `ia:${identifier}`,
          sourceQuality: 35,
        });
      }
    }

    return candidates;
  }

  async download(
    candidate: BookCandidate,
    options?: { maxBytes?: number },
  ): Promise<{ body: ReadableStream<Uint8Array>; contentType: string; sizeBytes?: number }> {
    const ref = JSON.parse(candidate.sourceRef) as SourceRef;
    if (!isAllowedArchiveUrl(ref.url)) {
      throw new Error("Rejected Internet Archive download URL outside the allowlist.");
    }
    const response = await fetch(ref.url, { redirect: "follow" });
    if (!response.ok || !response.body) {
      throw new Error(`Internet Archive download failed with HTTP ${response.status}.`);
    }
    if (!isAllowedArchiveUrl(response.url || ref.url)) {
      await response.body.cancel();
      throw new Error("Rejected Internet Archive redirect outside the allowlist.");
    }

    const contentLength = Number(response.headers.get("content-length"));
    const sizeBytes = Number.isFinite(contentLength) && contentLength > 0 ? contentLength : candidate.sizeBytes;
    if (sizeBytes && options?.maxBytes && sizeBytes > options.maxBytes) {
      await response.body.cancel();
      throw new Error(`Book is ${sizeBytes} bytes, above the cloud limit of ${options.maxBytes}.`);
    }

    return {
      body: limitedStream(response.body, options?.maxBytes),
      contentType: response.headers.get("content-type")?.split(";")[0] || ref.contentType,
      sizeBytes,
    };
  }
}
