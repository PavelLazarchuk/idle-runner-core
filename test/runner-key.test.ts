import { describe, expect, it, vi } from 'vitest';

import { IdleRunner } from '../src/core/idle-runner';
import { FakeScheduler } from './fake-scheduler';

function makeRunner(onError?: (error: unknown) => void) {
    const fake = new FakeScheduler();
    const runner = new IdleRunner({ scheduler: fake, flushOnHidden: false, onError });
    return { fake, runner };
}

describe('key — last write wins', () => {
    it('a second push with the same key supersedes the pending one', async () => {
        const { fake, runner } = makeRunner();
        const ran: string[] = [];
        const first = runner.push(() => ran.push('first'), { key: 'index' });
        first.catch(() => {});
        const second = runner.push(() => ran.push('second'), { key: 'index' });
        expect(runner.size).toBe(1);
        fake.fireSlice(100);
        await expect(first).rejects.toMatchObject({ name: 'AbortError' });
        await second;
        expect(ran).toEqual(['second']);
    });

    it('keeps the newest position in the queue, not the superseded one', async () => {
        const { fake, runner } = makeRunner();
        const ran: string[] = [];
        const stale = runner.push(() => ran.push('stale'), { key: 'index' });
        stale.catch(() => {});
        void runner.push(() => ran.push('other'));
        void runner.push(() => ran.push('fresh'), { key: 'index' });
        fake.fireSlice(100);
        expect(ran).toEqual(['other', 'fresh']);
    });

    it('different keys do not interfere, and unkeyed pushes are never deduped', async () => {
        const { fake, runner } = makeRunner();
        const ran: string[] = [];
        void runner.push(() => ran.push('a'), { key: 'a' });
        void runner.push(() => ran.push('b'), { key: 'b' });
        void runner.push(() => ran.push('plain'));
        void runner.push(() => ran.push('plain'));
        fake.fireSlice(100);
        expect(ran).toEqual(['a', 'b', 'plain', 'plain']);
    });

    it('accepts symbols and numbers as keys', async () => {
        const { fake, runner } = makeRunner();
        const token = Symbol('index');
        const ran: string[] = [];
        const stale = runner.push(() => ran.push('stale'), { key: token });
        stale.catch(() => {});
        void runner.push(() => ran.push('fresh'), { key: token });
        void runner.push(() => ran.push('numbered'), { key: 7 });
        fake.fireSlice(100);
        expect(ran).toEqual(['fresh', 'numbered']);
        await expect(stale).rejects.toMatchObject({ name: 'AbortError' });
    });

    it('releases the key once the task has run, so the next push queues normally', async () => {
        const { fake, runner } = makeRunner();
        const ran: string[] = [];
        const first = runner.push(() => ran.push('first'), { key: 'index' });
        fake.fireSlice(100);
        await first;
        const second = runner.push(() => ran.push('second'), { key: 'index' });
        fake.fireSlice(100);
        await second;
        expect(ran).toEqual(['first', 'second']);
    });

    it('supersedes across push and pushChunked, running the generator cleanup', async () => {
        const { fake, runner } = makeRunner();
        const log: string[] = [];
        function* work() {
            try {
                log.push('start');
                yield;
                log.push('end');
            } finally {
                log.push('cleanup');
            }
            return 'gen';
        }
        const stale = runner.pushChunked(work(), { key: 'index' });
        stale.catch(() => {});
        const fresh = runner.push(() => log.push('fn'), { key: 'index' });
        fake.fireSlice(100);
        await expect(stale).rejects.toMatchObject({ name: 'AbortError' });
        await fresh;
        expect(log).toEqual(['fn']);
    });

    it('does not supersede a chunked task that already started', async () => {
        const { fake, runner } = makeRunner();
        const log: string[] = [];
        function* work() {
            log.push('step1');
            yield;
            log.push('step2');
            return 'gen';
        }
        const running = runner.pushChunked(work(), { key: 'index' });
        const sequence = [100, 100, 0];
        fake.fireSlice(() => sequence.shift() ?? 0);
        expect(log).toEqual(['step1']);

        const next = runner.push(() => log.push('fn'), { key: 'index' });
        fake.fireSlice(100);
        await expect(running).resolves.toBe('gen');
        await next;
        expect(log).toEqual(['step1', 'step2', 'fn']);
    });

    it('a superseded task is not reported to onError — it is a requested outcome', async () => {
        const seen: unknown[] = [];
        const { runner } = makeRunner(error => seen.push(error));
        runner.push(() => 'stale', { key: 'index' });
        runner.push(() => 'fresh', { key: 'index' });
        await Promise.resolve();
        expect(seen).toEqual([]);
    });

    it('carries a priority independently of the key', async () => {
        const { fake, runner } = makeRunner();
        const ran: string[] = [];
        const stale = runner.push(() => ran.push('stale'), {
            key: 'index',
            priority: 'user-blocking',
        });
        stale.catch(() => {});
        void runner.push(() => ran.push('vis'));
        void runner.push(() => ran.push('fresh'), { key: 'index', priority: 'background' });
        fake.fireSlice(100);
        expect(ran).toEqual(['vis', 'fresh']);
    });

    it('clear() forgets keys, so a later push with the same key is not blocked', async () => {
        const { fake, runner } = makeRunner();
        const ran: string[] = [];
        const dropped = runner.push(() => ran.push('dropped'), { key: 'index' });
        dropped.catch(() => {});
        runner.clear();
        const after = runner.push(() => ran.push('after'), { key: 'index' });
        fake.fireSlice(100);
        await after;
        expect(ran).toEqual(['after']);
        await expect(dropped).rejects.toMatchObject({ name: 'AbortError' });
    });

    it('an aborted keyed task frees its key', async () => {
        const { fake, runner } = makeRunner();
        const ran: string[] = [];
        const controller = new AbortController();
        const aborted = runner.push(() => ran.push('aborted'), {
            key: 'index',
            signal: controller.signal,
        });
        aborted.catch(() => {});
        controller.abort();
        const replacement = runner.push(() => ran.push('replacement'), { key: 'index' });
        fake.fireSlice(100);
        await replacement;
        expect(ran).toEqual(['replacement']);
    });

    it('the typical keystroke pattern collapses to a single run', async () => {
        const { fake, runner } = makeRunner();
        const ran: string[] = [];
        const spy = vi.fn((query: string) => ran.push(query));
        for (const query of ['a', 'ab', 'abc', 'abcd']) {
            runner.push(() => spy(query), { key: 'search' }).catch(() => {});
        }
        expect(runner.size).toBe(1);
        fake.fireSlice(100);
        expect(spy).toHaveBeenCalledOnce();
        expect(ran).toEqual(['abcd']);
    });
});
