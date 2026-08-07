export interface Deadline {
    timeRemaining(): number;
    readonly didTimeout: boolean;
}

export interface SchedulerAdapter {
    request(callback: (deadline: Deadline) => void, timeout?: number): number;
    cancel(handle: number): void;
}

export type TaskPriority = 'user-blocking' | 'user-visible' | 'background';

export interface IdleTaskOptions {
    timeout?: number;
    signal?: AbortSignal;
    priority?: TaskPriority;
    key?: PropertyKey;
}

export interface IdleChunkedTaskOptions<P = unknown> extends IdleTaskOptions {
    /**
     * Called with every value the generator yields, in the slice that produced it —
     * a progress channel that costs nothing when unused. A throw is swallowed with a
     * dev warning: reporting progress must not be able to fail the task.
     */
    onProgress?: (value: P) => void;
}

export interface IdleRunnerOptions {
    budgetMs?: number;
    scheduler?: SchedulerAdapter;
    flushOnHidden?: boolean;
    onError?: (error: unknown) => void;
    agingMs?: number;
}
