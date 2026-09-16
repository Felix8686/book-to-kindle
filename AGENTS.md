# Book to Kindle agent rules

These are architecture constraints, not suggestions.

## Natural language vs deterministic code

The model owns natural-language understanding:

- intent;
- conversation context;
- references such as “第二本”, “刚才那本”, and “这本”;
- deciding which deterministic code action is needed;
- asking for clarification when intent/reference cannot be resolved safely.

Deterministic code owns:

- entity grounding and validation;
- bibliographic facts and author/work lookup;
- source relevance filtering, ranking and deduplication;
- downloads / format handling;
- D1 state and idempotency;
- Queue jobs and execution leases;
- R2 objects;
- Gmail delivery fences and Send-to-Kindle side effects;
- task status / cancellation;
- permissions, quotas, retries and timeouts.

Do not fix natural-language bugs with growing regex/keyword tables or per-title/per-author hardcoding.

Do not let the model invent facts code can retrieve.

## Entity grounding is mandatory

Any model-returned title/author that will drive a catalog lookup or book task must be grounded in the current user text or bounded conversation history.

The model is not allowed to silently correct, translate, rewrite, expand or glyph-substitute a user-visible entity.

If grounding fails, clarify and create no side effect.

## Queue / side-effect safety

- Free-form Telegram AI work belongs behind Queue, not inside the webhook.
- Durable assistant-job state must make reply retries safe.
- Duplicate/replayed book Queue messages must be serialized by execution lease.
- Gmail delivery must remain protected by a permanent task-scoped delivery fence.
- An uncertain delivery must never be blindly resent.
- If Gmail acceptance is durably recorded but TaskRecord was not updated before a crash, recover the accepted receipt rather than marking it unknown or resending.

## Workers AI

Workers AI methods are receiver-sensitive. Use `runWorkersAi` / `createReceiverSafeAi`; never invoke a detached bare `env.AI.run`.

Current intended models on the stabilization branch:

```text
assistant: @cf/meta/llama-3.3-70b-instruct-fp8-fast
vision:    @cf/qwen/qwen3.8-27b
```

Any model replacement must rerun the real entity/routing acceptance matrix.

## Development workflow

- Keep `main` unchanged until explicitly authorized.
- Develop on a branch and preserve the Cloudflare-first architecture.
- Fix reusable bug classes at shared abstractions, not one call site at a time.
- Repository migrations must fully reproduce required production schema.
- CI/typecheck/unit tests are necessary but not sufficient.
- Do not merge or label a stabilization as complete without isolated real-environment acceptance covering Telegram, Workers AI, source discovery, Queue replay/concurrency, R2, Gmail fence recovery and one real Kindle last-mile delivery.

Current stabilization work is tracked by Issue #4 and Draft PR #5.
