import { hostGlobals, type HostGlobals } from './host';

/**
 * Monotonic milliseconds. `Date.now()` is wall-clock: an NTP correction or a
 * user changing the system clock mid-flight shifts every armed deadline, and
 * its 1ms resolution is coarse next to a 5ms slice budget. `performance.now()`
 * is monotonic and sub-millisecond; Date is the fallback for hosts without it.
 *
 * Only ever compare values from the same source — the two clocks have
 * different origins.
 */
export function now(host: HostGlobals): number {
    const perf = host.performance;

    return perf ? perf.now() : Date.now();
}

export function hostNow(): number {
    return now(hostGlobals());
}
