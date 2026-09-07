export interface CatalogWork {
  title: string;
  authors: string[];
  firstPublishYear?: number;
  editionCount?: number;
  sources: Array<"openlibrary" | "google-books">;
}

export interface CatalogBookInfo {
  title: string;
  authors: string[];
  publishedDate?: string;
  publisher?: string;
  categories: string[];
  description?: string;
  sources: Array<"openlibrary" | "google-books">;
}

interface OpenLibraryAuthorDoc {
  title?: string;
  author_name?: string[];
  first_publish_year?: number;
  edition_count?: number;
}

interface OpenLibrarySearchResponse {
  docs?: OpenLibraryAuthorDoc[];
}

interface GoogleVolume {
  volumeInfo?: {
    title?: string;
    authors?: string[];
    publishedDate?: string;
    publisher?: string;
    description?: string;
    categories?: string[];
  };
}

interface GoogleVolumesResponse {
  items?: GoogleVolume[];
}

function normalizeText(value?: string): string {
  if (!value) return "";
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, "")
    .trim();
}

function unique(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function authorMatches(actual: string[] | undefined, requested: string): boolean {
  const target = normalizeText(requested);
  if (!target || !actual?.length) return false;
  return actual.some((author) => {
    const normalized = normalizeText(author);
    return Boolean(normalized) && (normalized === target || normalized.includes(target) || target.includes(normalized));
  });
}

function titleKey(title: string): string {
  return normalizeText(title);
}

function stripHtml(value?: string): string | undefined {
  if (!value) return undefined;
  const cleaned = value
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned || undefined;
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, {
    headers: {
      accept: "application/json",
      "user-agent": "book-to-kindle/0.6 (+https://github.com/Felix8686/book-to-kindle)",
    },
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error(`Catalog request failed with HTTP ${response.status}.`);
  return (await response.json()) as T;
}

function openLibraryAuthorUrl(author: string): string {
  const url = new URL("https://openlibrary.org/search.json");
  url.searchParams.set("author", author);
  url.searchParams.set("limit", "40");
  url.searchParams.set("fields", "title,author_name,first_publish_year,edition_count");
  return url.toString();
}

function googleAuthorUrl(author: string): string {
  const url = new URL("https://www.googleapis.com/books/v1/volumes");
  url.searchParams.set("q", `inauthor:\"${author}\"`);
  url.searchParams.set("printType", "books");
  url.searchParams.set("maxResults", "40");
  return url.toString();
}

export async function lookupAuthorWorks(author: string, limit = 8): Promise<CatalogWork[]> {
  const cleanAuthor = author.trim().slice(0, 200);
  if (!cleanAuthor) return [];

  const [olResult, googleResult] = await Promise.allSettled([
    fetchJson<OpenLibrarySearchResponse>(openLibraryAuthorUrl(cleanAuthor)),
    fetchJson<GoogleVolumesResponse>(googleAuthorUrl(cleanAuthor)),
  ]);

  const works = new Map<string, CatalogWork & { score: number }>();

  if (olResult.status === "fulfilled") {
    for (const doc of olResult.value.docs ?? []) {
      const title = doc.title?.trim().slice(0, 300);
      if (!title || !authorMatches(doc.author_name, cleanAuthor)) continue;
      const key = titleKey(title);
      if (!key) continue;

      const current = works.get(key);
      const editionCount = Number.isFinite(doc.edition_count) ? Math.max(0, Number(doc.edition_count)) : undefined;
      const score = 100 + Math.min(editionCount ?? 0, 80);
      if (current) {
        current.sources = unique([...current.sources, "openlibrary"]) as CatalogWork["sources"];
        current.authors = unique([...current.authors, ...(doc.author_name ?? [])]);
        current.editionCount = Math.max(current.editionCount ?? 0, editionCount ?? 0) || undefined;
        current.firstPublishYear = current.firstPublishYear ?? doc.first_publish_year;
        current.score += 100;
      } else {
        works.set(key, {
          title,
          authors: unique(doc.author_name ?? [cleanAuthor]),
          firstPublishYear: doc.first_publish_year,
          editionCount,
          sources: ["openlibrary"],
          score,
        });
      }
    }
  }

  if (googleResult.status === "fulfilled") {
    for (const volume of googleResult.value.items ?? []) {
      const info = volume.volumeInfo;
      const title = info?.title?.trim().slice(0, 300);
      if (!title || !authorMatches(info?.authors, cleanAuthor)) continue;
      const key = titleKey(title);
      if (!key) continue;

      const current = works.get(key);
      if (current) {
        current.sources = unique([...current.sources, "google-books"]) as CatalogWork["sources"];
        current.authors = unique([...current.authors, ...(info?.authors ?? [])]);
        current.score += 120;
      } else {
        works.set(key, {
          title,
          authors: unique(info?.authors ?? [cleanAuthor]),
          sources: ["google-books"],
          score: 120,
        });
      }
    }
  }

  return [...works.values()]
    .sort((a, b) => b.score - a.score || (b.editionCount ?? 0) - (a.editionCount ?? 0) || a.title.localeCompare(b.title))
    .slice(0, Math.max(1, Math.min(12, Math.floor(limit))))
    .map(({ score: _score, ...work }) => work);
}

function googleBookUrl(title: string, author?: string): string {
  const url = new URL("https://www.googleapis.com/books/v1/volumes");
  const terms = [`intitle:\"${title}\"`];
  if (author) terms.push(`inauthor:\"${author}\"`);
  url.searchParams.set("q", terms.join("+"));
  url.searchParams.set("printType", "books");
  url.searchParams.set("maxResults", "10");
  return url.toString();
}

function openLibraryBookUrl(title: string, author?: string): string {
  const url = new URL("https://openlibrary.org/search.json");
  url.searchParams.set("title", title);
  if (author) url.searchParams.set("author", author);
  url.searchParams.set("limit", "10");
  url.searchParams.set("fields", "title,author_name,first_publish_year,edition_count");
  return url.toString();
}

function titleCompatible(actual?: string, requested?: string): boolean {
  const a = normalizeText(actual);
  const r = normalizeText(requested);
  if (!a || !r) return false;
  return a === r || a.includes(r) || r.includes(a);
}

export async function lookupBookInfo(title: string, author?: string): Promise<CatalogBookInfo | null> {
  const cleanTitle = title.trim().slice(0, 300);
  const cleanAuthor = author?.trim().slice(0, 200);
  if (!cleanTitle) return null;

  const [googleResult, olResult] = await Promise.allSettled([
    fetchJson<GoogleVolumesResponse>(googleBookUrl(cleanTitle, cleanAuthor)),
    fetchJson<OpenLibrarySearchResponse>(openLibraryBookUrl(cleanTitle, cleanAuthor)),
  ]);

  let result: CatalogBookInfo | null = null;

  if (googleResult.status === "fulfilled") {
    for (const volume of googleResult.value.items ?? []) {
      const info = volume.volumeInfo;
      if (!titleCompatible(info?.title, cleanTitle)) continue;
      if (cleanAuthor && !authorMatches(info?.authors, cleanAuthor)) continue;
      result = {
        title: info?.title?.trim() || cleanTitle,
        authors: unique(info?.authors ?? (cleanAuthor ? [cleanAuthor] : [])),
        publishedDate: info?.publishedDate?.trim(),
        publisher: info?.publisher?.trim(),
        categories: unique(info?.categories ?? []),
        description: stripHtml(info?.description),
        sources: ["google-books"],
      };
      break;
    }
  }

  if (olResult.status === "fulfilled") {
    for (const doc of olResult.value.docs ?? []) {
      if (!titleCompatible(doc.title, cleanTitle)) continue;
      if (cleanAuthor && !authorMatches(doc.author_name, cleanAuthor)) continue;
      if (!result) {
        result = {
          title: doc.title?.trim() || cleanTitle,
          authors: unique(doc.author_name ?? (cleanAuthor ? [cleanAuthor] : [])),
          publishedDate: doc.first_publish_year ? String(doc.first_publish_year) : undefined,
          categories: [],
          sources: ["openlibrary"],
        };
      } else {
        result.authors = unique([...result.authors, ...(doc.author_name ?? [])]);
        result.sources = unique([...result.sources, "openlibrary"]) as CatalogBookInfo["sources"];
        result.publishedDate = result.publishedDate ?? (doc.first_publish_year ? String(doc.first_publish_year) : undefined);
      }
      break;
    }
  }

  return result;
}

export function formatAuthorWorksReply(author: string, works: CatalogWork[]): string {
  if (!works.length) {
    return `我没能从当前书目来源中可靠核对到“${author}”的作品列表。可以换一种作者写法，或直接告诉我具体书名。`;
  }

  const lines = works.map((work, index) => {
    const year = work.firstPublishYear ? `（${work.firstPublishYear}）` : "";
    return `${index + 1}. 《${work.title}》${year}`;
  });

  return [
    `我从书目来源中核对到这些“${author}”作品，按目录覆盖度排序：`,
    ...lines,
    "",
    "想了解哪一本可以直接说“第二本怎么样？”，要发送则说“第二本发到 Kindle”。",
  ].join("\n");
}

export function formatBookInfoReply(info: CatalogBookInfo | null, requestedTitle: string): string {
  if (!info) {
    return `我能确定你指的是《${requestedTitle}》，但当前书目来源没有返回足够可靠的详情。要发送的话可以直接说“把《${requestedTitle}》发到 Kindle”。`;
  }

  const lines = [`《${info.title}》`];
  if (info.authors.length) lines.push(`作者：${info.authors.join("、")}`);
  if (info.publishedDate) lines.push(`出版时间：${info.publishedDate}`);
  if (info.publisher) lines.push(`出版社：${info.publisher}`);
  if (info.categories.length) lines.push(`分类：${info.categories.slice(0, 4).join("、")}`);
  if (info.description) {
    const description = info.description.length > 700 ? `${info.description.slice(0, 697)}...` : info.description;
    lines.push(`简介：${description}`);
  }
  lines.push("要发送到 Kindle，可以直接说“这本发到 Kindle”。");
  return lines.join("\n");
}
