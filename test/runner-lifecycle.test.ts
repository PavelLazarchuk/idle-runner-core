import { describe, expect, it, vi } from 'vitest';

import { IdleRunner } from '../src/core/idle-runner';
import { FakeScheduler } from './fake-scheduler';

function makeRunner(budgetMs = 5) {
    const fake = new FakeScheduler();
    const runner = new IdleRunner({ scheduler: fake, budgetMs, flushOnHidden: false });
    return { fake, runner };
}

describe('clear', () => {
    it('rejects every pending task with AbortError and empties the queue', async () => {
        const { fake, runner } = makeRunner();
        const a = runner.push(() => 'a');
        const b = runner.push(() => 'b');
        a.catch(() => {});
        b.catch(() => {});
        runner.clear();
        await expect(a).rejects.toMatchObject({ name: 'AbortError' });
        await expect(b).rejects.toMatchObject({ name: 'AbortError' });
        expect(runner.size).toBe(0);
        expect(fake.pending).toBe(0);
    });

    it('rejects with a caller-supplied reason', async () => {
        const { runner } = makeRunner();
        const reason = new Error('shutting down');
        const p = runner.push(() => 'x');
        p.catch(() => {});
        runner.clear(reason);
        await expect(p).rejects.toBe(reason);
    });

    it('called from inside a running task, stops the drain safely', async () => {
        const { fake, runner } = makeRunner();
        const ran: string[] = [];
        const a = runner.push(() => {
            ran.push('a');
            runner.clear();
        });
        const b = runner.push(() => ran.push('b'));
        b.catch(() => {});
        fake.fireSlice(100);
        await a;
        await expect(b).rejects.toMatchObject({ name: 'AbortError' });
        expect(ran).toEqual(['a']);
        expect(runner.size).toBe(0);
    });
});

describe('pause / resume', () => {
    it('pause cancels the outstanding request; resume re-arms', () => {
        const { fake, runner } = makeRunner();
        void runner.push(() => 'x');
        expect(fake.pending).toBe(1);
        runner.pause();
        expect(fake.pending).toBe(0);
        runner.resume();
        expect(fake.pending).toBe(1);
    });

    it('push while paused never arms; resume arms once', () => {
        const { fake, runner } = makeRunner();
        runner.pause();
        void runner.push(() => 'x');
        void runner.push(() => 'y');
        expect(fake.pending).toBe(0);
        runner.resume();
        expect(fake.pending).toBe(1);
    });

    it('pause mid-generator resumes from the same yield, not from the start', async () => {
        const { fake, runner } = makeRunner(5);
        const steps: number[] = [];
        function* work() {
            steps.push(1);
            yield;
            steps.push(2);
            return 'ok';
        }
        const promise = runner.pushChunked(work());
        const sequence = [20, 14, 4];
        fake.fireSlice(() => sequence.shift() ?? 0);
        expect(steps).toEqual([1]);
        runner.pause();
        runner.resume();
        fake.fireSlice(100);
        await expect(promise).resolves.toBe('ok');
        expect(steps).toEqual([1, 2]);
    });

    it('pause → clear → resume neither throws nor leaves a dangling request', () => {
        const { fake, runner } = makeRunner();
        const p = runner.push(() => 'x');
        p.catch(() => {});
        runner.pause();
        runner.clear();
        runner.resume();
        expect(fake.pending).toBe(0);
        expect(runner.size).toBe(0);
    });
});

describe('flush', () => {
    it('drains everything synchronously, including a suspended generator', async () => {
        const { fake, runner } = makeRunner(5);
        const steps: string[] = [];
        function* work() {
            steps.push('g1');
            yield;
            steps.push('g2');
            return 'gen';
        }
        const genPromise = runner.pushChunked(work());
        const fnPromise = runner.push(() => steps.push('fn'));
        const sequence = [20, 14, 4];
        fake.fireSlice(() => sequence.shift() ?? 0);
        expect(steps).toEqual(['g1']);
        runner.flush();
        expect(steps).toEqual(['g1', 'g2', 'fn']);
        await expect(genPromise).resolves.toBe('gen');
        await fnPromise;
        expect(runner.size).toBe(0);
    });

    it('tasks pushed during flush stay queued for the next slice', async () => {
        const { fake, runner } = makeRunner();
        let innerRan = false;
        const outer = runner.push(() => {
            void runner.push(() => {
                innerRan = true;
            });
        });
        runner.flush();
        await outer;
        expect(innerRan).toBe(false);
        expect(runner.size).toBe(1);
        expect(fake.pending).toBe(1);
    });

    it('flush requested from inside a slice defers until the slice ends', async () => {
        const { fake, runner } = makeRunner();
        const ran: string[] = [];
        const a = runner.push(() => {
            ran.push('a');
            runner.flush();
        });
        const b = runner.push(() => ran.push('b'));
        const sequence = [20, 4];
        fake.fireSlice(() => sequence.shift() ?? 0);
        await a;
        await b;
        expect(ran).toEqual(['a', 'b']);
    });
});

describe('AbortSignal', () => {
    it('a pre-aborted signal rejects immediately and never enqueues', async () => {
        const { fake, runner } = makeRunner();
        const controller = new AbortController();
        controller.abort();
        await expect(runner.push(() => 'x', { signal: controller.signal })).rejects.toMatchObject({
            name: 'AbortError',
        });
        expect(runner.size).toBe(0);
        expect(fake.log).toHaveLength(0);
    });

    it('aborting a queued task removes it; neighbours are untouched', async () => {
        const { fake, runner } = makeRunner();
        const controller = new AbortController();
        const a = runner.push(() => 'a');
        const b = runner.push(() => 'b', { signal: controller.signal });
        b.catch(() => {});
        controller.abort();
        await expect(b).rejects.toMatchObject({ name: 'AbortError' });
        expect(runner.size).toBe(1);
        fake.fireSlice(100);
        await expect(a).resolves.toBe('a');
    });

    it('one signal shared across tasks aborts all of them and removes its listeners', async () => {
        const { runner } = makeRunner();
        const controller = new AbortController();
        const removeSpy = vi.spyOn(controller.signal, 'removeEventListener');
        const a = runner.push(() => 'a', { signal: controller.signal });
        const b = runner.push(() => 'b', { signal: controller.signal });
        a.catch(() => {});
        b.catch(() => {});
        controller.abort();
        await expect(a).rejects.toMatchObject({ name: 'AbortError' });
        await expect(b).rejects.toMatchObject({ name: 'AbortError' });
        expect(removeSpy).toHaveBeenCalledTimes(2);
        expect(runner.size).toBe(0);
    });

    it('listeners are removed when a task settles normally', async () => {
        const { fake, runner } = makeRunner();
        const controller = new AbortController();
        const removeSpy = vi.spyOn(controller.signal, 'removeEventListener');
        const p = runner.push(() => 'done', { signal: controller.signal });
        fake.fireSlice(100);
        await p;
        expect(removeSpy).toHaveBeenCalledTimes(1);
    });
});

describe('flushOnHidden', () => {
    it('drains the queue when the document goes hidden', async () => {
        const listeners = new Map<string, () => void>();
        const g = globalThis as unknown as Record<string, unknown>;
        g.document = {
            visibilityState: 'visible',
            addEventListener: (type: string, listener: () => void) => listeners.set(type, listener),
            removeEventListener: () => {},
        };
        g.window = {
            addEventListener: (type: string, listener: () => void) => listeners.set(type, listener),
            removeEventListener: () => {},
        };
        try {
            const fake = new FakeScheduler();
            const runner = new IdleRunner({ scheduler: fake, flushOnHidden: true });
            let ran = false;
            const p = runner.push(() => {
                ran = true;
            });
            (g.document as { visibilityState: string }).visibilityState = 'hidden';
            listeners.get('visibilitychange')!();
            expect(ran).toBe(true);
            await p;
        } finally {
            delete g.document;
            delete g.window;
        }
    });

    it('drains the queue on pagehide', async () => {
        const listeners = new Map<string, () => void>();
        const g = globalThis as unknown as Record<string, unknown>;
        g.document = {
            visibilityState: 'visible',
            addEventListener: (type: string, listener: () => void) => listeners.set(type, listener),
            removeEventListener: () => {},
        };
        g.window = {
            addEventListener: (type: string, listener: () => void) => listeners.set(type, listener),
            removeEventListener: () => {},
        };
        try {
            const fake = new FakeScheduler();
            const runner = new IdleRunner({ scheduler: fake, flushOnHidden: true });
            let ran = false;
            const p = runner.push(() => {
                ran = true;
            });
            listeners.get('pagehide')!();
            expect(ran).toBe(true);
            await p;
        } finally {
            delete g.document;
            delete g.window;
        }
    });
});

describe('review fixes regression', () => {
    it('budgetMs=50 is clamped to 49 so a real rIC-capped deadline (max 50) can still start a task', () => {
        const fake = new FakeScheduler();
        const runner = new IdleRunner({ scheduler: fake, budgetMs: 50, flushOnHidden: false });
        let ran = false;
        void runner.push(() => {
            ran = true;
        });
        fake.fireSlice(50);
        expect(ran).toBe(true);
    });

    it('aborting the only queued task disarms the outstanding request (no stray wake on an empty queue)', () => {
        const { fake, runner } = makeRunner();
        const controller = new AbortController();
        const p = runner.push(() => 'x', { signal: controller.signal });
        p.catch(() => {});
        expect(fake.pending).toBe(1);
        controller.abort();
        expect(runner.size).toBe(0);
        expect(fake.pending).toBe(0);
    });

    it('aborting the earliest-deadline task re-arms against the next-soonest deadline, not a stale one', () => {
        const { fake, runner } = makeRunner();
        const controller = new AbortController();
        const soon = runner.push(() => 'soon', { signal: controller.signal, timeout: 100 });
        soon.catch(() => {});
        void runner.push(() => 'later', { timeout: 5000 });
        expect(fake.lastRequestTimeout).toBeCloseTo(100, 0);
        controller.abort();
        expect(fake.lastRequestTimeout).toBeCloseTo(5000, 0);
    });

    it('flush() re-entered during flush() is not dropped (both tasks run, none deferred to a later wake)', async () => {
        const { fake, runner } = makeRunner();
        const ran: string[] = [];
        const a = runner.push(() => {
            ran.push('a');
            runner.flush();
        });
        const b = runner.push(() => ran.push('b'));
        runner.flush();
        await Promise.all([a, b]);
        expect(ran).toEqual(['a', 'b']);
        void runner.push(() => ran.push('c'));
        fake.fireSlice(4);
        expect(ran).toEqual(['a', 'b']);
    });

    it('a generator that aborts itself mid-step still runs its finally (deferred via microtask)', async () => {
        const { fake, runner } = makeRunner(5);
        let finallyRan = false;
        const controller = new AbortController();
        function* selfAborting() {
            try {
                controller.abort();
                yield;
            } finally {
                finallyRan = true;
            }
        }
        const promise = runner.pushChunked(selfAborting(), { signal: controller.signal });
        promise.catch(() => {});
        fake.fireSlice(100);
        expect(finallyRan).toBe(false);
        await Promise.resolve();
        await Promise.resolve();
        expect(finallyRan).toBe(true);
        await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
    });

    it('a very large remaining queue survives forced drain without a RangeError (no unshift(...spread))', () => {
        const { fake, runner } = makeRunner();
        const N = 70_000;
        void runner.push(() => 'expired', { timeout: 10 });
        for (let i = 0; i < N; i++) void runner.push(() => i);
        expect(() => fake.fireTimeout()).not.toThrow();
        expect(runner.size).toBe(N);
    });

    it('destroy() unbinds hidden-flush listeners and rejects pending tasks', async () => {
        const listeners = new Map<string, () => void>();
        const g = globalThis as unknown as Record<string, unknown>;
        g.document = {
            visibilityState: 'visible',
            addEventListener: (type: string, listener: () => void) => listeners.set(type, listener),
            removeEventListener: (type: string) => listeners.delete(type),
        };
        g.window = {
            addEventListener: (type: string, listener: () => void) => listeners.set(type, listener),
            removeEventListener: (type: string) => listeners.delete(type),
        };
        try {
            const fake = new FakeScheduler();
            const runner = new IdleRunner({ scheduler: fake, flushOnHidden: true });
            const p = runner.push(() => 'x');
            p.catch(() => {});
            expect(listeners.size).toBeGreaterThan(0);
            runner.destroy();
            expect(listeners.size).toBe(0);
            await expect(p).rejects.toMatchObject({ name: 'AbortError' });
        } finally {
            delete g.document;
            delete g.window;
        }
    });

    it('dev warnings are not suppressed when `process` is absent (CDN/no-bundler browser load)', () => {
        const originalProcess = (globalThis as { process?: unknown }).process;
        delete (globalThis as { process?: unknown }).process;
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        try {
            new IdleRunner({ budgetMs: 999, flushOnHidden: false });
            expect(warnSpy).toHaveBeenCalled();
        } finally {
            warnSpy.mockRestore();
            (globalThis as { process?: unknown }).process = originalProcess;
        }
    });
});

describe('memory', () => {
    it('100k settled tasks retain nothing', async () => {
        const { runner } = makeRunner();
        const promises: Array<Promise<number>> = [];
        for (let i = 0; i < 100_000; i++) {
            promises.push(runner.push(() => i));
        }
        const queue = (runner as unknown as { _queue: Array<Record<string, unknown>> })._queue;
        const first = queue[0]!;
        const last = queue[queue.length - 1]!;
        runner.flush();
        await Promise.all(promises);
        expect(runner.size).toBe(0);
        for (const task of [first, last]) {
            expect(task._resolve).toBeNull();
            expect(task._reject).toBeNull();
            expect(task._run).toBeNull();
            expect(task._gen).toBeNull();
            expect(task._signal).toBeNull();
            expect(task._onAbort).toBeNull();
        }
    });
});
