# Task cancellation

Book to Kindle supports explicit cancellation without pretending that an email already being delivered can be recalled.

## User commands

Telegram private chat:

```text
/cancel
取消
撤回
```

`/cancel` cancels the most recent Telegram-linked task that is still safely cancellable.

A specific Telegram task can also be targeted:

```text
/cancel <task-id>
```

The task must belong to the same allowed Telegram user.

HTTP clients can cancel with:

```http
POST /api/v1/tasks/<task-id>/cancel
Authorization: Bearer <API_TOKEN>
```

## Cancellation boundary

Cancellation is accepted while a task is in one of these states:

```text
queued
searching
needs_source
needs_selection
downloading
staged
```

A successful cancellation writes the terminal database state:

```text
cancelled
```

The Queue workflow re-checks this state at important boundaries so work that was already in flight cannot overwrite the user's cancellation.

## Why `delivering` cannot be cancelled

Once the task has entered:

```text
delivering
```

Gmail transmission has begun. There is no reliable transactional recall that can guarantee the message has not already been accepted and forwarded toward Kindle.

Therefore these states are deliberately not cancellable:

```text
delivering
delivery_unknown
delivered
```

The service reports the request as too late instead of falsely claiming that the document was withdrawn.

## Race-safety design

Cancellation and Queue processing can happen concurrently.

The implementation protects the cancellation decision in several ways:

1. Task repository updates do not overwrite a task already marked `cancelled`.
2. Workflow processing re-reads task state after search, before/after download staging, and immediately before Gmail delivery.
3. Source-selection callbacks re-read the task after their guarded update; if cancellation won the race, they neither enqueue work nor claim that sending will continue.
4. If cancellation wins while an ebook is being staged, the temporary R2 object is deleted best-effort.
5. If the transition to `delivering` wins first, cancellation is rejected as too late.
6. A cancelled task does not become `failed` merely because in-flight work notices the cancellation while unwinding.

This favors truthful delivery state over pretending to provide an email/Kindle recall feature that does not exist.

## Image-recognition note

Before image recognition has produced a book task, there is not yet a core task ID to cancel. Low-confidence or multi-book image recognition already provides a `取消` button on its selection prompt.

Once image recognition creates a normal book task, the same `/cancel` rules apply.
