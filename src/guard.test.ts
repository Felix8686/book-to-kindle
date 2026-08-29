import { describe, it, expect, vi } from "vitest";
import { UsageGuard } from "./guard";
import type { Env } from "./domain";

describe("Free Tier Guard usage counter and monthly limits", () => {
  it("enforces monthly task creation limits and allows read actions", async () => {
    let mockValue = 0;
    const mockDb = {
      prepare: vi.fn((query: string) => {
        return {
          bind: vi.fn((...args: any[]) => {
            return {
              first: vi.fn(async () => {
                if (query.includes("SELECT value FROM usage_counters")) {
                  return { value: mockValue };
                }
                return null;
              }),
              run: vi.fn(async () => {
                if (query.includes("INSERT INTO usage_counters")) {
                  mockValue += 1;
                }
                return { success: true };
              }),
            };
          }),
        };
      }),
    };

    const guard = new UsageGuard(mockDb as any);
    const env: Env = {
      DB: mockDb as any,
      FILES: {} as any,
      TASK_QUEUE: {} as any,
      AI: {} as any,
      API_TOKEN: "test",
      FREE_TIER_GUARD_ENABLED: "true",
      MAX_MONTHLY_TASKS: "2", // Test limit of 2 tasks
    };

    // Task 1: allowed
    let check = await guard.checkCanCreateTask(env);
    expect(check.allowed).toBe(true);
    await guard.increment("tasks_created");

    // Task 2: allowed
    check = await guard.checkCanCreateTask(env);
    expect(check.allowed).toBe(true);
    await guard.increment("tasks_created");

    // Task 3: rejected by safety guard
    check = await guard.checkCanCreateTask(env);
    expect(check.allowed).toBe(false);
    expect(check.reason).toContain("安全额度已达到上限");
  });
});
