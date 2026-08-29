import type { BookCandidate, BookIdentifiers, BookSearchContext, SourceAdapter } from "../domain";

interface GoogleVolume {
  id?: string;
  volumeInfo?: {
    title?: string;
    authors?: string[];
    language?: string;
    industryIdentifiers?: Array<{ type?: string; identifier?: string }>;
  };
  accessInfo?: {
    publicDomain?: boolean;
    viewability?: string;
    epub?: { isAvailable?: boolean; downloadLink?: string };
    pdf?: { isAvailable?: boolean; downloadLink?: string };
  };
}

interface GoogleVolumesResponse {
  items?: GoogleVolume[];
}

interface SourceRef {
  url: string;
  contentType: string;
  volumeId: string;
}

function normalizeDownloadUrl(value: string): string | null {
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase();
    const allowed =
      hostname === "books.google.com" ||
      hostname.endsWith(".google.com") ||
      hostname.endsWith(".googleusercontent.com");
    if (!allowed) return null;
    if (url.protocol === "http:") url.protocol = "https:";
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function identifiersFor(volume: GoogleVolume): BookIdentifiers {
  const output: BookIdentifiers = {
    googleVolumeIds: volume.id ? [volume.id] : undefined,
  };
  for (const item of volume.volumeInfo?.industryIdentifiers ?? []) {
    const value = item.identifier?.replace(/[^0-9X]/gi, "");
    if (!value) continue;
    if (item.type === "ISBN_10") output.isbn10 = [...new Set([...(output.isbn10 ?? []), value])];
    if (item.type === "ISBN_13") output.isbn13 = [...new Set([...(output.isbn13 ?? []), value])];
  }
  return output;
}

async function searchGoogle(query: string, language?: string): Promise<GoogleVolume[]> {
  const url = new URL("https://www.googleapis.com/books/v1/volumes");
  url.searchParams.set("q", query);
  url.searchParams.set("printType", "books");
  url.searchParams.set("filter", "free-ebooks");
  url.searchParams.set("maxResults", "20");
  if (language) url.searchParams.set("langRestrict", language);

  const response = await fetch(url.toString(), {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error(`Google Books search failed with HTTP ${response.status}.`);
  return ((await response.json()) as GoogleVolumesResponse).items ?? [];
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

export class GoogleBooksFreeSource implements SourceAdapter {
  readonly name = "google-books-free";

  async search(context: BookSearchContext): Promise<BookCandidate[]> {
    const queries = context.queryVariants.slice(0, 3).map((title) =>
      [title, context.request.author].filter(Boolean).join(" "),
    );
    const requests: Array<Promise<GoogleVolume[]>> = [];
    if (queries[0]) requests.push(searchGoogle(queries[0], context.preferredLanguage));
    for (const query of queries) requests.push(searchGoogle(query));

    const settled = await Promise.allSettled(requests);
    const seen = new Set<string>();
    const candidates: BookCandidate[] = [];

    for (const result of settled) {
      if (result.status !== "fulfilled") continue;
      for (const volume of result.value) {
        const id = volume.id;
        const info = volume.volumeInfo;
        const access = volume.accessInfo;
        if (!id || !info?.title || !access) continue;
        if (access.viewability !== "ALL_PAGES" && access.publicDomain !== true) continue;

        const author = info.authors?.join(", ") || undefined;
        const identifiers = identifiersFor(volume);
        const options: Array<{
          format: "epub" | "pdf";
          contentType: string;
          link?: string;
        }> = [
          { format: "epub", contentType: "application/epub+zip", link: access.epub?.isAvailable ? access.epub.downloadLink : undefined },
          { format: "pdf", contentType: "application/pdf", link: access.pdf?.isAvailable ? access.pdf.downloadLink : undefined },
        ];

        for (const option of options) {
          if (!option.link) continue;
          const url = normalizeDownloadUrl(option.link);
          if (!url) continue;
          const candidateId = `google-books:${id}:${option.format}`;
          if (seen.has(candidateId)) continue;
          seen.add(candidateId);
          const ref: SourceRef = { url, contentType: option.contentType, volumeId: id };
          candidates.push({
            id: candidateId,
            title: info.title,
            author,
            language: info.language,
            format: option.format,
            source: this.name,
            sourceRef: JSON.stringify(ref),
            identifiers,
            editionKey: `google:${id}`,
            sourceQuality: 40,
          });
        }
      }
    }

    return candidates;
  }

  async download(
    candidate: BookCandidate,
    options?: { maxBytes?: number },
  ): Promise<{ body: ReadableStream<Uint8Array>; contentType: string; sizeBytes?: number }> {
    const ref = JSON.parse(candidate.sourceRef) as SourceRef;
    const url = normalizeDownloadUrl(ref.url);
    if (!url) throw new Error("Rejected Google Books download URL outside the allowlist.");

    const response = await fetch(url, { redirect: "follow" });
    if (!response.ok || !response.body) {
      throw new Error(`Google Books download failed with HTTP ${response.status}.`);
    }
    const finalUrl = normalizeDownloadUrl(response.url || url);
    if (!finalUrl) {
      await response.body.cancel();
      throw new Error("Rejected Google Books redirect outside the allowlist.");
    }

    const contentLength = Number(response.headers.get("content-length"));
    const sizeBytes = Number.isFinite(contentLength) && contentLength > 0 ? contentLength : undefined;
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
