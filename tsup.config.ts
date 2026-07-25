import { defineConfig } from 'tsup';

export default defineConfig({
    entry: ['src/index.ts'],
    format: ['esm', 'cjs'],
    dts: true,
    target: 'es2020',
    sourcemap: true,
    clean: true,
    treeshake: true,
    esbuildOptions(options) {
        options.mangleProps = /^_/;
    },
});
