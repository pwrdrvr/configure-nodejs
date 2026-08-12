import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  ELECTRON_CACHE_SCHEMA_VERSION,
  assertElectronCachePathsSafe,
  buildCachePaths,
  buildElectronCachePaths,
  buildResult,
  buildWorkingDirectoryKey,
  normalizeCacheElectron,
  normalizeCacheKeySuffix,
  resolveWorkingDirectory,
} from '../scripts/resolve-cache-paths.mjs';

function withTempDir(callback) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'configure-nodejs-paths-'));

  try {
    callback(tempDir);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

test('resolveWorkingDirectory preserves repository-root usage', () => {
  withTempDir((tempDir) => {
    const result = resolveWorkingDirectory(tempDir, '.');

    assert.equal(result.workingDirectory, '.');
    assert.equal(result.absoluteWorkingDirectory, tempDir);
  });
});

test('resolveWorkingDirectory normalizes nested paths with forward slashes', () => {
  withTempDir((tempDir) => {
    const nested = path.join(tempDir, 'fixtures', 'npm-basic');
    fs.mkdirSync(nested, { recursive: true });

    const result = resolveWorkingDirectory(tempDir, path.join('fixtures', 'npm-basic'));

    assert.equal(result.workingDirectory, 'fixtures/npm-basic');
    assert.equal(result.absoluteWorkingDirectory, nested);
  });
});

test('resolveWorkingDirectory rejects paths outside the repository', () => {
  withTempDir((tempDir) => {
    assert.throws(
      () => resolveWorkingDirectory(tempDir, '../outside'),
      /resolves outside the repository root/,
    );
  });
});

test('resolveWorkingDirectory rejects missing paths', () => {
  withTempDir((tempDir) => {
    assert.throws(
      () => resolveWorkingDirectory(tempDir, 'missing'),
      /does not exist/,
    );
  });
});

test('buildWorkingDirectoryKey generates stable root and nested keys', () => {
  assert.equal(buildWorkingDirectoryKey('.'), 'root');
  assert.match(
    buildWorkingDirectoryKey('fixtures/yarn-basic'),
    /^fixtures__yarn-basic-[a-f0-9]{8}$/,
  );
});

test('normalizeCacheKeySuffix preserves safe values and normalizes separators', () => {
  assert.equal(normalizeCacheKeySuffix('fixture-tests'), 'fixture-tests');
  assert.equal(normalizeCacheKeySuffix(' fixture tests / ci '), 'fixture-tests-ci');
  assert.equal(normalizeCacheKeySuffix('   '), '');
});

test('normalizeCacheElectron accepts only normalized booleans', () => {
  assert.equal(normalizeCacheElectron(), false);
  assert.equal(normalizeCacheElectron('false'), false);
  assert.equal(normalizeCacheElectron(' TRUE '), true);
  assert.throws(
    () => normalizeCacheElectron('yes'),
    /Expected "true" or "false"/,
  );
  assert.throws(
    () => normalizeCacheElectron(''),
    /Expected "true" or "false"/,
  );
});

test('buildCachePaths preserves node_modules caching and scopes pnpm stores', () => {
  assert.deepEqual(buildCachePaths('.'), [
    'node_modules',
    '**/node_modules',
    '!node_modules/.cache',
    '!**/node_modules/.cache',
  ]);
  assert.deepEqual(buildCachePaths('fixtures/pnpm-basic', 'pnpm'), [
    'fixtures/pnpm-basic/.pnpm-store',
  ]);
});

test('disabled Electron caching preserves the existing cache paths and key segment', () => {
  withTempDir((tempDir) => {
    const defaultResult = buildResult({
      cwd: tempDir,
      workingDirectory: '.',
      packageManager: 'pnpm',
    });
    const explicitFalseResult = buildResult({
      cwd: tempDir,
      workingDirectory: '.',
      cacheElectron: 'false',
      packageManager: 'pnpm',
    });

    for (const result of [defaultResult, explicitFalseResult]) {
      assert.equal(result.cacheElectron, false);
      assert.equal(result.electronCacheKeySegment, '');
      assert.deepEqual(result.electronCachePaths, []);
      assert.deepEqual(result.cachePaths, ['.pnpm-store']);
      assert.equal(result.absolutePrebuildCachePath, '');
      assert.equal(result.absoluteElectronCachePath, '');
    }
  });
});

test('enabled Electron caching adds both workspace-relative caches and a schema key', () => {
  withTempDir((tempDir) => {
    const nested = path.join(tempDir, 'apps', 'desktop');
    fs.mkdirSync(nested, { recursive: true });

    const result = buildResult({
      cwd: tempDir,
      workingDirectory: path.join('apps', 'desktop'),
      cacheElectron: 'true',
      packageManager: 'pnpm',
    });

    assert.equal(result.cacheElectron, true);
    assert.equal(
      result.electronCacheKeySegment,
      `-electron-true-${ELECTRON_CACHE_SCHEMA_VERSION}`,
    );
    assert.deepEqual(result.electronCachePaths, [
      'apps/desktop/.cache/configure-nodejs/npm',
      'apps/desktop/.cache/configure-nodejs/electron',
    ]);
    assert.deepEqual(result.cachePaths, [
      'apps/desktop/.pnpm-store',
      ...result.electronCachePaths,
    ]);
    assert.equal(
      result.absolutePrebuildCachePath,
      path.join(nested, '.cache', 'configure-nodejs', 'npm'),
    );
    assert.equal(
      result.absoluteElectronCachePath,
      path.join(nested, '.cache', 'configure-nodejs', 'electron'),
    );
  });
});

test('Electron cache paths use portable separators for actions/cache', () => {
  assert.deepEqual(buildElectronCachePaths('apps/desktop'), [
    'apps/desktop/.cache/configure-nodejs/npm',
    'apps/desktop/.cache/configure-nodejs/electron',
  ]);
});

test('Electron cache validation rejects a working directory symlink outside the workspace', () => {
  withTempDir((tempDir) => {
    const workspace = path.join(tempDir, 'workspace');
    const outside = path.join(tempDir, 'outside');
    fs.mkdirSync(workspace);
    fs.mkdirSync(outside);
    fs.symlinkSync(
      outside,
      path.join(workspace, 'desktop'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );

    assert.throws(
      () =>
        buildResult({
          cwd: workspace,
          workingDirectory: 'desktop',
          cacheElectron: 'true',
          packageManager: 'pnpm',
        }),
      /Working directory.*escapes.*symbolic link/,
    );
  });
});

test('Electron cache validation rejects a cache symlink created outside the boundary', () => {
  withTempDir((tempDir) => {
    const workingDirectory = path.join(tempDir, 'desktop');
    const outside = path.join(tempDir, 'outside');
    const cacheRoot = path.join(workingDirectory, '.cache', 'configure-nodejs');
    fs.mkdirSync(cacheRoot, { recursive: true });
    fs.mkdirSync(outside);
    fs.symlinkSync(
      outside,
      path.join(cacheRoot, 'npm'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );

    assert.throws(
      () =>
        assertElectronCachePathsSafe({
          cwd: tempDir,
          absoluteWorkingDirectory: workingDirectory,
          absoluteElectronCachePaths: [path.join(cacheRoot, 'npm')],
        }),
      /Electron cache path.*escapes.*symbolic link/,
    );
  });
});

test('buildResult emits native absolute paths and stable cache metadata', () => {
  withTempDir((tempDir) => {
    const nested = path.join(tempDir, 'fixtures', 'pnpm-basic');
    fs.mkdirSync(nested, { recursive: true });

    const result = buildResult({
      cwd: tempDir,
      workingDirectory: path.join('fixtures', 'pnpm-basic'),
      cacheKeySuffix: 'fixture tests',
      packageManager: 'pnpm',
    });

    assert.equal(result.workingDirectory, 'fixtures/pnpm-basic');
    assert.match(result.workingDirectoryKey, /^fixtures__pnpm-basic-[a-f0-9]{8}$/);
    assert.equal(result.primaryCachePath, 'fixtures/pnpm-basic/.pnpm-store');
    assert.equal(result.absolutePrimaryCachePath, path.join(nested, '.pnpm-store'));
    assert.equal(result.cacheKeySuffixSegment, '-fixture-tests');
  });
});
