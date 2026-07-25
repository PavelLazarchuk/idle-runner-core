import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url)));
const spec = `${pkg.name}@${pkg.version}`;

try {
    execSync(`npm view ${spec} version`, { stdio: 'ignore' });
    console.log(`${spec} is already published — nothing to do.`);
} catch {
    execSync('changeset publish', { stdio: 'inherit' });
}
