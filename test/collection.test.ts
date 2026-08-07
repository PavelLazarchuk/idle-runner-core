import { describe, expect, it, vi } from 'vitest';

import { IdleRunner } from '../src/core/idle-runner';
import { idleForEach, idleMap } from '../src/core/collection';
import { FakeScheduler } from './fake-scheduler';

function makeRunner(budgetMs = 5) {
    const fake = new FakeScheduler();
    const runner = new IdleRunner({ scheduler: fake, budgetMs, flushOnHidden: false });
    return { fake, runner };
}

describe('idleMap', () => {
    it('maps every item, in order, with the index', async () => {
        const { fake, runner } = makeRunner();
        const promise = idleMap(['a', 'b', 'c'], (item, index) => `${index}${item}`, { runner });
        fake.fireSlice(100);
        await expect(promise).resolves.toEqual(['0a', '1b', '2c']);
    });

    it('resolves an empty array for an empty input without touching the scheduler budget', async () => {
        const { fake, runner } = makeRunner();
        const promise = idleMap([], item => item, { runner });
        fake.fireSlice(100);
        await expect(promise).resolves.toEqual([]);
    });

    it('accepts any iterable, not just arrays', async () => {
        const { fake, runner } = makeRunner();
        const promise = idleMap(new Set([1, 2, 3]), value => value * 2, { runner });
        fake.fireSlice(100);
        await expect(promise).resolves.toEqual([2, 4, 6]);
    });

    it('yields once per item by default, so a tight budget spreads the work', async () => {
        const { fake, runner } = makeRunner(5);
        const seen: number[] = [];
        const promise = idleMap([1, 2, 3, 4], value => value, {
            runner,
            onProgress: done => seen.push(done),
        });
        const sequence = [20, 14, 8, 4];
        fake.fireSlice(() => sequence.shift() ?? 0);
        expect(seen).toEqual([1, 2]);
        expect(runner.size).toBe(1);
        fake.fireSlice(100);
        await expect(promise).resolves.toEqual([1, 2, 3, 4]);
        expect(seen).toEqual([1, 2, 3, 4]);
    });

    it('chunkSize batches items between yields and still reports the final partial chunk', async () => {
        const { fake, runner } = makeRunner();
        const seen: number[] = [];
        const promise = idleMap([1, 2, 3, 4, 5], value => value, {
            runner,
            chunkSize: 2,
            onProgress: done => seen.push(done),
        });
        fake.fireSlice(100);
        await expect(promise).resolves.toEqual([1, 2, 3, 4, 5]);
        expect(seen).toEqual([2, 4, 5]);
    });

    it('does not report a trailing chunk twice when the count divides evenly', async () => {
        const { fake, runner } = makeRunner();
        const seen: number[] = [];
        const promise = idleMap([1, 2, 3, 4], value => value, {
            runner,
            chunkSize: 2,
            onProgress: done => seen.push(done),
        });
        fake.fireSlice(100);
        await promise;
        expect(seen).toEqual([2, 4]);
    });

    it('falls back to the default chunkSize on a bad value, with a warning', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const { fake, runner } = makeRunner();
        const seen: number[] = [];
        const promise = idleMap([1, 2], value => value, {
            runner,
            chunkSize: 0,
            onProgress: done => seen.push(done),
        });
        fake.fireSlice(100);
        await promise;
        expect(seen).toEqual([1, 2]);
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('chunkSize'));
        warn.mockRestore();
    });

    it('rejects with the first throw from fn and stops calling it', async () => {
        const { fake, runner } = makeRunner();
        const boom = new Error('item 2');
        const calls: number[] = [];
        const promise = idleMap(
            [1, 2, 3],
            value => {
                calls.push(value);
                if (value === 2) throw boom;
                return value;
            },
            { runner }
        );
        fake.fireSlice(100);
        await expect(promise).rejects.toBe(boom);
        expect(calls).toEqual([1, 2]);
    });

    it('aborts mid-flight and drops the partial result', async () => {
        const { fake, runner } = makeRunner(5);
        const controller = new AbortController();
        const calls: number[] = [];
        const promise = idleMap(
            [1, 2, 3, 4],
            value => {
                calls.push(value);
                return value;
            },
            { runner, signal: controller.signal }
        );
        promise.catch(() => {});
        const sequence = [20, 14, 4];
        fake.fireSlice(() => sequence.shift() ?? 0);
        controller.abort();
        await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
        expect(calls).toEqual([1]);
    });

    it('honours the key option: a second call supersedes the first', async () => {
        const { fake, runner } = makeRunner();
        const first = idleMap([1], value => value, { runner, key: 'shared' });
        first.catch(() => {});
        const second = idleMap([2], value => value, { runner, key: 'shared' });
        fake.fireSlice(100);
        await expect(first).rejects.toMatchObject({ name: 'AbortError' });
        await expect(second).resolves.toEqual([2]);
    });
});

describe('idleForEach', () => {
    it('runs fn for every item and resolves undefined', async () => {
        const { fake, runner } = makeRunner();
        const seen: string[] = [];
        const promise = idleForEach(['a', 'b'], item => seen.push(item), { runner });
        fake.fireSlice(100);
        await expect(promise).resolves.toBeUndefined();
        expect(seen).toEqual(['a', 'b']);
    });

    it('reports progress the same way idleMap does', async () => {
        const { fake, runner } = makeRunner();
        const seen: number[] = [];
        const promise = idleForEach([1, 2, 3], () => {}, {
            runner,
            onProgress: done => seen.push(done),
        });
        fake.fireSlice(100);
        await promise;
        expect(seen).toEqual([1, 2, 3]);
    });
});
