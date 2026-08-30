import type { BookCandidate, BookSearchContext, Env, SourceAdapter } from "../domain";

interface ZLibraryBook {
  id: number;
  hash: string;
  title: string;
  author?: string;
  lang?: string;
  extension?: string;
  filesize?: number;
  identifier?: string;
}

interface ZLibrarySearchResponse {
  success?: boolean;
  books?: ZLibraryBook[];
}

interface ZLibraryFileResponse {
  success?: boolean;
  file?: {
    downloadLink?: string;
    description?: string;
    author?: string;
    extension?: string;
  };
}

interface ZLibraryLoginResponse {
  success?: boolean;
  user?: {
    id?: number | string;
    remix_userkey?: string;
    personalDomains?: string[];
  };
}

interface ZLibraryProfileResponse {
  success?: boolean;
  user?: {
    id?: number | string;
    remix_userkey?: string;
    personalDomains?: string[];
  };
}

interface Session {
  userId: string;
  userKey: string;
  domains: string[];
}

interface SourceRef {
  bookId: number;
  hash: string;
  extension: string;
}

const DEFAULT_DOMAINS = ["https://z-library.biz", "https://1lib.fr", "https://singlelogin.me"];

function authCookies(session: Session): string {
  return `remix_userid=${session.userId}; remix_userkey=${session.userKey}`;
}

function authHeaders(session: Session): Record<string, string> {
  return {
    "user-agent": userAgent(),
    "remix-userid": session.userId,
    "remix-userkey": session.userKey,
    cookie: authCookies(session),
  };
}

export function isZLibraryConfigured(env: Env): boolean {
  return Boolean(
    (env.ZLIBRARY_REMIX_USERID && env.ZLIBRARY_REMIX_USERKEY) ||
      (env.ZLIBRARY_EMAIL && env.ZLIBRARY_PASSWORD),
  );
}

function baseDomains(env: Env): string[] {
  const configured = env.ZLIBRARY_DOMAIN?.trim();
  if (configured) return [configured.replace(/\/+$/, "")];
  return DEFAULT_DOMAINS;
}

function userAgent(): string {
  return "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
}

async function tryJsonFetch(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<{ response: Response; body: unknown }> {
  const response = await fetch(url, {
    ...init,
    signal: AbortSignal.timeout(timeoutMs),
  });
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  return { response, body };
}

function isAllowedHost(hostname: string, allowlist: string[]): boolean {
  const normalized = hostname.toLowerCase().replace(/^www\./, "");
  return allowlist.some((entry) => {
    const entryHost = new URL(entry).hostname.toLowerCase().replace(/^www\./, "");
    return normalized === entryHost || normalized.endsWith(`.${entryHost}`);
  });
}

function pickDownloadUrl(link: string, session: Session): string | null {
  try {
    const url = new URL(link);
    if (url.protocol !== "https:") return null;
    // Prefer an account personal domain when the link uses the /dtoken/ route.
    const tokenMatch = url.pathname.match(/\/dtoken\/(.+)$/);
    if (tokenMatch) {
      for (const domain of session.domains) {
        const candidate = new URL(`https://${new URL(domain).hostname}/dtoken/${tokenMatch[1]}`);
        if (isAllowedHost(candidate.hostname, session.domains)) return candidate.toString();
      }
      return null;
    }
    // Modern eapi returns a direct signed CDN link. The link is trusted because
    // it came from an authenticated eapi response; redirect safety is enforced
    // in download() by requiring the final host to match the original.
    return url.toString();
  } catch {
    return null;
  }
}

function isSameHost(a: string, b: string): boolean {
  try {
    return new URL(a).hostname.toLowerCase() === new URL(b).hostname.toLowerCase();
  } catch {
    return false;
  }
}

function identifiersFromBook(book: ZLibraryBook): { isbn10?: string[]; isbn13?: string[] } | undefined {
  const raw = book.identifier ?? "";
  const parts = raw.split(",").map((value) => value.trim().replace(/[^0-9X]/gi, "")).filter(Boolean);
  if (parts.length === 0) return undefined;
  const isbn10: string[] = [];
  const isbn13: string[] = [];
  for (const part of parts) {
    if (part.length === 10) isbn10.push(part);
    if (part.length === 13) isbn13.push(part);
  }
  if (isbn10.length === 0 && isbn13.length === 0) return undefined;
  return {
    ...(isbn10.length ? { isbn10: [...new Set(isbn10)] } : {}),
    ...(isbn13.length ? { isbn13: [...new Set(isbn13)] } : {}),
  };
}

function normalizeSearchText(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

export function isRelevantZLibraryResult(
  book: Pick<ZLibraryBook, "title" | "author">,
  context: BookSearchContext,
): boolean {
  const candidateTitle = normalizeSearchText(book.title);
  const titleMatches = context.queryVariants.some((variant) => {
    const expected = normalizeSearchText(variant);
    return expected.length >= 3 &&
      (candidateTitle.includes(expected) || expected.includes(candidateTitle));
  });
  if (!titleMatches) return false;

  const requestedAuthor = context.request.author?.trim();
  if (!requestedAuthor) return true;
  if (!book.author) return false;

  const expectedAuthor = normalizeSearchText(requestedAuthor);
  const candidateAuthor = normalizeSearchText(book.author);
  return candidateAuthor.includes(expectedAuthor) || expectedAuthor.includes(candidateAuthor);
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

export class ZLibrarySource implements SourceAdapter {
  readonly name = "zlibrary";

  private constructor(private readonly env: Env) {}

  static create(env: Env): ZLibrarySource {
    return new ZLibrarySource(env);
  }

  private async login(domain: string): Promise<Session> {
    const { response, body } = await tryJsonFetch(
      `${domain}/eapi/user/login`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "user-agent": userAgent(),
        },
        body: JSON.stringify({
          email: this.env.ZLIBRARY_EMAIL,
          password: this.env.ZLIBRARY_PASSWORD,
        }),
      },
      10000,
    );

    if (!response.ok) {
      throw new Error(`ZLibrary login failed with HTTP ${response.status}.`);
    }
    const parsed = body as ZLibraryLoginResponse;
    const user = parsed.user;
    if (!parsed.success || !user?.id || !user.remix_userkey) {
      throw new Error("ZLibrary login response did not include a usable session.");
    }

    return {
      userId: String(user.id),
      userKey: user.remix_userkey,
      domains: [domain, ...(user.personalDomains ?? []).map((item) => `https://${item}`)],
    };
  }

  private async sessionFromRemix(domain: string): Promise<Session> {
    const userId = this.env.ZLIBRARY_REMIX_USERID!.trim();
    const userKey = this.env.ZLIBRARY_REMIX_USERKEY!.trim();
    const session: Session = { userId, userKey, domains: [domain] };

    const { response, body } = await tryJsonFetch(
      `${domain}/eapi/user/profile`,
      { headers: authHeaders(session) },
      10000,
    );

    if (!response.ok) {
      throw new Error(`ZLibrary profile check failed with HTTP ${response.status}.`);
    }
    const parsed = body as ZLibraryProfileResponse;
    const user = parsed.user;
    if (parsed.success && user) {
      for (const item of user.personalDomains ?? []) session.domains.push(`https://${item}`);
    }

    return session;
  }

  private async ensureSession(): Promise<Session> {
    const errors: string[] = [];
    for (const domain of baseDomains(this.env)) {
      try {
        if (this.env.ZLIBRARY_REMIX_USERID && this.env.ZLIBRARY_REMIX_USERKEY) {
          return await this.sessionFromRemix(domain);
        }
        return await this.login(domain);
      } catch (error) {
        errors.push(`${domain}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    throw new Error(`ZLibrary session could not be established (${errors.join("; ")}).`);
  }

  async search(context: BookSearchContext): Promise<BookCandidate[]> {
    if (!isZLibraryConfigured(this.env)) {
      throw new Error("ZLibrary is not configured; set ZLIBRARY_EMAIL/ZLIBRARY_PASSWORD or ZLIBRARY_REMIX_USERID/ZLIBRARY_REMIX_USERKEY.");
    }

    const session = await this.ensureSession();
    const languages =
      context.preferredLanguage && context.preferredLanguage !== "zh"
        ? context.preferredLanguage
        : "";

    const queries = context.queryVariants.slice(0, 3).map((title) =>
      [title, context.request.author].filter(Boolean).join(" "),
    );
    const settled = await Promise.allSettled(
      queries.map(async (query) => {
        const errors: string[] = [];
        for (const domain of session.domains) {
          try {
            const { response, body } = await tryJsonFetch(
              `${domain}/eapi/book/search`,
              {
                method: "POST",
                headers: {
                  "content-type": "application/json",
                  ...authHeaders(session),
                },
                body: JSON.stringify({
                  message: query,
                  languages,
                  extensions: "epub,pdf",
                  page: 1,
                  limit: 20,
                  order: "",
                }),
              },
              12000,
            );
            if (!response.ok) {
              throw new Error(`ZLibrary search failed with HTTP ${response.status}.`);
            }
            const parsed = body as ZLibrarySearchResponse;
            if (!parsed.success) throw new Error("ZLibrary search returned success=false.");
            return parsed.books ?? [];
          } catch (error) {
            errors.push(`${domain}: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
        throw new Error(`All ZLibrary domains failed for query (${errors.join("; ")}).`);
      }),
    );

    const seen = new Set<string>();
    const candidates: BookCandidate[] = [];

    for (const result of settled) {
      if (result.status !== "fulfilled") continue;
      for (const book of result.value) {
        const format = (book.extension ?? "").toLowerCase();
        if (format !== "epub" && format !== "pdf") continue;
        if (!book.id || !book.hash || !book.title) continue;
        if (!isRelevantZLibraryResult(book, context)) continue;

        const id = `zlibrary:${book.id}:${book.hash}:${format}`;
        if (seen.has(id)) continue;
        seen.add(id);

        const ref: SourceRef = { bookId: book.id, hash: book.hash, extension: format };
        candidates.push({
          id,
          title: book.title,
          author: book.author || undefined,
          language: book.lang || undefined,
          format,
          sizeBytes: typeof book.filesize === "number" && book.filesize > 0 ? book.filesize : undefined,
          source: this.name,
          sourceRef: JSON.stringify(ref),
          identifiers: identifiersFromBook(book),
          editionKey: `zlibrary:${book.id}`,
          sourceQuality: 60,
        });
      }
    }

    return candidates;
  }

  async download(
    candidate: BookCandidate,
    options?: { maxBytes?: number },
  ): Promise<{ body: ReadableStream<Uint8Array>; contentType: string; sizeBytes?: number }> {
    if (!isZLibraryConfigured(this.env)) {
      throw new Error("ZLibrary is not configured.");
    }

    const ref = JSON.parse(candidate.sourceRef) as SourceRef;
    const session = await this.ensureSession();
    let downloadUrl: string | null = null;
    let declaredContentType = ref.extension === "pdf" ? "application/pdf" : "application/epub+zip";
    const errors: string[] = [];

    for (const domain of session.domains) {
      try {
        const { response, body } = await tryJsonFetch(
          `${domain}/eapi/book/${ref.bookId}/${ref.hash}/file`,
          { headers: authHeaders(session) },
          12000,
        );
        if (!response.ok) {
          throw new Error(`ZLibrary file lookup failed with HTTP ${response.status}.`);
        }
        const parsed = body as ZLibraryFileResponse;
        const file = parsed.file;
        const link = file?.downloadLink;
        if (!parsed.success || !link) throw new Error("ZLibrary file lookup returned no download link.");
        downloadUrl = pickDownloadUrl(link, session);
        if (!downloadUrl) throw new Error("ZLibrary download link is outside the allowed personal domains.");
        const declaredExtension = (file?.extension ?? "").toLowerCase();
        if (declaredExtension === "pdf") declaredContentType = "application/pdf";
        break;
      } catch (error) {
        errors.push(`${domain}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    if (!downloadUrl) {
      throw new Error(`ZLibrary download lookup failed on all domains (${errors.join("; ")}).`);
    }

    const response = await fetch(downloadUrl, {
      headers: authHeaders(session),
      redirect: "follow",
    });

    if (!response.ok || !response.body) {
      throw new Error(`ZLibrary download failed with HTTP ${response.status}.`);
    }
    if (!isSameHost(response.url || downloadUrl, downloadUrl)) {
      await response.body.cancel();
      throw new Error("Rejected ZLibrary download redirect to a different host.");
    }

    const contentLength = Number(response.headers.get("content-length"));
    const sizeBytes = Number.isFinite(contentLength) && contentLength > 0 ? contentLength : undefined;
    if (sizeBytes && options?.maxBytes && sizeBytes > options.maxBytes) {
      await response.body.cancel();
      throw new Error(`Book is ${sizeBytes} bytes, above the cloud limit of ${options.maxBytes}.`);
    }

    return {
      body: limitedStream(response.body, options?.maxBytes),
      contentType: response.headers.get("content-type")?.split(";")[0] || declaredContentType,
      sizeBytes,
    };
  }
}
