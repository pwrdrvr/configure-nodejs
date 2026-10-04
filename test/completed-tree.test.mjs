import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { installationInputsHash, buildCompletedKey, validateCacheMode, completePopulation, verifyCompletedTree, METADATA_PATH } from '../scripts/completed-tree.mjs';
import { shouldInstallDependencies, shouldDiscardRestoredDependencies } from '../scripts/resolve-node-version.mjs';
import { buildResult } from '../scripts/resolve-cache-paths.mjs';
import { hasCacheableDependencyPath } from '../scripts/detect-cache-paths.mjs';

function fixture(t) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'completed-tree-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  for (const [name, bytes] of Object.entries({ 'package.json': '{"packageManager":"pnpm@12.7.0"}', 'pnpm-lock.yaml': 'lockfileVersion: 9\n---\nsecond: document\n', 'pnpm-workspace.yaml': 'packageImportMethod: auto\n', '.npmrc': 'strict-peer-dependencies=true\n', 'patch.diff': 'original patch\n' })) {
    fs.writeFileSync(path.join(cwd, name), bytes);
  }
  fs.mkdirSync(path.join(cwd, 'node_modules/.pnpm'), { recursive: true });
  const args = { cwd, lockfilePath: 'pnpm-lock.yaml', cacheInputs: 'patch.diff' };
  return { ...args, key: 'completed-test', nodeMajor: 24, nodeABI: '137', lockfileSha: crypto.createHash('sha256').update(fs.readFileSync(path.join(cwd, args.lockfilePath))).digest('hex'), inputsHash: installationInputsHash(args) };
}

test('completed modes require explicit role and exact pnpm pin without changing defaults', () => {
  validateCacheMode({});
  for (const args of [{ dependencyCache: 'bad' }, { cacheMode: 'restore' }, { dependencyCache: 'node-modules' }, { dependencyCache: 'node-modules', cacheMode: 'restore', lookupOnly: 'true' }, { dependencyCache: 'node-modules', cacheMode: 'restore', packageManager: 'npm', packageManagerVersion: '11.0.0' }, { dependencyCache: 'node-modules', cacheMode: 'populate', packageManager: 'pnpm', packageManagerVersion: '^12' }]) {
    assert.throws(() => validateCacheMode(args));
  }
  for (const cacheMode of ['populate', 'restore']) validateCacheMode({ dependencyCache: 'node-modules', cacheMode, packageManager: 'pnpm', packageManagerVersion: '12.7.0' });
});

test('strict decision matrix never installs or discards a completed tree', () => {
  for (const cacheHit of [true, false]) for (const cacheMode of ['populate', 'restore']) for (const mismatch of [null, { installedMajor: 22 }]) {
    const args = { packageManager: 'pnpm', dependencyCache: 'node-modules', cacheHit, cacheMode, mismatch };
    if (mismatch || (cacheMode === 'restore' && !cacheHit)) assert.throws(() => shouldInstallDependencies(args), /forbid/);
    else assert.equal(shouldInstallDependencies(args), cacheMode === 'populate' && !cacheHit);
    if (mismatch) assert.throws(() => shouldDiscardRestoredDependencies(args), /forbid/);
    else assert.equal(shouldDiscardRestoredDependencies(args), false);
  }
  assert.equal(shouldInstallDependencies({ packageManager: 'pnpm', cacheHit: true }), true);
});

test('completed key changes for every compatibility input but ignores role and ImageVersion', () => {
  const args = { nodeMajor: 24, packageManagerVersion: '12.7.0', os: 'Linux', arch: 'X64', imageOS: 'ubuntu24', workingDirectory: '.', inputsHash: 'full-bytes', actionRevision: 'reviewed-sha', cacheKeySuffix: 'caller/policy', cacheElectron: false };
  const key = buildCompletedKey(args);
  for (const [field, value] of Object.entries({ nodeMajor: 22, packageManagerVersion: '10.33.0', os: 'macOS', arch: 'ARM64', imageOS: 'ubuntu26', workingDirectory: 'packages/app', inputsHash: 'different-bytes', actionRevision: 'new-sha', cacheKeySuffix: 'caller?policy', cacheElectron: true })) {
    assert.notEqual(buildCompletedKey({ ...args, [field]: value }), key, field);
  }
  assert.equal(buildCompletedKey({ ...args, cacheMode: 'populate', imageVersion: 'old' }), buildCompletedKey({ ...args, cacheMode: 'restore', imageVersion: 'new' }));
  assert.match(key, /^completed-node-modules-v1-node24-pnpm-12.7.0-/);
});

test('hash includes all lock bytes, policy files, additional inputs and workspace manifests', (t) => {
  const args = fixture(t);
  for (const name of ['pnpm-lock.yaml', 'package.json', '.npmrc', 'pnpm-workspace.yaml', 'patch.diff']) {
    const file = path.join(args.cwd, name);
    const original = fs.readFileSync(file);
    fs.appendFileSync(file, '\n# change at end\n');
    assert.notEqual(installationInputsHash(args), args.inputsHash, name);
    fs.writeFileSync(file, original);
  }
  fs.mkdirSync(path.join(args.cwd, 'packages/a'), { recursive: true });
  fs.writeFileSync(path.join(args.cwd, 'packages/a/package.json'), '{}');
  assert.notEqual(installationInputsHash(args), args.inputsHash);
  assert.throws(() => installationInputsHash({ ...args, cacheInputs: '../outside' }));
  assert.throws(() => installationInputsHash({ ...args, cacheInputs: 'missing.patch' }));
});

test('only verified population produces a cacheable completed tree', (t) => {
  const args = fixture(t);
  const paths = buildResult({ cwd: args.cwd, workingDirectory: '.', packageManager: 'pnpm', dependencyCache: 'node-modules' });
  const detectArgs = { ...paths, packageManager: 'pnpm', dependencyCache: 'node-modules' };
  assert.equal(hasCacheableDependencyPath(detectArgs), false);
  completePopulation(args);
  assert.equal(hasCacheableDependencyPath(detectArgs), true);
  verifyCompletedTree(args);
  for (const change of [{ nodeMajor: 22 }, { nodeABI: '999' }, { key: 'wrong-key' }]) assert.throws(() => verifyCompletedTree({ ...args, ...change }), /Incompatible/);
  fs.rmSync(path.join(args.cwd, METADATA_PATH));
  fs.appendFileSync(path.join(args.cwd, 'pnpm-lock.yaml'), '# mutation');
  assert.throws(() => completePopulation(args), /lockfile/);
  assert.equal(hasCacheableDependencyPath(detectArgs), false);
});

test('changed manifest prevents save even when lock remains unchanged', (t) => {
  const args = fixture(t);
  fs.appendFileSync(path.join(args.cwd, 'package.json'), '\n');
  assert.throws(() => completePopulation(args), /changed an input/);
  assert.equal(fs.existsSync(path.join(args.cwd, METADATA_PATH)), false);
});

test('default store paths and namespace remain distinct from completed trees', (t) => {
  const { cwd } = fixture(t);
  const defaults = buildResult({ cwd, workingDirectory: '.', packageManager: 'pnpm' });
  const completed = buildResult({ cwd, workingDirectory: './', packageManager: 'pnpm', dependencyCache: 'node-modules' });
  assert.deepEqual(defaults.cachePaths, ['.pnpm-store']);
  assert.equal(defaults.cacheKeyPrefix, 'pnpm-store');
  assert.equal(completed.primaryCachePath, 'node_modules');
  assert.ok(completed.cachePaths.includes(METADATA_PATH));
  assert.ok(!completed.cachePaths.includes('.pnpm-store'));
});
