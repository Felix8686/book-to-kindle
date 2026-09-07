import { describe, expect, it } from "vitest";
import type { Env } from "./domain";
import { runWorkersAi } from "./workers-ai";

describe("Workers AI invocation", () => {
  it("always preserves the binding as the run receiver", async () => {
    const ai = {
      marker: "workers-ai-binding",
      async run(this: { marker: string }, model: string, inputs: Record<string, unknown>) {
        expect(this).toBe(ai);
        expect(this.marker).toBe("workers-ai-binding");
        expect(model).toBe("test-model");
        expect(inputs).toEqual({ messages: [] });
        return { response: "ok" };
      },
    };

    await expect(
      runWorkersAi(ai as unknown as Env["AI"], "test-model", { messages: [] }),
    ).resolves.toEqual({ response: "ok" });
  });
});
