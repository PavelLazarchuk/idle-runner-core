import type { IdleRunner } from './idle-runner';
import type { IdleChunkedTaskOptions } from './types';
import { sharedRunner } from './shared';
import { devWarn } from './dev';

const DEFAULT_CHUNK_SIZE = 1;

export interface IdleCollectionOptions extends IdleChunkedTaskOptions<number> {
    runner?: IdleRunner;
    chunkSize?: number;
}

function resolveChunkSize(chunkSize: number | undefined): number {
    if (chunkSize === undefined) return DEFAULT_CHUNK_SIZE;

    if (!Number.isFinite(chunkSize) || chunkSize < 1) {
        devWarn(`chunkSize must be a finite number >= 1; using ${DEFAULT_CHUNK_SIZE}`);

        return DEFAULT_CHUNK_SIZE;
    }

    return Math.floor(chunkSize);
}

function* walk<T, R>(
    items: Iterable<T>,
    fn: (item: T, index: number) => R,
    chunkSize: number,
    out: R[] | null
): Generator<number, R[], unknown> {
    let index = 0;
    let sinceYield = 0;

    for (const item of items) {
        const value = fn(item, index++);

        if (out) out.push(value);
        if (++sinceYield < chunkSize) continue;

        sinceYield = 0;
        yield index;
    }

    if (sinceYield > 0) yield index;

    return out ?? [];
}

/**
 * `items.map(fn)` spread across idle slices instead of one long task.
 *
 * ```ts
 * const thumbnails = await idleMap(photos, downscale, {
 *     onProgress: done => setProgress(done / photos.length),
 * });
 * ```
 *
 * Rejects with the first throw from `fn`, and with an AbortError when the
 * `signal` is aborted — the partial result is dropped in both cases.
 */
export function idleMap<T, R>(
    items: Iterable<T>,
    fn: (item: T, index: number) => R,
    options: IdleCollectionOptions = {}
): Promise<R[]> {
    const { runner, chunkSize, ...task } = options;
    const out: R[] = [];

    return (runner ?? sharedRunner()).pushChunked<R[], number>(
        walk(items, fn, resolveChunkSize(chunkSize), out),
        task
    );
}

/**
 * `items.forEach(fn)` spread across idle slices. Same contract as {@link idleMap},
 * without collecting the results.
 *
 * ```ts
 * await idleForEach(rows, row => index.add(row), { chunkSize: 500 });
 * ```
 */
export function idleForEach<T>(
    items: Iterable<T>,
    fn: (item: T, index: number) => unknown,
    options: IdleCollectionOptions = {}
): Promise<void> {
    const { runner, chunkSize, ...task } = options;

    return (runner ?? sharedRunner())
        .pushChunked<unknown[], number>(walk(items, fn, resolveChunkSize(chunkSize), null), task)
        .then(() => undefined);
}
