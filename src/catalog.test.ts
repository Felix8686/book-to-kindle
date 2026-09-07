import { afterEach, describe, expect, it, vi } from "vitest";
import {
  formatAuthorWorksReply,
  lookupAuthorWorks,
  lookupBookInfo,
} from "./catalog";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("catalog tools", () => {
  it("filters unrelated works instead of trusting model memory", async () => {
    globalThis.fetch = vi.fn(async (url: RequestInfo | URL) => {
      const value = url.toString();
      if (value.includes("openlibrary.org/search.json")) {
        return new Response(
          JSON.stringify({
            docs: [
              {
                title: "蓝血人",
                author_name: ["倪匡"],
                first_publish_year: 1964,
                edition_count: 30,
              },
              {
                title: "神雕侠侣",
                author_name: ["金庸"],
                first_publish_year: 1959,
                edition_count: 100,
              },
            ],
          }),
          { status: 200 },
        );
      }

      if (value.includes("googleapis.com/books/v1/volumes")) {
        return new Response(
          JSON.stringify({
            items: [
              { volumeInfo: { title: "蓝血人", authors: ["倪匡"] } },
              { volumeInfo: { title: "东方不败", authors: ["金庸"] } },
            ],
          }),
          { status: 200 },
        );
      }

      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;

    const works = await lookupAuthorWorks("倪匡", 8);

    expect(works.map((work) => work.title)).toEqual(["蓝血人"]);
    expect(works[0].sources).toEqual(expect.arrayContaining(["openlibrary", "google-books"]));
    const reply = formatAuthorWorksReply("倪匡", works);
    expect(reply).toContain("1. 《蓝血人》");
    expect(reply).not.toContain("神雕侠侣");
    expect(reply).not.toContain("东方不败");
  });

  it("returns book metadata only when title and requested author are compatible", async () => {
    globalThis.fetch = vi.fn(async (url: RequestInfo | URL) => {
      const value = url.toString();
      if (value.includes("googleapis.com/books/v1/volumes")) {
        return new Response(
          JSON.stringify({
            items: [
              {
                volumeInfo: {
                  title: "蓝血人",
                  authors: ["倪匡"],
                  publishedDate: "1964",
                  publisher: "Test Publisher",
                  description: "<p>卫斯理系列作品。</p>",
                  categories: ["Fiction"],
                },
              },
            ],
          }),
          { status: 200 },
        );
      }

      if (value.includes("openlibrary.org/search.json")) {
        return new Response(
          JSON.stringify({
            docs: [
              {
                title: "蓝血人",
                author_name: ["倪匡"],
                first_publish_year: 1964,
              },
            ],
          }),
          { status: 200 },
        );
      }

      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;

    const info = await lookupBookInfo("蓝血人", "倪匡");
    expect(info?.title).toBe("蓝血人");
    expect(info?.authors).toContain("倪匡");
    expect(info?.description).toBe("卫斯理系列作品。");
    expect(info?.sources).toEqual(expect.arrayContaining(["google-books", "openlibrary"]));
  });
});
