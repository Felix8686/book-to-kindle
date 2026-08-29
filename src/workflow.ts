import type { BookCandidate, DeliveryAdapter, Env, SourceAdapter, TaskRecord } from "./domain";
import { TaskRepository } from "./repository";

const DEFAULT_MAX_CLOUD_FILE_BYTES = 20 * 1024 * 1024;

function maxCloudFileBytes(env: Env): number {
  const configured = Number(env.MAX_CLOUD_FILE_BYTES);
  if (!Number.isFinite(configured) || configured <= 0) return DEFAULT_MAX_CLOUD_FILE_BYTES;
  return Math.min(configured, 24 * 1024 * 1024);
}

export function candidateScore(candidate: BookCandidate, task: TaskRecord): number {
  let score = 0;
  const query = task.request.query.toLowerCase();
  const title = candidate.title.toLowerCase();

  if (title === query) score += 50;
  else if (title.includes(query) || query.includes(title)) score += 30;

  if (task.request.author && candidate.author) {
    const requestedAuthor = task.request.author.toLowerCase();
    const author = candidate.author.toLowerCase();
    if (author.includes(requestedAuthor) || requestedAuthor.includes(author)) score += 25;
  }

  if (task.request.language && candidate.language) {
    const requestedLanguage = task.request.language.toLowerCase();
    const language = candidate.language.toLowerCase();
    if (language === requestedLanguage || language.startsWith(requestedLanguage.slice(0, 2))) score += 15;
  }

  if (task.request.preferredFormat && candidate.format === task.request.preferredFormat) score += 10;
  if (candidate.sizeBytes && candidate.sizeBytes > DEFAULT_MAX_CLOUD_FILE_BYTES) score -= 100;

  return score;
}

function rankedCandidates(candidates: BookCandidate[], task: TaskRecord): BookCandidate[] {
  return candidates
    .map((candidate) => ({ ...candidate, score: candidateScore(candidate, task) }))
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
}

function autoSelect(ranked: BookCandidate[]): BookCandidate | null {
  if (ranked.length === 0) return null;
  const best = ranked[0];
  const second = ranked[1];

  if ((best.score ?? 0) < 40) return null;
  if (second && (best.score ?? 0) - (second.score ?? 0) < 10) return null;
  return best;
}

function hasValidSignature(format: string, bytes: Uint8Array): boolean {
  if (format === "pdf") {
    return bytes.length >= 5 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46 && bytes[4] === 0x2d;
  }

  if (format === "epub") {
    return bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
  }

  return false;
}

async function validatedBookStream(
  body: ReadableStream<Uint8Array>,
  format: string,
): Promise<ReadableStream<Uint8Array>> {
  const reader = body.getReader();
  const first = await reader.read();
  if (first.done || !first.value || !hasValidSignature(format, first.value)) {
    await reader.cancel("Invalid ebook signature");
    throw new Error(`Downloaded content does not look like a valid ${format.toUpperCase()} file.`);
  }

  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(first.value!);
    },
    async pull(controller) {
      try {
        const next = await reader.read();
        if (next.done) {
          controller.close();
          reader.releaseLock();
          return;
        }
        controller.enqueue(next.value);
      } catch (error) {
        controller.error(error);
      }
    },
    async cancel(reason) {
      await reader.cancel(reason);
    },
  });
}

export interface WorkflowDependencies {
  env: Env;
  sources: SourceAdapter[];
  delivery?: DeliveryAdapter;
}

export async function processTask(taskId: string, deps: WorkflowDependencies): Promise<void> {
  const repo = new TaskRepository(deps.env.DB);
  const task = await repo.get(taskId);
  if (!task) throw new Error(`Task not found: ${taskId}`);

  if (task.status === "delivered") return;
  if (task.status === "delivering") {
    await repo.update(taskId, {
      status: "failed",
      errorMessage: "Previous delivery outcome is unknown; automatic resend was blocked to avoid duplicates.",
    });
    return;
  }
  if (task.status === "needs_selection" && !task.selectedCandidate) return;

  try {
    let selected = task.selectedCandidate;

    if (!selected) {
      await repo.update(taskId, { status: "searching", errorMessage: null });

      if (deps.sources.length === 0) {
        await repo.update(taskId, {
          status: "needs_source",
          errorMessage: "No source adapter is configured.",
        });
        return;
      }

      const resultSets = await Promise.all(
        deps.sources.map(async (source) => {
          try {
            return await source.search(task.request);
          } catch (error) {
            console.warn(`Source ${source.name} failed`, error);
            return [];
          }
        }),
      );

      const ranked = rankedCandidates(resultSets.flat(), task).slice(0, 10);
      selected = autoSelect(ranked) ?? undefined;

      if (!selected) {
        await repo.update(taskId, {
          status: ranked.length > 0 ? "needs_selection" : "needs_source",
          candidates: ranked.length > 0 ? ranked : null,
          errorMessage:
            ranked.length > 0
              ? "Multiple or low-confidence candidates require confirmation."
              : "No compatible public-domain source was found.",
        });
        return;
      }
    }

    if (!selected) throw new Error("No book candidate was selected.");
    const source = deps.sources.find((item) => item.name === selected.source);
    if (!source) throw new Error(`Missing source adapter: ${selected.source}`);

    await repo.update(taskId, {
      status: "downloading",
      candidates: null,
      selectedCandidate: selected,
      errorMessage: null,
    });

    const cloudLimit = maxCloudFileBytes(deps.env);
    const download = await source.download(selected, { maxBytes: cloudLimit });

    if (download.sizeBytes && download.sizeBytes > cloudLimit) {
      throw new Error("File is too large for the Cloudflare delivery path; use a local enhancement node.");
    }

    const validatedBody = await validatedBookStream(download.body, selected.format.toLowerCase());
    const extension = selected.format.toLowerCase();
    const storageKey = `tasks/${taskId}/${crypto.randomUUID()}.${extension}`;
    await deps.env.FILES.put(storageKey, validatedBody, {
      httpMetadata: { contentType: download.contentType },
      customMetadata: {
        taskId,
        source: selected.source,
        title: selected.title.slice(0, 200),
      },
    });
    await repo.update(taskId, { status: "staged", storageKey });

    if (!deps.delivery || !deps.env.KINDLE_EMAIL) {
      await repo.update(taskId, {
        status: "staged",
        errorMessage: "File staged in R2; delivery adapter is not configured.",
      });
      return;
    }

    const object = await deps.env.FILES.get(storageKey);
    if (!object) throw new Error("Staged file disappeared from R2.");

    await repo.update(taskId, { status: "delivering" });
    await deps.delivery.deliver({
      task: (await repo.get(taskId))!,
      object,
      kindleEmail: deps.env.KINDLE_EMAIL,
    });

    await repo.update(taskId, { status: "delivered", errorMessage: null });
    await deps.env.FILES.delete(storageKey);
  } catch (error) {
    await repo.update(taskId, {
      status: "failed",
      errorMessage: error instanceof Error ? error.message : "Unknown workflow failure",
    });
    throw error;
  }
}
