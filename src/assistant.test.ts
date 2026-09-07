import { describe, expect, it } from "vitest";
import type { Env } from "./domain";
import { decideAssistantAction, normalizeAssistantDecision } from "./assistant";

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
});
