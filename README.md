# @idle-runner/core

Run non-urgent work without blocking the main thread. ~2kb, zero dependencies, **works on Safari** — where `requestIdleCallback` has never shipped enabled and most "idle" libraries quietly stop being idle libraries.

Tasks are deferred and **time-sliced**: the runner executes them in small budgeted slices (5ms by default) between the browser's latency-critical work, so input handling and rendering never wait behind your queue.

## Install

```sh
npm install @idle-runner/core
```

## Quick start

```ts
import { sharedRunner } from '@idle-runner/core';

// One queue per page is what you usually want — a second runner does not get
// a second main thread, it just splits the budget.
const runner = sharedRunner();

// Defer work nobody is waiting on. Resolves with the return value.
const index = await runner.push(() => buildSearchIndex(products));

// Work that must eventually run even if the page never goes idle:
await runner.push(() => flushAnalytics(events), { timeout: 2000 });
```

Heavy work goes through `pushChunked`, where every `yield` marks a point at which the runner is allowed to pause and hand the thread back:

```ts
function* thumbnailsFor(photos: Photo[]) {
    const out: Thumbnail[] = [];

    for (const photo of photos) {
        out.push(downscale(photo)); // ~4ms each — fine alone, 2s as a loop
        yield; // the runner stops here once the slice budget runs out
    }

    return out;
}

const thumbnails = await runner.pushChunked(thumbnailsFor(photos));
```

Without the runner that loop is one 2-second long task and the page is frozen for all of it. With it, the same work spreads across idle periods in ~5ms slices, and a click in the middle is still handled on the next frame.

### Cancelling

```ts
const controller = new AbortController();
const preview = runner.pushChunked(renderPreview(doc), { signal: controller.signal });

// User navigated away from the preview before it finished:
controller.abort(); // `preview` rejects with AbortError; the generator's finally runs
```

### In a component

The shared runner outlives every component, so there is nothing to clean up:

```tsx
function ProductList({ products }: { products: Product[] }) {
    useEffect(() => {
        const controller = new AbortController();

        sharedRunner()
            .push(() => warmImageCache(products), { signal: controller.signal })
            .catch(() => {}); // the abort below lands here

        return () => controller.abort();
    }, [products]);

    // ...
}
```

Reach for your own instance when you need a queue with a lifetime you control — a different budget, or one you can `clear()` wholesale. Then `destroy()` is mandatory, because a runner binds page lifecycle listeners and is otherwise pinned in memory for as long as the document lives:

```ts
useEffect(() => {
    const runner = new IdleRunner({ budgetMs: 10 });

    void runner.push(() => precomputeRoute(target));

    return () => runner.destroy(); // unbinds listeners, rejects pending tasks
}, [target]);
```

## Errors

`push` and `pushChunked` return real promises, and a task that throws rejects its promise. That means **a task you never awaited is an unhandled rejection** — including the `AbortError`s that `clear()` and `destroy()` deliver to everything still queued:

```ts
runner.push(() => JSON.parse(maybeInvalid)); // ⚠️ throws → unhandled rejection
```

Pick one of these:

```ts
// 1. Handle it at the call site.
runner.push(() => JSON.parse(maybeInvalid)).catch(reportToSentry);

// 2. Or hand the runner an error channel once, and stop thinking about it.
const runner = new IdleRunner({
    onError: error => reportToSentry(error),
});

runner.push(() => JSON.parse(maybeInvalid)); // reported, never unhandled
```

`onError` marks every task promise as handled, so fire-and-forget stops being a footgun. It does not swallow anything — `await runner.push(...)` still rejects exactly as before, and a `.catch()` you attach yourself still runs.

Aborts are deliberately **not** reported to `onError`: `destroy()` cancelling ten pending tasks is a requested outcome, not ten errors. A custom reason passed to `clear(reason)` is reported, because that one is yours.

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

## Does it actually work?

The claim is tested in a real browser rather than asserted, in [`test/browser/runner.browser.test.ts`](test/browser/runner.browser.test.ts), with a `PerformanceObserver` watching for `longtask` entries — and, crucially, **with a negative control**, because a benchmark that only shows the good number proves nothing:

| workload                                       | long tasks (≥50ms) observed |
| ---------------------------------------------- | --------------------------- |
| 180ms of work run directly (the control)       | at least one — as it must   |
| the same work through `IdleRunner` (60 × ~3ms) | none                        |

A companion test keeps a `requestAnimationFrame` loop running while a 100-task queue drains and asserts that frames keep arriving — the thread is shared, not monopolised.

Both run on **Chromium and WebKit** in CI, so the Safari path is covered by the same suite as everything else.

## How it works

`requestIdleCallback` does not exist in Safari and never has. The runner therefore picks the best available scheduling primitive at first use, in this order:

| rung                  | used where        | why it sits here                                                                                          |
| --------------------- | ----------------- | --------------------------------------------------------------------------------------------------------- |
| `requestIdleCallback` | Chromium, Firefox | real idle deadlines, straight from the browser — nothing to synthesise                                    |
| `setImmediate`        | Node              | ahead of `MessageChannel`: Node ≥15 exposes a global `MessageChannel` whose open port pins the event loop |
| `MessageChannel`      | Safari / WebKit   | no rIC, ever — and `setTimeout` would hit the 4ms nested-timer clamp, quadrupling the gap between slices  |
| `setTimeout(0)`       | anything else     | last resort                                                                                               |

Below the top rung there is no real deadline to read, so the runner synthesises one worth `2 × budgetMs` and re-checks it before starting each task. The budget is checked **before** a task starts, never after: starting a 40ms task with 0.3ms left on the clock is exactly how an "INP library" ends up creating long tasks.

Detection is lazy — no host global is touched until the first `push`.

## SSR / Node

Safe to import and run on the server. There is no top-level access to `window`, `document` or any timer; the lifecycle listeners no-op without a `document`, and in Node the queue drains on the `setImmediate` rung. Importing the package in a Next.js/Nuxt/Remix server bundle needs no `typeof window` guard and no dynamic import. This is covered by [`test/ssr.test.ts`](test/ssr.test.ts), which runs the full queue, chunked work and timeouts in a plain Node environment.

## API

### `sharedRunner()`

The page-wide runner with default options, created on first call. Use it unless you specifically need your own lifetime or budget. Not destroyable by design — it is meant to live as long as the page.

### `new IdleRunner(options?)`

| Option          | Type                       | Default | Description                                                                                                                                                                                                          |
| --------------- | -------------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `budgetMs`      | `number`                   | `5`     | Slice budget; a task starts only if more than this remains. Clamped to 1…49 (a task can only ever start when more than `budgetMs` remains, and the rIC deadline cap is 50, so 50 itself would never be satisfiable). |
| `scheduler`     | `SchedulerAdapter`         | auto    | Override the environment ladder — the seam for tests and exotic hosts.                                                                                                                                               |
| `flushOnHidden` | `boolean`                  | `true`  | Drain the queue on `visibilitychange: hidden` / `pagehide`, because hidden pages may never get another idle period — or never come back.                                                                             |
| `onError`       | `(error: unknown) => void` | —       | Error channel for tasks nobody awaited. See [Errors](#errors). Aborts are not reported.                                                                                                                              |

### Methods

| Member                          | Description                                                                                                                                                                                                           |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `push(fn, opts?)`               | Queue a function; resolves with its return value.                                                                                                                                                                     |
| `pushChunked(generator, opts?)` | Queue a generator; each `yield` is a pause point. Resolves with the generator's `return` value.                                                                                                                       |
| `clear(reason?)`                | Reject every pending task (`AbortError` by default, or your `reason`) and empty the queue.                                                                                                                            |
| `pause()` / `resume()`          | Stop/restart draining. A suspended generator resumes from the same `yield`. Note that `timeout` deadlines do not fire while paused.                                                                                   |
| `flush()`                       | Run everything **now**, ignoring idleness. By construction this is a long task — it's the escape hatch, and what `flushOnHidden` calls.                                                                               |
| `size`                          | Pending task count (including a suspended generator).                                                                                                                                                                 |
| `isRunning`                     | `true` while the runner is executing a slice.                                                                                                                                                                         |
| `destroy()`                     | Unbind lifecycle listeners (`visibilitychange`/`pagehide`/Safari `beforeunload`) and `clear()` pending tasks. Call this when a runner is no longer needed — otherwise it is pinned in memory for the page's lifetime. |

Per-task options (`push` / `pushChunked`):

| Option    | Type          | Description                                                                                               |
| --------- | ------------- | --------------------------------------------------------------------------------------------------------- |
| `timeout` | `number`      | ms after which the task is force-run even if the page never goes idle. Omit = may wait indefinitely.      |
| `signal`  | `AbortSignal` | Abort this one task. Rejects with `AbortError`; a chunked task's `finally` blocks run via `gen.return()`. |

Deadlines are measured on a monotonic clock (`performance.now()` where available), so a system clock change mid-flight cannot shift them.

### `createSchedulerAdapter(options?)`

The environment ladder as a standalone adapter (`{ request, cancel }`, mirroring rIC's shape). Exported for tests and custom hosts; it is also the seam through which a future `scheduler.postTask` rung can land without a breaking change.

## License

MIT
