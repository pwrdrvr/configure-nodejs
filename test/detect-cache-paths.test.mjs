import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  containsNodeModules,
  hasCacheableDependencyPath,
} from '../scripts/detect-cache-paths.mjs';

function withTempDir(callback) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'configure-nodejs-detect-'));

  try {
    callback(tempDir);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

test('containsNodeModules detects root and nested dependency directories', () => {
  withTempDir((tempDir) => {
    assert.equal(containsNodeModules(tempDir), false);
    fs.mkdirSync(path.join(tempDir, 'packages', 'app', 'node_modules'), {
      recursive: true,
    });
    assert.equal(containsNodeModules(tempDir), true);
  });
});

test('hasCacheableDependencyPath checks the configured pnpm store directly', () => {
  withTempDir((tempDir) => {
    const store = path.join(tempDir, '.pnpm-store');
    assert.equal(
      hasCacheableDependencyPath({
        packageManager: 'pnpm',
        absolutePrimaryCachePath: store,
        absoluteWorkingDirectory: tempDir,
      }),
      false,
    );
    fs.mkdirSync(store);
    assert.equal(
      hasCacheableDependencyPath({
        packageManager: 'pnpm',
        absolutePrimaryCachePath: store,
        absoluteWorkingDirectory: tempDir,
      }),
      true,
    );
  });
});
