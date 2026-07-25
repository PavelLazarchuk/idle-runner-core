import type { Deadline, SchedulerAdapter } from '../core/types';
import { hostGlobals, type HostGlobals } from './host';

export interface SchedulerAdapterOptions {
    budgetMs?: number;
}

export type RungName = 'requestIdleCallback' | 'setImmediate' | 'MessageChannel' | 'setTimeout';

const DEFAULT_BUDGET_MS = 5;

/**
 * Ladder order: rIC where it exists (Chromium/Firefox), setImmediate
 * before MessageChannel because Node ≥15 exposes a global MessageChannel whose open
 * port would pin the event loop, MessageChannel for WebKit (no rIC, ever, and
 * setTimeout would hit the 4ms nested clamp), setTimeout as the last resort.
 */
export function detectRung(host: HostGlobals): RungName {
    if (
        typeof host.requestIdleCallback === 'function' &&
        typeof host.cancelIdleCallback === 'function'
    ) {
        return 'requestIdleCallback';
    }
    if (typeof host.setImmediate === 'function') return 'setImmediate';
    if (typeof host.MessageChannel === 'function') return 'MessageChannel';

    return 'setTimeout';
}

function now(host: HostGlobals): number {
    return host.performance ? host.performance.now() : Date.now();
}

const TIMED_OUT_DEADLINE: Deadline = { didTimeout: true, timeRemaining: () => 0 };

function syntheticDeadline(host: HostGlobals, sliceMs: number): Deadline {
    const start = now(host);

    return {
        didTimeout: false,
        timeRemaining: () => Math.max(0, sliceMs - (now(host) - start)),
    };
}

function createRicAdapter(host: HostGlobals): SchedulerAdapter {
    return {
        request(callback, timeout) {
            return host.requestIdleCallback!(callback, timeout == null ? undefined : { timeout });
        },
        cancel(handle) {
            host.cancelIdleCallback!(handle);
        },
    };
}

interface PendingEntry {
    _cb: (deadline: Deadline) => void;
    _timer?: unknown;
    _task?: unknown;
}

function createMessageChannelAdapter(host: HostGlobals, sliceMs: number): SchedulerAdapter {
    const channel = new host.MessageChannel!();
    const fifo: number[] = [];
    const live = new Map<number, PendingEntry>();
    let nextId = 1;

    channel.port1.onmessage = () => {
        for (;;) {
            const id = fifo.shift();

            if (id === undefined) return;

            const entry = live.get(id);

            if (!entry) continue;

            live.delete(id);

            if (entry._timer !== undefined) host.clearTimeout(entry._timer);

            entry._cb(syntheticDeadline(host, sliceMs));

            return;
        }
    };

    return {
        request(callback, timeout) {
            const id = nextId++;
            const entry: PendingEntry = { _cb: callback };

            if (timeout != null) {
                entry._timer = host.setTimeout(() => {
                    if (!live.delete(id)) return;
                    callback(TIMED_OUT_DEADLINE);
                }, timeout);
            }

            live.set(id, entry);
            fifo.push(id);
            channel.port2.postMessage(0);

            return id;
        },
        cancel(handle) {
            const entry = live.get(handle);

            if (!entry) return;

            live.delete(handle);

            if (entry._timer !== undefined) host.clearTimeout(entry._timer);
        },
    };
}

function createMacrotaskAdapter(
    host: HostGlobals,
    sliceMs: number,
    post: (fire: () => void) => unknown,
    cancelPost: (task: unknown) => void
): SchedulerAdapter {
    const live = new Map<number, PendingEntry>();
    let nextId = 1;

    return {
        request(callback, timeout) {
            const id = nextId++;
            const entry: PendingEntry = { _cb: callback };
            entry._task = post(() => {
                if (!live.delete(id)) return;
                if (entry._timer !== undefined) host.clearTimeout(entry._timer);

                callback(syntheticDeadline(host, sliceMs));
            });

            if (timeout != null) {
                entry._timer = host.setTimeout(() => {
                    if (!live.delete(id)) return;

                    cancelPost(entry._task);
                    callback(TIMED_OUT_DEADLINE);
                }, timeout);
            }

            live.set(id, entry);

            return id;
        },
        cancel(handle) {
            const entry = live.get(handle);

            if (!entry) return;

            live.delete(handle);
            cancelPost(entry._task);

            if (entry._timer !== undefined) host.clearTimeout(entry._timer);
        },
    };
}

function createImpl(host: HostGlobals, sliceMs: number): SchedulerAdapter {
    if (
        typeof host.requestIdleCallback === 'function' &&
        typeof host.cancelIdleCallback === 'function'
    ) {
        return createRicAdapter(host);
    }
    if (typeof host.setImmediate === 'function') {
        return createMacrotaskAdapter(
            host,
            sliceMs,
            fire => host.setImmediate!(fire),
            task => host.clearImmediate?.(task)
        );
    }
    if (typeof host.MessageChannel === 'function') {
        return createMessageChannelAdapter(host, sliceMs);
    }

    return createMacrotaskAdapter(
        host,
        sliceMs,
        fire => host.setTimeout(fire, 0),
        task => host.clearTimeout(task)
    );
}

export function createSchedulerAdapterForHost(
    host: HostGlobals,
    options?: SchedulerAdapterOptions
): SchedulerAdapter {
    const sliceMs = 2 * (options?.budgetMs ?? DEFAULT_BUDGET_MS);
    let impl: SchedulerAdapter | null = null;
    const resolve = (): SchedulerAdapter => impl ?? (impl = createImpl(host, sliceMs));

    return {
        request: (callback, timeout) => resolve().request(callback, timeout),
        cancel: handle => resolve().cancel(handle),
    };
}

export function createSchedulerAdapter(options?: SchedulerAdapterOptions): SchedulerAdapter {
    return createSchedulerAdapterForHost(hostGlobals(), options);
}
