import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { IdleRunner } from '../src/core/idle-runner';
import type { IdleRunnerOptions } from '../src/core/types';
import { FakeScheduler } from './fake-scheduler';

function makeRunner(options: Omit<IdleRunnerOptions, 'scheduler' | 'flushOnHidden'> = {}) {
    const fake = new FakeScheduler();
    const runner = new IdleRunner({ ...options, scheduler: fake, flushOnHidden: false });
    return { fake, runner };
}

describe('priority — ordering', () => {
    it('a queue that never sets priority is still plain FIFO', async () => {
        const { fake, runner } = makeRunner();
        const order: string[] = [];
        const promises = ['a', 'b', 'c'].map(id => runner.push(() => order.push(id)));
        fake.fireSlice(100);
        await Promise.all(promises);
        expect(order).toEqual(['a', 'b', 'c']);
    });

    it('runs higher priority first regardless of push order', async () => {
        const { fake, runner } = makeRunner();
        const order: string[] = [];
        const promises = [
            runner.push(() => order.push('bg'), { priority: 'background' }),
            runner.push(() => order.push('vis')),
            runner.push(() => order.push('urgent'), { priority: 'user-blocking' }),
        ];
        fake.fireSlice(100);
        await Promise.all(promises);
        expect(order).toEqual(['urgent', 'vis', 'bg']);
    });

    it('keeps FIFO inside a priority', async () => {
        const { fake, runner } = makeRunner();
        const order: string[] = [];
        const promises = ['b1', 'b2', 'b3'].map(id =>
            runner.push(() => order.push(id), { priority: 'background' })
        );
        fake.fireSlice(100);
        await Promise.all(promises);
        expect(order).toEqual(['b1', 'b2', 'b3']);
    });

    it('a task pushed later at a higher priority jumps the queue between slices', async () => {
        const { fake, runner } = makeRunner();
        const order: string[] = [];
        void runner.push(() => order.push('bg'), { priority: 'background' });
        fake.fireSlice(4);
        expect(order).toEqual([]);
        void runner.push(() => order.push('urgent'), { priority: 'user-blocking' });
        fake.fireSlice(100);
        expect(order).toEqual(['urgent', 'bg']);
    });

    it('flush() drains in priority order too', () => {
        const { runner } = makeRunner();
        const order: string[] = [];
        void runner.push(() => order.push('bg'), { priority: 'background' });
        void runner.push(() => order.push('urgent'), { priority: 'user-blocking' });
        void runner.push(() => order.push('vis'));
        runner.flush();
        expect(order).toEqual(['urgent', 'vis', 'bg']);
        expect(runner.size).toBe(0);
    });

    it('a forced drain still runs only expired tasks, highest priority first', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(0);
        try {
            const { fake, runner } = makeRunner();
            const order: string[] = [];
            const bg = runner.push(() => order.push('bg'), {
                priority: 'background',
                timeout: 50,
            });
            const urgent = runner.push(() => order.push('urgent'), {
                priority: 'user-blocking',
                timeout: 50,
            });
            void runner.push(() => order.push('later'), { timeout: 5000 });
            vi.advanceTimersByTime(60);
            fake.fireTimeout();
            await Promise.all([bg, urgent]);
            expect(order).toEqual(['urgent', 'bg']);
            expect(runner.size).toBe(1);
        } finally {
            vi.useRealTimers();
        }
    });

    it('falls back to user-visible for an unknown priority from JS callers', async () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        try {
            const { fake, runner } = makeRunner();
            const order: string[] = [];
            void runner.push(() => order.push('bogus'), {
                priority: 'asap' as unknown as 'user-visible',
            });
            void runner.push(() => order.push('bg'), { priority: 'background' });
            void runner.push(() => order.push('urgent'), { priority: 'user-blocking' });
            fake.fireSlice(100);
            expect(order).toEqual(['urgent', 'bogus', 'bg']);
            expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('unknown priority'));
        } finally {
            warnSpy.mockRestore();
        }
    });
});

describe('priority — aging (starvation guard)', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(0);
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    it('a background task that waited longer than agingMs outranks fresh work', async () => {
        const { fake, runner } = makeRunner({ agingMs: 1000 });
        const order: string[] = [];
        const bg = runner.push(() => order.push('bg'), { priority: 'background' });
        vi.advanceTimersByTime(1500);
        void runner.push(() => order.push('vis'));
        void runner.push(() => order.push('urgent'), { priority: 'user-blocking' });
        fake.fireSlice(100);
        await bg;
        expect(order).toEqual(['bg', 'urgent', 'vis']);
    });

    it('does not promote a task that has not waited long enough yet', async () => {
        const { fake, runner } = makeRunner({ agingMs: 1000 });
        const order: string[] = [];
        void runner.push(() => order.push('bg'), { priority: 'background' });
        vi.advanceTimersByTime(200);
        const vis = runner.push(() => order.push('vis'));
        fake.fireSlice(100);
        await vis;
        expect(order).toEqual(['vis', 'bg']);
    });

    it('promotes the oldest first when several tasks are starved', async () => {
        const { fake, runner } = makeRunner({ agingMs: 100 });
        const order: string[] = [];
        void runner.push(() => order.push('bg'), { priority: 'background' });
        vi.advanceTimersByTime(50);
        const vis = runner.push(() => order.push('vis'));
        vi.advanceTimersByTime(200);
        void runner.push(() => order.push('urgent'), { priority: 'user-blocking' });
        fake.fireSlice(100);
        await vis;
        expect(order).toEqual(['bg', 'vis', 'urgent']);
    });

    it('agingMs: Infinity means strict priority forever', async () => {
        const { fake, runner } = makeRunner({ agingMs: Infinity });
        const order: string[] = [];
        const bg = runner.push(() => order.push('bg'), { priority: 'background' });
        vi.advanceTimersByTime(60_000);
        void runner.push(() => order.push('vis'));
        fake.fireSlice(100);
        await bg;
        expect(order).toEqual(['vis', 'bg']);
    });

    it('rejects a negative agingMs instead of promoting everything', async () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        try {
            const { fake, runner } = makeRunner({ agingMs: -5 });
            const order: string[] = [];
            void runner.push(() => order.push('bg'), { priority: 'background' });
            const vis = runner.push(() => order.push('vis'));
            fake.fireSlice(100);
            await vis;
            expect(order).toEqual(['vis', 'bg']);
            expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('agingMs'));
        } finally {
            warnSpy.mockRestore();
        }
    });
});

describe('priority — preemption of a suspended generator', () => {
    function* counting(log: string[], label: string, steps: number) {
        for (let i = 1; i <= steps; i++) {
            log.push(`${label}${i}`);
            yield;
        }
        return label;
    }

    it('parks a background generator when higher priority work arrives, then resumes it', async () => {
        const { fake, runner } = makeRunner();
        const log: string[] = [];
        const bg = runner.pushChunked(counting(log, 'bg', 3), { priority: 'background' });
        const sequence = [100, 100, 0];
        fake.fireSlice(() => sequence.shift() ?? 0);
        expect(log).toEqual(['bg1']);

        void runner.push(() => log.push('urgent'), { priority: 'user-blocking' });
        fake.fireSlice(100);
        await expect(bg).resolves.toBe('bg');
        expect(log).toEqual(['bg1', 'urgent', 'bg2', 'bg3']);
    });

    it('equal priority never preempts — the running generator finishes first', async () => {
        const { fake, runner } = makeRunner();
        const log: string[] = [];
        const gen = runner.pushChunked(counting(log, 'gen', 3));
        const sequence = [100, 100, 0];
        fake.fireSlice(() => sequence.shift() ?? 0);
        expect(log).toEqual(['gen1']);

        void runner.push(() => log.push('other'));
        fake.fireSlice(100);
        await gen;
        expect(log).toEqual(['gen1', 'gen2', 'gen3', 'other']);
    });

    it('a parked generator is still counted in size and still cancellable', async () => {
        const { fake, runner } = makeRunner();
        const log: string[] = [];
        const controller = new AbortController();
        const bg = runner.pushChunked(counting(log, 'bg', 3), {
            priority: 'background',
            signal: controller.signal,
        });
        bg.catch(() => {});
        const sequence = [100, 100, 0];
        fake.fireSlice(() => sequence.shift() ?? 0);
        expect(runner.size).toBe(1);

        void runner.push(() => log.push('urgent'), { priority: 'user-blocking' });
        expect(runner.size).toBe(2);
        controller.abort();
        expect(runner.size).toBe(1);
        fake.fireSlice(100);
        await expect(bg).rejects.toMatchObject({ name: 'AbortError' });
        expect(log).toEqual(['bg1', 'urgent']);
    });
});
