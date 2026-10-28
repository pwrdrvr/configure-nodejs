import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { collectDirectoryLinks, restoreDirectoryLinks } from '../scripts/completed-tree.mjs';

function fixture(t) {
  const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'completed-links-')));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const target = path.join(cwd, 'node_modules/.pnpm/retry/node_modules/retry');
  const file = path.join(cwd, 'node_modules/.pnpm/owner/node_modules/retry');
  fs.mkdirSync(target, { recursive: true });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(path.join(target, 'index.js'), 'module.exports = 42;');
  fs.symlinkSync(path.relative(path.dirname(file), target), file, 'junction');
  return { cwd, target, file, links: collectDirectoryLinks(cwd) };
}

test('records directory targets without traversing package aliases', (t) => {
  const { cwd, links } = fixture(t);
  assert.deepEqual(links, [{ path: 'node_modules/.pnpm/owner/node_modules/retry', target: 'node_modules/.pnpm/retry/node_modules/retry' }]);
  restoreDirectoryLinks({ cwd, links });
});

test('restores a recorded directory-link type lost by Windows tar without installing', (t) => {
  const { cwd, file, target, links } = fixture(t);
  let restored = false;
  const filesystem = {
    ...fs,
    statSync(candidate) {
      if (candidate === file && !restored) throw Object.assign(new Error('wrong Windows link type'), { code: 'EPERM' });
      return fs.statSync(candidate);
    },
    symlinkSync(...args) {
      assert.equal(args[2], 'junction');
      fs.symlinkSync(...args);
      restored = true;
    },
  };
  restoreDirectoryLinks({ cwd, links, filesystem });
  assert.equal(restored, true);
  assert.equal(fs.realpathSync(file), fs.realpathSync(target));
  assert.equal(fs.readFileSync(path.join(file, 'index.js'), 'utf8'), 'module.exports = 42;');
});

test('validates all recorded paths before changing any restored link', (t) => {
  const { cwd, links } = fixture(t);
  let changes = 0;
  const filesystem = {
    ...fs,
    statSync(candidate) {
      if (candidate.endsWith(`${path.sep}owner${path.sep}node_modules${path.sep}retry`)) throw Object.assign(new Error('wrong type'), { code: 'EPERM' });
      return fs.statSync(candidate);
    },
    unlinkSync() { changes++; },
  };
  assert.throws(() => restoreDirectoryLinks({ cwd, links: [...links, { path: '../outside/node_modules/link', target: links[0].target }], filesystem }), /escapes/);
  assert.equal(changes, 0);
});

test('rejects changed, missing, duplicate and out-of-workspace dependency edges', (t) => {
  const { cwd, file, links } = fixture(t);
  for (const entries of [undefined, [...links, ...links], [{ ...links[0], target: '../outside' }], [{ ...links[0], target: 'node_modules' }], [{ ...links[0], path: 'node_modules/missing' }]]) {
    assert.throws(() => restoreDirectoryLinks({ cwd, links: entries }));
  }
  fs.unlinkSync(file);
  fs.mkdirSync(file);
  assert.throws(() => restoreDirectoryLinks({ cwd, links }), /incompatible/);
});
