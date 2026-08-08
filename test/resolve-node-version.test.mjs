import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildNodeCacheKeySegment,
  buildResult,
  detectNodeMajorMismatch,
  extractNodeMajor,
  parseNodeVersionSpec,
} from '../scripts/resolve-node-version.mjs';

const PINNED_SPECS = [
  ['22.x', 22],
  ['24.14.1', 24],
  ['24', 24],
  ['v24.14.1', 24],
  ['24.X', 24],
  ['24.*', 24],
  ['=24.0.0', 24],
  ['~22.3.0', 22],
  ['~22', 22],
  ['^24.1.0', 24],
  ['24-nightly', 24],
  ['24.0.0-nightly20240101abcdef', 24],
  ['  20.11.0  ', 20],
];

for (const [spec, major] of PINNED_SPECS) {
  test(`parseNodeVersionSpec pins "${spec}" to major ${major}`, () => {
    const result = parseNodeVersionSpec(spec);

    assert.equal(result.isFloating, false);
    assert.equal(result.major, major);
  });
}

const FLOATING_SPECS = [
  ['lts/*', 'lts-alias'],
  ['lts/-1', 'lts-alias'],
  ['lts/jod', 'lts-alias'],
  ['LTS/*', 'lts-alias'],
  ['lts', 'lts-alias'],
  ['latest', 'moving-alias'],
  ['current', 'moving-alias'],
  ['node', 'moving-alias'],
  ['nightly', 'moving-alias'],
  ['*', 'moving-alias'],
  ['x', 'moving-alias'],
  ['>=20', 'open-ended-range'],
  ['>20.1.0', 'open-ended-range'],
  ['<=24', 'open-ended-range'],
  ['<24', 'open-ended-range'],
  ['>=20 <21', 'compound-range'],
  ['20 || 22', 'compound-range'],
  ['20||22', 'compound-range'],
  ['x.x', 'unrecognized'],
  ['', 'empty'],
  ['   ', 'empty'],
];

for (const [spec, reason] of FLOATING_SPECS) {
  test(`parseNodeVersionSpec floats "${spec}" (${reason})`, () => {
    const result = parseNodeVersionSpec(spec);

    assert.equal(result.isFloating, true);
    assert.equal(result.major, null);
    assert.equal(result.reason, reason);
  });
}

test('parseNodeVersionSpec tolerates nullish input', () => {
  assert.equal(parseNodeVersionSpec(undefined).isFloating, true);
  assert.equal(parseNodeVersionSpec(null).isFloating, true);
});

test('extractNodeMajor reads the major from resolved setup-node output', () => {
  assert.equal(extractNodeMajor('24.18.0'), 24);
  assert.equal(extractNodeMajor('v22.11.0'), 22);
  assert.equal(extractNodeMajor('25.0.0-nightly20260101abcdef'), 25);
  assert.equal(extractNodeMajor(''), null);
  assert.equal(extractNodeMajor(undefined), null);
  assert.equal(extractNodeMajor('lts/*'), null);
});

test('buildNodeCacheKeySegment rejects a missing major', () => {
  assert.equal(buildNodeCacheKeySegment(24), 'node24');
  assert.throws(() => buildNodeCacheKeySegment(null), /Expected a Node\.js major/);
  assert.throws(() => buildNodeCacheKeySegment('24'), /Expected a Node\.js major/);
});

test('buildResult keys a pinned spec without consulting setup-node', () => {
  const result = buildResult({ nodeVersion: '22.x' });

  assert.equal(result.isFloating, false);
  assert.equal(result.resolvedFrom, 'spec');
  assert.equal(result.nodeMajor, 22);
  assert.equal(result.nodeCacheKeySegment, 'node22');
});

test('buildResult ignores the installed version for a pinned spec', () => {
  // The pinned path restores before setup-node runs, so nothing is available
  // to read; the segment has to come from the spec alone.
  const result = buildResult({
    nodeVersion: '24.14.1',
    installedNodeVersion: '',
  });

  assert.equal(result.nodeCacheKeySegment, 'node24');
});

test('buildResult keys a floating spec on the version setup-node installed', () => {
  const result = buildResult({
    nodeVersion: 'lts/*',
    installedNodeVersion: '24.18.0',
  });

  assert.equal(result.isFloating, true);
  assert.equal(result.resolvedFrom, 'setup-node');
  assert.equal(result.nodeMajor, 24);
  assert.equal(result.nodeCacheKeySegment, 'node24');
});

test('buildResult refuses to key a floating spec without a resolved version', () => {
  assert.throws(
    () => buildResult({ nodeVersion: 'lts/*', installedNodeVersion: '' }),
    /must use the version actions\/setup-node installed/,
  );
});

test('a floating spec crossing a major changes the cache key segment', () => {
  // The regression this module exists for: `lts/*` used to contribute the
  // literal string "lts/*" to the key, so a runner image moving from Node 22 to
  // Node 24 restored a node_modules whose native addons were built against the
  // previous NODE_MODULE_VERSION.
  const beforeBump = buildResult({
    nodeVersion: 'lts/*',
    installedNodeVersion: '22.20.0',
  });
  const afterBump = buildResult({
    nodeVersion: 'lts/*',
    installedNodeVersion: '24.18.0',
  });

  assert.notEqual(
    beforeBump.nodeCacheKeySegment,
    afterBump.nodeCacheKeySegment,
  );
});

test('patch and minor moves within one major keep sharing a cache entry', () => {
  // ABI is stable within a major, so pinning differently inside one major must
  // not fragment the cache.
  assert.equal(
    buildResult({ nodeVersion: '24.14.1' }).nodeCacheKeySegment,
    buildResult({ nodeVersion: '24.18.0' }).nodeCacheKeySegment,
  );
  assert.equal(
    buildResult({ nodeVersion: '24.x' }).nodeCacheKeySegment,
    buildResult({ nodeVersion: '^24.1.0' }).nodeCacheKeySegment,
  );
  assert.equal(
    buildResult({ nodeVersion: 'lts/*', installedNodeVersion: '24.14.1' })
      .nodeCacheKeySegment,
    buildResult({ nodeVersion: 'lts/*', installedNodeVersion: '24.18.0' })
      .nodeCacheKeySegment,
  );
});

test('detectNodeMajorMismatch stays quiet when setup-node agrees or was skipped', () => {
  assert.equal(
    detectNodeMajorMismatch({
      cacheKeyNodeMajor: '24',
      installedNodeVersion: '24.18.0',
    }),
    null,
  );
  assert.equal(
    detectNodeMajorMismatch({
      cacheKeyNodeMajor: '24',
      installedNodeVersion: '',
    }),
    null,
  );
  assert.equal(
    detectNodeMajorMismatch({
      cacheKeyNodeMajor: '',
      installedNodeVersion: '24.18.0',
    }),
    null,
  );
});

test('detectNodeMajorMismatch reports a spec that resolved outside its parsed major', () => {
  assert.deepEqual(
    detectNodeMajorMismatch({
      cacheKeyNodeMajor: '22',
      installedNodeVersion: '24.18.0',
    }),
    { cacheKeyNodeMajor: 22, installedMajor: 24 },
  );
});
