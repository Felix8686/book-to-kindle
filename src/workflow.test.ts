import { describe, expect, it } from "vitest";
import { candidateScore, candidateDedupKey } from "./workflow";
import { BookCandidate, BookSearchContext, TaskRecord } from "./domain";

describe("Workflow Ranking & Deduplication", () => {
  const task: TaskRecord = {
    id: "task-1",
    status: "searching",
    request: { query: "The Great Gatsby" },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  const context: BookSearchContext = {
    request: { query: "The Great Gatsby" },
    preferredLanguage: "zh",
    identity: {
      canonicalTitle: "The Great Gatsby",
      authors: ["F. Scott Fitzgerald"],
      titles: [
        { title: "The Great Gatsby", language: "en", source: "openlibrary" },
        { title: "了不起的盖茨比", language: "zh", source: "openlibrary" },
      ],
      identifiers: { isbn13: ["9787532725695"] },
    },
    queryVariants: ["The Great Gatsby", "了不起的盖茨比"],
  };

  it("scores preferred language candidates higher", () => {
    const zhCandidate: BookCandidate = {
      id: "zh-1",
      title: "了不起的盖茨比",
      author: "F. Scott Fitzgerald",
      language: "zh",
      format: "epub",
      source: "zlibrary",
      sourceRef: "12345",
      identifiers: { isbn13: ["9787532725695"] },
    };

    const enCandidate: BookCandidate = {
      id: "en-1",
      title: "The Great Gatsby",
      author: "F. Scott Fitzgerald",
      language: "en",
      format: "epub",
      source: "gutendex",
      sourceRef: "64317",
    };

    const scoreZh = candidateScore(zhCandidate, task, context);
    const scoreEn = candidateScore(enCandidate, task, context);

    expect(scoreZh).toBeGreaterThan(scoreEn);
  });

  it("deduplicates identical editions across sources while keeping distinct ones", () => {
    const candidate1: BookCandidate = {
      id: "1",
      title: "The Great Gatsby",
      author: "F. Scott Fitzgerald",
      language: "en",
      format: "epub",
      source: "gutendex",
      sourceRef: "1",
      identifiers: { isbn13: ["9780743273565"] },
    };

    const candidate2: BookCandidate = {
      id: "2",
      title: "The Great Gatsby",
      author: "F. Scott Fitzgerald",
      language: "en",
      format: "epub",
      source: "internet-archive-public",
      sourceRef: "ia-1",
      identifiers: { isbn13: ["9780743273565"] },
    };

    const candidate3: BookCandidate = {
      id: "3",
      title: "The Great Gatsby (Annotated)",
      author: "F. Scott Fitzgerald",
      language: "en",
      format: "epub",
      source: "zlibrary",
      sourceRef: "zl-1",
      identifiers: { isbn13: ["9780141182636"] },
    };

    const key1 = candidateDedupKey(candidate1);
    const key2 = candidateDedupKey(candidate2);
    const key3 = candidateDedupKey(candidate3);

    expect(key1).toBe(key2);
    expect(key1).not.toBe(key3);
  });
});
