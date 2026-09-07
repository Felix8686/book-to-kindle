import { describe, expect, it } from "vitest";
import type { Env } from "./domain";
import { recognizeBooksFromImage } from "./telegram";

describe("Telegram vision invocation", () => {
  it("preserves the Workers AI receiver at the Telegram image call site", async () => {
    const ai = {
      marker: "telegram-vision-binding",
      async run(
        this: { marker: string },
        model: string,
        inputs: Record<string, unknown>,
      ) {
        expect(this).toBe(ai);
        expect(this.marker).toBe("telegram-vision-binding");
        expect(model).toBe("@cf/meta/llama-3.2-11b-vision-instruct");
        expect(inputs.image).toEqual(expect.stringMatching(/^data:image\/jpeg;base64,/));
        return {
          response: JSON.stringify({
            books: [
              {
                title: "1984",
                author: "George Orwell",
                language: "en",
                confidence: 0.99,
              },
            ],
          }),
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
