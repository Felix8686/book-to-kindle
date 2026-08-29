import type { BookCandidate, BookRequest, TaskRecord, TaskStatus } from "./domain";

function parseJson<T>(value: unknown): T | undefined {
  if (typeof value !== "string" || !value) return undefined;
  return JSON.parse(value) as T;
}

export class TaskRepository {
  constructor(private readonly db: D1Database) {}

  async create(id: string, request: BookRequest): Promise<TaskRecord> {
    const now = new Date().toISOString();
    await this.db
      .prepare(
        `INSERT INTO tasks (id, status, request_json, created_at, updated_at)
         VALUES (?1, 'queued', ?2, ?3, ?3)`,
      )
      .bind(id, JSON.stringify(request), now)
      .run();

    return {
      id,
      status: "queued",
      request,
      createdAt: now,
      updatedAt: now,
    };
  }

  async get(id: string): Promise<TaskRecord | null> {
    const row = await this.db
      .prepare(
        `SELECT id, status, request_json, candidates_json, selected_candidate_json, storage_key,
                error_message, created_at, updated_at
         FROM tasks WHERE id = ?1`,
      )
      .bind(id)
      .first<Record<string, unknown>>();

    if (!row) return null;

    return {
      id: String(row.id),
      status: String(row.status) as TaskStatus,
      request: parseJson<BookRequest>(row.request_json)!,
      candidates: parseJson<BookCandidate[]>(row.candidates_json),
      selectedCandidate: parseJson<BookCandidate>(row.selected_candidate_json),
      storageKey: row.storage_key ? String(row.storage_key) : undefined,
      errorMessage: row.error_message ? String(row.error_message) : undefined,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }

  async update(
    id: string,
    patch: {
      status?: TaskStatus;
      candidates?: BookCandidate[] | null;
      selectedCandidate?: BookCandidate | null;
      storageKey?: string | null;
      errorMessage?: string | null;
    },
  ): Promise<void> {
    const current = await this.get(id);
    if (!current) throw new Error(`Task not found: ${id}`);

    const status = patch.status ?? current.status;
    const candidates =
      patch.candidates === undefined ? current.candidates : patch.candidates ?? undefined;
    const candidate =
      patch.selectedCandidate === undefined
        ? current.selectedCandidate
        : patch.selectedCandidate ?? undefined;
    const storageKey =
      patch.storageKey === undefined ? current.storageKey : patch.storageKey ?? undefined;
    const errorMessage =
      patch.errorMessage === undefined ? current.errorMessage : patch.errorMessage ?? undefined;

    await this.db
      .prepare(
        `UPDATE tasks
         SET status = ?2,
             candidates_json = ?3,
             selected_candidate_json = ?4,
             storage_key = ?5,
             error_message = ?6,
             updated_at = ?7
         WHERE id = ?1`,
      )
      .bind(
        id,
        status,
        candidates ? JSON.stringify(candidates) : null,
        candidate ? JSON.stringify(candidate) : null,
        storageKey ?? null,
        errorMessage ?? null,
        new Date().toISOString(),
      )
      .run();
  }
}
