import type { Deadline, SchedulerAdapter } from '../src/core/types';

interface FakeRequest {
    id: number;
    callback: (deadline: Deadline) => void;
    timeout: number | undefined;
}

export type FakeLogEntry =
    { op: 'request'; timeout: number | undefined } | { op: 'cancel'; handle: number };

/**
 * Deterministic SchedulerAdapter: the test scripts the deadline instead of
 * mocking timers, so every loop branch is a plain synchronous assertion.
 */
export class FakeScheduler implements SchedulerAdapter {
    readonly log: FakeLogEntry[] = [];
    private nextId = 1;
    private readonly live = new Map<number, FakeRequest>();

    request(callback: (deadline: Deadline) => void, timeout?: number): number {
        const id = this.nextId++;
        this.live.set(id, { id, callback, timeout });
        this.log.push({ op: 'request', timeout });
        return id;
    }

    cancel(handle: number): void {
        if (this.live.delete(handle)) {
            this.log.push({ op: 'cancel', handle });
        }
    }

    get pending(): number {
        return this.live.size;
    }

    get lastRequestTimeout(): number | undefined {
        for (let i = this.log.length - 1; i >= 0; i--) {
            const entry = this.log[i];
            if (entry && entry.op === 'request') return entry.timeout;
        }
        return undefined;
    }

    fireSlice(remaining: number | (() => number)): void {
        const request = this.takeOldest();
        const timeRemaining = typeof remaining === 'function' ? remaining : () => remaining;
        request.callback({ didTimeout: false, timeRemaining });
    }

    fireTimeout(): void {
        const request = this.takeOldest();
        request.callback({ didTimeout: true, timeRemaining: () => 0 });
    }

    private takeOldest(): FakeRequest {
        const first = this.live.entries().next();
        if (first.done) {
            throw new Error('FakeScheduler: no live request to fire');
        }
        this.live.delete(first.value[0]);
        return first.value[1];
    }
}
