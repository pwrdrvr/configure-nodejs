import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// The repository intentionally ships no dependencies, and CI runs `npm test`
// straight off a checkout, so there is no YAML parser available here. These
// checks are deliberately line-oriented: they guard the handful of action.yml
// invariants that unit tests on the helper modules cannot reach.

const actionPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'action.yml',
);
const actionYaml = fs.readFileSync(actionPath, 'utf8');

// Windows runners check out with CRLF. `.` does not match `\r` in a JavaScript
// regex -- it is a line terminator -- so splitting on `\n` alone leaves a `\r`
// that silently defeats every `$`-anchored pattern below.
export function linesOf(text) {
  return text.split(/\r?\n/);
}

const actionLines = linesOf(actionYaml);

// Locates a step by its `id:` and returns every line belonging to that step,
// so assertions can look for a key anywhere inside it. Reading the step as a
// block rather than at a fixed offset from the id keeps a harmless reordering
// of `uses:`/`if:` from failing as if it were a cache-key regression.
function stepBlock(id, lines = actionLines) {
  const start = lines.findIndex((line) => line.trim() === `id: ${id}`);
  assert.notEqual(start, -1, `action.yml has no step with id "${id}"`);

  // Walk back to the `- name:` that opens the step, then forward to the next.
  const isStepStart = (line) => /^\s*- name: /.test(line);
  let first = start;
  while (first > 0 && !isStepStart(lines[first])) {
    first -= 1;
  }

  let last = first + 1;
  while (last < lines.length && !isStepStart(lines[last])) {
    last += 1;
  }

  return { first, last, lines: lines.slice(first, last) };
}

// The value of a top-level key within a step, e.g. `if` or `uses`. Only the
// step's own keys are considered, not keys nested under `with:`/`env:`.
function stepValue(id, key, lines = actionLines) {
  const block = stepBlock(id, lines).lines;
  const indent = /^(\s*)- /.exec(block[0])[1].length + 2;
  const pattern = new RegExp(`^ {${indent}}${key}: (.*)$`);

  for (const line of block) {
    const match = pattern.exec(line);
    if (match) {
      return match[1].trim();
    }
  }

  return null;
}

function cacheKeyLines() {
  return actionLines
    .filter((line) => /^\s*key: /.test(line))
    .map((line) => line.trim().slice('key: '.length));
}

function inlineScripts() {
  const blocks = [];

  for (let index = 0; index < actionLines.length; index += 1) {
    const match = /^(\s*)script: \|\s*$/.exec(actionLines[index]);
    if (!match) {
      continue;
    }

    // A YAML block scalar takes its indentation from the first non-empty line,
    // not from a fixed offset off the parent key. Deriving it keeps an
    // unexpectedly indented body from silently extracting as an empty string,
    // which would then "parse" and pass.
    const parentIndent = match[1].length;
    const body = [];
    let bodyIndent = null;
    let cursor = index + 1;

    while (cursor < actionLines.length) {
      const line = actionLines[cursor];
      const contentAt = line.search(/\S/);

      if (contentAt !== -1 && contentAt <= parentIndent) {
        break;
      }

      if (bodyIndent === null && contentAt !== -1) {
        bodyIndent = contentAt;
      }

      body.push(bodyIndent === null ? '' : line.slice(bodyIndent));
      cursor += 1;
    }

    assert.notEqual(
      bodyIndent,
      null,
      `action.yml:${index + 1} declares an empty script block`,
    );
    blocks.push({ line: index + 1, body: body.join('\n') });
    index = cursor - 1;
  }

  return blocks;
}

test('restore and save use one identical dependency cache key', () => {
  const keys = cacheKeyLines();

  assert.equal(keys.length, 2, 'expected exactly one restore key and one save key');
  assert.equal(
    keys[0],
    keys[1],
    'the save key must match the restore key or every run re-saves under a key it will never restore from',
  );
});

test('the dependency cache key is built from the resolved Node.js major', () => {
  const [key] = cacheKeyLines();

  assert.match(
    key,
    /\$\{\{ steps\.resolve-dependency-cache-paths\.outputs\.nodeCacheKeySegment \}\}/,
  );
  assert.doesNotMatch(
    key,
    /inputs\.node-version/,
    'interpolating the raw node-version input lets a floating spec such as lts/* keep one key across a major bump',
  );
});

test('exactly one of the two setup-node steps runs, chosen by the version spec', () => {
  assert.equal(
    stepValue('setup-node-floating', 'if'),
    "steps.resolve-cache-paths.outputs.nodeVersionIsFloating == 'true'",
  );
  assert.match(
    stepValue('setup-node', 'if'),
    /^steps\.resolve-cache-paths\.outputs\.nodeVersionIsFloating != 'true' &&/,
  );
  assert.equal(stepValue('setup-node-floating', 'uses'), 'actions/setup-node@v6');
  assert.equal(stepValue('setup-node', 'uses'), 'actions/setup-node@v6');
});

test('the step scanners survive a CRLF checkout', () => {
  // Regression: this file used to split on `\n`, which left a `\r` on every
  // line. `.` does not match `\r`, so `(.*)$` stopped matching and every
  // stepValue assertion compared against null on Windows only.
  // Normalize before adding CRLF so this holds whether the checkout on disk
  // already uses CRLF or LF.
  const crlf = linesOf(actionYaml.replace(/\r?\n/g, '\r\n'));

  assert.equal(
    stepValue('setup-node-floating', 'if', crlf),
    "steps.resolve-cache-paths.outputs.nodeVersionIsFloating == 'true'",
  );
  assert.equal(
    stepValue('install-dependencies', 'if', crlf),
    "steps.prepare-package-manager.outputs.shouldInstall == 'true'",
  );
});

test('a floating spec resolves Node before the restore, a pinned spec after', () => {
  const floating = stepBlock('setup-node-floating').first;
  const restore = stepBlock('cache-dependencies').first;
  const pinned = stepBlock('setup-node').first;

  assert.ok(
    floating < restore,
    'the floating spec has to be resolved before the key is computed',
  );
  assert.ok(
    restore < pinned,
    'the pinned fast path must keep the restore ahead of setup-node so lookup-only can skip installing Node on a hit',
  );
});

test('the pinned fast path still lets lookup-only skip Node installation on a hit', () => {
  assert.match(
    stepValue('setup-node', 'if'),
    /\(inputs\.lookup-only != 'true' \|\| steps\.cache-dependencies\.outputs\.cache-hit != 'true'\)/,
  );
});

test('installation is gated on the resolved shouldInstall decision', () => {
  // The three reasons an install can be required live in
  // shouldInstallDependencies, where they are unit tested. The step condition
  // must not drift into re-deriving them.
  assert.equal(
    stepValue('install-dependencies', 'if'),
    "steps.prepare-package-manager.outputs.shouldInstall == 'true'",
  );
});

test('every inline github-script body parses', () => {
  const AsyncFunction = Object.getPrototypeOf(async function noop() {}).constructor;
  const blocks = inlineScripts();

  assert.ok(blocks.length >= 6, 'expected the composite action to inline several scripts');

  for (const block of blocks) {
    assert.doesNotThrow(
      () =>
        new AsyncFunction(
          'core',
          'github',
          'context',
          'exec',
          'glob',
          'io',
          'require',
          'process',
          block.body,
        ),
      `action.yml:${block.line} inline script does not parse`,
    );
  }
});
