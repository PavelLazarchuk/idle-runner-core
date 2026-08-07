---
'@idle-runner/core': minor
---

Progress reporting, list helpers and `whenIdle()`.

- `pushChunked` accepts `onProgress`, called with every value the generator yields — a progress channel that costs nothing when unused. A throwing `onProgress` is warned about, never fails the task.
- New tree-shakeable `idleMap` / `idleForEach`: `map`/`forEach` over any iterable, spread across idle slices, with `chunkSize` and item-count progress. Importing `IdleRunner` alone does not pull them in.
- New `IdleRunner#whenIdle()`: resolves once the queue is empty, whether tasks resolved, rejected or aborted. Never rejects.
