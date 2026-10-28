import { checkArchiveProbe } from '../cache-archive-probe.mjs';
import assert from 'node:assert/strict';
import pc from 'picocolors';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { transformSync } from 'esbuild';
assert.equal(typeof pc.green, 'function');
assert.match(transformSync('const square = (x: number) => x * x', { loader: 'ts' }).code, /const square/);
console.log(pc.green('pnpm 12 links and native esbuild binary loaded'));

checkArchiveProbe();

let lockfile;
try { lockfile = (await import('proper-lockfile')).default; }
catch (error) {
  const require = createRequire(import.meta.url);
  const owner = path.dirname(require.resolve('proper-lockfile/package.json'));
  for (const file of [path.resolve(owner, '../retry'), path.resolve('node_modules/.pnpm/retry@0.12.0/node_modules/retry')]) {
    const stat = fs.lstatSync(file);
    console.log('restored dependency', file, { symlink: stat.isSymbolicLink(), target: stat.isSymbolicLink() ? fs.readlinkSync(file) : null });
  }
  throw error;
}
const release = lockfile.lockSync(process.cwd());
try { assert.equal(lockfile.checkSync(process.cwd()), true); }
finally { release(); }
