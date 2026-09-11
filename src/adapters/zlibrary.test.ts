import { afterEach, describe, expect, it, vi } from "vitest";
import { isRelevantZLibraryResult, ZLibrarySource } from "./zlibrary";
import type { BookCandidate, BookSearchContext, Env } from "../domain";

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

describe("ZLibrary download credential scoping", () => {
  const candidate: BookCandidate = {
    id: "zlibrary:123:abc:epub",
    title: "Brian",
    author: "Jeremy Cooper",
    format: "epub",
    source: "zlibrary",
    sourceRef: JSON.stringify({ bookId: 123, hash: "abc", extension: "epub" }),
  };

  function stubDownloadFetch(downloadLink: string, downloadHeaders: Headers[]) {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/eapi/user/profile")) {
        return new Response(JSON.stringify({ success: true, user: {} }), { status: 200 });
      }
      if (url.endsWith("/eapi/book/123/abc/file")) {
        return new Response(
          JSON.stringify({ success: true, file: { downloadLink, extension: "epub" } }),
          { status: 200 },
        );
      }
      if (url === downloadLink) {
        downloadHeaders.push(new Headers(init?.headers));
        return new Response(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00]), { status: 200 });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
  }

  function env(): Env {
    return {
      ZLIBRARY_REMIX_USERID: "1",
      ZLIBRARY_REMIX_USERKEY: "secret-key",
      ZLIBRARY_DOMAIN: "https://z-lib.gd",
    } as Env;
  }

  it("does not send session credentials to a signed CDN download link", async () => {
    const downloadHeaders: Headers[] = [];
    stubDownloadFetch("https://cdn-files.example.com/dl/signed-token.epub", downloadHeaders);

    const result = await ZLibrarySource.create(env()).download(candidate, { maxBytes: 1024 });
    await result.body.cancel();

    expect(downloadHeaders).toHaveLength(1);
    expect(downloadHeaders[0]?.get("cookie")).toBeNull();
    expect(downloadHeaders[0]?.get("remix-userid")).toBeNull();
    expect(downloadHeaders[0]?.get("remix-userkey")).toBeNull();
  });

  it("still authenticates downloads routed through the account's own domain", async () => {
    const downloadHeaders: Headers[] = [];
    stubDownloadFetch("https://z-lib.gd/dtoken/some-token", downloadHeaders);

    const result = await ZLibrarySource.create(env()).download(candidate, { maxBytes: 1024 });
    await result.body.cancel();

    expect(downloadHeaders).toHaveLength(1);
    expect(downloadHeaders[0]?.get("remix-userkey")).toBe("secret-key");
  });
});
