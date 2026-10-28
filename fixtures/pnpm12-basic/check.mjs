import { checkArchiveProbe } from '../cache-archive-probe.mjs';
import assert from 'node:assert/strict';
import pc from 'picocolors';
import lockfile from 'proper-lockfile';
import { transformSync } from 'esbuild';
assert.equal(typeof pc.green, 'function');
assert.match(transformSync('const square = (x: number) => x * x', { loader: 'ts' }).code, /const square/);
console.log(pc.green('pnpm 12 links and native esbuild binary loaded'));

checkArchiveProbe();

const release = lockfile.lockSync(process.cwd());
try { assert.equal(lockfile.checkSync(process.cwd()), true); }
finally { release(); }
