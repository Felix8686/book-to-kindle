import type { BookCandidate, BookSearchContext, Env, SourceAdapter } from "../domain";

interface ZLibraryBook {
  id: number;
  hash: string;
  title: string;
  author?: string;
  lang?: string;
  extension?: string;
  filesize?: number;
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

const DEFAULT_DOMAINS = ["https://1lib.fr", "https://singlelogin.me"];

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
    const tokenMatch = url.pathname.match(/\/dtoken\/(.+)$/);
    if (!tokenMatch) return null;
    for (const domain of session.domains) {
      const candidate = new URL(`https://${new URL(domain).hostname}/dtoken/${tokenMatch[1]}`);
      if (isAllowedHost(candidate.hostname, session.domains)) return candidate.toString();
    }
    return isAllowedHost(url.hostname, session.domains) ? url.toString() : null;
  } catch {
    return null;
  }
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

    const headers = {
      "user-agent": userAgent(),
      "remix-userid": userId,
      "remix-userkey": userKey,
    };

    const { response, body } = await tryJsonFetch(
      `${domain}/eapi/user/profile`,
      { headers },
      10000,
    );

    if (!response.ok) {
      throw new Error(`ZLibrary profile check failed with HTTP ${response.status}.`);
    }
    const parsed = body as ZLibraryProfileResponse;
    const user = parsed.user;
    const domains = [domain];
    if (parsed.success && user) {
      for (const item of user.personalDomains ?? []) domains.push(`https://${item}`);
    }

    return { userId, userKey, domains };
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
                  "user-agent": userAgent(),
                  "remix-userid": session.userId,
                  "remix-userkey": session.userKey,
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
          {
            headers: {
              "user-agent": userAgent(),
              "remix-userid": session.userId,
              "remix-userkey": session.userKey,
            },
          },
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
      headers: {
        "user-agent": userAgent(),
        "remix-userid": session.userId,
        "remix-userkey": session.userKey,
      },
      redirect: "follow",
    });

    if (!response.ok || !response.body) {
      throw new Error(`ZLibrary download failed with HTTP ${response.status}.`);
    }
    if (!isAllowedHost(new URL(response.url || downloadUrl).hostname, session.domains)) {
      await response.body.cancel();
      throw new Error("Rejected ZLibrary download redirect outside the allowed personal domains.");
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
