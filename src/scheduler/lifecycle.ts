import { hostGlobals, type HostGlobals } from './host';

/**
 * Flush-on-hidden binding (borrowed from idlize's ensureTasksRun):
 * idle periods on hidden pages are throttled to as little as one every 10s, and
 * the page may never come back at all. Returns an unbind function; no-ops in
 * hostless environments (Node/SSR).
 */
export function bindHiddenFlush(flush: () => void, host: HostGlobals = hostGlobals()): () => void {
    const doc = host.document;
    const win = host.window;

    if (!doc || typeof doc.addEventListener !== 'function') {
        return () => {};
    }

    const onVisibilityChange = () => {
        if (doc.visibilityState === 'hidden') flush();
    };
    const onPageHide = () => flush();
    doc.addEventListener('visibilitychange', onVisibilityChange);
    win?.addEventListener?.('pagehide', onPageHide);
    const ua = host.navigator?.userAgent ?? '';
    const isSafari = /safari/i.test(ua) && !/(chrom|crios|android|edg)/i.test(ua);
    const onBeforeUnload = isSafari ? () => flush() : null;

    if (onBeforeUnload) win?.addEventListener?.('beforeunload', onBeforeUnload);

    return () => {
        doc.removeEventListener('visibilitychange', onVisibilityChange);
        win?.removeEventListener?.('pagehide', onPageHide);

        if (onBeforeUnload) win?.removeEventListener?.('beforeunload', onBeforeUnload);
    };
}
