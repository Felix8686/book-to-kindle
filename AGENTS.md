# Book to Kindle agent rules

These rules are architecture constraints, not suggestions.

## Natural language vs deterministic code

The model is the natural-language understanding layer. It is responsible for:

- understanding the user's wording and conversation context;
- resolving references such as “第二本”, “刚才那本”, and “这本”;
- deciding which deterministic application action/tool is needed;
- asking for clarification when the intent or referenced book cannot be resolved safely.

Deterministic code is responsible for everything after intent is understood, including:

- bibliographic facts and author/work lookup;
- source search and candidate ranking;
- downloads and format handling;
- D1 state and idempotency;
- Queue jobs;
- R2 objects;
- Gmail / Send-to-Kindle delivery;
- task status and cancellation;
- permissions, quotas, validation and side effects.

Do not fix language-understanding bugs by adding an ever-growing set of regexes, keyword branches or one-off author/title special cases. Fix the model routing/context contract instead.

Do not let the model invent deterministic facts that code can retrieve. In particular, author work lists, editions, publication metadata, source availability and task/delivery state must come from code-backed data sources.

The safe high-level flow is:

`user natural language -> model understands intent/context -> code tool executes -> structured result -> user-facing response`

Side-effectful actions such as creating a book task or sending to Kindle must only occur after the model has resolved a concrete target with sufficient confidence, or through an explicit deterministic command such as `/send`.

When AI fails, arbitrary text must fail safe as conversation/clarification; it must never silently degrade into “treat the whole message as a book title”.

## Development workflow

- Keep `main` unchanged during development unless explicitly authorized.
- Work on a feature/fix branch and validate before merge.
- Preserve the Cloudflare-first architecture unless a requirement genuinely needs local resources.
- A bug fix that reveals a reusable bug class should be fixed at the shared abstraction when practical, not patched independently in every call site.
