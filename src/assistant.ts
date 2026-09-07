import type { BookRequest, Env } from "./domain";
import {
  formatAuthorWorksReply,
  formatBookInfoReply,
  lookupAuthorWorks,
  lookupBookInfo,
} from "./catalog";
import { runWorkersAi } from "./workers-ai";

export const DEFAULT_ASSISTANT_MODEL = "@cf/meta/llama-3.1-8b-instruct-fast" as const;
const DEFAULT_HISTORY_LIMIT = 12;
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

export type AssistantRoute =
  | AssistantDecision
  | {
      kind: "author_works";
      author: string;
      text: string;
      confidence: number;
    }
  | {
      kind: "book_info";
      request: BookRequest;
      text: string;
      confidence: number;
    };

const SYSTEM_PROMPT = [
  "你是 Book to Kindle 的自然语言理解层。你的职责是理解用户、上下文和指代，然后选择正确动作；确定性业务和书目事实由代码工具完成。",
  "绝不能把所有文字默认当作书名，也不要用模型记忆编造作者作品、版本、出版信息或书目事实。",
  "",
  "你只能选择五种动作：",
  "1. reply：普通聊天、澄清或不需要书目工具的回答；不得在这里凭记忆列作者作品清单。",
  "2. author_works：用户询问某作者有哪些作品、推荐哪些作品、从哪些作品开始读。只提取 author，具体作品列表由代码查询。",
  "3. book_info：用户询问某本具体书怎么样、讲什么、出版信息等。必须从当前消息或最近历史可靠解析具体书名，详情由代码查询。",
  "4. book：只有当用户明确要查找/获取并发送一本具体书到 Kindle 时使用。",
  "5. status：用户询问最近 Kindle 任务是否发送成功、进度、结果或当前状态时使用。",
  "",
  "关键规则：",
  "- 人名、作者名、流派名、系列名、主题词、普通问句本身都不是发送任务。比如用户只发‘倪匡’，通常 reply。",
  "- ‘倪匡有哪些值得看？’必须 author_works，author=倪匡；不要自己列作品。",
  "- 如果上一条助手回复是编号书单，用户说‘第二本怎么样？’，必须从最近历史取出第 2 本的准确书名并 book_info。",
  "- 如果上一条助手回复是编号书单，用户说‘第二本发到 Kindle’，必须从最近历史取出第 2 本的准确书名并 book。",
  "- 用户说‘刚才那本发成功了吗？’、‘到哪一步了？’、‘发过去没有？’，必须 status，绝不能再次创建 book。",
  "- 对‘第二本’、‘刚才那本’、‘这本’等指代，优先利用最近对话解析；无法可靠确定时 reply 追问，不得猜。",
  "- book 和 book_info 的 title 必须来自用户消息或最近历史中已经出现的具体书名，禁止编造。",
  "- 不确定用户是在讨论一本书还是要发送它时，必须 reply 或 book_info，不能擅自创建发送任务。",
  "- reply 要直接面向用户，不要解释内部分类、JSON 或工具机制。默认使用用户当前消息的语言。",
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

function normalizeBook(raw: unknown): BookRequest | null {
  if (!raw || typeof raw !== "object") return null;
  const book = raw as Record<string, unknown>;
  const title = cleanString(book.title, 300);
  if (!title) return null;
  const author = cleanString(book.author, 200) || undefined;
  const language = cleanString(book.language, 32) || undefined;
  const preferredFormat = normalizeFormat(book.format);
  return {
    query: title,
    author,
    language,
    preferredFormat,
  };
}

export function normalizeAssistantDecision(value: unknown): AssistantRoute {
  const fallback: AssistantDecision = {
    kind: "reply",
    text: "我不太确定你的意思。你可以继续说明想了解哪位作者、哪本书，或者明确说要把哪本书发送到 Kindle。",
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

  if (action === "author_works") {
    const author = cleanString(raw.author, 200);
    if (!author || confidence < 0.55) {
      return { kind: "reply", text: reply || fallback.text, confidence };
    }
    return {
      kind: "author_works",
      author,
      text: reply,
      confidence,
    };
  }

  if (action === "book_info") {
    const request = normalizeBook(raw.book);
    if (!request || confidence < 0.55) {
      return { kind: "reply", text: reply || fallback.text, confidence };
    }
    return {
      kind: "book_info",
      request,
      text: reply,
      confidence,
    };
  }

  if (action === "book") {
    const request = normalizeBook(raw.book);
    if (!request || confidence < 0.6) {
      return {
        kind: "reply",
        text: reply || fallback.text,
        confidence,
      };
    }

    return {
      kind: "book",
      request,
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

async function executeCodeRoute(route: AssistantRoute): Promise<AssistantDecision> {
  if (route.kind === "author_works") {
    const works = await lookupAuthorWorks(route.author, 8);
    return {
      kind: "reply",
      text: formatAuthorWorksReply(route.author, works),
      confidence: route.confidence,
    };
  }

  if (route.kind === "book_info") {
    const info = await lookupBookInfo(route.request.query, route.request.author);
    return {
      kind: "reply",
      text: formatBookInfoReply(info, route.request.query),
      confidence: route.confidence,
    };
  }

  return route;
}

export async function decideAssistantAction(
  env: Env,
  text: string,
  history: AssistantHistoryMessage[] = [],
): Promise<AssistantDecision> {
  const model = env.ASSISTANT_MODEL?.trim() || DEFAULT_ASSISTANT_MODEL;

  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    ...sanitizeHistory(history),
    { role: "user", content: text.trim().slice(0, MAX_HISTORY_CONTENT_CHARS) },
  ];

  const raw = await runWorkersAi(env.AI, model, {
    messages,
    max_tokens: 600,
    temperature: 0.1,
    response_format: {
      type: "json_schema",
      json_schema: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["reply", "author_works", "book_info", "book", "status"],
          },
          reply: { type: "string" },
          confidence: { type: "number" },
          author: { type: "string" },
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

  const route = normalizeAssistantDecision(parseAiResponse(raw));
  return executeCodeRoute(route);
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
