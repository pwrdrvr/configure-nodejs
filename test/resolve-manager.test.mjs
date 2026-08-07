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

function writeFixture(tempDir, packageJson, lockfileName, lockfileContents) {
  fs.writeFileSync(path.join(tempDir, 'package.json'), JSON.stringify(packageJson));
  fs.writeFileSync(path.join(tempDir, lockfileName), lockfileContents);
}

test('normalizeManager validates the supported values', () => {
  assert.equal(normalizeManager(' PNPM '), 'pnpm');
  assert.throws(() => normalizeManager('bun'), /Unsupported package manager "bun"/);
});

test('buildResult resolves npm to a structured frozen install', () => {
  withTempDir((tempDir) => {
    writeFixture(
      tempDir,
      { name: 'fixture', version: '1.0.0' },
      'package-lock.json',
      '{}\n',
    );

    const result = buildResult({ cwd: tempDir, explicitManager: 'npm' });

    assert.equal(result.packageManager, 'npm');
    assert.equal(result.installCommand, 'npm ci');
    assert.equal(result.installExecutable, 'npm');
    assert.deepEqual(result.installArguments, ['ci']);
    assert.equal(result.lockfileName, 'package-lock.json');
  });
});

test('buildResult resolves pinned pnpm to a structured store install', () => {
  withTempDir((tempDir) => {
    writeFixture(
      tempDir,
      {
        name: 'fixture',
        version: '1.0.0',
        packageManager: 'pnpm@10.12.1',
      },
      'pnpm-lock.yaml',
      'lockfileVersion: 9.0\n',
    );

    const result = buildResult({ cwd: tempDir, explicitManager: '' });

    assert.equal(result.packageManager, 'pnpm');
    assert.equal(result.packageManagerVersion, '10.12.1');
    assert.equal(
      result.installCommand,
      'pnpm install --frozen-lockfile --store-dir .pnpm-store',
    );
    assert.equal(result.installExecutable, 'pnpm');
    assert.deepEqual(result.installArguments, [
      'install',
      '--frozen-lockfile',
      '--store-dir',
      '.pnpm-store',
    ]);
    assert.equal(result.managerCacheKey, 'pnpm-10.12.1');
  });
});

test('buildResult resolves modern Yarn installs with --immutable', () => {
  withTempDir((tempDir) => {
    writeFixture(
      tempDir,
      {
        name: 'fixture',
        version: '1.0.0',
        packageManager: 'yarn@4.6.0',
      },
      'yarn.lock',
      '# yarn lockfile\n',
    );
    fs.writeFileSync(path.join(tempDir, '.yarnrc.yml'), 'nodeLinker: node-modules\n');

    const result = buildResult({ cwd: tempDir, explicitManager: '' });

    assert.equal(result.installCommand, 'yarn install --immutable');
    assert.equal(result.installExecutable, 'yarn');
    assert.deepEqual(result.installArguments, ['install', '--immutable']);
  });
});

test('buildResult falls back to classic Yarn frozen installs', () => {
  withTempDir((tempDir) => {
    writeFixture(
      tempDir,
      { name: 'fixture', version: '1.0.0' },
      'yarn.lock',
      '# yarn classic lockfile\n',
    );

    const result = buildResult({ cwd: tempDir, explicitManager: 'yarn' });

    assert.equal(result.installCommand, 'yarn install --frozen-lockfile');
    assert.deepEqual(result.installArguments, ['install', '--frozen-lockfile']);
  });
});

test('buildResult rejects multiple lockfiles without an explicit manager', () => {
  withTempDir((tempDir) => {
    writeFixture(
      tempDir,
      { name: 'fixture', version: '1.0.0' },
      'package-lock.json',
      '{}\n',
    );
    fs.writeFileSync(path.join(tempDir, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n');

    assert.throws(
      () => buildResult({ cwd: tempDir, explicitManager: '' }),
      /Found multiple lockfiles/,
    );
  });
});

test('buildResult honors an explicit manager with multiple lockfiles', () => {
  withTempDir((tempDir) => {
    writeFixture(
      tempDir,
      { name: 'fixture', version: '1.0.0' },
      'package-lock.json',
      '{}\n',
    );
    fs.writeFileSync(path.join(tempDir, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n');

    const result = buildResult({ cwd: tempDir, explicitManager: 'npm' });

    assert.equal(result.packageManager, 'npm');
    assert.equal(result.lockfileName, 'package-lock.json');
  });
});

test('buildResult rejects missing lockfiles', () => {
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
