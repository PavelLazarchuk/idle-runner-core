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

export interface IdleRunnerOptions {
    budgetMs?: number;
    scheduler?: SchedulerAdapter;
    flushOnHidden?: boolean;
    onError?: (error: unknown) => void;
    agingMs?: number;
}
