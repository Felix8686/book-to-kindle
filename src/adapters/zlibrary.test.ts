import { afterEach, describe, expect, it, vi } from "vitest";
import { isRelevantZLibraryResult, ZLibrarySource } from "./zlibrary";
import type { BookSearchContext, Env } from "../domain";

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

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ZLibrary result relevance", () => {
  it("rejects unrelated popular results returned for a missed search", () => {
    expect(isRelevantZLibraryResult({ title: "明朝那些事儿", author: "当年明月" }, context)).toBe(false);
  });

  it("accepts the requested title and author", () => {
    expect(isRelevantZLibraryResult({ title: "Brian", author: "Jeremy Cooper" }, context)).toBe(true);
  });
});

describe("ZLibrary eapi search compatibility", () => {
  it("uses form encoding and always searches the user's raw title first", async () => {
    const searchBodies: URLSearchParams[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);

      if (url.endsWith("/eapi/user/profile")) {
        return new Response(JSON.stringify({ success: true, user: {} }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }

      if (url.endsWith("/eapi/book/search")) {
        const headers = new Headers(init?.headers);
        expect(headers.get("content-type")).toBe("application/x-www-form-urlencoded");
        const body = new URLSearchParams(String(init?.body ?? ""));
        searchBodies.push(body);

        const books = body.get("message") === "毛泽东私人医生回忆录"
          ? [{
              id: 123,
              hash: "abc",
              title: "毛泽东私人医生回忆录 = THE PRIVATE LIFE OF CHAIRMAN MAO",
              author: "李志绥",
              lang: "Chinese",
              extension: "epub",
              filesize: 1024,
            }]
          : [];

        return new Response(JSON.stringify({ success: true, books }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }

      throw new Error(`Unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const chineseContext: BookSearchContext = {
      request: { query: "毛泽东私人医生回忆录" },
      queryVariants: ["错误的解析标题一", "错误的解析标题二", "毛泽东私人医生回忆录"],
      preferredLanguage: "zh",
      identity: {
        canonicalTitle: "毛泽东私人医生回忆录",
        authors: [],
        identifiers: {},
        titles: [{ title: "毛泽东私人医生回忆录", language: "zh", source: "request" }],
      },
    };

    const source = ZLibrarySource.create({
      ZLIBRARY_REMIX_USERID: "1",
      ZLIBRARY_REMIX_USERKEY: "key",
      ZLIBRARY_DOMAIN: "https://z-lib.gd",
    } as Env);

    const candidates = await source.search(chineseContext);

    expect(searchBodies[0]?.get("message")).toBe("毛泽东私人医生回忆录");
    expect(searchBodies[0]?.getAll("extensions[]")).toEqual(["EPUB", "PDF"]);
    expect(searchBodies[0]?.has("languages[]")).toBe(false);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.title).toContain("毛泽东私人医生回忆录");
  });

  it("maps ISO language codes to ZLibrary language values", async () => {
    let englishSearchBody: URLSearchParams | undefined;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/eapi/user/profile")) {
        return new Response(JSON.stringify({ success: true, user: {} }), { status: 200 });
      }
      if (url.endsWith("/eapi/book/search")) {
        englishSearchBody = new URLSearchParams(String(init?.body ?? ""));
        return new Response(JSON.stringify({ success: true, books: [] }), { status: 200 });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const source = ZLibrarySource.create({
      ZLIBRARY_REMIX_USERID: "1",
      ZLIBRARY_REMIX_USERKEY: "key",
      ZLIBRARY_DOMAIN: "https://z-lib.gd",
    } as Env);

    await source.search(context);
    expect(englishSearchBody?.get("languages[]")).toBe("english");
  });
});
