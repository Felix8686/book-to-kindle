import { afterEach, describe, expect, it, vi } from "vitest";
import { hasStructuredRequestMarkers, parseTelegramBookRequest, processTelegramSemanticText } from "./telegram";
import { isSemanticParsingConfigured, normalizeSemanticParse, parseTextSemantics } from "./semantic";
import { queryAuthorWorks } from "./catalog";
import type { Env } from "./domain";

function fakeEnv(overrides: Partial<Env> = {}): Env {
  return {
    TELEGRAM_BOT_TOKEN: "test-token",
    TELEGRAM_ALLOWED_USER_IDS: "777",
    ...overrides,
  } as unknown as Env;
}

function aiReturning(payload: unknown): Env["AI"] {
  return {
    run: vi.fn(async () => ({ response: JSON.stringify(payload) })),
  } as unknown as Env["AI"];
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Semantic text parsing (AI layer)", () => {
  it("maps an author works question to intent=author_works with the author entity", async () => {
    const env = fakeEnv({ AI: aiReturning({ intent: "author_works", author: "金庸", confidence: 0.9 }) });
    const result = await parseTextSemantics(env, "金庸有哪些出名的作品");
    expect(result.intent).toBe("author_works");
    expect(result.author).toBe("金庸");
    expect(result.title).toBeUndefined();
  });

  it("maps another author works question without any keyword rules", async () => {
    const env = fakeEnv({ AI: aiReturning({ intent: "author_works", author: "倪匡", confidence: 0.9 }) });
    const result = await parseTextSemantics(env, "倪匡有哪些出名的作品");
    expect(result.intent).toBe("author_works");
    expect(result.author).toBe("倪匡");
  });

  it("maps a third phrasing of the same intent", async () => {
    const env = fakeEnv({ AI: aiReturning({ intent: "author_works", author: "东野圭吾", confidence: 0.88 }) });
    const result = await parseTextSemantics(env, "东野圭吾写过哪些小说");
    expect(result.intent).toBe("author_works");
    expect(result.author).toBe("东野圭吾");
  });

  it("keeps send_book intent with the extracted title", async () => {
    const env = fakeEnv({ AI: aiReturning({ intent: "send_book", title: "天龙八部", confidence: 0.95 }) });
    const result = await parseTextSemantics(env, "把《天龙八部》发到 Kindle");
    expect(result.intent).toBe("send_book");
    expect(result.title).toBe("天龙八部");
  });

  it("downgrades incomplete model output to unknown instead of guessing", () => {
    expect(normalizeSemanticParse({ intent: "author_works", author: "  ", confidence: 0.9 }).intent).toBe("unknown");
    expect(normalizeSemanticParse({ intent: "send_book", confidence: 0.9 }).intent).toBe("unknown");
    expect(normalizeSemanticParse({ intent: "delete_everything" }).intent).toBe("unknown");
  });

  it("reports whether the AI semantic layer is available", () => {
    expect(isSemanticParsingConfigured(fakeEnv({ AI: aiReturning({}) }))).toBe(true);
    expect(isSemanticParsingConfigured(fakeEnv())).toBe(false);
  });
});

describe("Deterministic entry gating", () => {
  it("routes explicit structured input to code without a model call", () => {
    expect(hasStructuredRequestMarkers("把《天龙八部》发到 Kindle")).toBe(true);
    expect(hasStructuredRequestMarkers("/send 天龙八部")).toBe(true);
    expect(hasStructuredRequestMarkers("天龙八部 中文 epub")).toBe(true);
    expect(hasStructuredRequestMarkers(" Brian，作者 Jeremy Cooper，epub")).toBe(true);
    expect(parseTelegramBookRequest("把《天龙八部》发到 Kindle")?.query).toBe("天龙八部");
    expect(parseTelegramBookRequest("天龙八部 中文 epub")?.language).toBe("zh");
  });

  it("leaves free-form natural language to the semantic layer", () => {
    expect(hasStructuredRequestMarkers("金庸有哪些出名的作品")).toBe(false);
    expect(hasStructuredRequestMarkers("天龙八部")).toBe(false);
  });
});

describe("Author works catalog verification", () => {
  const AUTHORS_JSON = JSON.stringify({
    docs: [{ key: "/authors/OL1A", name: "Jin Yong", alternate_names: ["金庸", "Louis Cha"] }],
  });
  // A book whose title merely contains the author name must never appear.
  const WORKS_JSON = JSON.stringify({
    docs: [
      { key: "/works/OLW2", title: "The Return of the Condor Heroes", author_key: ["/authors/OL1A"], edition_count: 12, first_publish_year: 1959 },
      { key: "/works/OLW1", title: "射雕英雄传", author_key: ["/authors/OL1A"], edition_count: 40, first_publish_year: 1957 },
      { key: "/works/OLW3", title: "名人名家读金庸", author_key: ["/authors/OL99A"], edition_count: 999, first_publish_year: 2001 },
    ],
  });

  function stubOpenLibrary() {
    return vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("openlibrary.org/search/authors.json")) return new Response(AUTHORS_JSON, { status: 200 });
      if (url.includes("openlibrary.org/search.json")) return new Response(WORKS_JSON, { status: 200 });
      throw new Error(`Unexpected fetch: ${url}`);
    }) as unknown as typeof fetch;
  }

  it("only returns works verified against the author entity, ordered by edition count", async () => {
    const works = await queryAuthorWorks("金庸", stubOpenLibrary());
    expect(works.map((work) => work.title)).toEqual(["射雕英雄传", "The Return of the Condor Heroes"]);
    expect(works.some((work) => work.title.includes("金庸"))).toBe(false);
  });

  it("sends a verified catalog reply for an author works question", async () => {
    const sent: Array<Record<string, unknown>> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("openlibrary.org")) return stubOpenLibrary()(input);
      if (url.includes("api.telegram.org")) {
        sent.push(JSON.parse(String(init?.body ?? "{}")));
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }));

    const env = fakeEnv({ AI: aiReturning({ intent: "author_works", author: "金庸", confidence: 0.9 }) });
    await processTelegramSemanticText(
      { kind: "telegram_text_semantic", chatId: "555", userId: "777", sourceMessageId: 1, text: "金庸有哪些出名的作品" },
      env,
    );

    expect(sent).toHaveLength(1);
    const text = String(sent[0]?.text);
    expect(text).toContain("射雕英雄传");
    expect(text).not.toContain("名人名家读金庸");
  });

  it("asks for clarification when the intent is unknown", async () => {
    const sent: Array<Record<string, unknown>> = [];
    vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      sent.push(JSON.parse(String(init?.body ?? "{}")));
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }));

    const env = fakeEnv({ AI: aiReturning({ intent: "unknown", confidence: 0.4 }) });
    await processTelegramSemanticText(
      { kind: "telegram_text_semantic", chatId: "555", userId: "777", sourceMessageId: 2, text: "今天天气怎么样" },
      env,
    );

    expect(sent).toHaveLength(1);
    expect(String(sent[0]?.text)).toContain("没太理解");
  });
});
