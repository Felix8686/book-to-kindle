import type { BookRequest, Env } from "./domain";

export const DEFAULT_ASSISTANT_MODEL = "@cf/meta/llama-3.1-8b-instruct-fast" as const;
const DEFAULT_HISTORY_LIMIT = 8;
const MAX_HISTORY_LIMIT = 12;
const MAX_HISTORY_CONTENT_CHARS = 1600;
const MAX_REPLY_CHARS = 3500;

export interface AssistantHistoryMessage {
  role: "user" | "assistant";
  content: string;
}

export type AssistantDecision =
  | {
      kind: "reply";
      text: string;
      confidence: number;
    }
  | {
      kind: "book";
      request: BookRequest;
      text: string;
      confidence: number;
    }
  | {
      kind: "status";
      text: string;
      confidence: number;
    };

const SYSTEM_PROMPT = [
  "你是 Book to Kindle 的电子书阅读助手，同时负责决定是否调用系统工具。",
  "用户可以像和正常助手聊天一样输入任意自然语言；绝不能把所有文字默认当作书名。",
  "你可以讨论作者、作品、系列、阅读顺序、推荐、书籍内容，也可以处理闲聊式或含糊输入。",
  "",
  "你只能选择三种动作：",
  "1. reply：正常回复用户，不创建任何 Kindle 任务。",
  "2. book：只有当你确认用户要获取/查找并发送一本明确的书到 Kindle 时使用。",
  "3. status：用户询问最近一次 Kindle 任务的进度、结果或是否发送成功时使用。",
  "",
  "关键规则：",
  "- 人名、作者名、流派名、系列名、主题词、普通问句都不是书名任务。比如用户只发‘倪匡’，必须 reply，不能 book。",
  "- 不确定用户是在讨论一本书还是要发送它时，必须 reply 并自然追问，不能擅自创建任务。",
  "- 如果用户只输入一个你高度确定是具体书名的短语，可以结合最近对话判断；仍有歧义就 reply。",
  "- 用户明确说‘发到 Kindle’、‘帮我找这本书并发送’、‘把第二本发过去’等，且能从当前消息或历史中确定书名时，使用 book。",
  "- 对‘第二本’、‘刚才那本’、‘作者的第一本’等指代，要利用最近对话解析；无法可靠确定时 reply 追问。",
  "- book 动作里的 title 必须是你能从用户消息或历史中可靠确定的具体书名，禁止编造。",
  "- reply 要直接回答用户，不要解释你的内部分类或工具机制。默认使用用户当前消息的语言。",
  "",
  "输出必须是 JSON，并严格符合给定 schema。",
].join("\n");

function clampConfidence(value: unknown): number {
  const confidence = Number(value);
  if (!Number.isFinite(confidence)) return 0.5;
  return Math.max(0, Math.min(1, confidence));
}

function cleanString(value: unknown, maxChars: number): string {
  return typeof value === "string" ? value.trim().slice(0, maxChars) : "";
}

function normalizeFormat(value: unknown): "epub" | "pdf" | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === "pdf") return "pdf";
  if (normalized === "epub") return "epub";
  return undefined;
}

export function normalizeAssistantDecision(value: unknown): AssistantDecision {
  const fallback: AssistantDecision = {
    kind: "reply",
    text: "我不太确定你的意思。你可以直接告诉我想了解哪位作者、哪本书，或者明确说要把哪本书发送到 Kindle。",
    confidence: 0,
  };

  if (!value || typeof value !== "object") return fallback;
  const raw = value as Record<string, unknown>;
  const action = cleanString(raw.action, 32).toLowerCase();
  const confidence = clampConfidence(raw.confidence);
  const reply = cleanString(raw.reply, MAX_REPLY_CHARS);

  if (action === "status") {
    return {
      kind: "status",
      text: reply || "我来查一下最近的 Kindle 任务。",
      confidence,
    };
  }

  if (action === "book") {
    const book = raw.book && typeof raw.book === "object" ? (raw.book as Record<string, unknown>) : null;
    const title = cleanString(book?.title, 300);
    if (!title || confidence < 0.6) {
      return {
        kind: "reply",
        text: reply || fallback.text,
        confidence,
      };
    }

    const author = cleanString(book?.author, 200) || undefined;
    const language = cleanString(book?.language, 32) || undefined;
    const preferredFormat = normalizeFormat(book?.format);
    return {
      kind: "book",
      request: {
        query: title,
        author,
        language,
        preferredFormat,
      },
      text: reply,
      confidence,
    };
  }

  if (action === "reply") {
    return {
      kind: "reply",
      text: reply || fallback.text,
      confidence,
    };
  }

  return fallback;
}

function parseAiResponse(raw: unknown): unknown {
  const response = raw && typeof raw === "object" && "response" in raw
    ? (raw as { response?: unknown }).response
    : raw;

  if (typeof response === "string") {
    try {
      return JSON.parse(response);
    } catch {
      return null;
    }
  }
  return response;
}

function sanitizeHistory(history: AssistantHistoryMessage[]): AssistantHistoryMessage[] {
  return history
    .slice(-MAX_HISTORY_LIMIT)
    .map((message) => ({
      role: message.role,
      content: message.content.trim().slice(0, MAX_HISTORY_CONTENT_CHARS),
    }))
    .filter((message) => message.content.length > 0);
}

export async function decideAssistantAction(
  env: Env,
  text: string,
  history: AssistantHistoryMessage[] = [],
): Promise<AssistantDecision> {
  const model = env.ASSISTANT_MODEL?.trim() || DEFAULT_ASSISTANT_MODEL;
  const runText = env.AI.run as unknown as (
    model: string,
    inputs: Record<string, unknown>,
  ) => Promise<unknown>;

  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    ...sanitizeHistory(history),
    { role: "user", content: text.trim().slice(0, MAX_HISTORY_CONTENT_CHARS) },
  ];

  // Workers AI's run method is receiver-sensitive. Keep env.AI as `this`
  // even though the cast is needed for response_format fields that may lag
  // behind the generated Workers TypeScript declarations.
  const raw = await runText.call(env.AI, model, {
    messages,
    max_tokens: 600,
    temperature: 0.15,
    response_format: {
      type: "json_schema",
      json_schema: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["reply", "book", "status"] },
          reply: { type: "string" },
          confidence: { type: "number" },
          book: {
            type: "object",
            properties: {
              title: { type: "string" },
              author: { type: "string" },
              language: { type: "string" },
              format: { type: "string" },
            },
          },
        },
        required: ["action", "reply", "confidence"],
      },
    },
  });

  return normalizeAssistantDecision(parseAiResponse(raw));
}

export class TelegramConversationRepository {
  constructor(private readonly db: D1Database) {}

  async history(
    chatId: string,
    userId: string,
    limit: number = DEFAULT_HISTORY_LIMIT,
  ): Promise<AssistantHistoryMessage[]> {
    const safeLimit = Math.max(1, Math.min(MAX_HISTORY_LIMIT, Math.floor(limit)));
    try {
      const result = await this.db
        .prepare(
          `SELECT role, content
           FROM telegram_conversation_messages
           WHERE chat_id = ?1 AND user_id = ?2
           ORDER BY id DESC
           LIMIT ?3`,
        )
        .bind(chatId, userId, safeLimit)
        .all<Record<string, unknown>>();

      return (result.results ?? [])
        .map((row) => ({
          role: row.role === "assistant" ? "assistant" as const : "user" as const,
          content: String(row.content ?? ""),
        }))
        .reverse()
        .filter((message) => message.content.length > 0);
    } catch (error) {
      console.warn("Telegram conversation history unavailable", error);
      return [];
    }
  }

  async append(
    chatId: string,
    userId: string,
    role: "user" | "assistant",
    content: string,
  ): Promise<void> {
    const clean = content.trim().slice(0, MAX_HISTORY_CONTENT_CHARS);
    if (!clean) return;

    try {
      const now = new Date().toISOString();
      await this.db
        .prepare(
          `INSERT INTO telegram_conversation_messages
             (chat_id, user_id, role, content, created_at)
           VALUES (?1, ?2, ?3, ?4, ?5)`,
        )
        .bind(chatId, userId, role, clean, now)
        .run();

      await this.db
        .prepare(
          `DELETE FROM telegram_conversation_messages
           WHERE chat_id = ?1 AND user_id = ?2
             AND id NOT IN (
               SELECT id FROM telegram_conversation_messages
               WHERE chat_id = ?1 AND user_id = ?2
               ORDER BY id DESC
               LIMIT ?3
             )`,
        )
        .bind(chatId, userId, MAX_HISTORY_LIMIT)
        .run();
    } catch (error) {
      console.warn("Telegram conversation history write failed", error);
    }
  }
}
