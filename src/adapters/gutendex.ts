import type { BookCandidate, BookRequest, SourceAdapter } from "../domain";

interface GutendexBook {
  id: number;
  title: string;
  authors: Array<{ name: string }>;
  languages: string[];
  copyright: boolean | null;
  formats: Record<string, string>;
}

interface GutendexResponse {
  results: GutendexBook[];
}

interface SourceRef {
  url: string;
  contentType: string;
  bookId: number;
}

function normalizeLanguage(language?: string): string | undefined {
  if (!language) return undefined;
  const value = language.trim().toLowerCase();
  const aliases: Record<string, string> = {
    english: "en",
    chinese: "zh",
    japanese: "ja",
    french: "fr",
    german: "de",
    spanish: "es",
    italian: "it",
    portuguese: "pt",
    russian: "ru",
  };
  return aliases[value] ?? value.slice(0, 2);
}

function formatsFor(book: GutendexBook): Array<{ format: "epub" | "pdf"; contentType: string; url: string }> {
  const output: Array<{ format: "epub" | "pdf"; contentType: string; url: string }> = [];

  const epub = book.formats["application/epub+zip"];
  if (epub) output.push({ format: "epub", contentType: "application/epub+zip", url: epub });

  const pdf = book.formats["application/pdf"];
  if (pdf) output.push({ format: "pdf", contentType: "application/pdf", url: pdf });

  return output;
}

function isAllowedDownloadUrl(value: string): boolean {
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase();
    return url.protocol === "https:" && (hostname === "gutenberg.org" || hostname.endsWith(".gutenberg.org"));
  } catch {
    return false;
  }
}

function limitedStream(
  body: ReadableStream<Uint8Array>,
  maxBytes?: number,
): ReadableStream<Uint8Array> {
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

export class GutendexSource implements SourceAdapter {
  readonly name = "gutendex";

  async search(request: BookRequest): Promise<BookCandidate[]> {
    const query = [request.query, request.author].filter(Boolean).join(" ");
    const url = new URL("https://gutendex.com/books");
    url.searchParams.set("search", query);
    url.searchParams.set("copyright", "false");

    const language = normalizeLanguage(request.language);
    if (language) url.searchParams.set("languages", language);

    const response = await fetch(url.toString(), {
      headers: { accept: "application/json" },
    });
    if (!response.ok) {
      throw new Error(`Gutendex search failed with HTTP ${response.status}.`);
    }

    const data = (await response.json()) as GutendexResponse;
    const candidates: BookCandidate[] = [];

    for (const book of data.results.slice(0, 12)) {
      if (book.copyright !== false) continue;
      const author = book.authors.map((item) => item.name).filter(Boolean).join(", ") || undefined;

      for (const item of formatsFor(book)) {
        if (!isAllowedDownloadUrl(item.url)) continue;
        const sourceRef: SourceRef = {
          url: item.url,
          contentType: item.contentType,
          bookId: book.id,
        };

        candidates.push({
          id: `gutenberg:${book.id}:${item.format}`,
          title: book.title,
          author,
          language: book.languages[0],
          format: item.format,
          source: this.name,
          sourceRef: JSON.stringify(sourceRef),
        });
      }
    }

    return candidates;
  }

  async download(
    candidate: BookCandidate,
    options?: { maxBytes?: number },
  ): Promise<{
    body: ReadableStream<Uint8Array>;
    contentType: string;
    sizeBytes?: number;
  }> {
    const ref = JSON.parse(candidate.sourceRef) as SourceRef;
    if (!isAllowedDownloadUrl(ref.url)) {
      throw new Error("Rejected download URL outside the Project Gutenberg allowlist.");
    }

    const response = await fetch(ref.url, {
      headers: { accept: ref.contentType },
      redirect: "follow",
    });

    if (!response.ok || !response.body) {
      throw new Error(`Gutendex download failed with HTTP ${response.status}.`);
    }

    const finalUrl = response.url || ref.url;
    if (!isAllowedDownloadUrl(finalUrl)) {
      await response.body.cancel();
      throw new Error("Rejected redirect outside the Project Gutenberg allowlist.");
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
