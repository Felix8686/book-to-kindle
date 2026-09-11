# Handoff — 2026-09-12 (zcode audit round)

## Round 2 update (same branch, semantic layer)

Commits after `dea20de` implement the Semantic/Deterministic Responsibility Boundary (see `docs/ARCHITECTURE.md` §3, now a standing constraint):

- **Architecture:** `docs/ARCHITECTURE.md` formally defines the boundary — semantic understanding (intent, entities, fuzzy language) belongs to the AI model; deterministic execution (routing, verification, ordering, delivery, state) belongs to code. Regex/keyword intent matching is prohibited as a model-avoidance strategy, and vice versa.
- **Implementation:** new `src/semantic.ts` (Workers AI text parsing via the existing `AI` binding, JSON Mode, model `@cf/qwen/qwen2.5-7b-instruct` by default, env-overridable via `SEMANTIC_TEXT_MODEL`) and `src/catalog.ts` (deterministic author-works catalog query). Telegram text entry now routes: explicit structured input -> legacy deterministic parser (no model call); free-form text -> `telegram_text_semantic` Queue job -> AI parse -> code routing (`find_book`/`send_book` -> normal `BookRequest` flow; `author_works` -> catalog reply; `unknown` -> clarification). No AI binding -> legacy behavior unchanged.
- **Author verification guarantee:** catalog works come from the resolved Open Library author entity and are filtered by `author_key` membership; books whose title/description/keywords merely mention the author can never appear (regression-tested with a poisoned fixture).
- **Tests:** 27/27 passing (16 prior + 11 new); `tsc --noEmit` clean. Existing tests unmodified.
- **Known trade-offs:** Open Library author search accepts its top entity for cross-script names (东野圭吾 vs Keigo Higashino) when no exact alias matches; works remain structurally verified, but a genuinely wrong top entity would list the wrong author's works — acceptable deterministic risk, revisit if observed. Reply titles are OL primary titles (often English for zh authors); edition-title enrichment is future work. AI parse runs in Queue (not webhook), so free-form requests get one extra async step (~seconds).


## Branch / HEAD

- Base: `main` @ `c88f646dc678a45a032f57e7900ba5f827993f11`
- Branch: `fix/booktokindle-zcode-20260911`
- Commits:
  - `7e89fa5` fix: stop adopting unverified Open Library top result into canonical identity
  - `ec0a902` fix: scope ZLibrary session credentials away from signed CDN download links
- Not merged into main.

## Problems found and fixed

### 1. Resolver adopted unverified Open Library top result (P1 — wrong-book risk)

- Symptom: when no OL search doc strictly matched title+author, `resolveOpenLibrary` fell back to `docs[0]` unconditionally and injected that unrelated work's ISBNs, authors and edition titles into the canonical identity.
- Impact: a contaminated candidate could gain +50 (ISBN overlap) / +45 (exact title) in `candidateScore` and be **auto-delivered as the wrong book** (`autoSelect` threshold 55). This reintroduced exactly the "metadata contamination" that v0.6.1 (commit 7679ddb) claimed to have fixed — the fallback was added in that same commit.
- Root cause: `docs[0]` fallback in `src/resolver.ts`.
- Fix: only a strictly verified doc (title compatible + author compatible) may become the canonical work. No fallback to unverified docs. The original request remains the fallback search identity (per architecture §8).
- Test: `src/resolver.test.ts` — "does not adopt an unrelated top Open Library result when no doc strictly matches" (failed before fix, passes after).

### 2. ZLibrary credentials leaked to third-party CDN hosts (P2 — security)

- Symptom: `ZLibrarySource.download()` sent `remix_userid`/`remix_userkey` cookies and headers to **any** download URL, including signed CDN links on unrelated hosts.
- Impact: account session credentials disclosed to third-party hosts on every eapi direct-CDN download. v0.6.1 CHANGELOG claimed this was fixed ("ZLibrary auth token handling scoped to prevent sending credentials to signed CDN download links") but commit 7679ddb never touched `src/adapters/zlibrary.ts` — the fix was documented, not implemented.
- Root cause: `download()` used `authHeaders(session)` unconditionally.
- Fix: auth headers are sent only when the download URL host is inside the account's session domains (via existing `isAllowedHost`); signed CDN links get a plain user-agent. `/dtoken/` links rewritten to personal domains still authenticate.
- Tests: `src/adapters/zlibrary.test.ts` — "does not send session credentials to a signed CDN download link" (failed before fix) and "still authenticates downloads routed through the account's own domain".

## Test evidence

- `npm run typecheck` — clean.
- `npm test` — 16/16 passed (13 pre-existing + 3 new regression tests). Pre-existing tests were not modified.
- Both fixes were reproduced first with failing tests before any code change.

## Audit notes / unresolved (not fixed this round, by priority)

1. **(P2) Source adapters other than ZLibrary apply no relevance pre-filter**: `googlebooks.ts`, `gutendex.ts`, `internetarchive.ts` push every returned record as a candidate. With fix #1 the scoring guard is much safer (wrong book no longer gains ISBN/title identity points), but irrelevant free-ebooks results can still crowd the candidate list and trigger unnecessary `needs_selection` pauses. A shared deterministic relevance check (like `isRelevantZLibraryResult`) or a bounded candidate cap per source would reduce selection noise. Note the architecture principle: "is this really the user's book" across ambiguous candidates is a semantic judgment — the current pause-at-`needs_selection` behavior is the correct deterministic fallback; don't replace it with more keyword heuristics.
2. **(P3) `isRelevantZLibraryResult` substring edge cases**: very short titles (<3 normalized chars) are always rejected; generic short titles can false-positive/negative. Acceptable today; revisit only with a real failing case.
3. **(P3) ZLibrary `zh` has no `languages[]` filter by design** (Chinese results are indexed under several language values); confirmed intentional in commit 425127e's test — do not "fix".
4. **(observed, no action) `pickDownloadUrl` accepts any https direct CDN link** returned by an authenticated eapi response; redirect safety is enforced via same-host check in `download()`. Consistent with docs/SOURCES.md's trust model for eapi responses.

## Suggested next steps

1. Review + merge branch into main (CI runs `npm test`).
2. Consider shared relevance pre-filtering for the three non-ZLibrary sources (item 1 above).
3. Live-verify one real ZLibrary download against the deployed Worker to confirm the CDN credential scoping behaves as unit-tested.

## Verification commands

```bash
npm run typecheck
npm test
```

## Round 3 update — real-environment acceptance (2026-09-12)

### Staging environment (fully isolated from production)

Created: D1 `book-to-kindle-staging` (beaac40b-…), Queue `book-to-kindle-tasks-staging` + DLQ, R2 `book-to-kindle-files-staging`, Worker `book-to-kindle-staging` (https://book-to-kindle-staging.mzer8-substracker.workers.dev), configured via `wrangler.staging.toml` (committed). Secrets set: placeholder bot token, random webhook secret, API token, allowlist 1118263109 (read from production D1, read-only). Production was never touched.

### Fails found in real environment, root-caused and fixed

1. **All AI calls failed with `TypeError: Cannot set properties of undefined (setting '#options')`.** Root cause: `env.AI.run` was captured as a detached function reference; workerd's `Ai` class reads call config from private fields, so the lost `this` broke every call. This also meant the pre-existing vision path (`recognizeBooksFromImage`) had never been able to work in production. Fix: `env.AI.run.bind(env.AI)` in `semantic.ts` and `telegram.ts`. Proven by controlled probe: bound call → request reached Workers AI; unbound → TypeError.
2. **`@cf/qwen/qwen2.5-7b-instruct` unusable on this account** (`AiError 5007: No such model`, 5/5 probes; one earlier success suggests flaky rollout). Default semantic model switched to `@cf/meta/llama-3.3-70b-instruct-fp8-fast` (stable, correct Chinese intent/entity extraction for 金庸/东野圭吾; overridable via `SEMANTIC_TEXT_MODEL`).

### Acceptance results (staging, synthetic UTF-8 Telegram updates)

1. 金庸有哪些出名的作品 — semantic branch taken (no task created), AI returned `intent=author_works, author=金庸`, catalog works from author_key verification were all genuine Jin Yong titles (書劍恩仇錄/鹿鼎記/神鵰俠侶…), zero title-keyword contamination. PASS (reply delivery itself unverifiable without real bot token — see below).
2. 倪匡有哪些出名的作品 — intent correct (`author_works`), but the model mis-extracts the character 匡 as 匣 (glyph confusion, reproduced in JSON mode and raw mode, also with 70b). Catalog then safely returns nothing ("没能确认" reply). FAIL — model capability limit, fail-safe behavior; not fixable with keyword patches per the architecture boundary. Revisit when a Chinese-strong model (e.g. Qwen) is stably available on the account.
3. 东野圭吾写过哪些小说 — AI returned `intent=author_works, author=东野圭吾`. PASS.
4. 把《天龙八部》发到 Kindle — `markers=true` → deterministic parser → task `{"query":"天龙八部","preferredFormat":"epub"}` created, no AI call, workflow ran real source searches and correctly ended `needs_source` (no ZLibrary credentials on staging). PASS.
5. 天龙八部 (bare title) — semantic branch → AI `find_book`, `title=天龙八部` → task created → `needs_source`. Base experience intact. PASS.

### Notes

- An initial "routing bug" (test 4 taking the semantic path) was a test-harness artifact: Git Bash `curl -d` sent the Chinese payload as GBK; real Telegram messages are UTF-8. Use `curl --data-binary @utf8-file.json` for webhook testing.
- Telegram replies could not be verified end-to-end because the production bot token cannot be exported from Cloudflare secrets; a placeholder token makes sendMessage fail with 401 (expected). To finish that last mile: set the real token on staging (`wrangler secret put TELEGRAM_BOT_TOKEN --config wrangler.staging.toml`) or point Telegram's webhook at staging temporarily.
- One-off probe worker `ai-probe-once` used for evidence was deleted after the round.
