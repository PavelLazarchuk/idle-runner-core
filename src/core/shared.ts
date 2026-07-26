import { IdleRunner } from './idle-runner';

let shared: IdleRunner | null = null;

export function sharedRunner(): IdleRunner {
    if (!shared) shared = new IdleRunner();

    return shared;
}
