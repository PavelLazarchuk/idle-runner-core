import type { Deadline, IdleRunnerOptions, IdleTaskOptions, SchedulerAdapter } from './types';
import { createAbortError } from './abort-error';
import { createSchedulerAdapter } from '../scheduler/adapter';
import { bindHiddenFlush } from '../scheduler/lifecycle';

const DEFAULT_BUDGET_MS = 5;
const MAX_BUDGET_MS = 49;

// Internal members are _-prefixed so the build can mangle them (tsup
// esbuildOptions mangleProps) — they are the bulk of the shipped bytes.
interface Task {
    _kind: 'fn' | 'gen';
    _run: (() => unknown) | null;
    _gen: Generator<unknown, unknown, unknown> | null;
    _resolve: ((value: unknown) => void) | null;
    _reject: ((reason: unknown) => void) | null;
    _deadlineAt: number | null;
    _signal: AbortSignal | null;
    _onAbort: (() => void) | null;
    _settled: boolean;
}

declare const process: { env?: { NODE_ENV?: string } } | undefined;

function isDev(): boolean {
    return typeof process === 'undefined' || process?.env?.NODE_ENV !== 'production';
}

function devWarn(message: string): void {
    if (isDev() && typeof console !== 'undefined') {
        console.warn(`idle-runner: ${message}`);
    }
}

export class IdleRunner {
    private readonly _budgetMs: number;
    private readonly _scheduler: SchedulerAdapter;
    private readonly _unbindHidden: (() => void) | null;
    private _queue: Task[] = [];
    private _current: Task | null = null;
    private _handle: number | null = null;
    private _armedDeadlineAt: number | null = null;
    private _paused = false;
    private _inSlice = false;
    private _pendingFlush = false;
    private _warnedSlowStep = false;

    constructor(options: IdleRunnerOptions = {}) {
        let budget = options.budgetMs ?? DEFAULT_BUDGET_MS;

        if (budget > MAX_BUDGET_MS) {
            devWarn(`budgetMs clamped to ${MAX_BUDGET_MS}`);
            budget = MAX_BUDGET_MS;
        }
        if (budget < 1) budget = 1;

        this._budgetMs = budget;
        this._scheduler = options.scheduler ?? createSchedulerAdapter({ budgetMs: budget });
        this._unbindHidden =
            options.flushOnHidden !== false ? bindHiddenFlush(() => this.flush()) : null;
    }

    /** Unbind lifecycle listeners and reject pending tasks. Call when the runner is no longer needed. */
    destroy(): void {
        this._unbindHidden?.();
        this.clear();
    }

    push<T>(fn: () => T, options?: IdleTaskOptions): Promise<T> {
        return this._enqueue<T>('fn', fn, null, options);
    }

    pushChunked<T>(
        generator: Generator<unknown, T, unknown>,
        options?: IdleTaskOptions
    ): Promise<T> {
        const candidate = generator as unknown as Record<PropertyKey, unknown> | null;

        if (
            typeof candidate?.next !== 'function' ||
            typeof candidate?.[Symbol.iterator] !== 'function'
        ) {
            return Promise.reject(new TypeError('needs a sync generator'));
        }

        return this._enqueue<T>('gen', null, generator, options);
    }

    clear(reason?: unknown): void {
        const error = reason === undefined ? createAbortError() : reason;
        this._disarm();

        if (this._current) {
            const task = this._current;
            this._current = null;
            this._closeGenerator(task);
            this._settle(task, false, error);
        }

        for (const task of this._queue.splice(0)) {
            if (task._settled) continue;

            this._closeGenerator(task);
            this._settle(task, false, error);
        }
    }

    pause(): void {
        this._paused = true;
        this._disarm();
    }

    resume(): void {
        if (!this._paused) return;

        this._paused = false;
        this._arm();
    }

    flush(): void {
        this._disarm();

        if (this._inSlice) {
            this._pendingFlush = true;

            return;
        }

        this._flushNow();
    }

    get size(): number {
        return this._queue.length + (this._current ? 1 : 0);
    }

    get isRunning(): boolean {
        return this._inSlice;
    }

    private _enqueue<T>(
        kind: 'fn' | 'gen',
        run: (() => T) | null,
        gen: Generator<unknown, T, unknown> | null,
        options: IdleTaskOptions | undefined
    ): Promise<T> {
        const signal = options?.signal ?? null;

        if (signal?.aborted) {
            return Promise.reject(createAbortError());
        }

        return new Promise<T>((resolve, reject) => {
            const task: Task = {
                _kind: kind,
                _run: run,
                _gen: gen,
                _resolve: resolve as (value: unknown) => void,
                _reject: reject,
                _deadlineAt: options?.timeout != null ? Date.now() + options.timeout : null,
                _signal: signal,
                _onAbort: null,
                _settled: false,
            };

            if (signal) {
                const onAbort = () => this._abortTask(task);
                task._onAbort = onAbort;
                signal.addEventListener('abort', onAbort, { once: true });
            }

            this._queue.push(task);
            this._arm(task._deadlineAt);
        });
    }

    /**
     * Arm (or re-arm) the single outstanding scheduler request. rIC's timeout is
     * frozen at request time, so a push with an earlier deadline than the armed
     * one must cancel and re-request; later or absent deadlines keep the existing
     * request, which is what coalesces a burst of pushes into one request.
     */
    private _arm(candidate: number | null = null): void {
        if (this._paused || this._inSlice || this.size === 0) return;
        if (this._handle !== null) {
            const keep =
                candidate == null ||
                (this._armedDeadlineAt != null && this._armedDeadlineAt <= candidate);

            if (keep) return;

            this._scheduler.cancel(this._handle);
            this._handle = null;
        }

        const min = this._minDeadlineAt();
        this._armedDeadlineAt = min;
        this._handle = this._scheduler.request(
            this._onSlice,
            min == null ? undefined : Math.max(0, min - Date.now())
        );
    }

    private _disarm(): void {
        if (this._handle !== null) {
            this._scheduler.cancel(this._handle);
            this._handle = null;
        }

        this._armedDeadlineAt = null;
    }

    private _minDeadlineAt(): number | null {
        let min = this._current?._deadlineAt ?? null;

        for (const task of this._queue) {
            if (task._deadlineAt != null && (min == null || task._deadlineAt < min)) {
                min = task._deadlineAt;
            }
        }

        return min;
    }

    private readonly _onSlice = (deadline: Deadline): void => {
        this._handle = null;
        this._armedDeadlineAt = null;

        if (this._paused) return;

        this._inSlice = true;

        try {
            if (deadline.didTimeout) {
                this._forcedDrain();
            } else {
                this._budgetedDrain(deadline);
            }
        } finally {
            this._inSlice = false;
            this._afterSlice();
        }
    };

    private _afterSlice(): void {
        if (this._pendingFlush) {
            this._pendingFlush = false;
            this._flushNow();
        } else {
            this._arm();
        }
    }

    /**
     * Budgeted drain: the budget is checked BEFORE starting each task, not after —
     * starting a 40ms task with 0.3ms left is how an "INP library" creates long
     * tasks. The queue length is snapshotted so tasks pushed from inside a running
     * task land in the next slice, never this one.
     */
    private _budgetedDrain(deadline: Deadline): void {
        const initialLength = this._queue.length;
        let taken = 0;

        while (!this._paused && deadline.timeRemaining() > this._budgetMs) {
            if (this._current) {
                this._stepCurrent();
                continue;
            }
            if (taken >= initialLength) break;

            const task = this._queue.shift();

            if (!task) break;

            taken++;

            if (task._settled) continue;
            if (task._kind === 'gen') {
                this._current = task;
                continue;
            }

            this._executeFn(task);
        }
    }

    private _forcedDrain(): void {
        const nowMs = Date.now();
        this._drain(task => task._deadlineAt != null && task._deadlineAt <= nowMs);
    }

    private _flushNow(): void {
        this._inSlice = true;

        try {
            this._drain(null);
        } finally {
            this._inSlice = false;
            this._afterSlice();
        }
    }

    private _drain(predicate: ((task: Task) => boolean) | null): void {
        if (this._current && (!predicate || predicate(this._current))) {
            const task = this._current;
            this._current = null;
            this._runToCompletion(task);
        }

        const remaining: Task[] = [];

        for (const task of this._queue.splice(0)) {
            if (task._settled) continue;
            if (!predicate || predicate(task)) this._runToCompletion(task);
            else remaining.push(task);
        }

        this._queue = remaining.concat(this._queue);
    }

    private _executeFn(task: Task): void {
        try {
            const value = task._run!();
            this._settle(task, true, value);
        } catch (error) {
            this._settle(task, false, error);
        }
    }

    private _stepCurrent(): void {
        const task = this._current!;

        if (task._settled) {
            this._current = null;
            return;
        }

        const started = Date.now();

        try {
            const result = task._gen!.next();
            this._maybeWarnSlowStep(started);

            if (result.done) {
                this._current = null;
                this._settle(task, true, result.value);
            }
        } catch (error) {
            this._current = null;
            this._settle(task, false, error);
        }
    }

    private _runToCompletion(task: Task): void {
        if (task._kind === 'fn') {
            this._executeFn(task);

            return;
        }

        try {
            for (;;) {
                const result = task._gen!.next();

                if (result.done) {
                    this._settle(task, true, result.value);

                    return;
                }
                if (task._settled) return;
            }
        } catch (error) {
            this._settle(task, false, error);
        }
    }

    private _abortTask(task: Task): void {
        if (task._settled) return;
        if (this._current === task) {
            this._current = null;
        } else {
            const index = this._queue.indexOf(task);

            if (index !== -1) this._queue.splice(index, 1);
        }
        this._closeGenerator(task);
        this._settle(task, false, createAbortError());
        this._disarm();
        this._arm();
    }

    private _closeGenerator(task: Task): void {
        const gen = task._gen;

        if (!gen) return;

        try {
            gen.return(undefined);
        } catch {
            queueMicrotask(() => {
                try {
                    gen.return(undefined);
                } catch {
                    devWarn('generator cleanup threw');
                }
            });
        }
    }

    private _settle(task: Task, resolved: boolean, value: unknown): void {
        if (task._settled) return;

        task._settled = true;
        const deliver = resolved ? task._resolve : task._reject;

        if (task._signal && task._onAbort) {
            task._signal.removeEventListener('abort', task._onAbort);
        }

        task._resolve = null;
        task._reject = null;
        task._run = null;
        task._gen = null;
        task._signal = null;
        task._onAbort = null;
        deliver?.(value);
    }

    private _maybeWarnSlowStep(started: number): void {
        if (this._warnedSlowStep) return;

        const elapsed = Date.now() - started;

        if (elapsed > Math.max(50, this._budgetMs * 4)) {
            this._warnedSlowStep = true;
            devWarn(`slow chunk step (${elapsed}ms); yield more often`);
        }
    }
}
