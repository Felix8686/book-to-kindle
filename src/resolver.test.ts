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
