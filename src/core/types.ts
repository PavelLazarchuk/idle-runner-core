export interface Deadline {
    timeRemaining(): number;
    readonly didTimeout: boolean;
}

export interface SchedulerAdapter {
    request(callback: (deadline: Deadline) => void, timeout?: number): number;
    cancel(handle: number): void;
}

export interface IdleTaskOptions {
    timeout?: number;
    signal?: AbortSignal;
}

export interface IdleRunnerOptions {
    budgetMs?: number;
    scheduler?: SchedulerAdapter;
    flushOnHidden?: boolean;
}
