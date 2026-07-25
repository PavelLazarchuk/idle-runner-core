import { describe, expect, it } from 'vitest';

import { IdleRunner } from '../src/core/idle-runner';
import { FakeScheduler } from './fake-scheduler';

function makeRunner(budgetMs = 5) {
    const fake = new FakeScheduler();
    const runner = new IdleRunner({ scheduler: fake, budgetMs, flushOnHidden: false });
    return { fake, runner };
}

describe('pushChunked', () => {
    it('re-checks the budget between every next(): cheap yields finish in one slice', async () => {
        const { fake, runner } = makeRunner();
        const steps: number[] = [];
        function* work() {
            steps.push(1);
            yield;
            steps.push(2);
            yield;
            steps.push(3);
            return 'all';
        }
        const promise = runner.pushChunked(work());
        fake.fireSlice(100);
        await expect(promise).resolves.toBe('all');
        expect(steps).toEqual([1, 2, 3]);
    });

    it('suspends mid-generator when the budget runs out and resumes in the next slice', async () => {
        const { fake, runner } = makeRunner(5);
        const steps: number[] = [];
        function* work() {
            steps.push(1);
            yield;
            steps.push(2);
            yield;
            steps.push(3);
            return 'resumed';
        }
        const promise = runner.pushChunked(work());
        const sequence = [20, 14, 8, 4];
        fake.fireSlice(() => sequence.shift() ?? 0);
        expect(steps).toEqual([1, 2]);
        expect(runner.size).toBe(1);
        fake.fireSlice(100);
        await expect(promise).resolves.toBe('resumed');
        expect(steps).toEqual([1, 2, 3]);
    });

    it('rejects when the generator throws mid-flight', async () => {
        const { fake, runner } = makeRunner();
        const boom = new Error('mid-flight');
        function* work() {
            yield;
            throw boom;
        }
        const promise = runner.pushChunked(work());
        fake.fireSlice(100);
        await expect(promise).rejects.toBe(boom);
        expect(runner.size).toBe(0);
    });

    it('runs user finally blocks via gen.return() when cleared mid-flight', async () => {
        const { fake, runner } = makeRunner(5);
        let finallyRan = false;
        function* work() {
            try {
                yield;
                yield;
            } finally {
                finallyRan = true;
            }
        }
        const promise = runner.pushChunked(work());
        promise.catch(() => {});
        const sequence = [20, 14, 4];
        fake.fireSlice(() => sequence.shift() ?? 0);
        expect(finallyRan).toBe(false);
        runner.clear();
        expect(finallyRan).toBe(true);
        await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
    });

    it('an already-consumed generator resolves undefined (single-use, documented)', async () => {
        const { fake, runner } = makeRunner();
        function* work() {
            yield;
            return 'gone';
        }
        const gen = work();
        for (const _ of gen) {
            void _;
        }
        const promise = runner.pushChunked(gen);
        fake.fireSlice(100);
        await expect(promise).resolves.toBeUndefined();
    });

    it('accepts a cross-realm-style duck-typed iterator object', async () => {
        const { fake, runner } = makeRunner();
        let calls = 0;
        const duck = {
            next() {
                calls++;
                return calls < 3
                    ? { done: false, value: undefined }
                    : { done: true, value: 'duck' };
            },
            return() {
                return { done: true, value: undefined };
            },
            [Symbol.iterator]() {
                return this;
            },
        };
        const promise = runner.pushChunked(duck as unknown as Generator<unknown, string, unknown>);
        fake.fireSlice(100);
        await expect(promise).resolves.toBe('duck');
    });

    it('rejects async generators with a TypeError explaining the deadline contract', async () => {
        const { runner } = makeRunner();
        async function* asyncWork() {
            yield 1;
        }
        const promise = runner.pushChunked(
            asyncWork() as unknown as Generator<unknown, unknown, unknown>
        );
        await expect(promise).rejects.toBeInstanceOf(TypeError);
        expect(runner.size).toBe(0);
    });

    it('an infinite generator exits via abort, and its finally runs', async () => {
        const { fake, runner } = makeRunner(5);
        let finallyRan = false;
        function* forever() {
            try {
                for (;;) yield;
            } finally {
                finallyRan = true;
            }
        }
        const controller = new AbortController();
        const promise = runner.pushChunked(forever(), { signal: controller.signal });
        promise.catch(() => {});
        const sequence = [20, 14, 4];
        fake.fireSlice(() => sequence.shift() ?? 0);
        controller.abort();
        expect(finallyRan).toBe(true);
        await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
        expect(runner.size).toBe(0);
    });
});
