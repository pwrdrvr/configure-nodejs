import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { resolveCorepackCache } from '../scripts/resolve-corepack-cache.mjs';

const base = { manager: 'pnpm', version: '10.33.0', runnerTemp: '/tmp/runner', os: 'Linux', arch: 'X64' };
test('Corepack identity separates versions, integrity hashes, managers and platforms', () => {
  const original = resolveCorepackCache(base);
  for (const change of [
    { version: '10.34.0' }, { version: '10.33.0+sha224.abcdef' },
    { manager: 'yarn' }, { os: 'Windows' }, { arch: 'ARM64' },
  ]) {
    assert.notEqual(resolveCorepackCache({ ...base, ...change }).key, original.key);
  }
  assert.equal(resolveCorepackCache({ ...base, runnerTemp: '/another/runner' }).key, original.key);
  assert.equal(
    path.relative(base.runnerTemp, path.dirname(original.home)),
    'configure-nodejs-corepack',
  );
});
test('mutable selectors and npm do not enable Corepack caching', () => {
  for (const version of ['', 'latest', '10.x', '^10.0.0', 'https://example.com/pnpm.tgz']) {
    assert.equal(resolveCorepackCache({ ...base, version }), null);
  }
  assert.equal(resolveCorepackCache({ ...base, manager: 'npm' }), null);
  assert.ok(resolveCorepackCache({ ...base, version: '11.0.0-rc.1' }));
});

test('opt-out disables caching even for an existing action-managed home', () => {
  const home = resolveCorepackCache(base).home;
  assert.equal(resolveCorepackCache({ ...base, enabled: false }), null);
  assert.equal(resolveCorepackCache({ ...base, enabled: false, corepackHome: home, managedCorepackHome: home }), null);
});

test('caller-supplied homes remain unmanaged, even if they resemble our default', () => {
  for (const corepackHome of ['/custom/corepack', 'C:\\custom\\corepack', resolveCorepackCache(base).home]) {
    assert.equal(resolveCorepackCache({ ...base, corepackHome }), null);
  }
  assert.equal(resolveCorepackCache({ ...base, corepackHome: '/new/home', managedCorepackHome: '/old/home' }), null);
});

test('repeated invocations can restore an action-managed home and change versions', () => {
  const original = resolveCorepackCache(base);
  const existing = { corepackHome: original.home, managedCorepackHome: original.home };
  assert.deepEqual(resolveCorepackCache({ ...base, ...existing }), original);
  assert.notEqual(resolveCorepackCache({ ...base, ...existing, version: '10.34.0' }).home, original.home);
});
