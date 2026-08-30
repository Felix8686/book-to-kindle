import { describe, expect, it } from "vitest";
import { parseTelegramBookRequest } from "./telegram";

describe("Telegram book request parsing", () => {
  it("removes author, format, and leftover mixed punctuation from an unquoted title", () => {
    expect(parseTelegramBookRequest("Brian，作者 Jeremy Cooper，epub")).toEqual({
      query: "Brian",
      author: "Jeremy Cooper",
      language: undefined,
      preferredFormat: "epub",
    });
  });
});
