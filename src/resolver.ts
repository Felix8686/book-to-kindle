import type {
  BookIdentifiers,
  BookIdentity,
  BookRequest,
  BookSearchContext,
  BookTitleVariant,
} from "./domain";
import { normalizeBookLanguage } from "./settings";

interface OpenLibrarySearchDoc {
  key?: string;
  title?: string;
  author_name?: string[];
  isbn?: string[];
}

interface OpenLibrarySearchResponse {
  docs?: OpenLibrarySearchDoc[];
}

interface OpenLibraryEdition {
  key?: string;
  title?: string;
  languages?: Array<{ key?: string }>;
  isbn_10?: string[];
  isbn_13?: string[];
}

interface OpenLibraryEditionsResponse {
  entries?: OpenLibraryEdition[];
}

interface GoogleVolume {
  id?: string;
  volumeInfo?: {
    title?: string;
    authors?: string[];
    language?: string;
    industryIdentifiers?: Array<{ type?: string; identifier?: string }>;
  };
}

interface GoogleVolumesResponse {
  items?: GoogleVolume[];
}

function unique(values: Array<string | undefined>): string[] {
  return [...new Set(values.map((value) => value?.trim()).filter((value): value is string => Boolean(value)))];
}

function normalizeOlLanguage(key?: string): string | undefined {
  const code = key?.split("/").pop()?.toLowerCase();
  if (!code) return undefined;
  if (["chi", "zho"].includes(code)) return "zh";
  if (code === "eng") return "en";
  return normalizeBookLanguage(code) ?? code.slice(0, 2);
}

function normalizeGoogleLanguage(value?: string): string | undefined {
  if (!value) return undefined;
  return normalizeBookLanguage(value) ?? value.toLowerCase().slice(0, 2);
}

function addTitle(
  output: BookTitleVariant[],
  seen: Set<string>,
  title: string | undefined,
  language: string | undefined,
  source: BookTitleVariant["source"],
): void {
  const cleaned = title?.replace(/\s+/g, " ").trim().slice(0, 300);
  if (!cleaned) return;
  const key = `${cleaned.toLowerCase()}|${language ?? ""}`;
  if (seen.has(key)) return;
  seen.add(key);
  output.push({ title: cleaned, language, source });
}

function mergeIdentifiers(target: BookIdentifiers, incoming: BookIdentifiers): void {
  target.isbn10 = unique([...(target.isbn10 ?? []), ...(incoming.isbn10 ?? [])]);
  target.isbn13 = unique([...(target.isbn13 ?? []), ...(incoming.isbn13 ?? [])]);
  target.openLibraryWorkKeys = unique([
    ...(target.openLibraryWorkKeys ?? []),
    ...(incoming.openLibraryWorkKeys ?? []),
  ]);
  target.googleVolumeIds = unique([
    ...(target.googleVolumeIds ?? []),
    ...(incoming.googleVolumeIds ?? []),
  ]);
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, {
    headers: {
      accept: "application/json",
      "user-agent": "book-to-kindle/0.5 (+https://github.com/Felix8686/book-to-kindle)",
    },
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error(`Resolver request failed with HTTP ${response.status}.`);
  return (await response.json()) as T;
}

async function resolveOpenLibrary(
  request: BookRequest,
  preferredLanguage: string,
): Promise<{
  titles: BookTitleVariant[];
  authors: string[];
  identifiers: BookIdentifiers;
  canonicalTitle?: string;
}> {
  const search = new URL("https://openlibrary.org/search.json");
  search.searchParams.set("q", [request.query, request.author].filter(Boolean).join(" "));
  search.searchParams.set("lang", preferredLanguage);
  search.searchParams.set("limit", "5");
  search.searchParams.set("fields", "key,title,author_name,isbn");

  const data = await fetchJson<OpenLibrarySearchResponse>(search.toString());
  const docs = data.docs ?? [];
  const first = docs[0];
  const titles: BookTitleVariant[] = [];
  const seen = new Set<string>();
  const identifiers: BookIdentifiers = {};
  const authors: string[] = [];

  for (const doc of docs.slice(0, 3)) {
    addTitle(titles, seen, doc.title, undefined, "openlibrary");
    authors.push(...(doc.author_name ?? []));
    if (doc.key) {
      identifiers.openLibraryWorkKeys = unique([
        ...(identifiers.openLibraryWorkKeys ?? []),
        doc.key,
      ]);
    }
    for (const isbn of doc.isbn ?? []) {
      const clean = isbn.replace(/[^0-9X]/gi, "");
      if (clean.length === 10) identifiers.isbn10 = unique([...(identifiers.isbn10 ?? []), clean]);
      if (clean.length === 13) identifiers.isbn13 = unique([...(identifiers.isbn13 ?? []), clean]);
    }
  }

  if (first?.key?.startsWith("/works/")) {
    try {
      const editionsUrl = new URL(`https://openlibrary.org${first.key}/editions.json`);
      editionsUrl.searchParams.set("limit", "50");
      const editions = await fetchJson<OpenLibraryEditionsResponse>(editionsUrl.toString());
      const preferred: OpenLibraryEdition[] = [];
      const others: OpenLibraryEdition[] = [];

      for (const edition of editions.entries ?? []) {
        const language = normalizeOlLanguage(edition.languages?.[0]?.key);
        (language === preferredLanguage ? preferred : others).push(edition);
      }

      for (const edition of [...preferred.slice(0, 8), ...others.slice(0, 12)]) {
        const language = normalizeOlLanguage(edition.languages?.[0]?.key);
        addTitle(titles, seen, edition.title, language, "openlibrary");
        identifiers.isbn10 = unique([...(identifiers.isbn10 ?? []), ...(edition.isbn_10 ?? [])]);
        identifiers.isbn13 = unique([...(identifiers.isbn13 ?? []), ...(edition.isbn_13 ?? [])]);
      }
    } catch (error) {
      console.warn("Open Library editions lookup failed", error);
    }
  }

  return {
    titles,
    authors: unique(authors),
    identifiers,
    canonicalTitle: first?.title,
  };
}

async function resolveGoogleBooks(
  request: BookRequest,
  preferredLanguage: string,
): Promise<{
  titles: BookTitleVariant[];
  authors: string[];
  identifiers: BookIdentifiers;
  canonicalTitle?: string;
}> {
  const q = [request.query, request.author].filter(Boolean).join(" ");
  const makeUrl = (language?: string) => {
    const url = new URL("https://www.googleapis.com/books/v1/volumes");
    url.searchParams.set("q", q);
    url.searchParams.set("printType", "books");
    url.searchParams.set("maxResults", "10");
    if (language) url.searchParams.set("langRestrict", language);
    return url.toString();
  };

  const settled = await Promise.allSettled([
    fetchJson<GoogleVolumesResponse>(makeUrl(preferredLanguage)),
    fetchJson<GoogleVolumesResponse>(makeUrl()),
  ]);

  const volumes = settled.flatMap((result) =>
    result.status === "fulfilled" ? result.value.items ?? [] : [],
  );
  const titles: BookTitleVariant[] = [];
  const seen = new Set<string>();
  const authors: string[] = [];
  const identifiers: BookIdentifiers = {};

  for (const volume of volumes.slice(0, 16)) {
    const info = volume.volumeInfo;
    if (!info?.title) continue;
    addTitle(titles, seen, info.title, normalizeGoogleLanguage(info.language), "google-books");
    authors.push(...(info.authors ?? []));
    if (volume.id) {
      identifiers.googleVolumeIds = unique([...(identifiers.googleVolumeIds ?? []), volume.id]);
    }
    for (const identifier of info.industryIdentifiers ?? []) {
      const clean = identifier.identifier?.replace(/[^0-9X]/gi, "");
      if (!clean) continue;
      if (identifier.type === "ISBN_10") identifiers.isbn10 = unique([...(identifiers.isbn10 ?? []), clean]);
      if (identifier.type === "ISBN_13") identifiers.isbn13 = unique([...(identifiers.isbn13 ?? []), clean]);
    }
  }

  return {
    titles,
    authors: unique(authors),
    identifiers,
    canonicalTitle: volumes[0]?.volumeInfo?.title,
  };
}

function orderedQueryVariants(
  request: BookRequest,
  preferredLanguage: string,
  titles: BookTitleVariant[],
): string[] {
  const preferred = titles
    .filter((item) => item.language === preferredLanguage)
    .map((item) => item.title);
  const neutral = titles.filter((item) => !item.language).map((item) => item.title);
  const fallback = titles
    .filter((item) => item.language && item.language !== preferredLanguage)
    .map((item) => item.title);
  return unique([...preferred, ...neutral, request.query, ...fallback]).slice(0, 8);
}

export async function resolveBookSearchContext(
  request: BookRequest,
  preferredLanguage: string,
): Promise<BookSearchContext> {
  const requestTitle: BookTitleVariant = {
    title: request.query,
    language: normalizeBookLanguage(request.language),
    source: "request",
  };

  const [openLibrary, googleBooks] = await Promise.allSettled([
    resolveOpenLibrary(request, preferredLanguage),
    resolveGoogleBooks(request, preferredLanguage),
  ]);

  const titles: BookTitleVariant[] = [requestTitle];
  const seen = new Set([`${request.query.toLowerCase()}|${requestTitle.language ?? ""}`]);
  const authors = [request.author].filter((value): value is string => Boolean(value));
  const identifiers: BookIdentifiers = {};
  let canonicalTitle = request.query;

  for (const result of [openLibrary, googleBooks]) {
    if (result.status !== "fulfilled") {
      console.warn("Book resolver source failed", result.reason);
      continue;
    }
    canonicalTitle = canonicalTitle === request.query && result.value.canonicalTitle
      ? result.value.canonicalTitle
      : canonicalTitle;
    authors.push(...result.value.authors);
    mergeIdentifiers(identifiers, result.value.identifiers);
    for (const title of result.value.titles) {
      addTitle(titles, seen, title.title, title.language, title.source);
    }
  }

  const identity: BookIdentity = {
    canonicalTitle,
    authors: unique(authors),
    titles,
    identifiers,
  };

  return {
    request,
    preferredLanguage,
    identity,
    queryVariants: orderedQueryVariants(request, preferredLanguage, titles),
  };
}
