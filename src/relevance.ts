import type {
  BookCandidate,
  BookIdentifiers,
  BookSearchContext,
  SourceAdapter,
} from "./domain";

function normalizeText(value?: string): string {
  return (value ?? "")
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "")
    .trim();
}

function identifierSet(identifiers?: BookIdentifiers): Set<string> {
  return new Set(
    [...(identifiers?.isbn10 ?? []), ...(identifiers?.isbn13 ?? [])]
      .map((value) => value.replace(/[^0-9X]/gi, "").toUpperCase())
      .filter(Boolean),
  );
}

function hasIdentifierOverlap(candidate: BookCandidate, context: BookSearchContext): boolean {
  const actual = identifierSet(candidate.identifiers);
  if (actual.size === 0) return false;
  const expected = identifierSet(context.identity.identifiers);
  return [...actual].some((value) => expected.has(value));
}

function titleCompatible(candidateTitle: string, context: BookSearchContext): boolean {
  const actual = normalizeText(candidateTitle);
  if (!actual) return false;

  const variants = [
    context.request.query,
    ...context.queryVariants,
    ...context.identity.titles.map((item) => item.title),
  ];

  for (const raw of variants) {
    const expected = normalizeText(raw);
    if (!expected) continue;
    if (actual === expected) return true;
    // Substring matching is useful for subtitles/edition suffixes, but very
    // short strings are too collision-prone to be safe as a relevance signal.
    if (Math.min(actual.length, expected.length) >= 3) {
      if (actual.includes(expected) || expected.includes(actual)) return true;
    }
  }
  return false;
}

function authorCompatible(candidateAuthor: string | undefined, requestedAuthor: string): boolean {
  const actual = normalizeText(candidateAuthor);
  const expected = normalizeText(requestedAuthor);
  if (!actual || !expected) return false;
  return actual === expected || actual.includes(expected) || expected.includes(actual);
}

export function isRelevantCandidate(
  candidate: BookCandidate,
  context: BookSearchContext,
): boolean {
  // Matching edition identifiers are the strongest deterministic evidence.
  if (hasIdentifierOverlap(candidate, context)) return true;

  if (!titleCompatible(candidate.title, context)) return false;

  // When the request explicitly names an author, title-only coincidence is not
  // enough. This blocks unrelated same-title books from entering ranking.
  if (context.request.author) {
    return authorCompatible(candidate.author, context.request.author);
  }

  return true;
}

export function withRelevanceGate(source: SourceAdapter): SourceAdapter {
  return {
    name: source.name,
    async search(context) {
      const candidates = await source.search(context);
      return candidates.filter((candidate) => isRelevantCandidate(candidate, context));
    },
    download(candidate, options) {
      return source.download(candidate, options);
    },
  };
}
