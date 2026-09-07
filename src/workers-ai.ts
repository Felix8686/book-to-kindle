import type { Env } from "./domain";

export type WorkersAiInput = Record<string, unknown>;

const LEGACY_VISION_MODEL = "@cf/meta/llama-3.2-11b-vision-instruct";
export const CURRENT_VISION_MODEL = "@cf/qwen/qwen3.8-27b";

function extractTextContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value
    .map((part) => {
      if (!part || typeof part !== "object") return "";
      const text = (part as { text?: unknown }).text;
      return typeof text === "string" ? text : "";
    })
    .filter(Boolean)
    .join("\n");
}

function extractChatCompletionText(raw: unknown): string {
  if (!raw || typeof raw !== "object") return "";
  const choices = (raw as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return "";
  const message = choices[0] && typeof choices[0] === "object"
    ? (choices[0] as { message?: unknown }).message
    : undefined;
  if (!message || typeof message !== "object") return "";
  return extractTextContent((message as { content?: unknown }).content).trim();
}

function parseJsonish(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) return null;

  const unfenced = trimmed
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  try {
    return JSON.parse(unfenced);
  } catch {
    const start = unfenced.indexOf("{");
    const end = unfenced.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(unfenced.slice(start, end + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

function adaptLegacyVisionInput(inputs: WorkersAiInput): WorkersAiInput | null {
  const image = typeof inputs.image === "string" ? inputs.image : "";
  if (!image) return null;

  const sourceMessages = Array.isArray(inputs.messages) ? inputs.messages : [];
  const systemText = sourceMessages
    .filter((message) => message && typeof message === "object" && (message as { role?: unknown }).role === "system")
    .map((message) => extractTextContent((message as { content?: unknown }).content))
    .filter(Boolean)
    .join("\n");
  const userText = sourceMessages
    .filter((message) => message && typeof message === "object" && (message as { role?: unknown }).role === "user")
    .map((message) => extractTextContent((message as { content?: unknown }).content))
    .filter(Boolean)
    .join("\n");

  const jsonInstruction = [
    "Return only valid JSON. Do not use Markdown fences or explanatory text.",
    '{"books":[{"title":"...","author":"...","language":"...","confidence":0.0}]}',
    'If no book can be identified reliably, return {"books":[]}. Return at most 5 books.',
  ].join("\n");

  return {
    messages: [
      ...(systemText ? [{ role: "system", content: systemText }] : []),
      {
        role: "user",
        content: [
          { type: "image_url", image_url: { url: image } },
          { type: "text", text: [userText, jsonInstruction].filter(Boolean).join("\n\n") },
        ],
      },
    ],
    max_completion_tokens:
      typeof inputs.max_tokens === "number" ? inputs.max_tokens : 384,
    temperature: typeof inputs.temperature === "number" ? inputs.temperature : 0,
    reasoning_effort: "low",
  };
}

/**
 * Cloudflare's Workers AI binding exposes receiver-sensitive methods.
 * Always invoke them with the original binding object as `this`.
 *
 * Telegram's older vision call site still sends the Llama-era top-level
 * `image` payload. Translate that request at this shared boundary to the
 * current Qwen 3.8 multimodal message format, then normalize its
 * chat-completions response back to `{ response }` for the existing parser.
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

  if (model === LEGACY_VISION_MODEL) {
    const qwenInputs = adaptLegacyVisionInput(inputs);
    if (qwenInputs) {
      const raw = await run.call(ai, CURRENT_VISION_MODEL, qwenInputs);
      const text = extractChatCompletionText(raw);
      const parsed = parseJsonish(text);
      return { response: parsed ?? text };
    }
  }

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
