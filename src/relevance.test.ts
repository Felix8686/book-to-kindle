import { describe, expect, it } from "vitest";
import type { BookCandidate, BookSearchContext } from "./domain";
import { isRelevantCandidate } from "./relevance";

const context: BookSearchContext = {
  request: { query: "The Great Gatsby", author: "F. Scott Fitzgerald" },
  preferredLanguage: "zh",
  identity: {
    canonicalTitle: "The Great Gatsby",
    authors: ["F. Scott Fitzgerald"],
    titles: [
      { title: "The Great Gatsby", language: "en", source: "openlibrary" },
      { title: "了不起的盖茨比", language: "zh", source: "openlibrary" },
    ],
    identifiers: { isbn13: ["9780743273565"] },
  },
  queryVariants: ["了不起的盖茨比", "The Great Gatsby"],
};

function candidate(overrides: Partial<BookCandidate>): BookCandidate {
  return {
    id: "candidate",
    title: "The Great Gatsby",
    author: "F. Scott Fitzgerald",
    language: "en",
    format: "epub",
    source: "test",
    sourceRef: "test",
    ...overrides,
  };
}

describe("candidate relevance gate", () => {
  it("accepts a translated title variant with the requested author", () => {
    expect(
      isRelevantCandidate(
        candidate({ title: "了不起的盖茨比", author: "F. Scott Fitzgerald" }),
        context,
      ),
    ).toBe(true);
  });

  it("rejects an unrelated title even when a source returns it", () => {
    expect(
      isRelevantCandidate(candidate({ title: "Tender Is the Night" }), context),
    ).toBe(false);
  });

  it("rejects a same-title candidate by the wrong author", () => {
    expect(
      isRelevantCandidate(candidate({ author: "Someone Else" }), context),
    ).toBe(false);
  });

  it("accepts exact ISBN overlap as strongest identity evidence", () => {
    expect(
      isRelevantCandidate(
        candidate({
          title: "Completely Different Display Title",
          author: "Another Display Name",
          identifiers: { isbn13: ["9780743273565"] },
        }),
        context,
      ),
    ).toBe(true);
  });

  it("accepts a bibliographic family-name-first author ordering", () => {
    const austenContext: BookSearchContext = {
      request: { query: "Pride and Prejudice", author: "Jane Austen" },
      preferredLanguage: "en",
      identity: {
        canonicalTitle: "Pride and Prejudice",
        authors: ["Jane Austen"],
        titles: [{ title: "Pride and Prejudice", language: "en", source: "openlibrary" }],
        identifiers: {},
      },
      queryVariants: ["Pride and Prejudice"],
    };

    expect(
      isRelevantCandidate(
        candidate({ title: "Pride and Prejudice", author: "Austen, Jane" }),
        austenContext,
      ),
    ).toBe(true);
  });
});