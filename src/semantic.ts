import type { Env } from "./domain";
import { normalizeBookLanguage } from "./settings";

// Architectural boundary (docs/ARCHITECTURE.md §3): free-form user text is a
// semantic understanding problem owned by the AI model. This layer converts
// one message into structured intent; everything downstream (routing, task
// creation, catalog queries, verification, ordering) stays deterministic code.
// Never grow this file into keyword/regex intent matching.

export const DEFAULT_SEMANTIC_TEXT_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast" as const;

export type TextIntent = "find_book" | "author_works" | "send_book" | "unknown";

export interface SemanticParseResult {
  intent: TextIntent;
  title?: string;
  author?: string;
  language?: string;
  preferredFormat?: "epub" | "pdf";
  confidence: number;
}

export function semanticTextModel(env: Env): string {
  const configured = env.SEMANTIC_TEXT_MODEL?.trim();
  return configured || DEFAULT_SEMANTIC_TEXT_MODEL;
}

export function isSemanticParsingConfigured(env: Env): boolean {
  return Boolean(env.AI);
}

const INTENTS: readonly TextIntent[] = ["find_book", "author_works", "send_book", "unknown"];

function cleanField(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const cleaned = value.replace(/\s+/g, " ").trim().slice(0, maxLength);
  return cleaned || undefined;
}

export function normalizeSemanticParse(value: unknown): SemanticParseResult {
  const raw = (value ?? {}) as Record<string, unknown>;
  const intent = INTENTS.includes(raw.intent as TextIntent) ? (raw.intent as TextIntent) : "unknown";
  const confidenceRaw = typeof raw.confidence === "number" ? raw.confidence : 0;
  const confidence = Math.min(Math.max(confidenceRaw, 0), 1);
  const title = cleanField(raw.title, 200);
  const author = cleanField(raw.author, 200);
  const preferredFormat = raw.preferredFormat === "pdf" ? "pdf" : raw.preferredFormat === "epub" ? "epub" : undefined;

  if (intent === "author_works" && !author) return { intent: "unknown", confidence };
  if ((intent === "find_book" || intent === "send_book") && !title) return { intent: "unknown", confidence };

  return {
    intent,
    ...(title ? { title } : {}),
    ...(author ? { author } : {}),
    language: normalizeBookLanguage(cleanField(raw.language, 30)),
    ...(preferredFormat ? { preferredFormat } : {}),
    confidence,
  };
}

const PARSE_PROMPT = [
  "Classify what the user wants and extract the relevant bibliographic entities.",
  "intent meanings:",
  '- "send_book": the user wants one specific book delivered/sent (to their Kindle).',
  '- "find_book": the user is looking for one specific book (no delivery wording).',
  '- "author_works": the user asks which works/books/novels an author has written — the author is the subject, not a specific title.',
  '- "unknown": anything else (recommendations, chit-chat, questions not about a specific book or author).',
  "Rules:",
  "- For send_book/find_book put the book title in \"title\" and the author in \"author\" only if stated.",
  "- For author_works put the person's name in \"author\" and never fill \"title\".",
  "- Never guess an entity that the user did not mention. Use null for missing fields.",
  "- \"language\" is only the user's explicitly requested language, as an ISO 639-1 code.",
  "- Respond in the JSON schema only.",
].join("\n");

export async function parseTextSemantics(env: Env, text: string): Promise<SemanticParseResult> {
  // Cloudflare supports JSON Mode for this model; the generated Workers
  // TypeScript declarations lag that documented field (same bridge as vision).
  // The method must keep its `this` binding: workerd's Ai class reads call
  // configuration from private fields, and a detached `env.AI.run` reference
  // fails with "Cannot set properties of undefined (setting '#options')".
  const runModel = env.AI.run.bind(env.AI) as unknown as (
    model: string,
    inputs: Record<string, unknown>,
  ) => Promise<unknown>;

  const raw = await runModel(semanticTextModel(env), {
    messages: [
      {
        role: "system",
        content:
          "You map a user's chat message about books into structured intent JSON. The user may write in Chinese, English, or any language. Be conservative: if the request does not clearly fit, use intent \"unknown\".",
      },
      { role: "user", content: `${PARSE_PROMPT}\n\nUser message: ${text.slice(0, 500)}` },
    ],
    max_tokens: 256,
    temperature: 0,
    response_format: {
      type: "json_schema",
      json_schema: {
        type: "object",
        properties: {
          intent: { type: "string", enum: ["find_book", "author_works", "send_book", "unknown"] },
          title: { type: ["string", "null"] },
          author: { type: ["string", "null"] },
          language: { type: ["string", "null"] },
          preferredFormat: { type: ["string", "null"], enum: ["epub", "pdf", null] },
          confidence: { type: "number" },
        },
        required: ["intent", "confidence"],
      },
    },
  });

  const response = (raw as { response?: unknown }).response;
  if (typeof response === "string") {
    try {
      return normalizeSemanticParse(JSON.parse(response));
    } catch {
      return { intent: "unknown", confidence: 0 };
    }
  }
  return normalizeSemanticParse(response);
}
