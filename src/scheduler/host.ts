export interface HostIdleDeadline {
    timeRemaining(): number;
    readonly didTimeout: boolean;
}

export interface HostMessagePortLike {
    onmessage: ((event: unknown) => void) | null;
    postMessage(value: unknown): void;
}

export interface HostGlobals {
    requestIdleCallback?: (
        callback: (deadline: HostIdleDeadline) => void,
        options?: { timeout?: number }
    ) => number;
    cancelIdleCallback?: (handle: number) => void;
    setImmediate?: (callback: () => void) => unknown;
    clearImmediate?: (handle: unknown) => void;
    MessageChannel?: new () => { port1: HostMessagePortLike; port2: HostMessagePortLike };
    setTimeout: (callback: () => void, ms?: number) => unknown;
    clearTimeout: (handle: unknown) => void;
    performance?: { now(): number };
    document?: {
        visibilityState?: string;
        addEventListener(type: string, listener: () => void): void;
        removeEventListener(type: string, listener: () => void): void;
    };
    window?: {
        addEventListener?(type: string, listener: () => void): void;
        removeEventListener?(type: string, listener: () => void): void;
    };
    navigator?: { userAgent?: string };
}

export function hostGlobals(): HostGlobals {
    return globalThis as unknown as HostGlobals;
}
