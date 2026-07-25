# @idle-runner/core

Run non-urgent work without blocking the main thread. ~2kb, zero dependencies, **works on Safari** — where `requestIdleCallback` has never shipped enabled and most "idle" libraries quietly stop being idle libraries.

Tasks are deferred and **time-sliced**: the runner executes them in small budgeted slices (5ms by default) between the browser's latency-critical work, so input handling and rendering never wait behind your queue.

## Install

```sh
npm install @idle-runner/core
```

## Usage

```ts
import { IdleRunner } from '@idle-runner/core';

const runner = new IdleRunner();

// Fire-and-forget deferral — resolves with the return value.
const index = await runner.push(() => buildSearchIndex(products));

// Heavy work, chunked: `yield` marks "safe to pause here".
function* computeAll(items: Item[]) {
    const results = [];
    for (const item of items) {
        results.push(expensiveTransform(item));
        yield; // the runner pauses here when the slice budget runs out
    }
    return results;
}
const results = await runner.pushChunked(computeAll(items));

// Work that must eventually run even if the page never goes idle:
await runner.push(sendAnalyticsBatch, { timeout: 2000 });
```

## When to use this — and when not to

**Good fits** — work whose result nobody is waiting on _right now_:

- prefetching and precomputing ahead of need
- warming caches and derived indexes
- analytics and logging flushes
- non-urgent state/DOM reconciliation
- hydrating below-the-fold widgets

**Bad fits — use something else:**

- ❌ **Work the next paint depends on.** If the user just clicked "apply coupon" and is watching the total, deferring that calculation to idle makes INP _worse_, not better. Compute it now.
- ❌ **Genuinely heavy, parallelizable work.** This library defers work on the main thread; it does not offload it. A 200ms computation is still a 200ms computation — chunk it with `pushChunked`, or move it to a **Web Worker**.
- ❌ **Async job concurrency control** (rate-limiting N fetches, etc.) — that's [`p-queue`](https://github.com/sindresorhus/p-queue)'s job. This library is about main-thread responsiveness, not async orchestration.

## API

### `new IdleRunner(options?)`

| Option          | Type               | Default | Description                                                                                                                                                                                                        |
| --------------- | ------------------ | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `budgetMs`      | `number`           | `5`     | Slice budget; a task starts only if more than this remains. Clamped to 49 (a task can only ever start when more than `budgetMs` remains, and the rIC deadline cap is 50, so 50 itself would never be satisfiable). |
| `scheduler`     | `SchedulerAdapter` | auto    | Override the environment ladder — the seam for tests and exotic hosts.                                                                                                                                             |
| `flushOnHidden` | `boolean`          | `true`  | Drain the queue on `visibilitychange: hidden` / `pagehide`, because hidden pages may never get another idle period — or never come back.                                                                           |

### Methods

| Member                          | Description                                                                                                                                                                                                           |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `push(fn, opts?)`               | Queue a function; resolves with its return value.                                                                                                                                                                     |
| `pushChunked(generator, opts?)` | Queue a generator; each `yield` is a pause point. Resolves with the generator's `return` value.                                                                                                                       |
| `clear(reason?)`                | Reject every pending task (`AbortError` by default, or your `reason`) and empty the queue.                                                                                                                            |
| `pause()` / `resume()`          | Stop/restart draining. A suspended generator resumes from the same `yield`.                                                                                                                                           |
| `flush()`                       | Run everything **now**, ignoring idleness. By construction this is a long task — it's the escape hatch, and what `flushOnHidden` calls.                                                                               |
| `size`                          | Pending task count (including a suspended generator).                                                                                                                                                                 |
| `isRunning`                     | `true` while the runner is executing a slice.                                                                                                                                                                         |
| `destroy()`                     | Unbind lifecycle listeners (`visibilitychange`/`pagehide`/Safari `beforeunload`) and `clear()` pending tasks. Call this when a runner is no longer needed — otherwise it is pinned in memory for the page's lifetime. |

Per-task options (`push` / `pushChunked`):

| Option    | Type          | Description                                                                                               |
| --------- | ------------- | --------------------------------------------------------------------------------------------------------- |
| `timeout` | `number`      | ms after which the task is force-run even if the page never goes idle. Omit = may wait indefinitely.      |
| `signal`  | `AbortSignal` | Abort this one task. Rejects with `AbortError`; a chunked task's `finally` blocks run via `gen.return()`. |

### `createSchedulerAdapter(options?)`

The environment ladder as a standalone adapter (`{ request, cancel }`, mirroring rIC's shape). Exported for tests and custom hosts; it is also the seam through which a future `scheduler.postTask` rung can land without a breaking change.
