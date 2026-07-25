import { describe, expect, it, vi } from 'vitest';

import { createSchedulerAdapterForHost, detectRung } from '../src/scheduler/adapter';
import { bindHiddenFlush } from '../src/scheduler/lifecycle';
import type { HostGlobals } from '../src/scheduler/host';

const noopTimers = {
    setTimeout: (cb: () => void, ms?: number) => setTimeout(cb, ms),
    clearTimeout: (h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

describe('detectRung — ladder precedence', () => {
    it('prefers requestIdleCallback when present', () => {
        const host = {
            requestIdleCallback: () => 1,
            cancelIdleCallback: () => {},
            setImmediate: () => 1,
            MessageChannel,
            ...noopTimers,
        } as unknown as HostGlobals;
        expect(detectRung(host)).toBe('requestIdleCallback');
    });

    it('prefers setImmediate over MessageChannel (Node guard: an open port pins the event loop)', () => {
        const host = {
            setImmediate: () => 1,
            MessageChannel,
            ...noopTimers,
        } as unknown as HostGlobals;
        expect(detectRung(host)).toBe('setImmediate');
    });

    it('falls back to MessageChannel when rIC and setImmediate are absent (the WebKit path)', () => {
        const host = { MessageChannel, ...noopTimers } as unknown as HostGlobals;
        expect(detectRung(host)).toBe('MessageChannel');
    });

    it('falls back to setTimeout when nothing else exists', () => {
        const host = { ...noopTimers } as unknown as HostGlobals;
        expect(detectRung(host)).toBe('setTimeout');
    });
});

describe('requestIdleCallback rung — passthrough', () => {
    it('forwards callback and timeout, returns the native handle, cancels natively', () => {
        const ric = vi.fn(() => 77);
        const cancel = vi.fn();
        const host = {
            requestIdleCallback: ric,
            cancelIdleCallback: cancel,
            ...noopTimers,
        } as unknown as HostGlobals;
        const adapter = createSchedulerAdapterForHost(host);
        const cb = () => {};
        const handle = adapter.request(cb, 123);
        expect(handle).toBe(77);
        expect(ric).toHaveBeenCalledWith(cb, { timeout: 123 });
        adapter.cancel(handle);
        expect(cancel).toHaveBeenCalledWith(77);
    });

    it('omits the options object when no timeout is given', () => {
        const ric = vi.fn(() => 1);
        const host = {
            requestIdleCallback: ric,
            cancelIdleCallback: () => {},
            ...noopTimers,
        } as unknown as HostGlobals;
        createSchedulerAdapterForHost(host).request(() => {});
        expect(ric).toHaveBeenCalledWith(expect.any(Function), undefined);
    });
});

describe('MessageChannel rung — synthesized deadline', () => {
    const mcHost = (budget?: number) => {
        const host = {
            MessageChannel,
            performance,
            ...noopTimers,
        } as unknown as HostGlobals;
        return createSchedulerAdapterForHost(
            host,
            budget == null ? undefined : { budgetMs: budget }
        );
    };

    it('fires asynchronously with didTimeout=false and a bounded timeRemaining', async () => {
        const adapter = mcHost(5);
        const deadline = await new Promise<{ didTimeout: boolean; timeRemaining(): number }>(
            resolve => adapter.request(d => resolve(d))
        );
        expect(deadline.didTimeout).toBe(false);
        expect(deadline.timeRemaining()).toBeLessThanOrEqual(10);
        expect(deadline.timeRemaining()).toBeGreaterThanOrEqual(0);
    });

    it('a cancelled request never fires', async () => {
        const adapter = mcHost();
        const spy = vi.fn();
        const handle = adapter.request(spy);
        adapter.cancel(handle);
        await new Promise(resolve => setTimeout(resolve, 30));
        expect(spy).not.toHaveBeenCalled();
    });

    it('later requests still fire after an earlier one was cancelled (fifo skip)', async () => {
        const adapter = mcHost();
        const first = vi.fn();
        const handle = adapter.request(first);
        const second = new Promise<boolean>(resolve => adapter.request(d => resolve(d.didTimeout)));
        adapter.cancel(handle);
        await expect(second).resolves.toBe(false);
        expect(first).not.toHaveBeenCalled();
    });
});

describe('setImmediate rung (Node)', () => {
    it('fires with a synthesized idle deadline', async () => {
        const host = {
            setImmediate,
            clearImmediate,
            performance,
            ...noopTimers,
        } as unknown as HostGlobals;
        const adapter = createSchedulerAdapterForHost(host);
        const deadline = await new Promise<{ didTimeout: boolean }>(resolve =>
            adapter.request(d => resolve(d))
        );
        expect(deadline.didTimeout).toBe(false);
    });

    it('cancel prevents the callback', async () => {
        const host = {
            setImmediate,
            clearImmediate,
            ...noopTimers,
        } as unknown as HostGlobals;
        const adapter = createSchedulerAdapterForHost(host);
        const spy = vi.fn();
        adapter.cancel(adapter.request(spy));
        await new Promise(resolve => setTimeout(resolve, 20));
        expect(spy).not.toHaveBeenCalled();
    });
});

describe('lazy detection', () => {
    it('touches no host API until the first request()', () => {
        const reads: string[] = [];
        const host = new Proxy({} as Record<string, unknown>, {
            get(_target, prop) {
                reads.push(String(prop));
                if (prop === 'setTimeout') return noopTimers.setTimeout;
                if (prop === 'clearTimeout') return noopTimers.clearTimeout;
                return undefined;
            },
        }) as unknown as HostGlobals;
        const adapter = createSchedulerAdapterForHost(host);
        expect(reads).toHaveLength(0);
        adapter.request(() => {});
        expect(reads.length).toBeGreaterThan(0);
    });
});

describe('bindHiddenFlush', () => {
    interface StubTarget {
        listeners: Map<string, () => void>;
        addEventListener: (type: string, listener: () => void) => void;
        removeEventListener: (type: string, listener: () => void) => void;
    }
    const stubTarget = (): StubTarget => {
        const listeners = new Map<string, () => void>();
        return {
            listeners,
            addEventListener: (type: string, listener: () => void) => listeners.set(type, listener),
            removeEventListener: (type: string) => listeners.delete(type),
        };
    };

    it('no-ops without a document (SSR)', () => {
        const flush = vi.fn();
        const unbind = bindHiddenFlush(flush, { ...noopTimers } as unknown as HostGlobals);
        unbind();
        expect(flush).not.toHaveBeenCalled();
    });

    it('flushes when visibility goes hidden, not while visible', () => {
        const doc = stubTarget() as StubTarget & { visibilityState: string };
        doc.visibilityState = 'visible';
        const win = stubTarget();
        const flush = vi.fn();
        bindHiddenFlush(flush, {
            document: doc,
            window: win,
            ...noopTimers,
        } as unknown as HostGlobals);
        doc.listeners.get('visibilitychange')!();
        expect(flush).not.toHaveBeenCalled();
        doc.visibilityState = 'hidden';
        doc.listeners.get('visibilitychange')!();
        expect(flush).toHaveBeenCalledTimes(1);
    });

    it('flushes on pagehide', () => {
        const doc = stubTarget() as StubTarget & { visibilityState: string };
        const win = stubTarget();
        const flush = vi.fn();
        bindHiddenFlush(flush, {
            document: doc,
            window: win,
            ...noopTimers,
        } as unknown as HostGlobals);
        win.listeners.get('pagehide')!();
        expect(flush).toHaveBeenCalledTimes(1);
    });

    it('adds the beforeunload workaround only for Safari user agents', () => {
        const safariUA =
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15';
        const chromeUA =
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

        const docA = stubTarget() as StubTarget & { visibilityState: string };
        const winA = stubTarget();
        bindHiddenFlush(() => {}, {
            document: docA,
            window: winA,
            navigator: { userAgent: safariUA },
            ...noopTimers,
        } as unknown as HostGlobals);
        expect(winA.listeners.has('beforeunload')).toBe(true);

        const docB = stubTarget() as StubTarget & { visibilityState: string };
        const winB = stubTarget();
        bindHiddenFlush(() => {}, {
            document: docB,
            window: winB,
            navigator: { userAgent: chromeUA },
            ...noopTimers,
        } as unknown as HostGlobals);
        expect(winB.listeners.has('beforeunload')).toBe(false);
    });

    it('unbind removes every listener it added', () => {
        const doc = stubTarget() as StubTarget & { visibilityState: string };
        const win = stubTarget();
        const unbind = bindHiddenFlush(() => {}, {
            document: doc,
            window: win,
            ...noopTimers,
        } as unknown as HostGlobals);
        expect(doc.listeners.size + win.listeners.size).toBeGreaterThan(0);
        unbind();
        expect(doc.listeners.size).toBe(0);
        expect(win.listeners.size).toBe(0);
    });
});
