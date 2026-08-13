# @idle-runner/core

## 1.3.1

### Patch Changes

- 2525b84: Ignore a non-finite `timeout` instead of spinning the queue on it, and share one promise between `whenIdle()` callers.

    - `timeout` is now validated like `budgetMs`, `agingMs` and `chunkSize` already were: `NaN`, `Infinity` and non-numbers from JS callers warn in dev and are dropped. Before, such a value became the task's deadline, which the platform converts to `0` — the scheduler fired immediately with `didTimeout`, the forced drain found nothing due (`NaN <= now` is false), and the runner re-armed and fired again, forever, without ever running the task. It also made every later `push` cancel and re-arm the pending request, since no deadline compares as earlier than `NaN`.
    - `whenIdle()` hands every caller the same promise until the queue drains, instead of keeping a resolver per call — a runner that stays busy could not release any of them.

    Together these cost about 40 bytes, which puts the CJS bundle 20 B over its `size-limit` budget; that one entry moves from 3 kB to 3.1 kB. Both ESM entries stay at 3 kB.

## 1.3.0

### Minor Changes

- 8de0a39: Progress reporting, list helpers and `whenIdle()`.

    - `pushChunked` accepts `onProgress`, called with every value the generator yields — a progress channel that costs nothing when unused. A throwing `onProgress` is warned about, never fails the task.
    - New tree-shakeable `idleMap` / `idleForEach`: `map`/`forEach` over any iterable, spread across idle slices, with `chunkSize` and item-count progress. Importing `IdleRunner` alone does not pull them in.
    - New `IdleRunner#whenIdle()`: resolves once the queue is empty, whether tasks resolved, rejected or aborted. Never rejects.

## 1.2.1

### Patch Changes

- 53cd442: Add a `size-limit` budget and enforce it in CI. `npm run size` measures the built ESM and CJS bundles (minified + brotli) and fails if they exceed the limits in `.size-limit.json` — currently 3 kB for the full entry point, plus a tree-shaken `IdleRunner`-only entry so a regression in tree-shakeability shows up as a CI failure. Tooling only; the published bundle is unchanged.

## 1.2.0

### Minor Changes

- 4ffa7e9: Add task `priority` and `key`-based deduplication. Both are opt-in; a call that never sets either behaves exactly as before — plain FIFO.

    - **`priority`** — `push`/`pushChunked` accept `priority: 'user-blocking' | 'user-visible' | 'background'` (default `'user-visible'`). Three FIFO buckets, drained highest-first. A new `agingMs` runner option (default `1000`, `Infinity` disables it) guards against starvation: a task that has waited longer than that outranks everything ahead of it, oldest-starved-first. Priority is cooperative for plain functions — a running one always finishes — but a **suspended `pushChunked` generator** is parked at its next `yield` for genuinely higher-priority work and resumed afterward from the same point.
    - **`key`** — `push`/`pushChunked` accept `key: PropertyKey`. A second push with the same key supersedes a pending one with that key: the stale task rejects with `AbortError` (silent under `onError`, like other aborts) and never runs. Closes the common "recompute on every keystroke, only the latest matters" pattern without hand-rolling an `AbortController` per key. Only pending work is superseded — a task already running keeps going.

## 1.1.1

### Patch Changes

- ebb76ad: Improve npm/search discoverability: broaden `description`, add more `keywords` (including the full package name), and add npm badges to the README.

## 1.1.0

### Minor Changes

- 4c5fa9f: Add `sharedRunner()` and an `onError` option; fix a non-finite `budgetMs` silently hanging the queue.

    - **`sharedRunner()`** — the page-wide runner, created on first call. Most apps want one queue, and a shared one sidesteps the `destroy()` lifetime question that per-component runners raise.
    - **`onError`** — an error channel for tasks nobody awaited. It marks every task promise as handled, so fire-and-forget `push()` no longer produces unhandled rejections (including the `AbortError`s `destroy()` delivers). It observes rather than swallows: the returned promise still rejects. Aborts are not reported.
    - **Fix: a non-finite `budgetMs` stopped the queue forever.** `NaN` loses every comparison, so `timeRemaining() > NaN` was always false and nothing ever drained — silently. Non-finite and non-numeric values now warn and fall back to the default.
    - **Fix: `clear()` on a hand-written iterator without `return()`** no longer emits a bogus "generator cleanup threw" warning.
    - Task deadlines and slow-step measurements now use a monotonic clock (`performance.now()` where available) instead of `Date.now()`, so a system clock change cannot shift them.
    - The low `budgetMs` clamp now warns, matching the high clamp.

## 1.0.0

### Major Changes

- Initial release.
- TypeScript support.
- Documentation.
