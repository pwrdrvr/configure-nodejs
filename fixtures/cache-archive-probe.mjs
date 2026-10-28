import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const contents = 'completed-tree archive probe\n';

// A package with its own node_modules is reachable through both the virtual
// store and workspace aliases. actions/cache must not pass all those nested
// aliases to tar as independent archive roots.
export function seedArchiveProbe(root = process.cwd()) {
  const target = path.join(root, 'node_modules', '.archive-probe', 'package');
  const bin = path.join(target, 'node_modules', '.bin');
  fs.mkdirSync(bin, { recursive: true });
  const file = path.join(bin, 'probe');
  fs.writeFileSync(file, contents);
  const hardlink = path.join(bin, 'probe-copy');
  if (!fs.existsSync(hardlink)) fs.linkSync(file, hardlink);
  for (const modules of ['node_modules', 'packages/archive-probe/node_modules']) {
    const directory = path.join(root, modules);
    fs.mkdirSync(directory, { recursive: true });
    const link = path.join(directory, 'archive-probe');
    if (!fs.existsSync(link)) {
      fs.symlinkSync(path.relative(directory, target), link, process.platform === 'win32' ? 'junction' : 'dir');
    }
  }
}

export function checkArchiveProbe(root = process.cwd()) {
  for (const modules of ['node_modules', 'packages/archive-probe/node_modules']) {
    const link = path.join(root, modules, 'archive-probe');
    assert.ok(fs.lstatSync(link).isSymbolicLink(), 'workspace package aliases must remain links');
    for (const file of ['probe', 'probe-copy']) {
      assert.equal(fs.readFileSync(path.join(link, 'node_modules', '.bin', file), 'utf8'), contents);
    }
  }
}
