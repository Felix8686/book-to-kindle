# Handoff — 2026-09-12 (zcode audit round)

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
