import type { BookCandidate, DeliveryAdapter, Env, SourceAdapter, TaskRecord } from "./domain";
import { TaskRepository } from "./repository";

const MAX_CLOUD_FILE_BYTES = 24 * 1024 * 1024;

function candidateScore(candidate: BookCandidate, task: TaskRecord): number {
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

  if (task.request.language && candidate.language === task.request.language) score += 15;
  if (task.request.preferredFormat && candidate.format === task.request.preferredFormat) score += 10;
  if (candidate.sizeBytes && candidate.sizeBytes > MAX_CLOUD_FILE_BYTES) score -= 100;

  return score;
}

function selectCandidate(candidates: BookCandidate[], task: TaskRecord): BookCandidate | null {
  if (candidates.length === 0) return null;

  const ranked = candidates
    .map((candidate) => ({ ...candidate, score: candidateScore(candidate, task) }))
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0));

  const best = ranked[0];
  const second = ranked[1];

  if ((best.score ?? 0) < 40) return null;
  if (second && (best.score ?? 0) - (second.score ?? 0) < 10) return null;
  return best;
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

  try {
    await repo.update(taskId, { status: "searching", errorMessage: null });

    if (deps.sources.length === 0) {
      await repo.update(taskId, {
        status: "needs_source",
        errorMessage: "No source adapter is configured yet.",
      });
      return;
    }

    const resultSets = await Promise.all(
      deps.sources.map(async (source) => {
        try {
          return await source.search(task.request);
        } catch {
          return [];
        }
      }),
    );

    const candidates = resultSets.flat();
    const selected = selectCandidate(candidates, task);

    if (!selected) {
      await repo.update(taskId, {
        status: candidates.length > 0 ? "needs_selection" : "needs_source",
        errorMessage:
          candidates.length > 0
            ? "Multiple or low-confidence candidates require confirmation."
            : "No compatible source was found.",
      });
      return;
    }

    const source = deps.sources.find((item) => item.name === selected.source);
    if (!source) throw new Error(`Missing source adapter: ${selected.source}`);

    await repo.update(taskId, { status: "downloading", selectedCandidate: selected });
    const download = await source.download(selected);

    if (download.sizeBytes && download.sizeBytes > MAX_CLOUD_FILE_BYTES) {
      throw new Error("File is too large for the Cloudflare delivery path; use a local enhancement node.");
    }

    const extension = selected.format.toLowerCase();
    const storageKey = `tasks/${taskId}/${crypto.randomUUID()}.${extension}`;
    await deps.env.FILES.put(storageKey, download.body, {
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
        errorMessage: "File staged in R2; delivery adapter is not configured yet.",
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
