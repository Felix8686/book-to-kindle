import { describe, it, expect, vi } from "vitest";
import { cancelTask } from "./cancel";
import type { Env, TaskRecord } from "./domain";

describe("Cancel state machine and race protection", () => {
  function createMockEnv(initialTask?: Partial<TaskRecord>): {
    env: Env;
    storedTask: TaskRecord | null;
  } {
    let task: TaskRecord | null = initialTask
      ? ({
          id: "test-task-1",
          request: { query: "Test Book" },
          status: "queued",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          ...initialTask,
        } as TaskRecord)
      : null;

    const mockDb = {
      prepare: vi.fn((query: string) => {
        return {
          bind: vi.fn((...args: any[]) => {
            return {
              first: vi.fn(async () => {
                if (query.includes("SELECT") && query.includes("FROM tasks")) {
                  return task
                    ? {
                        ...task,
                        request_json: JSON.stringify(task.request),
                        candidates_json: task.candidates ? JSON.stringify(task.candidates) : null,
                        selected_candidate_json: task.selectedCandidate
                          ? JSON.stringify(task.selectedCandidate)
                          : null,
                        delivery_receipt_json: task.deliveryReceipt
                          ? JSON.stringify(task.deliveryReceipt)
                          : null,
                        telegram_entry_json: null,
                      }
                    : null;
                }
                return null;
              }),
              run: vi.fn(async () => {
                if (query.includes("UPDATE tasks SET status = 'cancelled'")) {
                  if (task && task.status !== "cancelled") {
                    task.status = "cancelled";
                    return { success: true, meta: { changes: 1 } };
                  }
                  return { success: true, meta: { changes: 0 } };
                }
                return { success: true, meta: { changes: 1 } };
              }),
            };
          }),
        };
      }),
    };

    const mockFiles = {
      delete: vi.fn(async () => {}),
    };

    return {
      env: {
        DB: mockDb as any,
        FILES: mockFiles as any,
        TASK_QUEUE: {} as any,
        AI: {} as any,
        API_TOKEN: "test",
      },
      get storedTask() {
        return task;
      },
    };
  }

  it("successfully cancels queued, searching, downloading, staged tasks", async () => {
    for (const status of ["queued", "searching", "needs_source", "needs_selection", "downloading", "staged"] as const) {
      const { env } = createMockEnv({ status });
      const res = await cancelTask("test-task-1", env);
      expect(res.outcome).toBe("cancelled");
      if (res.outcome === "cancelled") {
        expect(res.title).toBe("Test Book");
      }
    }
  });

  it("blocks cancellation if task is already delivering or delivered", async () => {
    const { env: envDelivering } = createMockEnv({ status: "delivering" });
    const res1 = await cancelTask("test-task-1", envDelivering);
    expect(res1.outcome).toBe("too_late");
    if (res1.outcome === "too_late") {
      expect(res1.status).toBe("delivering");
    }

    const { env: envDelivered } = createMockEnv({ status: "delivered" });
    const res2 = await cancelTask("test-task-1", envDelivered);
    expect(res2.outcome).toBe("too_late");
    if (res2.outcome === "too_late") {
      expect(res2.status).toBe("delivered");
    }
  });

  it("handles idempotent cancel on already cancelled task", async () => {
    const { env } = createMockEnv({ status: "cancelled" });
    const res = await cancelTask("test-task-1", env);
    expect(res.outcome).toBe("cancelled");
    if (res.outcome === "cancelled") {
      expect(res.title).toBe("Test Book");
    }
  });
});
