import type { Env } from "./domain";

export type WorkersAiInput = Record<string, unknown>;

/**
 * Cloudflare's Workers AI binding exposes a receiver-sensitive `run` method.
 * Always invoke it with the binding object as `this`; extracting `env.AI.run`
 * and calling it as a bare function breaks internal private state.
 */
export async function runWorkersAi(
  ai: Env["AI"],
  model: string,
  inputs: WorkersAiInput,
): Promise<unknown> {
  const run = ai.run as unknown as (
    this: Env["AI"],
    model: string,
    inputs: WorkersAiInput,
  ) => Promise<unknown>;

  return run.call(ai, model, inputs);
}
