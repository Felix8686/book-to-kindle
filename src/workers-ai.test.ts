import { describe, expect, it } from "vitest";
import type { Env } from "./domain";
import { createReceiverSafeAi, runWorkersAi } from "./workers-ai";

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

  it("keeps receiver semantics even when legacy code extracts run", async () => {
    const ai = {
      marker: "vision-binding",
      async run(this: { marker: string }, model: string) {
        expect(this).toBe(ai);
        expect(this.marker).toBe("vision-binding");
        return { response: model };
      },
    };

    const safeAi = createReceiverSafeAi(ai as unknown as Env["AI"]);
    const extractedRun = safeAi.run as unknown as (model: string, inputs: Record<string, unknown>) => Promise<unknown>;

    await expect(extractedRun("vision-model", {})).resolves.toEqual({ response: "vision-model" });
  });
});
