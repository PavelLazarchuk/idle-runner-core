---
'@idle-runner/core': patch
---

Add a `size-limit` budget and enforce it in CI. `npm run size` measures the built ESM and CJS bundles (minified + brotli) and fails if they exceed the limits in `.size-limit.json` — currently 3 kB for the full entry point, plus a tree-shaken `IdleRunner`-only entry so a regression in tree-shakeability shows up as a CI failure. Tooling only; the published bundle is unchanged.
