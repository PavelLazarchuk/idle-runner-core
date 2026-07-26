# @idle-runner/core

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
