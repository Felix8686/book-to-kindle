import { describe, it, expect, vi } from "vitest";
import { resolveBookSearchContext } from "./resolver";
import type { BookRequest } from "./domain";

describe("Resolver canonical work & metadata isolation", () => {
  it("isolates ISBNs between different authors for same/similar title", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (url: RequestInfo | URL) => {
      const urlStr = url.toString();
      if (urlStr.includes("openlibrary.org/search.json")) {
        return new Response(
          JSON.stringify({
            docs: [
              {
                key: "/works/OL100W",
                title: "The Republic",
                author_name: ["Plato"],
                isbn: ["1111111111", "9781111111111"],
              },
              {
                key: "/works/OL200W",
                title: "The Republic of Thieves",
                author_name: ["Scott Lynch"],
                isbn: ["2222222222", "9782222222222"],
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (urlStr.includes("/works/OL100W/editions.json")) {
        return new Response(
          JSON.stringify({
            entries: [
              {
                title: "理想国",
                languages: [{ key: "/languages/chi" }],
                isbn_10: ["3333333333"],
                isbn_13: ["9783333333333"],
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (urlStr.includes("googleapis.com/books/v1/volumes")) {
        return new Response(
          JSON.stringify({
            items: [
              {
                id: "google-rep-1",
                volumeInfo: {
                  title: "The Republic",
                  authors: ["Plato"],
                  language: "en",
                  industryIdentifiers: [{ type: "ISBN_13", identifier: "9781111111111" }],
                },
              },
              {
                id: "google-rep-unrelated",
                volumeInfo: {
                  title: "The Republic of Pirates",
                  authors: ["Colin Woodard"],
                  language: "en",
                  industryIdentifiers: [{ type: "ISBN_13", identifier: "9789999999999" }],
                },
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response("Not found", { status: 404 });
    }) as unknown as typeof fetch;

    try {
      const request: BookRequest = { query: "The Republic", author: "Plato" };
      const context = await resolveBookSearchContext(request, "zh");

      // Scott Lynch and Colin Woodard's ISBNs must NOT contaminate Plato's work
      expect(context.identity.identifiers.isbn13).toContain("9781111111111");
      expect(context.identity.identifiers.isbn13).toContain("9783333333333");
      expect(context.identity.identifiers.isbn13).not.toContain("9782222222222");
      expect(context.identity.identifiers.isbn13).not.toContain("9789999999999");

      // Canonical title should be preserved
      expect(context.identity.canonicalTitle).toBe("The Republic");

      // Translated Chinese title should be discovered in query variants
      expect(context.queryVariants).toContain("理想国");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("does not adopt an unrelated top Open Library result when no doc strictly matches", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (url: RequestInfo | URL) => {
      const urlStr = url.toString();
      if (urlStr.includes("openlibrary.org/search.json")) {
        return new Response(
          JSON.stringify({
            docs: [
              {
                key: "/works/OL999W",
                title: "An Unrelated Novel",
                author_name: ["Someone Else"],
                isbn: ["4444444444", "9784444444444"],
              },
              {
                key: "/works/OL998W",
                title: "Another Unrelated Story",
                author_name: ["Third Party"],
                isbn: ["5555555555", "9785555555555"],
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (urlStr.includes("/works/OL999W/editions.json")) {
        return new Response(
          JSON.stringify({
            entries: [
              {
                title: "无关作品的中文版",
                languages: [{ key: "/languages/chi" }],
                isbn_13: ["9787777777777"],
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({ items: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    try {
      const request: BookRequest = { query: "某本冷门中文书" };
      const context = await resolveBookSearchContext(request, "zh");

      // A top result that matches neither the title nor a supplied author must
      // not inject its ISBNs, authors or edition titles into the canonical
      // identity; otherwise an unrelated candidate can outrank the real book.
      expect(context.identity.identifiers.isbn13 ?? []).not.toContain("9784444444444");
      expect(context.identity.identifiers.isbn13 ?? []).not.toContain("9787777777777");
      expect(context.identity.authors).not.toContain("Someone Else");
      expect(context.queryVariants).not.toContain("无关作品的中文版");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("handles cross-language edition discovery for English original into Chinese", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (url: RequestInfo | URL) => {
      const urlStr = url.toString();
      if (urlStr.includes("openlibrary.org/search.json")) {
        return new Response(
          JSON.stringify({
            docs: [
              {
                key: "/works/OL456W",
                title: "Pride and Prejudice",
                author_name: ["Jane Austen"],
                isbn: ["1234567890"],
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (urlStr.includes("/works/OL456W/editions.json")) {
        return new Response(
          JSON.stringify({
            entries: [
              {
                title: "傲慢与偏见",
                languages: [{ key: "/languages/chi" }],
                isbn_13: ["9787532724697"],
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({ items: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    try {
      const request: BookRequest = { query: "Pride and Prejudice" };
      const context = await resolveBookSearchContext(request, "zh");

      expect(context.queryVariants[0]).toBe("傲慢与偏见");
      expect(context.identity.identifiers.isbn13).toContain("9787532724697");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
