import { describe, expect, it } from "vitest";
import { groundAssistantRoute, type AssistantHistoryMessage } from "./assistant";

describe("assistant entity grounding", () => {
  const noHistory: AssistantHistoryMessage[] = [];

  it("keeps a bare Chinese title when the model preserves the user's text", () => {
    const result = groundAssistantRoute(
      {
        kind: "book",
        request: { query: "纳尼亚传奇", preferredFormat: "epub" },
        text: "",
        confidence: 0.96,
      },
      "纳尼亚传奇",
      noHistory,
    );

    expect(result.kind).toBe("book");
    if (result.kind === "book") expect(result.request.query).toBe("纳尼亚传奇");
  });

  it("blocks a hallucinated or glyph-corrupted title from becoming a task", () => {
    const result = groundAssistantRoute(
      {
        kind: "book",
        request: { query: "纽里亚主事书", preferredFormat: "epub" },
        text: "",
        confidence: 0.97,
      },
      "纳尼亚传奇",
      noHistory,
    );

    expect(result.kind).toBe("reply");
    if (result.kind === "reply") {
      expect(result.text).toContain("没有足够依据");
      expect(result.confidence).toBe(0);
    }
  });

  it("allows a contextual second-book title only when it exists in recent history", () => {
    const history: AssistantHistoryMessage[] = [
      {
        role: "assistant",
        content: "1. 《钻石花》\n2. 《蓝血人》\n3. 《地底奇人》",
      },
    ];

    const result = groundAssistantRoute(
      {
        kind: "book",
        request: { query: "蓝血人", author: "倪匡" },
        text: "",
        confidence: 0.93,
      },
      "第二本发到 Kindle",
      history,
    );

    expect(result.kind).toBe("book");
    if (result.kind === "book") {
      expect(result.request.query).toBe("蓝血人");
      // The title is grounded; an ungrounded author is removed rather than poisoning search.
      expect(result.request.author).toBeUndefined();
    }
  });

  it("blocks a contextual title that does not exist in recent history", () => {
    const history: AssistantHistoryMessage[] = [
      {
        role: "assistant",
        content: "1. 《钻石花》\n2. 《蓝血人》\n3. 《地底奇人》",
      },
    ];

    const result = groundAssistantRoute(
      {
        kind: "book_info",
        request: { query: "透明光" },
        text: "",
        confidence: 0.91,
      },
      "第二本怎么样？",
      history,
    );

    expect(result.kind).toBe("reply");
  });

  it("blocks an author entity invented by the model", () => {
    const result = groundAssistantRoute(
      {
        kind: "author_works",
        author: "倪框",
        text: "",
        confidence: 0.94,
      },
      "倪匡有哪些值得看？",
      noHistory,
    );

    expect(result.kind).toBe("reply");
  });
});
