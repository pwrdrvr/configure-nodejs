import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  PERSISTENT_STORE_ENTRIES,
  SEED_MARKER_NAME,
  checkPersistentStore,
  invalidatePersistentStore,
  isPersistentStoreEnabled,
  moveDirectory,
  normalizeMaxAgeDays,
  persistentStorePaths,
  readSeedMarker,
  relocateStorePath,
  resolvePersistentCorepackHome,
  resolvePersistentStoreRoot,
  seedPersistentStore,
  validatePersistentStoreMode,
  withStoreDir,
} from '../scripts/persistent-store.mjs';

const DAY = 86400;
const NOW = 1_800_000_000;

function sandbox(t) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'persistent-store-')));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const workspace = path.join(base, 'work', 'repo', 'repo');
  const home = path.join(base, 'home', 'runner');
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  return { base, workspace, home };
}

function populate(paths, { marker } = {}) {
  for (const name of Object.values(PERSISTENT_STORE_ENTRIES)) {
    fs.mkdirSync(path.join(paths.root, name, 'content'), { recursive: true });
    fs.writeFileSync(path.join(paths.root, name, 'content', 'file'), name);
  }
  fs.mkdirSync(path.join(paths.root, 'pnpm-store.incoming'), { recursive: true });
  fs.writeFileSync(path.join(paths.root, 'unrelated.txt'), 'not ours');
  if (marker !== undefined) fs.writeFileSync(paths.marker, marker);
}

function managedEntriesPresent(paths) {
  return [...Object.values(PERSISTENT_STORE_ENTRIES), 'pnpm-store.incoming', SEED_MARKER_NAME]
    .filter((name) => fs.existsSync(path.join(paths.root, name)));
}

test('persistent mode is opt-in and empty means disabled', () => {
  assert.equal(isPersistentStoreEnabled(''), false);
  assert.equal(isPersistentStoreEnabled('   '), false);
  assert.equal(isPersistentStoreEnabled(undefined), false);
  assert.equal(isPersistentStoreEnabled('/var/cache/ci'), true);
});

test('max age must be a whole number of days', () => {
  assert.equal(normalizeMaxAgeDays(), 14);
  assert.equal(normalizeMaxAgeDays(' 7 '), 7);
  for (const value of ['0', '-1', '1.5', 'two', '']) {
    assert.throws(() => normalizeMaxAgeDays(value), /persistent-store-max-age-days/);
  }
});

test('persistent mode rejects completed trees, lookup-only, other managers, and unpinned pnpm', () => {
  const ok = { dependencyCache: 'default', lookupOnly: 'false', packageManager: 'pnpm', packageManagerVersion: '10.33.0' };
  validatePersistentStoreMode(ok);
  validatePersistentStoreMode({ ...ok, packageManagerVersion: '10.33.0+sha512.abc123' });
  for (const [change, message] of [
    [{ dependencyCache: 'node-modules' }, /node-modules/],
    [{ lookupOnly: 'true' }, /lookup-only/],
    [{ packageManager: 'npm' }, /pnpm only/],
    [{ packageManager: 'yarn' }, /pnpm only/],
    [{ packageManagerVersion: '' }, /exact pnpm pin/],
    [{ packageManagerVersion: '^10.0.0' }, /exact pnpm pin/],
  ]) {
    assert.throws(() => validatePersistentStoreMode({ ...ok, ...change }), message);
  }
});

test('path guard accepts an absolute root outside the workspace and home', (t) => {
  const { base, workspace, home } = sandbox(t);
  for (const candidate of [path.join(base, 'cache', 'ci'), path.join(home, 'Library', 'Caches', 'ci')]) {
    assert.equal(resolvePersistentStoreRoot({ persistentStoreDir: candidate, workspace, home }), candidate);
  }
  assert.equal(
    resolvePersistentStoreRoot({ persistentStoreDir: '~/Library/Caches/ci', workspace, home }),
    path.join(home, 'Library', 'Caches', 'ci'),
  );
  // A sibling whose name merely starts with the workspace's is not inside it.
  const sibling = `${workspace}-cache`;
  assert.equal(resolvePersistentStoreRoot({ persistentStoreDir: sibling, workspace, home }), sibling);
});

test('path guard rejects relative paths, filesystem roots, home, and workspace overlap', (t) => {
  const { base, workspace, home } = sandbox(t);
  const reject = (persistentStoreDir, message) => assert.throws(
    () => resolvePersistentStoreRoot({ persistentStoreDir, workspace, home }),
    message,
    persistentStoreDir,
  );
  reject('relative/cache', /absolute/);
  reject('./cache', /absolute/);
  reject(path.parse(base).root, /filesystem root/);
  reject(home, /home directory/);
  reject('~', /home directory/);
  reject('~/', /home directory/);
  reject('~other/cache', /absolute/);
  reject(path.dirname(home), /home directory/);
  reject(workspace, /workspace/);
  reject(path.join(workspace, '.cache', 'store'), /inside the workspace/);
  // An ancestor of the workspace could name it as a managed entry.
  reject(path.dirname(workspace), /workspace/);
  reject(path.join(base, 'work'), /workspace/);
});

test('path guard judges a symlinked root by its target', { skip: process.platform === 'win32' && 'symlinks need privileges on Windows' }, (t) => {
  const { base, workspace, home } = sandbox(t);
  const intoWorkspace = path.join(base, 'link-into-workspace');
  fs.symlinkSync(workspace, intoWorkspace, 'dir');
  assert.throws(
    () => resolvePersistentStoreRoot({ persistentStoreDir: path.join(intoWorkspace, 'store'), workspace, home }),
    /inside the workspace/,
  );
  const toRoot = path.join(base, 'link-to-root');
  fs.symlinkSync(path.parse(base).root, toRoot, 'dir');
  assert.throws(
    () => resolvePersistentStoreRoot({ persistentStoreDir: toRoot, workspace, home }),
    /filesystem root/,
  );
  const elsewhere = path.join(base, 'real-cache');
  fs.mkdirSync(elsewhere);
  const link = path.join(base, 'cache-link');
  fs.symlinkSync(elsewhere, link, 'dir');
  assert.equal(resolvePersistentStoreRoot({ persistentStoreDir: link, workspace, home }), elsewhere);
});

test('a marker is warm only when readable, not future-dated, and younger than the limit', (t) => {
  const { base } = sandbox(t);
  const marker = path.join(base, SEED_MARKER_NAME);
  const read = () => readSeedMarker(marker, { now: NOW, maxAgeDays: 14 });
  assert.equal(read().state, 'missing');
  for (const [contents, state] of [
    [`${NOW}\n`, 'warm'],
    [`${NOW - 14 * DAY + 1}`, 'warm'],
    [`${NOW - 14 * DAY}`, 'expired'],
    [`${NOW - 400 * DAY}`, 'expired'],
    [`${NOW + 60}`, 'future'],
    ['', 'unreadable'],
    ['yesterday', 'unreadable'],
    ['-5', 'unreadable'],
    ['1.5', 'unreadable'],
  ]) {
    fs.writeFileSync(marker, contents);
    assert.equal(read().state, state, JSON.stringify(contents));
  }
  fs.rmSync(marker);
  fs.mkdirSync(marker);
  assert.equal(read().state, 'unreadable', 'a marker that cannot be read as a file');
});

test('a warm store is kept as is', (t) => {
  const { base } = sandbox(t);
  const paths = persistentStorePaths(path.join(base, 'cache'));
  fs.mkdirSync(paths.root);
  populate(paths, { marker: `${NOW - DAY}` });
  const result = checkPersistentStore({ paths, now: NOW, maxAgeDays: 14 });
  assert.deepEqual({ warm: result.warm, reason: result.reason, dropped: result.dropped }, { warm: true, reason: 'warm', dropped: false });
  assert.equal(managedEntriesPresent(paths).length, 6);
});

test('cold markers drop every managed entry and nothing else', (t) => {
  const { base } = sandbox(t);
  for (const [marker, reason] of [
    [`${NOW - 15 * DAY}`, 'expired'],
    ['garbage', 'unreadable'],
    [`${NOW + DAY}`, 'future'],
    [undefined, 'missing'],
  ]) {
    const paths = persistentStorePaths(path.join(base, `cache-${reason}`));
    fs.mkdirSync(paths.root);
    populate(paths, { marker });
    const result = checkPersistentStore({ paths, now: NOW, maxAgeDays: 14 });
    assert.deepEqual({ warm: result.warm, reason: result.reason, dropped: result.dropped }, { warm: false, reason, dropped: true });
    assert.deepEqual(managedEntriesPresent(paths), [], reason);
    assert.equal(fs.readFileSync(path.join(paths.root, 'unrelated.txt'), 'utf8'), 'not ours');
  }
});

test('a first run creates the root and reports nothing dropped', (t) => {
  const { base } = sandbox(t);
  const paths = persistentStorePaths(path.join(base, 'new', 'cache'));
  const result = checkPersistentStore({ paths, now: NOW, maxAgeDays: 14 });
  assert.deepEqual({ warm: result.warm, reason: result.reason, dropped: result.dropped }, { warm: false, reason: 'missing', dropped: false });
  assert.ok(fs.statSync(paths.root).isDirectory());
});

test('a symlinked entry under the root is refused, never followed', { skip: process.platform === 'win32' && 'symlinks need privileges on Windows' }, (t) => {
  const { base } = sandbox(t);
  const paths = persistentStorePaths(path.join(base, 'cache'));
  fs.mkdirSync(paths.root);
  const outside = path.join(base, 'outside');
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'keep'), 'keep');
  fs.symlinkSync(outside, path.join(paths.root, 'electron.incoming'), 'dir');
  assert.throws(() => checkPersistentStore({ paths, now: NOW, maxAgeDays: 14 }), /symbolic link/);
  assert.equal(fs.readFileSync(path.join(outside, 'keep'), 'utf8'), 'keep');
});

function workspaceCaches(workspace) {
  const store = path.join(workspace, '.pnpm-store');
  const electron = path.join(workspace, '.cache', 'configure-nodejs', 'electron');
  const prebuild = path.join(workspace, '.cache', 'configure-nodejs', 'npm');
  for (const directory of [path.join(store, 'v10'), electron, prebuild]) {
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'payload'), directory);
  }
  return { store, electron, prebuild };
}

test('seeding moves the workspace store and caches, then writes the marker last', (t) => {
  const { base, workspace } = sandbox(t);
  const paths = persistentStorePaths(path.join(base, 'cache'));
  fs.mkdirSync(paths.root);
  const caches = workspaceCaches(workspace);
  const renames = [];
  const rename = (source, destination) => {
    assert.equal(fs.existsSync(paths.marker), false, `marker written before moving ${source}`);
    renames.push([source, destination]);
    fs.renameSync(source, destination);
  };
  const result = seedPersistentStore({
    paths,
    workspaceStore: caches.store,
    workspaceElectron: caches.electron,
    workspacePrebuild: caches.prebuild,
    now: NOW,
    rename,
  });
  assert.deepEqual(result, { seeded: true, moved: ['store', 'electron', 'prebuild'] });
  assert.equal(renames.length, 6, 'each entry moves through a temporary name');
  assert.equal(fs.readFileSync(paths.marker, 'utf8').trim(), String(NOW));
  for (const [source, destination] of [[caches.store, paths.store], [caches.electron, paths.electron], [caches.prebuild, paths.prebuild]]) {
    assert.equal(fs.existsSync(source), false);
    assert.ok(fs.existsSync(path.join(destination, path.basename(source) === '.pnpm-store' ? 'v10' : '', 'payload')));
  }
  assert.equal(fs.existsSync(`${paths.store}.incoming`), false);
  assert.equal(checkPersistentStore({ paths, now: NOW + 60, maxAgeDays: 14 }).warm, true);
});

test('seeding without Electron caching moves only the store', (t) => {
  const { base, workspace } = sandbox(t);
  const paths = persistentStorePaths(path.join(base, 'cache'));
  const caches = workspaceCaches(workspace);
  const result = seedPersistentStore({ paths, workspaceStore: caches.store, now: NOW });
  assert.deepEqual(result, { seeded: true, moved: ['store'] });
  assert.ok(fs.existsSync(caches.electron), 'Electron caches stay put when not opted in');
});

test('seeding replaces a leftover destination and leaves no marker when a move fails', (t) => {
  const { base, workspace } = sandbox(t);
  const paths = persistentStorePaths(path.join(base, 'cache'));
  fs.mkdirSync(path.join(paths.store, 'stale'), { recursive: true });
  const caches = workspaceCaches(workspace);
  seedPersistentStore({ paths, workspaceStore: caches.store, now: NOW });
  assert.equal(fs.existsSync(path.join(paths.store, 'stale')), false);

  const again = workspaceCaches(workspace);
  const failing = () => { throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); };
  assert.throws(() => seedPersistentStore({ paths, workspaceStore: again.store, now: NOW, rename: failing }), /disk full/);
  assert.equal(fs.existsSync(paths.marker), false, 'a failed seed must not leave the store trusted');
});

test('seeding is a no-op when install left no workspace store', (t) => {
  const { base, workspace } = sandbox(t);
  const paths = persistentStorePaths(path.join(base, 'cache'));
  const result = seedPersistentStore({ paths, workspaceStore: path.join(workspace, '.pnpm-store'), now: NOW });
  assert.deepEqual(result, { seeded: false, moved: [] });
  assert.equal(fs.existsSync(paths.marker), false);
});

test('a move across volumes falls back to copy and removes the source', (t) => {
  const { base, workspace } = sandbox(t);
  const { store } = workspaceCaches(workspace);
  const destination = path.join(base, 'elsewhere');
  moveDirectory(store, destination, {
    rename: () => { throw Object.assign(new Error('cross-device link'), { code: 'EXDEV' }); },
  });
  assert.equal(fs.existsSync(store), false);
  assert.ok(fs.existsSync(path.join(destination, 'v10', 'payload')));
  assert.throws(
    () => moveDirectory(destination, store, { rename: () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); } }),
    /denied/,
  );
});

test('a Windows rename blocked by a transient lock is retried; other platforms fail at once', (t) => {
  const { base, workspace } = sandbox(t);
  const { store } = workspaceCaches(workspace);
  let attempts = 0;
  const flaky = (source, destination) => {
    attempts += 1;
    if (attempts < 3) throw Object.assign(new Error('locked'), { code: 'EPERM' });
    fs.renameSync(source, destination);
  };
  moveDirectory(store, path.join(base, 'moved'), { rename: flaky, platform: 'win32' });
  assert.equal(attempts, 3);
  assert.ok(fs.existsSync(path.join(base, 'moved', 'v10', 'payload')));

  attempts = 0;
  assert.throws(
    () => moveDirectory(path.join(base, 'moved'), store, { rename: flaky, platform: 'linux' }),
    /locked/,
  );
  assert.equal(attempts, 1);
});

test('invalidation removes only the marker', (t) => {
  const { base } = sandbox(t);
  const paths = persistentStorePaths(path.join(base, 'cache'));
  fs.mkdirSync(paths.root);
  populate(paths, { marker: `${NOW}` });
  invalidatePersistentStore(paths);
  assert.equal(fs.existsSync(paths.marker), false);
  assert.ok(fs.existsSync(path.join(paths.store, 'content', 'file')));
  assert.equal(checkPersistentStore({ paths, now: NOW, maxAgeDays: 14 }).warm, false);
});

test('the warm install points --store-dir at the persistent store', () => {
  const store = path.join(os.tmpdir(), 'cache', 'pnpm-store');
  assert.deepEqual(
    withStoreDir(['install', '--frozen-lockfile', '--store-dir', '.pnpm-store'], store),
    ['install', '--frozen-lockfile', '--store-dir', store],
  );
  assert.deepEqual(withStoreDir(['install'], store), ['install', '--store-dir', store]);
});

test('Corepack follows the root unless the caller manages COREPACK_HOME', () => {
  const paths = persistentStorePaths(path.join(os.tmpdir(), 'cache'));
  assert.deepEqual(resolvePersistentCorepackHome({ paths }), { home: paths.corepack, managed: true });
  assert.deepEqual(
    resolvePersistentCorepackHome({ paths, corepackHome: '/runner/temp/corepack', managedCorepackHome: '/runner/temp/corepack' }),
    { home: paths.corepack, managed: true },
  );
  assert.deepEqual(
    resolvePersistentCorepackHome({ paths, corepackHome: '/caller/corepack' }),
    { home: '/caller/corepack', managed: false },
  );
});

test('the reported store path follows the store when it moves', () => {
  const workspaceStore = path.join(os.tmpdir(), 'ws', '.pnpm-store');
  const persistentStore = path.join(os.tmpdir(), 'cache', 'pnpm-store');
  assert.equal(
    relocateStorePath({ discoveredStorePath: path.join(workspaceStore, 'v10'), workspaceStore, persistentStore }),
    path.join(persistentStore, 'v10'),
  );
  assert.equal(relocateStorePath({ discoveredStorePath: '', workspaceStore, persistentStore }), persistentStore);
  assert.equal(
    relocateStorePath({ discoveredStorePath: path.join(os.tmpdir(), 'other'), workspaceStore, persistentStore }),
    persistentStore,
  );
});
