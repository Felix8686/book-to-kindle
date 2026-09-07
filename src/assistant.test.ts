import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "./domain";
import { decideAssistantAction, normalizeAssistantDecision } from "./assistant";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("assistant decision normalization", () => {
  it("keeps conversational replies as replies", () => {
    expect(
      normalizeAssistantDecision({
        action: "reply",
        reply: "倪匡是香港著名科幻作家。你想了解他，还是找他的作品？",
        confidence: 0.98,
      }),
    ).toEqual({
      kind: "reply",
      text: "倪匡是香港著名科幻作家。你想了解他，还是找他的作品？",
      confidence: 0.98,
    });
  });

  it("routes author work questions to a code-backed catalog action", () => {
    expect(
      normalizeAssistantDecision({
        action: "author_works",
        reply: "",
        confidence: 0.96,
        author: "倪匡",
      }),
    ).toEqual({
      kind: "author_works",
      author: "倪匡",
      text: "",
      confidence: 0.96,
    });
  });

  it("routes contextual book discussion to book metadata lookup", () => {
    expect(
      normalizeAssistantDecision({
        action: "book_info",
        reply: "",
        confidence: 0.91,
        book: { title: "蓝血人", author: "倪匡" },
      }),
    ).toEqual({
      kind: "book_info",
      request: {
        query: "蓝血人",
        author: "倪匡",
        language: undefined,
        preferredFormat: undefined,
      },
      text: "",
      confidence: 0.91,
    });
  });

  it("accepts a confident explicit book action", () => {
    expect(
      normalizeAssistantDecision({
        action: "book",
        reply: "开始处理。",
        confidence: 0.93,
        book: {
          title: "寻秦记",
          author: "黄易",
          language: "zh",
          format: "epub",
        },
      }),
    ).toEqual({
      kind: "book",
      request: {
        query: "寻秦记",
        author: "黄易",
        language: "zh",
        preferredFormat: "epub",
      },
      text: "开始处理。",
      confidence: 0.93,
    });
  });

  it("refuses a low-confidence or title-less book action", () => {
    expect(
      normalizeAssistantDecision({
        action: "book",
        reply: "你是想了解倪匡，还是找他的作品？",
        confidence: 0.42,
        book: { author: "倪匡" },
      }).kind,
    ).toBe("reply");
  });

  it("maps natural-language progress questions to the status tool", () => {
    expect(
      normalizeAssistantDecision({
        action: "status",
        reply: "我来查一下。",
        confidence: 0.91,
      }),
    ).toEqual({
      kind: "status",
      text: "我来查一下。",
      confidence: 0.91,
    });
  });

  it("preserves the Workers AI receiver when invoking run", async () => {
    const ai = {
      marker: "workers-ai-binding",
      async run(this: { marker: string }, model: string, inputs: Record<string, unknown>) {
        expect(this).toBe(ai);
        expect(this.marker).toBe("workers-ai-binding");
        expect(model).toBe("@cf/meta/llama-3.1-8b-instruct-fast");
        expect(inputs).toHaveProperty("messages");
        return {
          response: JSON.stringify({
            action: "reply",
            reply: "倪匡是香港著名作家。",
            confidence: 0.99,
          }),
        };
      },
    };

    const decision = await decideAssistantAction(
      { AI: ai } as unknown as Env,
      "倪匡",
    );

    expect(decision).toEqual({
      kind: "reply",
      text: "倪匡是香港著名作家。",
      confidence: 0.99,
    });
  });

  it("executes author recommendations from catalog data instead of model titles", async () => {
    globalThis.fetch = vi.fn(async (url: RequestInfo | URL) => {
      const value = url.toString();
      if (value.includes("openlibrary.org/search.json")) {
        return new Response(
          JSON.stringify({
            docs: [
              { title: "蓝血人", author_name: ["倪匡"], edition_count: 20 },
              { title: "神雕侠侣", author_name: ["金庸"], edition_count: 99 },
            ],
          }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ items: [] }), { status: 200 });
    }) as unknown as typeof fetch;

    const ai = {
      async run() {
        return {
          response: JSON.stringify({
            action: "author_works",
            reply: "《神雕侠侣》很值得看。",
            confidence: 0.99,
            author: "倪匡",
          }),
        };
      },
    };

    const decision = await decideAssistantAction(
      { AI: ai } as unknown as Env,
      "倪匡有哪些值得看？",
    );

    expect(decision.kind).toBe("reply");
    if (decision.kind !== "reply") throw new Error("expected reply");
    expect(decision.text).toContain("《蓝血人》");
    expect(decision.text).not.toContain("神雕侠侣");
  });
});
