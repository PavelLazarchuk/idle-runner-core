export function createAbortError(message = 'Aborted'): Error {
    if (typeof DOMException === 'function') {
        return new DOMException(message, 'AbortError') as unknown as Error;
    }

    const error = new Error(message);
    error.name = 'AbortError';

    return error;
}
