import tseslint from 'typescript-eslint';

export default tseslint.config(
    { ignores: ['dist/', 'coverage/', 'node_modules/'] },
    ...tseslint.configs.recommended,
    {
        files: ['src/core/**/*.ts'],
        rules: {
            'no-restricted-globals': [
                'error',
                'window',
                'document',
                'navigator',
                'requestIdleCallback',
                'cancelIdleCallback',
                'setTimeout',
                'clearTimeout',
                'setInterval',
                'clearInterval',
                'setImmediate',
                'clearImmediate',
                'MessageChannel',
                'performance',
                'addEventListener',
                'removeEventListener',
            ],
        },
    }
);
