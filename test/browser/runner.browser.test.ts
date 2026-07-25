import { describe, expect, it } from 'vitest';

import { IdleRunner } from '../../src/core/idle-runner';
import { detectRung } from '../../src/scheduler/adapter';
import type { HostGlobals } from '../../src/scheduler/host';

const hasRic = typeof globalThis.requestIdleCallback === 'function';

function busyWait(ms: number): void {
    const start = performance.now();
    while (performance.now() - start < ms) {
        // burn
    }
}

describe('rung selection in a real browser', () => {
    it('selects rIC where the platform has it, MessageChannel where it does not (WebKit)', () => {
        const rung = detectRung(globalThis as unknown as HostGlobals);
        if (hasRic) {
            expect(rung).toBe('requestIdleCallback');
        } else {
            expect(rung).toBe('MessageChannel');
        }
    });

    it('runs a queue end-to-end on the platform rung', async () => {
        const runner = new IdleRunner({ flushOnHidden: false });
        const results = await Promise.all([
            runner.push(() => 1),
            runner.push(() => 2),
            runner.pushChunked(
                (function* () {
                    yield;
                    return 3;
                })()
            ),
        ]);
        expect(results).toEqual([1, 2, 3]);
    });

    it('honors a timeout on the platform rung', async () => {
        const runner = new IdleRunner({ flushOnHidden: false });
        await expect(runner.push(() => 'forced', { timeout: 50 })).resolves.toBe('forced');
    });
});

describe('slicing keeps the main thread responsive', () => {
    it('rendering still gets frames while the queue drains (thread not monopolized)', async () => {
        const runner = new IdleRunner({ budgetMs: 5, flushOnHidden: false });
        let frames = 0;
        let draining = true;
        const onFrame = () => {
            frames++;
            if (draining) requestAnimationFrame(onFrame);
        };
        requestAnimationFrame(onFrame);
        await Promise.all(Array.from({ length: 100 }, () => runner.push(() => busyWait(3))));
        draining = false;
        expect(frames).toBeGreaterThanOrEqual(3);
    });
});

describe('longtask benchmark with negative control (Chromium/Firefox only)', () => {
    const supportsLongtask =
        typeof PerformanceObserver !== 'undefined' &&
        (PerformanceObserver.supportedEntryTypes ?? []).includes('longtask');

    async function observeLongTasks(work: () => Promise<void> | void): Promise<number[]> {
        const durations: number[] = [];
        const observer = new PerformanceObserver(list => {
            for (const entry of list.getEntries()) durations.push(entry.duration);
        });
        observer.observe({ type: 'longtask' });
        await work();
        await new Promise(resolve => setTimeout(resolve, 200));
        observer.disconnect();
        return durations;
    }

    it.skipIf(!supportsLongtask)(
        'the negative control DOES produce a long task (otherwise the benchmark proves nothing)',
        async () => {
            const durations = await observeLongTasks(() => {
                busyWait(180);
            });
            expect(durations.some(d => d >= 50)).toBe(true);
        }
    );

    it.skipIf(!supportsLongtask)(
        'the same workload through IdleRunner produces no long task',
        async () => {
            const runner = new IdleRunner({ budgetMs: 5, flushOnHidden: false });
            const durations = await observeLongTasks(async () => {
                await Promise.all(Array.from({ length: 60 }, () => runner.push(() => busyWait(3))));
            });
            expect(durations.filter(d => d >= 50)).toEqual([]);
        }
    );
});
