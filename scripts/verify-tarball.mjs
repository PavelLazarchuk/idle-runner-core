import { execSync } from 'node:child_process';

const output = execSync('npm pack --dry-run --json', {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
});
const [pack] = JSON.parse(output);
const files = pack.files.map(file => file.path);

const allowed = /^(dist\/|package\.json$|README\.md$|LICENSE$|CHANGELOG\.md$)/;
const unexpected = files.filter(file => !allowed.test(file));

if (unexpected.length > 0) {
    console.error('Unexpected files in the npm tarball:');
    for (const file of unexpected) console.error(`  ${file}`);
    process.exit(1);
}

const required = [
    'dist/index.js',
    'dist/index.cjs',
    'dist/index.d.ts',
    'dist/index.d.cts',
    'package.json',
    'README.md',
    'LICENSE',
];
const missing = required.filter(file => !files.includes(file));

if (missing.length > 0) {
    console.error('Missing from the npm tarball:');
    for (const file of missing) console.error(`  ${file}`);
    process.exit(1);
}

console.log(`tarball ok: ${files.length} files, ${pack.size} bytes packed`);
