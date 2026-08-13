---
'@idle-runner/core': patch
---

Ignore a non-finite `timeout` instead of spinning the queue on it, and share one promise between `whenIdle()` callers.

- `timeout` is now validated like `budgetMs`, `agingMs` and `chunkSize` already were: `NaN`, `Infinity` and non-numbers from JS callers warn in dev and are dropped. Before, such a value became the task's deadline, which the platform converts to `0` — the scheduler fired immediately with `didTimeout`, the forced drain found nothing due (`NaN <= now` is false), and the runner re-armed and fired again, forever, without ever running the task. It also made every later `push` cancel and re-arm the pending request, since no deadline compares as earlier than `NaN`.
- `whenIdle()` hands every caller the same promise until the queue drains, instead of keeping a resolver per call — a runner that stays busy could not release any of them.

Together these cost about 40 bytes, which puts the CJS bundle 20 B over its `size-limit` budget; that one entry moves from 3 kB to 3.1 kB. Both ESM entries stay at 3 kB.
