import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  buildCachePaths,
  buildResult,
  buildWorkingDirectoryKey,
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
