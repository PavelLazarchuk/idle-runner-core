import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { IdleRunner } from '../src/core/idle-runner';
import { FakeScheduler } from './fake-scheduler';

function makeRunner(budgetMs = 5) {
    const fake = new FakeScheduler();
    const runner = new IdleRunner({ scheduler: fake, budgetMs, flushOnHidden: false });
    return { fake, runner };
}

describe('push — budgeted drain', () => {
    it('resolves a pushed task with its return value', async () => {
        const { fake, runner } = makeRunner();
        const promise = runner.push(() => 42);
        expect(runner.size).toBe(1);
        fake.fireSlice(100);
        await expect(promise).resolves.toBe(42);
        expect(runner.size).toBe(0);
    });

    it('runs tasks FIFO', async () => {
        const { fake, runner } = makeRunner();
        const order: string[] = [];
        const promises = ['a', 'b', 'c'].map(id => runner.push(() => order.push(id)));
        fake.fireSlice(100);
        await Promise.all(promises);
        expect(order).toEqual(['a', 'b', 'c']);
    });

    it('starts a task at remaining=6 but not at remaining=4 (budgetMs=5)', () => {
        const { fake, runner } = makeRunner(5);
        const ran: string[] = [];
        void runner.push(() => ran.push('a'));
        void runner.push(() => ran.push('b'));
        const sequence = [6, 4];
        fake.fireSlice(() => sequence.shift() ?? 0);
        expect(ran).toEqual(['a']);
        expect(runner.size).toBe(1);
        expect(fake.pending).toBe(1);
    });

    it('starts nothing when the slice opens below the budget', () => {
        const { fake, runner } = makeRunner(5);
        const spy = vi.fn();
        void runner.push(spy);
        fake.fireSlice(4);
        expect(spy).not.toHaveBeenCalled();
        expect(runner.size).toBe(1);
    });

    it('isolates a throwing task: neighbours still settle', async () => {
        const { fake, runner } = makeRunner();
        const boom = new Error('boom');
        const a = runner.push(() => 'a');
        const b = runner.push(() => {
            throw boom;
        });
        const c = runner.push(() => 'c');
        fake.fireSlice(100);
        await expect(a).resolves.toBe('a');
        await expect(b).rejects.toBe(boom);
        await expect(c).resolves.toBe('c');
    });

    it('a task pushed from inside a task lands in the next slice, not this one', async () => {
        const { fake, runner } = makeRunner();
        let innerRan = false;
        const outer = runner.push(() => {
            void runner.push(() => {
                innerRan = true;
            });
        });
        fake.fireSlice(100);
        await outer;
        expect(innerRan).toBe(false);
        expect(fake.pending).toBe(1);
        fake.fireSlice(100);
        expect(innerRan).toBe(true);
    });

    it('a burst of pushes without timeouts arms exactly one request', () => {
        const { fake, runner } = makeRunner();
        for (let i = 0; i < 1000; i++) void runner.push(() => i);
        expect(fake.log.filter(e => e.op === 'request')).toHaveLength(1);
    });

    it('nulls task internals after settling (no closure retention)', async () => {
        const { fake, runner } = makeRunner();
        const promise = runner.push(() => 'x');
        const internal = (runner as unknown as { _queue: Array<Record<string, unknown>> })
            ._queue[0]!;
        fake.fireSlice(100);
        await promise;
        expect(internal._resolve).toBeNull();
        expect(internal._reject).toBeNull();
        expect(internal._run).toBeNull();
        expect(internal._signal).toBeNull();
    });

    it('isRunning is true only while a slice executes', async () => {
        const { fake, runner } = makeRunner();
        let seenDuringTask: boolean | null = null;
        const p = runner.push(() => {
            seenDuringTask = runner.isRunning;
        });
        expect(runner.isRunning).toBe(false);
        fake.fireSlice(100);
        await p;
        expect(seenDuringTask).toBe(true);
        expect(runner.isRunning).toBe(false);
    });
});

describe('push — timeout / forced drain', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(0);
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    it('didTimeout regression (§0): the expired task runs even though timeRemaining() is 0', async () => {
        const { fake, runner } = makeRunner();
        const spy = vi.fn(() => 'forced');
        const promise = runner.push(spy, { timeout: 50 });
        vi.advanceTimersByTime(50);
        fake.fireTimeout();
        expect(spy).toHaveBeenCalledOnce();
        await expect(promise).resolves.toBe('forced');
    });

    it('forced drain runs ONLY expired tasks; unexpired ones stay queued', async () => {
        const { fake, runner } = makeRunner();
        const ran: string[] = [];
        const a = runner.push(() => ran.push('a'), { timeout: 50 });
        void runner.push(() => ran.push('b'), { timeout: 5000 });
        void runner.push(() => ran.push('c'));
        vi.advanceTimersByTime(60);
        fake.fireTimeout();
        await a;
        expect(ran).toEqual(['a']);
        expect(runner.size).toBe(2);
        expect(fake.lastRequestTimeout).toBe(4940);
    });

    it('reconciles the armed timeout: earlier deadline cancels and re-requests', () => {
        const { fake, runner } = makeRunner();
        void runner.push(() => 'a', { timeout: 1000 });
        expect(fake.log).toEqual([{ op: 'request', timeout: 1000 }]);
        void runner.push(() => 'b', { timeout: 100 });
        expect(fake.log).toEqual([
            { op: 'request', timeout: 1000 },
            { op: 'cancel', handle: 1 },
            { op: 'request', timeout: 100 },
        ]);
        void runner.push(() => 'c', { timeout: 5000 });
        expect(fake.log).toHaveLength(3);
    });

    it('a push with a deadline re-arms a request that was armed without one', () => {
        const { fake, runner } = makeRunner();
        void runner.push(() => 'idle-only');
        expect(fake.lastRequestTimeout).toBeUndefined();
        void runner.push(() => 'urgent', { timeout: 200 });
        expect(fake.lastRequestTimeout).toBe(200);
    });

    it('an expired chunked task is run to completion on forced drain', async () => {
        const { fake, runner } = makeRunner();
        const steps: number[] = [];
        function* work() {
            steps.push(1);
            yield;
            steps.push(2);
            yield;
            steps.push(3);
            return 'done';
        }
        const promise = runner.pushChunked(work(), { timeout: 50 });
        vi.advanceTimersByTime(50);
        fake.fireTimeout();
        expect(steps).toEqual([1, 2, 3]);
        await expect(promise).resolves.toBe('done');
    });
});
