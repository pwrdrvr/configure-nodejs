import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  buildCachePaths,
  buildResult,
  buildWorkingDirectoryKey,
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

test('resolveWorkingDirectory preserves root-relative usage', () => {
  withTempDir((tempDir) => {
    const result = resolveWorkingDirectory(tempDir, '.');

    assert.equal(result.workingDirectory, '.');
    assert.equal(result.absoluteWorkingDirectory, tempDir);
  });
});

test('resolveWorkingDirectory resolves nested directories relative to the repository root', () => {
  withTempDir((tempDir) => {
    fs.mkdirSync(path.join(tempDir, 'fixtures', 'npm-basic'), { recursive: true });

    const result = resolveWorkingDirectory(tempDir, 'fixtures/npm-basic');

    assert.equal(result.workingDirectory, 'fixtures/npm-basic');
    assert.match(result.absoluteWorkingDirectory, /fixtures\/npm-basic$/);
  });
});

test('resolveWorkingDirectory rejects paths that escape the repository root', () => {
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

test('buildWorkingDirectoryKey generates a stable root key and nested slug', () => {
  assert.equal(buildWorkingDirectoryKey('.'), 'root');
  assert.match(
    buildWorkingDirectoryKey('fixtures/yarn-basic'),
    /^fixtures__yarn-basic-[a-f0-9]{8}$/,
  );
});

test('buildCachePaths scopes cache globs to the resolved working directory', () => {
  assert.deepEqual(buildCachePaths('.'), [
    'node_modules',
    '**/node_modules',
    '!node_modules/.cache',
    '!**/node_modules/.cache',
  ]);

  assert.deepEqual(buildCachePaths('fixtures/pnpm-basic'), [
    'fixtures/pnpm-basic/node_modules',
    'fixtures/pnpm-basic/**/node_modules',
    '!fixtures/pnpm-basic/node_modules/.cache',
    '!fixtures/pnpm-basic/**/node_modules/.cache',
  ]);
});

test('buildResult combines normalized working-directory and cache metadata', () => {
  withTempDir((tempDir) => {
    fs.mkdirSync(path.join(tempDir, 'fixtures', 'npm-basic'), { recursive: true });

    const result = buildResult({
      cwd: tempDir,
      workingDirectory: 'fixtures/npm-basic',
    });

    assert.equal(result.workingDirectory, 'fixtures/npm-basic');
    assert.match(result.workingDirectoryKey, /^fixtures__npm-basic-[a-f0-9]{8}$/);
    assert.equal(result.cachePaths[0], 'fixtures/npm-basic/node_modules');
  });
});
