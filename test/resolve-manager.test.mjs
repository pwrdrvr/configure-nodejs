import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { buildResult, normalizeManager } from '../scripts/resolve-manager.mjs';

function withTempDir(callback) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'configure-nodejs-manager-'));

  try {
    callback(tempDir);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

test('normalizeManager validates the supported values', () => {
  assert.equal(normalizeManager(' PNPM '), 'pnpm');
  assert.throws(
    () => normalizeManager('bun'),
    /Unsupported package manager "bun"/,
  );
});

test('buildResult resolves npm from an explicit package-manager override', () => {
  withTempDir((tempDir) => {
    fs.writeFileSync(
      path.join(tempDir, 'package.json'),
      JSON.stringify({ name: 'fixture', version: '1.0.0' }),
    );
    fs.writeFileSync(path.join(tempDir, 'package-lock.json'), '{}\n');

    const result = buildResult({ cwd: tempDir, explicitManager: 'npm' });

    assert.equal(result.packageManager, 'npm');
    assert.equal(result.installCommand, 'npm ci');
    assert.equal(result.lockfileName, 'package-lock.json');
  });
});

test('buildResult resolves pnpm from packageManager metadata', () => {
  withTempDir((tempDir) => {
    fs.writeFileSync(
      path.join(tempDir, 'package.json'),
      JSON.stringify({
        name: 'fixture',
        version: '1.0.0',
        packageManager: 'pnpm@10.12.1',
      }),
    );
    fs.writeFileSync(path.join(tempDir, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n');

    const result = buildResult({ cwd: tempDir, explicitManager: '' });

    assert.equal(result.packageManager, 'pnpm');
    assert.equal(result.packageManagerVersion, '10.12.1');
    assert.equal(result.installCommand, 'pnpm install --frozen-lockfile');
    assert.equal(result.managerCacheKey, 'pnpm-10.12.1');
  });
});

test('buildResult resolves modern Yarn installs with --immutable', () => {
  withTempDir((tempDir) => {
    fs.writeFileSync(
      path.join(tempDir, 'package.json'),
      JSON.stringify({
        name: 'fixture',
        version: '1.0.0',
        packageManager: 'yarn@4.6.0',
      }),
    );
    fs.writeFileSync(path.join(tempDir, 'yarn.lock'), '# yarn lockfile\n');
    fs.writeFileSync(path.join(tempDir, '.yarnrc.yml'), 'nodeLinker: node-modules\n');

    const result = buildResult({ cwd: tempDir, explicitManager: '' });

    assert.equal(result.packageManager, 'yarn');
    assert.equal(result.installCommand, 'yarn install --immutable');
  });
});

test('buildResult falls back to classic Yarn install flags when no Berry signal exists', () => {
  withTempDir((tempDir) => {
    fs.writeFileSync(
      path.join(tempDir, 'package.json'),
      JSON.stringify({ name: 'fixture', version: '1.0.0' }),
    );
    fs.writeFileSync(path.join(tempDir, 'yarn.lock'), '# yarn classic lockfile\n');

    const result = buildResult({ cwd: tempDir, explicitManager: 'yarn' });

    assert.equal(result.packageManager, 'yarn');
    assert.equal(result.installCommand, 'yarn install --frozen-lockfile');
  });
});

test('buildResult rejects multiple lockfiles in one working directory', () => {
  withTempDir((tempDir) => {
    fs.writeFileSync(
      path.join(tempDir, 'package.json'),
      JSON.stringify({ name: 'fixture', version: '1.0.0' }),
    );
    fs.writeFileSync(path.join(tempDir, 'package-lock.json'), '{}\n');
    fs.writeFileSync(path.join(tempDir, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n');

    assert.throws(
      () => buildResult({ cwd: tempDir, explicitManager: '' }),
      /Found multiple lockfiles/,
    );
  });
});

test('buildResult honors an explicit manager when multiple lockfiles are present', () => {
  withTempDir((tempDir) => {
    fs.writeFileSync(
      path.join(tempDir, 'package.json'),
      JSON.stringify({ name: 'fixture', version: '1.0.0' }),
    );
    fs.writeFileSync(path.join(tempDir, 'package-lock.json'), '{}\n');
    fs.writeFileSync(path.join(tempDir, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n');

    const result = buildResult({ cwd: tempDir, explicitManager: 'npm' });

    assert.equal(result.packageManager, 'npm');
    assert.equal(result.lockfileName, 'package-lock.json');
    assert.equal(result.installCommand, 'npm ci');
  });
});

test('buildResult rejects missing lockfiles when the manager cannot be resolved', () => {
  withTempDir((tempDir) => {
    fs.writeFileSync(
      path.join(tempDir, 'package.json'),
      JSON.stringify({ name: 'fixture', version: '1.0.0' }),
    );

    assert.throws(
      () => buildResult({ cwd: tempDir, explicitManager: '' }),
      /Could not determine package manager/,
    );
  });
});
