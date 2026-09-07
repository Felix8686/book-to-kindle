import type { Env } from "./domain";

export type WorkersAiInput = Record<string, unknown>;

/**
 * Cloudflare's Workers AI binding exposes receiver-sensitive methods.
 * Always invoke them with the original binding object as `this`.
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

/**
 * Compatibility wrapper for legacy code that still extracts methods such as
 * `const run = env.AI.run`. Every function read from this proxy is bound back
 * to the original Workers AI binding, preventing receiver/private-field loss.
 */
export function createReceiverSafeAi(ai: Env["AI"]): Env["AI"] {
  const functionCache = new Map<PropertyKey, unknown>();

  return new Proxy(ai as unknown as object, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (typeof value !== "function") return value;
      if (functionCache.has(property)) return functionCache.get(property);
      const bound = value.bind(target);
      functionCache.set(property, bound);
      return bound;
    },
  }) as unknown as Env["AI"];
}
