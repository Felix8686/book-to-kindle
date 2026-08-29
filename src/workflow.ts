import type {
  BookCandidate,
  BookIdentifiers,
  BookSearchContext,
  DeliveryAdapter,
  Env,
  SourceAdapter,
  TaskRecord,
} from "./domain";
import { TaskRepository } from "./repository";
import { resolveBookSearchContext } from "./resolver";
import { normalizeBookLanguage, preferredLanguageForTask } from "./settings";

const DEFAULT_MAX_CLOUD_FILE_BYTES = 20 * 1024 * 1024;

function maxCloudFileBytes(env: Env): number {
  const configured = Number(env.MAX_CLOUD_FILE_BYTES);
  if (!Number.isFinite(configured) || configured <= 0) return DEFAULT_MAX_CLOUD_FILE_BYTES;
  return Math.min(configured, 24 * 1024 * 1024);
}

function normalizeLanguage(value?: string): string | undefined {
  if (!value) return undefined;
  const known = normalizeBookLanguage(value);
  if (known) return known;
  const raw = value.trim().toLowerCase();
  if (raw === "eng") return "en";
  if (["chi", "zho"].includes(raw)) return "zh";
  return raw.slice(0, 2);
}

function normalizedText(value?: string): string {
  return (value ?? "")
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function identifierValues(identifiers?: BookIdentifiers): Set<string> {
  return new Set([
    ...(identifiers?.isbn10 ?? []),
    ...(identifiers?.isbn13 ?? []),
  ].map((value) => value.replace(/[^0-9X]/gi, "")));
}

function hasIdentifierOverlap(candidate: BookCandidate, context: BookSearchContext): boolean {
  const candidateIds = identifierValues(candidate.identifiers);
  if (candidateIds.size === 0) return false;
  const identityIds = identifierValues(context.identity.identifiers);
  return [...candidateIds].some((value) => identityIds.has(value));
}

export function candidateScore(
  candidate: BookCandidate,
  task: TaskRecord,
  context?: BookSearchContext,
): number {
  let score = 0;
  const candidateTitle = normalizedText(candidate.title);
  const titleVariants = context?.identity.titles.map((item) => item.title) ?? [task.request.query];
  const normalizedVariants = titleVariants.map(normalizedText).filter(Boolean);

  if (normalizedVariants.some((title) => title === candidateTitle)) score += 45;
  else if (
    normalizedVariants.some((title) => title.includes(candidateTitle) || candidateTitle.includes(title))
  ) score += 28;

  const requestedAuthors = context?.identity.authors.length
    ? context.identity.authors
    : task.request.author
      ? [task.request.author]
      : [];
  if (candidate.author && requestedAuthors.length) {
    const author = normalizedText(candidate.author);
    if (requestedAuthors.some((value) => {
      const requested = normalizedText(value);
      return author.includes(requested) || requested.includes(author);
    })) score += 25;
  }

  if (context && hasIdentifierOverlap(candidate, context)) score += 50;

  const preferredLanguage = context?.preferredLanguage ?? normalizeLanguage(task.request.language);
  const candidateLanguage = normalizeLanguage(candidate.language);
  if (preferredLanguage && candidateLanguage === preferredLanguage) score += 30;

  if (task.request.preferredFormat && candidate.format === task.request.preferredFormat) score += 10;
  else if (!task.request.preferredFormat && candidate.format === "epub") score += 8;

  score += Math.min(Math.max(candidate.sourceQuality ?? 0, 0), 15);
  if (candidate.sizeBytes && candidate.sizeBytes > DEFAULT_MAX_CLOUD_FILE_BYTES) score -= 100;

  return score;
}

function candidateDedupKey(candidate: BookCandidate): string {
  const isbn13 = candidate.identifiers?.isbn13?.[0]?.replace(/[^0-9X]/gi, "");
  const isbn10 = candidate.identifiers?.isbn10?.[0]?.replace(/[^0-9X]/gi, "");
  const language = normalizeLanguage(candidate.language) ?? "";
  const format = candidate.format.toLowerCase();
  if (isbn13 || isbn10) return `isbn:${isbn13 ?? isbn10}:${language}:${format}`;
  return [
    normalizedText(candidate.title),
    normalizedText(candidate.author),
    language,
    format,
  ].join("|");
}

function rankedCandidates(
  candidates: BookCandidate[],
  task: TaskRecord,
  context: BookSearchContext,
): BookCandidate[] {
  const deduped = new Map<string, BookCandidate>();
  for (const candidate of candidates) {
    const key = candidateDedupKey(candidate);
    const existing = deduped.get(key);
    if (!existing || (candidate.sourceQuality ?? 0) > (existing.sourceQuality ?? 0)) {
      deduped.set(key, candidate);
    }
  }

  return [...deduped.values()]
    .map((candidate) => ({ ...candidate, score: candidateScore(candidate, task, context) }))
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
}

function autoSelect(ranked: BookCandidate[]): BookCandidate | null {
  if (ranked.length === 0) return null;
  const best = ranked[0];
  const second = ranked[1];

  if ((best.score ?? 0) < 55) return null;
  if (second && (best.score ?? 0) - (second.score ?? 0) < 12) return null;
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
  const buffered: Uint8Array[] = [];
  let bufferedBytes = 0;

  try {
    while (bufferedBytes < 5) {
      const next = await reader.read();
      if (next.done) break;
      buffered.push(next.value);
      bufferedBytes += next.value.byteLength;
    }

    const header = new Uint8Array(Math.min(bufferedBytes, 5));
    let offset = 0;
    for (const chunk of buffered) {
      if (offset >= header.byteLength) break;
      const count = Math.min(chunk.byteLength, header.byteLength - offset);
      header.set(chunk.subarray(0, count), offset);
      offset += count;
    }

    if (!hasValidSignature(format, header)) {
      await reader.cancel("Invalid ebook signature");
      throw new Error(`Downloaded content does not look like a valid ${format.toUpperCase()} file.`);
    }
  } catch (error) {
    try {
      await reader.cancel(error);
    } catch {
      // Preserve the original validation error.
    }
    throw error;
  }

  let bufferedIndex = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        if (bufferedIndex < buffered.length) {
          controller.enqueue(buffered[bufferedIndex++]);
          return;
        }
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

async function isCancelled(repo: TaskRepository, taskId: string): Promise<boolean> {
  const latest = await repo.get(taskId);
  return Boolean(latest && String(latest.status) === "cancelled");
}

async function cleanupCancelledObject(env: Env, storageKey: string): Promise<void> {
  try {
    await env.FILES.delete(storageKey);
  } catch (error) {
    console.warn("Cancelled task R2 cleanup failed", storageKey, error);
  }
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

  if (String(task.status) === "cancelled") return;
  if (task.status === "delivered" || task.status === "delivery_unknown") return;
  if (task.status === "delivering") {
    await repo.update(taskId, {
      status: "delivery_unknown",
      errorMessage:
        "A previous Gmail delivery started but its final outcome is unknown. Automatic resend was blocked to avoid a duplicate Kindle document.",
    });
    return;
  }
  if (task.status === "needs_selection" && !task.selectedCandidate) return;

  let deliveryStarted = false;
  let activeStorageKey: string | undefined;

  try {
    let selected = task.selectedCandidate;

    if (!selected) {
      await repo.update(taskId, { status: "searching", errorMessage: null });
      if (await isCancelled(repo, taskId)) return;

      if (deps.sources.length === 0) {
        await repo.update(taskId, {
          status: "needs_source",
          errorMessage: "No source adapter is configured.",
        });
        return;
      }

      const preferredLanguage = await preferredLanguageForTask(
        deps.env,
        taskId,
        task.request.language,
      );
      const context = await resolveBookSearchContext(task.request, preferredLanguage);
      if (await isCancelled(repo, taskId)) return;

      const resultSets = await Promise.allSettled(
        deps.sources.map((source) => source.search(context)),
      );
      const candidates: BookCandidate[] = [];
      resultSets.forEach((result, index) => {
        if (result.status === "fulfilled") candidates.push(...result.value);
        else console.warn(`Source ${deps.sources[index]?.name ?? index} failed`, result.reason);
      });

      if (await isCancelled(repo, taskId)) return;

      const ranked = rankedCandidates(candidates, task, context).slice(0, 10);
      selected = autoSelect(ranked) ?? undefined;

      if (!selected) {
        await repo.update(taskId, {
          status: ranked.length > 0 ? "needs_selection" : "needs_source",
          candidates: ranked.length > 0 ? ranked : null,
          errorMessage:
            ranked.length > 0
              ? "Multiple or low-confidence editions require confirmation."
              : "No compatible downloadable source was found.",
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
      deliveryReceipt: null,
      errorMessage: null,
    });
    if (await isCancelled(repo, taskId)) return;

    const cloudLimit = maxCloudFileBytes(deps.env);
    const download = await source.download(selected, { maxBytes: cloudLimit });

    if (await isCancelled(repo, taskId)) {
      try {
        await download.body.cancel("Task cancelled by user");
      } catch {
        // Best effort only.
      }
      return;
    }

    if (download.sizeBytes && download.sizeBytes > cloudLimit) {
      throw new Error("File is too large for the Cloudflare delivery path; use a local enhancement node.");
    }

    const validatedBody = await validatedBookStream(download.body, selected.format.toLowerCase());
    const extension = selected.format.toLowerCase();
    const storageKey = `tasks/${taskId}/${crypto.randomUUID()}.${extension}`;
    activeStorageKey = storageKey;
    const storageOptions = {
      httpMetadata: { contentType: download.contentType },
      customMetadata: {
        taskId,
        source: selected.source,
        title: selected.title.slice(0, 200),
      },
    };

    if (download.sizeBytes !== undefined) {
      const fixedLength = new FixedLengthStream(download.sizeBytes);
      await Promise.all([
        deps.env.FILES.put(storageKey, fixedLength.readable, storageOptions),
        validatedBody.pipeTo(fixedLength.writable),
      ]);
    } else {
      const bufferedBody = await new Response(validatedBody).arrayBuffer();
      await deps.env.FILES.put(storageKey, bufferedBody, storageOptions);
    }

    if (await isCancelled(repo, taskId)) {
      await cleanupCancelledObject(deps.env, storageKey);
      activeStorageKey = undefined;
      return;
    }

    await repo.update(taskId, { status: "staged", storageKey });
    if (await isCancelled(repo, taskId)) {
      await cleanupCancelledObject(deps.env, storageKey);
      activeStorageKey = undefined;
      return;
    }

    if (!deps.delivery || !deps.env.KINDLE_EMAIL) {
      await repo.update(taskId, {
        status: "staged",
        errorMessage: "File staged in R2; delivery adapter is not configured.",
      });
      return;
    }

    const object = await deps.env.FILES.get(storageKey);
    if (!object) throw new Error("Staged file disappeared from R2.");

    await repo.update(taskId, { status: "delivering", errorMessage: null });
    if (await isCancelled(repo, taskId)) {
      await cleanupCancelledObject(deps.env, storageKey);
      activeStorageKey = undefined;
      return;
    }

    deliveryStarted = true;
    const receipt = await deps.delivery.deliver({
      task: (await repo.get(taskId))!,
      object,
      kindleEmail: deps.env.KINDLE_EMAIL,
    });

    await repo.update(taskId, {
      status: "delivered",
      deliveryReceipt: receipt,
      errorMessage: null,
    });
    deliveryStarted = false;

    try {
      await deps.env.FILES.delete(storageKey);
      activeStorageKey = undefined;
    } catch (cleanupError) {
      console.warn("Delivered task R2 cleanup failed", taskId, cleanupError);
    }
  } catch (error) {
    if (await isCancelled(repo, taskId)) {
      if (activeStorageKey) await cleanupCancelledObject(deps.env, activeStorageKey);
      return;
    }

    const message = error instanceof Error ? error.message : "Unknown workflow failure";
    if (deliveryStarted) {
      try {
        await repo.update(taskId, {
          status: "delivery_unknown",
          errorMessage:
            `Gmail delivery started but its final outcome could not be confirmed: ${message}. ` +
            "Automatic resend was blocked to avoid a duplicate Kindle document.",
        });
        return;
      } catch (stateError) {
        console.error("Could not persist delivery_unknown state", taskId, stateError);
        throw error;
      }
    }

    await repo.update(taskId, {
      status: "failed",
      errorMessage: message,
    });
    throw error;
  }
}
