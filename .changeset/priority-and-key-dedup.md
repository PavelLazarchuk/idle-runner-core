---
'@idle-runner/core': minor
---

Add task `priority` and `key`-based deduplication. Both are opt-in; a call that never sets either behaves exactly as before — plain FIFO.

- **`priority`** — `push`/`pushChunked` accept `priority: 'user-blocking' | 'user-visible' | 'background'` (default `'user-visible'`). Three FIFO buckets, drained highest-first. A new `agingMs` runner option (default `1000`, `Infinity` disables it) guards against starvation: a task that has waited longer than that outranks everything ahead of it, oldest-starved-first. Priority is cooperative for plain functions — a running one always finishes — but a **suspended `pushChunked` generator** is parked at its next `yield` for genuinely higher-priority work and resumed afterward from the same point.
- **`key`** — `push`/`pushChunked` accept `key: PropertyKey`. A second push with the same key supersedes a pending one with that key: the stale task rejects with `AbortError` (silent under `onError`, like other aborts) and never runs. Closes the common "recompute on every keystroke, only the latest matters" pattern without hand-rolling an `AbortController` per key. Only pending work is superseded — a task already running keeps going.
