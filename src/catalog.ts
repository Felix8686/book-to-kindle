// Deterministic author-catalog lookup (docs/ARCHITECTURE.md §3): once the
// semantic layer has identified intent=author_works and an author name, all
// further work is code-owned. Works are resolved through the Open Library
// author ENTITY and verified by author_key membership — never by matching the
// author name against titles, descriptions or keywords.

export interface AuthorWork {
  title: string;
  firstPublishYear?: number;
}

const FIELDS = "key,title,author_name,author_key,edition_count,first_publish_year";

function normalizePersonName(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[\p{P}\p{Z}\p{S}]+/gu, "");
}

interface OpenLibraryAuthorDoc {
  key?: string;
  name?: string;
  alternate_names?: string[];
}

interface OpenLibraryAuthorSearchResponse {
  docs?: OpenLibraryAuthorDoc[];
}

interface OpenLibraryWorkDoc {
  key?: string;
  title?: string;
  author_key?: string[];
  edition_count?: number;
  first_publish_year?: number;
}

interface OpenLibraryWorkSearchResponse {
  docs?: OpenLibraryWorkDoc[];
}

async function fetchJson<T>(url: string, fetchImpl: typeof fetch): Promise<T> {
  const response = await fetchImpl(url, {
    headers: {
      accept: "application/json",
      "user-agent": "book-to-kindle/0.7 (+https://github.com/Felix8686/book-to-kindle)",
    },
    signal: AbortSignal.timeout(6000),
  });
  if (!response.ok) throw new Error(`Author catalog request failed with HTTP ${response.status}.`);
  return (await response.json()) as T;
}

function cleanTitle(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, 300);
}

/**
 * Resolve an author name to an Open Library author entity and return their
 * works, most-editioned first. Authorship is guaranteed structurally: every
 * returned work must list the resolved author's key in its author_key field,
 * so books that merely mention the author in title/description/keywords can
 * never appear in the result.
 */
export async function queryAuthorWorks(
  author: string,
  fetchImpl: typeof fetch = fetch,
): Promise<AuthorWork[]> {
  const trimmed = author.trim();
  if (!trimmed) return [];

  const authorSearchUrl = `https://openlibrary.org/search/authors.json?q=${encodeURIComponent(trimmed)}&limit=5`;
  const authorData = await fetchJson<OpenLibraryAuthorSearchResponse>(authorSearchUrl, fetchImpl);
  const docs = authorData.docs ?? [];
  if (docs.length === 0 || !docs[0].key) return [];

  const normalizedQuery = normalizePersonName(trimmed);
  const matchesQuery = (doc: OpenLibraryAuthorDoc): boolean =>
    [doc.name, ...(doc.alternate_names ?? [])].some(
      (name) => name && normalizePersonName(name) === normalizedQuery,
    );
  // Prefer an entity whose name/alias exactly matches the user's string; the
  // search engine is name-scoped, so its top hit is the best entity guess for
  // cross-script names (e.g. 东野圭吾 vs Keigo Higashino). Either way, the
  // author_key verification below keeps the work list structurally correct.
  const resolved = docs.find(matchesQuery) ?? docs[0];
  if (!resolved.key) return [];

  const worksUrl =
    `https://openlibrary.org/search.json?author=${encodeURIComponent(resolved.name ?? trimmed)}` +
    `&fields=${encodeURIComponent(FIELDS)}&limit=50`;
  const worksData = await fetchJson<OpenLibraryWorkSearchResponse>(worksUrl, fetchImpl);

  const verified = (worksData.docs ?? []).filter(
    (doc) => doc.title && doc.author_key?.includes(resolved.key!),
  );
  verified.sort((a, b) => (b.edition_count ?? 0) - (a.edition_count ?? 0));

  return verified.slice(0, 8).map((doc) => ({
    title: cleanTitle(doc.title!),
    ...(typeof doc.first_publish_year === "number" ? { firstPublishYear: doc.first_publish_year } : {}),
  }));
}
