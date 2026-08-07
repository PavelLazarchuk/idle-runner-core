declare const process: { env?: { NODE_ENV?: string } } | undefined;

function isDev(): boolean {
    return typeof process === 'undefined' || process?.env?.NODE_ENV !== 'production';
}

export function devWarn(message: string): void {
    if (isDev() && typeof console !== 'undefined') {
        console.warn(`idle-runner: ${message}`);
    }
}
