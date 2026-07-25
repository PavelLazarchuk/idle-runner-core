import { describe, expect, it } from 'vitest';

describe('SSR / Node', () => {
    it('imports without touching host globals and runs end-to-end on the Node rung', async () => {
        const { IdleRunner } = await import('../src/index');

        const runner = new IdleRunner();
        await expect(runner.push(() => 6 * 7)).resolves.toBe(42);
    });

    it('chunked work completes on the Node rung across real slices', async () => {
        const { IdleRunner } = await import('../src/index');
        const runner = new IdleRunner();
        function* sum() {
            let total = 0;
            for (let i = 1; i <= 100; i++) {
                total += i;
                if (i % 10 === 0) yield;
            }
            return total;
        }
        await expect(runner.pushChunked(sum())).resolves.toBe(5050);
    });

    it('honors a task timeout end-to-end with the real adapter', async () => {
        const { IdleRunner } = await import('../src/index');
        const runner = new IdleRunner();
        await expect(runner.push(() => 'forced', { timeout: 30 })).resolves.toBe('forced');
    });
});
