import { describe, expect, it, vi } from 'vitest';

import { IdleRunner } from '../src/core/idle-runner';
import { FakeScheduler } from './fake-scheduler';

function makeRunner(budgetMs = 5) {
    const fake = new FakeScheduler();
    const runner = new IdleRunner({ scheduler: fake, budgetMs, flushOnHidden: false });
    return { fake, runner };
}

describe('pushChunked onProgress', () => {
    it('reports every yielded value and not the return value', async () => {
        const { fake, runner } = makeRunner();
        const seen: number[] = [];
        function* work() {
            yield 1;
            yield 2;
            return 3;
        }
        const promise = runner.pushChunked(work(), { onProgress: value => seen.push(value) });
        fake.fireSlice(100);
        await expect(promise).resolves.toBe(3);
        expect(seen).toEqual([1, 2]);
    });

    it('keeps reporting across slice boundaries', async () => {
        const { fake, runner } = makeRunner(5);
        const seen: number[] = [];
        function* work() {
            yield 1;
            yield 2;
            return 'done';
        }
        const promise = runner.pushChunked(work(), { onProgress: value => seen.push(value) });
        const sequence = [20, 14, 4];
        fake.fireSlice(() => sequence.shift() ?? 0);
        expect(seen).toEqual([1]);
        fake.fireSlice(100);
        await expect(promise).resolves.toBe('done');
        expect(seen).toEqual([1, 2]);
    });

    it('reports on the forced-drain path too', async () => {
        const { fake, runner } = makeRunner();
        const seen: number[] = [];
        function* work() {
            yield 1;
            yield 2;
            return 'flushed';
        }
        const promise = runner.pushChunked(work(), { onProgress: value => seen.push(value) });
        runner.flush();
        await expect(promise).resolves.toBe('flushed');
        expect(seen).toEqual([1, 2]);
        expect(fake.pending).toBe(0);
    });

    it('a throwing onProgress warns but does not fail the task', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const { fake, runner } = makeRunner();
        function* work() {
            yield 1;
            return 'survived';
        }
        const promise = runner.pushChunked(work(), {
            onProgress: () => {
                throw new Error('reporting blew up');
            },
        });
        fake.fireSlice(100);
        await expect(promise).resolves.toBe('survived');
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('onProgress threw'));
        warn.mockRestore();
    });

    it('stops reporting once the task is aborted', async () => {
        const { fake, runner } = makeRunner(5);
        const seen: number[] = [];
        function* forever() {
            for (let i = 1; ; i++) yield i;
        }
        const controller = new AbortController();
        const promise = runner.pushChunked(forever(), {
            signal: controller.signal,
            onProgress: value => seen.push(value),
        });
        promise.catch(() => {});
        const sequence = [20, 14, 4];
        fake.fireSlice(() => sequence.shift() ?? 0);
        const afterSlice = [...seen];
        controller.abort();
        await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
        expect(seen).toEqual(afterSlice);
    });
});

describe('whenIdle', () => {
    it('resolves immediately on an empty queue', async () => {
        const { runner } = makeRunner();
        await expect(runner.whenIdle()).resolves.toBeUndefined();
    });

    it('resolves after the last queued task settles', async () => {
        const { fake, runner } = makeRunner();
        const order: string[] = [];
        void runner.push(() => order.push('a'));
        void runner.push(() => order.push('b'));
        const idle = runner.whenIdle().then(() => order.push('idle'));
        fake.fireSlice(100);
        await idle;
        expect(order).toEqual(['a', 'b', 'idle']);
    });

    it('stays pending while tasks are still queued', async () => {
        const { fake, runner } = makeRunner(5);
        let settled = false;
        function* work() {
            yield;
            yield;
        }
        void runner.pushChunked(work());
        void runner.whenIdle().then(() => (settled = true));
        const sequence = [20, 14, 4];
        fake.fireSlice(() => sequence.shift() ?? 0);
        await Promise.resolve();
        expect(settled).toBe(false);
        expect(runner.size).toBe(1);
        fake.fireSlice(100);
        await runner.whenIdle();
        expect(settled).toBe(true);
    });

    it('resolves rather than rejects when the task fails', async () => {
        const { fake, runner } = makeRunner();
        runner
            .push(() => {
                throw new Error('boom');
            })
            .catch(() => {});
        const idle = runner.whenIdle();
        fake.fireSlice(100);
        await expect(idle).resolves.toBeUndefined();
    });

    it('resolves when the queue is cleared instead of run', async () => {
        const { runner } = makeRunner();
        runner.push(() => 'never').catch(() => {});
        const idle = runner.whenIdle();
        runner.clear();
        await expect(idle).resolves.toBeUndefined();
    });

    it('resolves when the only task is aborted', async () => {
        const { runner } = makeRunner();
        const controller = new AbortController();
        runner.push(() => 'never', { signal: controller.signal }).catch(() => {});
        const idle = runner.whenIdle();
        controller.abort();
        await expect(idle).resolves.toBeUndefined();
    });

    it('a paused runner with work queued keeps it pending', async () => {
        const { runner } = makeRunner();
        runner.push(() => 'later').catch(() => {});
        let settled = false;
        void runner.whenIdle().then(() => (settled = true));
        runner.pause();
        await Promise.resolve();
        expect(settled).toBe(false);
        runner.clear();
    });
});
