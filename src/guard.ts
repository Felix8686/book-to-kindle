import type { Env } from "./domain";

export type UsageMetric =
  | "tasks_created"
  | "ai_image_requests"
  | "source_requests"
  | "r2_puts"
  | "r2_gets"
  | "r2_deletes"
  | "gmail_deliveries";

export interface GuardCheckResult {
  allowed: boolean;
  reason?: string;
  metric?: UsageMetric;
  currentValue?: number;
  limit?: number;
}

export function currentMonthKey(date: Date = new Date()): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

export function isFreeTierGuardEnabled(env: Env): boolean {
  if (env.FREE_TIER_GUARD_ENABLED === undefined) return true;
  return env.FREE_TIER_GUARD_ENABLED.toLowerCase() !== "false";
}

export const DEFAULT_GUARD_LIMITS: Record<UsageMetric, number> = {
  tasks_created: 500,
  ai_image_requests: 300,
  source_requests: 3000,
  r2_puts: 2000,
  r2_gets: 10000,
  r2_deletes: 2000,
  gmail_deliveries: 400,
};

export class UsageGuard {
  constructor(private readonly db: D1Database) {}

  async getMetricValue(metric: UsageMetric, monthKey: string = currentMonthKey()): Promise<number> {
    try {
      const row = await this.db
        .prepare("SELECT value FROM usage_counters WHERE month_key = ? AND metric = ?")
        .bind(monthKey, metric)
        .first<{ value: number }>();
      return row?.value ?? 0;
    } catch {
      return 0;
    }
  }

  async increment(metric: UsageMetric, delta: number = 1, monthKey: string = currentMonthKey()): Promise<void> {
    try {
      const now = new Date().toISOString();
      await this.db
        .prepare(
          "INSERT INTO usage_counters (month_key, metric, value, updated_at) VALUES (?, ?, ?, ?) " +
            "ON CONFLICT(month_key, metric) DO UPDATE SET value = value + excluded.value, updated_at = excluded.updated_at",
        )
        .bind(monthKey, metric, delta, now)
        .run();
    } catch (error) {
      console.warn("Usage counter increment failed", metric, error);
    }
  }

  async checkCanCreateTask(env: Env): Promise<GuardCheckResult> {
    if (!isFreeTierGuardEnabled(env)) return { allowed: true };
    const limit = Number(env.MAX_MONTHLY_TASKS) || DEFAULT_GUARD_LIMITS.tasks_created;
    const current = await this.getMetricValue("tasks_created");
    if (current >= limit) {
      return {
        allowed: false,
        reason:
          "本月 Book to Kindle 的安全额度已达到上限。系统已暂停新的书籍任务，以避免产生意外费用。下月会自动使用新的月度额度。",
        metric: "tasks_created",
        currentValue: current,
        limit,
      };
    }
    return { allowed: true, currentValue: current, limit };
  }

  async checkCanProcessAiImage(env: Env): Promise<GuardCheckResult> {
    if (!isFreeTierGuardEnabled(env)) return { allowed: true };
    const limit = Number(env.MAX_MONTHLY_AI_IMAGES) || DEFAULT_GUARD_LIMITS.ai_image_requests;
    const current = await this.getMetricValue("ai_image_requests");
    if (current >= limit) {
      return {
        allowed: false,
        reason:
          "本月 Book to Kindle 的 AI 图片识别安全额度已达到上限。请直接发送书名文本进行投递。",
        metric: "ai_image_requests",
        currentValue: current,
        limit,
      };
    }
    return { allowed: true, currentValue: current, limit };
  }
}
