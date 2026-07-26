import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { IdleRunner } from '../src/core/idle-runner';
import { sharedRunner } from '../src/core/shared';
import { FakeScheduler } from './fake-scheduler';

describe('budgetMs validation', () => {
    let warnSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    });
    afterEach(() => {
        warnSpy.mockRestore();
    });

    it.each([
        ['NaN', NaN],
        ['Infinity', Infinity],
        ['a non-number from JS callers', 'oops'],
    ])(
        'falls back to the default budget for %s instead of hanging the queue',
        async (_label, value) => {
            const fake = new FakeScheduler();
            const runner = new IdleRunner({
                scheduler: fake,
                budgetMs: value as number,
                flushOnHidden: false,
            });
            const promise = runner.push(() => 'ran');
            fake.fireSlice(100);
            await expect(promise).resolves.toBe('ran');
            expect(warnSpy).toHaveBeenCalled();
        }
    );

    it('warns on the low clamp too, not only the high one', () => {
        new IdleRunner({ budgetMs: 0, flushOnHidden: false });
        expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('clamped to 1'));
    });

    it('a valid budget neither warns nor is altered', () => {
        const fake = new FakeScheduler();
        const runner = new IdleRunner({ scheduler: fake, budgetMs: 8, flushOnHidden: false });
        const ran: string[] = [];
        void runner.push(() => ran.push('a'));
        void runner.push(() => ran.push('b'));
        const sequence = [9, 7];
        fake.fireSlice(() => sequence.shift() ?? 0);
        expect(ran).toEqual(['a']);
        expect(warnSpy).not.toHaveBeenCalled();
    });
});

describe('onError', () => {
    function makeRunner(onError: (error: unknown) => void) {
        const fake = new FakeScheduler();
        const runner = new IdleRunner({ scheduler: fake, flushOnHidden: false, onError });
        return { fake, runner };
    }

    it('reports a throwing task without the caller attaching a handler', async () => {
        const seen: unknown[] = [];
        const { fake, runner } = makeRunner(error => seen.push(error));
        const boom = new Error('boom');
        runner.push(() => {
            throw boom;
        });
        fake.fireSlice(100);
        await Promise.resolve();
        expect(seen).toEqual([boom]);
    });

    it('the returned promise still rejects — onError observes, it does not swallow', async () => {
        const { fake, runner } = makeRunner(() => {});
        const boom = new Error('boom');
        const promise = runner.push(() => {
            throw boom;
        });
        fake.fireSlice(100);
        await expect(promise).rejects.toBe(boom);
    });

    it('stays silent for AbortError from destroy(), which is requested, not failure', async () => {
        const seen: unknown[] = [];
        const { runner } = makeRunner(error => seen.push(error));
        runner.push(() => 'a');
        runner.push(() => 'b');
        runner.destroy();
        await Promise.resolve();
        expect(seen).toEqual([]);
    });

    it('stays silent for a signal abort', async () => {
        const seen: unknown[] = [];
        const { runner } = makeRunner(error => seen.push(error));
        const controller = new AbortController();
        runner.push(() => 'x', { signal: controller.signal });
        controller.abort();
        await Promise.resolve();
        expect(seen).toEqual([]);
    });

    it('reports a caller-supplied clear() reason, which is not an abort', async () => {
        const seen: unknown[] = [];
        const { runner } = makeRunner(error => seen.push(error));
        const reason = new Error('shutting down');
        runner.push(() => 'x');
        runner.clear(reason);
        await Promise.resolve();
        expect(seen).toEqual([reason]);
    });

    it('reports the pushChunked TypeError, which is otherwise a rejection nobody catches', async () => {
        const seen: unknown[] = [];
        const { runner } = makeRunner(error => seen.push(error));
        runner.pushChunked(undefined as unknown as Generator<unknown, void, unknown>);
        await Promise.resolve();
        expect(seen).toHaveLength(1);
        expect(seen[0]).toBeInstanceOf(TypeError);
    });

    it('an onError that itself throws is contained', async () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        try {
            const { fake, runner } = makeRunner(() => {
                throw new Error('handler exploded');
            });
            runner.push(() => {
                throw new Error('boom');
            });
            fake.fireSlice(100);
            await Promise.resolve();
            expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('onError threw'));
        } finally {
            warnSpy.mockRestore();
        }
    });
});

describe('sharedRunner', () => {
    it('returns the same instance every call', () => {
        expect(sharedRunner()).toBe(sharedRunner());
    });

    it('is a working IdleRunner', async () => {
        await expect(sharedRunner().push(() => 6 * 7)).resolves.toBe(42);
    });
});

describe('non-generator iterators', () => {
    it('clear() closes an iterator without a return() method without warning about it', async () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        try {
            const fake = new FakeScheduler();
            const runner = new IdleRunner({ scheduler: fake, flushOnHidden: false });
            let i = 0;
            const iterator = {
                next: () => (i++ < 3 ? { value: i, done: false } : { value: 'x', done: true }),
                [Symbol.iterator]() {
                    return this;
                },
            } as unknown as Generator<unknown, string, unknown>;
            const promise = runner.pushChunked(iterator);
            promise.catch(() => {});
            runner.clear();
            await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
            await Promise.resolve();
            await Promise.resolve();
            expect(warnSpy).not.toHaveBeenCalled();
        } finally {
            warnSpy.mockRestore();
        }
    });
});
