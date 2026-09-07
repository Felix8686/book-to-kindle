# Telegram Assistant Architecture

## Why this exists

The Telegram entry point used to treat almost every non-command text message as a book title. That made inputs such as an author name (`倪匡`) enter the download workflow and forced the product into an endless cycle of adding special-case parsers.

The text entry point is now assistant-first:

`Telegram text -> LLM semantic router -> reply / book tool / status tool`

Book search, source resolution, download, R2 staging, Gmail delivery and Kindle delivery remain the existing workflow. They are tools behind the assistant rather than the default interpretation of every message.

## Actions

The assistant may return only three actions:

- `reply`: normal conversational response. No task is created.
- `book`: create an existing `BookRequest` and enqueue the existing Kindle workflow.
- `status`: query the user's latest existing task.

Explicit `/send <book>` remains deterministic and bypasses the LLM.

## Conversation context

Migration `0009_telegram_conversation.sql` adds bounded recent Telegram conversation history. Only the latest 12 user/assistant messages per private chat/user are retained by the application. The assistant reads the latest 8 by default so follow-up references such as `第二本发到 Kindle` can be resolved from recent context.

If the history table is temporarily unavailable, conversation reads/writes degrade safely and do not block the Telegram interaction.

## Failure behavior

An AI routing failure must never fall back to treating arbitrary text as a book title.

Only text with an explicit book-delivery/search action may use the legacy parser as a fallback. Otherwise the bot replies that it could not reliably understand the message and creates no Kindle task.

## Regression acceptance cases

1. `倪匡` -> conversational reply; no task row and no Queue book message.
2. `倪匡有哪些值得看？` -> recommendation/conversation reply; no task.
3. `把《寻秦记》发到 Kindle` -> one book task with query `寻秦记`.
4. Recommendation reply containing several books, followed by `第二本发到 Kindle` -> resolves the referenced title from recent history and creates one book task.
5. `刚才那本发成功了吗？` -> status tool; does not create a new task.
6. `/send Pride and Prejudice` -> deterministic existing send path still works even if Workers AI is unavailable.
7. Simulated Workers AI failure + input `倪匡` -> safe reply; no task.
8. Simulated Workers AI failure + explicit `把《寻秦记》发到 Kindle` -> deterministic fallback may create the task.
9. Existing image recognition, candidate selection, Queue processing, Gmail delivery and task-state notifications remain unchanged.

## Deployment order

1. Apply D1 migration `0009_telegram_conversation.sql`.
2. Run typecheck and unit tests.
3. Run isolated Telegram webhook tests with mocked Telegram and Workers AI.
4. Deploy Worker only after regression evidence is clean.
5. Do not merge to `main` until production acceptance passes.
