# Telegram Assistant Architecture

## Non-negotiable principle

Book to Kindle uses this split at the architecture boundary:

`user natural language -> model understands intent/context -> code tool executes -> user-facing result`

The model owns natural-language understanding: intent, context and references such as `第二本`, `刚才那本`, and `这本`.

Deterministic code owns bibliographic facts, source search, downloads, D1/Queue/R2 state, Gmail/Kindle delivery, status and all other side effects.

Do not fix natural-language bugs by accumulating regexes or one-off author/title branches. Do not let the model invent book lists or task state when code can retrieve them.

The same rules are mirrored in the repository-root `AGENTS.md` so future coding agents see them before modifying the project.

## Why this exists

The Telegram entry point used to treat almost every non-command text message as a book title. That made inputs such as an author name (`倪匡`) enter the download workflow and forced the product into an endless cycle of adding special-case parsers.

The text entry point is assistant-first rather than title-first.

## Model routes and code actions

The model may classify an utterance into five semantic routes:

- `reply`: normal conversation or clarification; no side effect.
- `author_works`: model extracts the author; code queries Open Library / Google Books and builds the work list.
- `book_info`: model resolves a concrete title, including contextual references; code queries bibliographic metadata.
- `book`: model resolves a concrete title for Kindle delivery; code creates the existing `BookRequest` and runs the existing workflow.
- `status`: model recognizes a task-status question; code queries the user's latest real task.

`author_works` and `book_info` are executed inside the assistant layer and converted into a normal reply before Telegram receives the decision. Telegram still sees only conversational reply, book task, or status behavior.

Explicit `/send <book>` remains deterministic and bypasses the LLM.

## Bibliographic reliability

Author work lists and book metadata must be code-backed. The current catalog tool queries Open Library and Google Books, filters results by normalized author/title compatibility, deduplicates titles and prefers entries corroborated by multiple sources or stronger catalog coverage.

The model must not substitute its memory for these catalog tools. For example, `倪匡有哪些值得看？` is routed to `author_works`; the model is not allowed to invent the list itself.

This requirement was added after production validation showed the model could produce plausible but false author-work associations when allowed to answer from memory.

## Conversation context

Migration `0009_telegram_conversation.sql` adds bounded recent Telegram conversation history. Only the latest 12 user/assistant messages per private chat/user are retained, and the assistant reads all 12. This allows numbered code-generated lists to become stable context for follow-ups such as `第二本怎么样？` and `第二本发到 Kindle`.

If the history table is temporarily unavailable, conversation reads/writes degrade safely and do not block the Telegram interaction.

## Workers AI receiver safety

Cloudflare Workers AI binding methods are receiver-sensitive. Extracting `env.AI.run` and invoking it as a bare function can break internal private state.

`src/workers-ai.ts` provides receiver-safe invocation and a compatibility proxy. Text assistant calls use the shared invocation helper. The Queue boundary wraps the legacy image-recognition path with the compatibility proxy so image AI calls retain the original binding receiver as well.

This requirement was added after production logs captured `TypeError: Cannot set properties of undefined (setting '#options')` in both text and image AI paths.

## Failure behavior

An AI routing failure must never fall back to treating arbitrary text as a book title.

Only text with an explicit book-delivery/search action may use the legacy parser as a fallback. Otherwise the bot replies that it could not reliably understand the message and creates no Kindle task.

## Regression acceptance cases

1. `倪匡` -> conversational reply; no task row and no Queue book message.
2. `倪匡有哪些值得看？` -> `author_works`; returned titles must come from filtered catalog data, not model memory; no task.
3. Follow the numbered work list with `第二本怎么样？` -> model resolves the exact second title; code executes `book_info`; no task.
4. Follow the same list with `第二本发到 Kindle` -> model resolves the exact second title and creates exactly one book task.
5. `刚才那本发成功了吗？` -> `status`; no new task or Queue message. If the latest task is `needs_selection`, the correct answer is that delivery has not completed and user selection is still required.
6. `把《寻秦记》发到 Kindle` -> one book task with query `寻秦记`.
7. `/send Pride and Prejudice` -> deterministic existing send path works even if Workers AI is unavailable.
8. Simulated Workers AI failure + input `倪匡` -> safe reply; no task.
9. Simulated Workers AI failure + explicit `把《寻秦记》发到 Kindle` -> deterministic fallback may create the task.
10. Real image recognition must not reproduce the Workers AI receiver/private-field error.
11. Existing candidate selection, Queue processing, R2 cleanup, Gmail delivery and task-state notifications remain unchanged.

## Deployment order

1. Run typecheck and unit tests.
2. Run isolated Telegram / catalog / Workers AI receiver regression tests.
3. Deploy the feature branch Worker.
4. Re-run the real Telegram sequence, including contextual second-book resolution, status and a real image.
5. Do not merge to `main` until production acceptance passes.
