import type {
    Deadline,
    IdleRunnerOptions,
    IdleTaskOptions,
    SchedulerAdapter,
    TaskPriority,
} from './types';
import { createAbortError } from './abort-error';
import { createSchedulerAdapter } from '../scheduler/adapter';
import { bindHiddenFlush } from '../scheduler/lifecycle';
import { hostNow } from '../scheduler/clock';

const DEFAULT_BUDGET_MS = 5;
const MIN_BUDGET_MS = 1;
const MAX_BUDGET_MS = 49;
const DEFAULT_AGING_MS = 1000;

const PRIORITY_RANKS: Record<string, number | undefined> = {
    'user-blocking': 0,
    'user-visible': 1,
    background: 2,
};
const RANK_COUNT = 3;
const DEFAULT_RANK = 1;

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
    _rank: number;
    _seq: number;
    _queuedAt: number;
    _key: PropertyKey | null;
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
    private readonly _agingMs: number;
    private readonly _scheduler: SchedulerAdapter;
    private readonly _unbindHidden: (() => void) | null;
    private readonly _onError: ((error: unknown) => void) | null;
    private readonly _queues: Task[][] = [[], [], []];
    private readonly _keyed = new Map<PropertyKey, Task>();
    private _nextSeq = 1;
    private _current: Task | null = null;
    private _handle: number | null = null;
    private _armedDeadlineAt: number | null = null;
    private _paused = false;
    private _inSlice = false;
    private _pendingFlush = false;
    private _warnedSlowStep = false;

    constructor(options: IdleRunnerOptions = {}) {
        let budget = options.budgetMs ?? DEFAULT_BUDGET_MS;

        if (!Number.isFinite(budget)) {
            devWarn(`budgetMs must be a finite number; using ${DEFAULT_BUDGET_MS}`);
            budget = DEFAULT_BUDGET_MS;
        } else if (budget > MAX_BUDGET_MS) {
            devWarn(`budgetMs clamped to ${MAX_BUDGET_MS}`);
            budget = MAX_BUDGET_MS;
        } else if (budget < MIN_BUDGET_MS) {
            devWarn(`budgetMs clamped to ${MIN_BUDGET_MS}`);
            budget = MIN_BUDGET_MS;
        }

        let aging = options.agingMs ?? DEFAULT_AGING_MS;

        if (Number.isNaN(aging) || aging < 0) {
            devWarn(`agingMs must be >= 0; using ${DEFAULT_AGING_MS}`);
            aging = DEFAULT_AGING_MS;
        }

        this._budgetMs = budget;
        this._agingMs = aging;
        this._onError = options.onError ?? null;
        this._scheduler = options.scheduler ?? createSchedulerAdapter({ budgetMs: budget });
        this._unbindHidden =
            options.flushOnHidden !== false ? bindHiddenFlush(() => this.flush()) : null;
    }

    destroy(): void {
        this._unbindHidden?.();
        this.clear();
    }

    push<T>(fn: () => T, options?: IdleTaskOptions): Promise<T> {
        return this._guard(this._enqueue<T>('fn', fn, null, options));
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
            return this._guard(Promise.reject(new TypeError('needs a sync generator')));
        }

        return this._guard(this._enqueue<T>('gen', null, generator, options));
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

        for (const bucket of this._queues) {
            for (const task of bucket.splice(0)) {
                if (task._settled) continue;

                this._closeGenerator(task);
                this._settle(task, false, error);
            }
        }

        this._keyed.clear();
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
        let total = this._current ? 1 : 0;

        for (const bucket of this._queues) total += bucket.length;

        return total;
    }

    get isRunning(): boolean {
        return this._inSlice;
    }

    private _guard<T>(promise: Promise<T>): Promise<T> {
        if (this._onError) promise.catch(this._reportError);

        return promise;
    }

    private readonly _reportError = (error: unknown): void => {
        if ((error as { name?: unknown } | null)?.name === 'AbortError') return;

        try {
            this._onError!(error);
        } catch {
            devWarn('onError threw');
        }
    };

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

        const rank = this._rankOf(options?.priority);
        const key = options?.key ?? null;

        return new Promise<T>((resolve, reject) => {
            const queuedAt = hostNow();
            const task: Task = {
                _kind: kind,
                _run: run,
                _gen: gen,
                _resolve: resolve as (value: unknown) => void,
                _reject: reject,
                _deadlineAt: options?.timeout != null ? queuedAt + options.timeout : null,
                _signal: signal,
                _onAbort: null,
                _settled: false,
                _rank: rank,
                _seq: this._nextSeq++,
                _queuedAt: queuedAt,
                _key: key,
            };

            if (key !== null) this._supersede(key, task);

            if (signal) {
                const onAbort = () => this._abortTask(task);
                task._onAbort = onAbort;
                signal.addEventListener('abort', onAbort, { once: true });
            }

            this._queues[rank]!.push(task);
            this._arm(task._deadlineAt);
        });
    }

    private _rankOf(priority: TaskPriority | undefined): number {
        if (priority === undefined) return DEFAULT_RANK;

        const rank = PRIORITY_RANKS[priority];

        if (rank === undefined) {
            devWarn(`unknown priority "${String(priority)}"; using user-visible`);

            return DEFAULT_RANK;
        }

        return rank;
    }

    private _supersede(key: PropertyKey, next: Task): void {
        const previous = this._keyed.get(key);

        if (previous && !previous._settled) {
            this._removeTask(previous);
            this._closeGenerator(previous);
            this._settle(previous, false, createAbortError('Superseded'));
        }

        this._keyed.set(key, next);
    }

    private _releaseKey(task: Task): void {
        if (task._key !== null && this._keyed.get(task._key) === task) {
            this._keyed.delete(task._key);
        }
    }

    private _removeTask(task: Task): void {
        const bucket = this._queues[task._rank]!;
        const index = bucket.indexOf(task);

        if (index !== -1) bucket.splice(index, 1);
    }

    private _take(
        maxSeq: number,
        predicate: ((task: Task) => boolean) | null,
        nowMs: number
    ): Task | null {
        let best: Task | null = null;
        let bestIndex = -1;
        let bestStarved = false;

        for (let rank = 0; rank < RANK_COUNT; rank++) {
            const bucket = this._queues[rank]!;
            let candidate: Task | null = null;
            let candidateIndex = -1;

            for (let i = 0; i < bucket.length; i++) {
                const task = bucket[i]!;

                if (task._seq > maxSeq) break;
                if (task._settled) continue;
                if (predicate && !predicate(task)) continue;

                candidate = task;
                candidateIndex = i;
                break;
            }

            if (!candidate) continue;

            const starved = nowMs - candidate._queuedAt >= this._agingMs;

            if (
                !best ||
                (starved && !bestStarved) ||
                (starved && bestStarved && candidate._queuedAt < best._queuedAt)
            ) {
                best = candidate;
                bestIndex = candidateIndex;
                bestStarved = starved;
            }
        }

        if (!best) return null;

        this._queues[best._rank]!.splice(bestIndex, 1);
        this._releaseKey(best);

        return best;
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
            min == null ? undefined : Math.max(0, min - hostNow())
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

        for (const bucket of this._queues) {
            for (const task of bucket) {
                if (task._deadlineAt != null && (min == null || task._deadlineAt < min)) {
                    min = task._deadlineAt;
                }
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
     * tasks. The sequence is snapshotted so tasks pushed from inside a running
     * task land in the next slice, never this one.
     */
    private _budgetedDrain(deadline: Deadline): void {
        const maxSeq = this._nextSeq - 1;

        while (!this._paused && deadline.timeRemaining() > this._budgetMs) {
            if (this._current && !this._preempt(maxSeq)) {
                this._stepCurrent();
                continue;
            }

            const task = this._take(maxSeq, null, hostNow());

            if (!task) break;
            if (task._kind === 'gen') {
                this._current = task;
                continue;
            }

            this._executeFn(task);
        }
    }

    private _preempt(maxSeq: number): boolean {
        const current = this._current!;

        for (let rank = 0; rank < current._rank; rank++) {
            for (const task of this._queues[rank]!) {
                if (task._seq > maxSeq) break;
                if (task._settled) continue;

                this._current = null;
                this._queues[current._rank]!.unshift(current);

                return true;
            }
        }

        return false;
    }

    private _forcedDrain(): void {
        const nowMs = hostNow();
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
        const maxSeq = this._nextSeq - 1;
        const nowMs = hostNow();

        if (this._current && (!predicate || predicate(this._current))) {
            const task = this._current;
            this._current = null;
            this._runToCompletion(task);
        }

        for (;;) {
            const task = this._take(maxSeq, predicate, nowMs);

            if (!task) break;
            if (task._settled) continue;

            this._runToCompletion(task);
        }
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

        const started = hostNow();

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
            this._removeTask(task);
        }
        this._closeGenerator(task);
        this._settle(task, false, createAbortError());
        this._disarm();
        this._arm();
    }

    private _closeGenerator(task: Task): void {
        const gen = task._gen;

        if (!gen || typeof gen.return !== 'function') return;

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

        this._releaseKey(task);
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

        const elapsed = hostNow() - started;

        if (elapsed > Math.max(50, this._budgetMs * 4)) {
            this._warnedSlowStep = true;
            devWarn(`slow chunk step (${elapsed}ms); yield more often`);
        }
    }
}
