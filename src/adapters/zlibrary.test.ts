import { describe, expect, it } from "vitest";
import { isRelevantZLibraryResult } from "./zlibrary";
import type { BookSearchContext } from "../domain";

const context: BookSearchContext = {
  request: { query: "Brian", author: "Jeremy Cooper", preferredFormat: "epub" },
  queryVariants: ["Brian"],
  preferredLanguage: "en",
  identity: {
    canonicalTitle: "Brian",
    authors: ["Jeremy Cooper"],
    identifiers: {},
    titles: [{ title: "Brian", language: "en", source: "request" }],
  },
};

describe("ZLibrary result relevance", () => {
  it("rejects unrelated popular results returned for a missed search", () => {
    expect(isRelevantZLibraryResult({ title: "明朝那些事儿", author: "当年明月" }, context)).toBe(false);
  });

  it("accepts the requested title and author", () => {
    expect(isRelevantZLibraryResult({ title: "Brian", author: "Jeremy Cooper" }, context)).toBe(true);
  });
});
