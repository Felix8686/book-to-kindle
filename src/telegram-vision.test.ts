import { describe, expect, it } from "vitest";
import type { Env } from "./domain";
import { recognizeBooksFromImage } from "./telegram";

describe("Telegram vision invocation", () => {
  it("uses Qwen 3.8 multimodal input while preserving the Workers AI receiver", async () => {
    const ai = {
      marker: "telegram-vision-binding",
      async run(
        this: { marker: string },
        model: string,
        inputs: Record<string, unknown>,
      ) {
        expect(this).toBe(ai);
        expect(this.marker).toBe("telegram-vision-binding");
        expect(model).toBe("@cf/qwen/qwen3.8-27b");

        const messages = inputs.messages as Array<Record<string, unknown>>;
        const user = messages.find((message) => message.role === "user");
        const content = user?.content as Array<Record<string, unknown>>;
        const imagePart = content.find((part) => part.type === "image_url");
        expect(imagePart).toEqual({
          type: "image_url",
          image_url: {
            url: expect.stringMatching(/^data:image\/jpeg;base64,/),
          },
        });
        expect(inputs).not.toHaveProperty("response_format");

        return {
          choices: [
            {
              message: {
                role: "assistant",
                content: "```json\n{\"books\":[{\"title\":\"1984\",\"author\":\"George Orwell\",\"language\":\"en\",\"confidence\":0.99}]}\n```",
              },
            },
          ],
        };
      },
    };

    const env = { AI: ai } as unknown as Env;
    const books = await recognizeBooksFromImage(
      env,
      new Uint8Array([0xff, 0xd8, 0xff]),
      "image/jpeg",
    );

    expect(books).toEqual([
      {
        title: "1984",
        author: "George Orwell",
        language: "en",
        confidence: 0.99,
      },
    ]);
  });
});
