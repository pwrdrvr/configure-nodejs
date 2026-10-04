import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'node:os';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
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
    .filter((line) => /^ {8}key: /.test(line) && !line.includes('resolve-corepack-cache'))
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

  assert.equal(keys.length, 3, 'expected restore, save, and completed save-confirmation keys');
  assert.equal(keys[0], keys[2]);
  assert.equal(
    keys[0],
    keys[1],
    'the save key must match the restore key or every run re-saves under a key it will never restore from',
  );
});

test('the shared key output retains the default key and isolates completed trees', () => {
  assert.equal(cacheKeyLines()[0], '${{ steps.resolve-dependency-cache-paths.outputs.cacheKey }}');
  const block = stepBlock('resolve-dependency-cache-paths').lines.join('\n');
  assert.match(block, /nodeVersion.nodeCacheKeySegment/);
  assert.match(block, /result.electronCacheKeySegment/);
  assert.match(block, /buildCompletedKey/);
  assert.doesNotMatch(block, /ImageVersion/);
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
    /inputs\.lookup-only != 'true'/,
  );
});

test('lookup-only still prepares and installs on a miss but skips setup on a hit', () => {
  assert.match(stepValue('prepare-package-manager', 'if'), /inputs.lookup-only != 'true'/);
  assert.match(stepValue('prepare-package-manager', 'if'), /cache-mode == 'restore'/);
  assert.equal(
    stepValue('install-dependencies', 'if'),
    "steps.prepare-package-manager.outputs.shouldInstall == 'true'",
  );
});

test('enabled Electron caching exports both lifecycle download cache variables', () => {
  const prepareScript = inlineScripts().find((block) => {
    const step = stepBlock('prepare-package-manager');
    return block.line >= step.first && block.line < step.last;
  });

  assert.ok(prepareScript, 'failed to find the prepare-package-manager script');
  assert.match(prepareScript.body, /core\.exportVariable\('npm_config_cache'/);
  assert.match(
    prepareScript.body,
    /core\.exportVariable\('electron_config_cache'/,
  );
});

test('a pnpm lookup-only miss exports the local store for the install step', () => {
  const prepareScript = stepBlock('prepare-package-manager').lines.join('\n');

  assert.match(
    prepareScript,
    /if \(manager === 'pnpm'\) \{[\s\S]*core\.exportVariable\('npm_config_store_dir', expectedStorePath\)/,
  );
  assert.doesNotMatch(
    prepareScript,
    /CONFIGURE_NODEJS_LOOKUP_ONLY !== 'true'[\s\S]*core\.exportVariable\('npm_config_store_dir'/,
    'the prepare step only runs for normal consumers or lookup-only misses, so both paths must export the store',
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

test('the README documents exactly the outputs the action declares', () => {
  // Adding an output and forgetting the docs is silent, and the count in the
  // collapsed <summary> goes stale even more quietly.
  const readmePath = path.join(path.dirname(actionPath), 'README.md');
  const readme = fs.readFileSync(readmePath, 'utf8');

  const outputsBlock = actionYaml.slice(
    actionYaml.indexOf('\noutputs:'),
    actionYaml.indexOf('\nruns:'),
  );
  const declared = linesOf(outputsBlock)
    .map((line) => /^ {2}([a-z][a-z0-9-]*):$/.exec(line))
    .filter(Boolean)
    .map((match) => match[1]);

  assert.ok(declared.length > 0, 'failed to parse outputs out of action.yml');

  const undocumented = declared.filter(
    (name) => !readme.includes(`| \`${name}\` |`),
  );
  assert.deepEqual(undocumented, [], 'outputs missing from the README table');

  const claimed = /All (\d+) outputs/.exec(readme);
  assert.ok(claimed, 'the README no longer states how many outputs there are');
  assert.equal(
    Number(claimed[1]),
    declared.length,
    'the README output count does not match action.yml',
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

test('Corepack restores before activation and saves before dependency installation', () => {
  const resolve = stepBlock('resolve-corepack-cache');
  const restore = stepBlock('cache-corepack');
  const prepare = stepBlock('prepare-package-manager');
  const save = stepBlock('save-corepack');
  assert.ok(resolve.first < restore.first && restore.first < prepare.first);
  assert.ok(prepare.first < save.first && save.first < stepBlock('install-dependencies').first);
  for (const block of [restore, save]) {
    assert.match(block.lines.join('\n'), /key: \$\{\{ steps.resolve-corepack-cache.outputs.key \}\}/);
    assert.match(block.lines.join('\n'), /path: \$\{\{ steps.resolve-corepack-cache.outputs.home \}\}/);
  }
  assert.match(stepValue('resolve-corepack-cache', 'if'), /needsCorepack == 'true'/);
  assert.match(stepValue('resolve-corepack-cache', 'if'), /inputs.lookup-only != 'true'/);
  assert.match(stepValue('save-corepack', 'if'), /steps.cache-corepack.outputs.cache-hit != 'true'/);
  assert.doesNotMatch(stepValue('save-corepack', 'if'), /always\(\)/);
});


test('Corepack options preserve external homes and bypass restore/save outputs', async () => {
  const step = stepBlock('resolve-corepack-cache');
  const script = inlineScripts().find((block) => block.line >= step.first && block.line < step.last);
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const run = new AsyncFunction('core', 'require', 'process', script.body);
  assert.match(step.lines.join('\n'), /CONFIGURE_NODEJS_CACHE_COREPACK: \$\{\{ inputs.cache-corepack \}\}/);
  assert.match(actionYaml, /  cache-corepack:\r?\n    description: .*\r?\n    default: "true"/);
  for (const [enabled, home] of [['false', ''], ['true', '/caller/corepack'], ['false', '/caller/corepack'], ['true', '']]) {
    const env = {
      CONFIGURE_NODEJS_CACHE_COREPACK: enabled,
      CONFIGURE_NODEJS_PACKAGE_MANAGER: 'pnpm',
      CONFIGURE_NODEJS_PACKAGE_MANAGER_VERSION: '10.33.0',
      CONFIGURE_NODEJS_RUNNER_OS: 'Linux',
      CONFIGURE_NODEJS_RUNNER_ARCH: 'X64',
      GITHUB_ACTION_PATH: path.dirname(actionPath),
      RUNNER_TEMP: path.dirname(actionPath),
      COREPACK_HOME: home,
    };
    const outputs = {};
    const exports = {};
    await run({
      setOutput: (key, value) => { outputs[key] = value; },
      exportVariable: (key, value) => { exports[key] = value; },
    }, createRequire(import.meta.url), { env });
    if (enabled === 'false' || home) {
      assert.equal(outputs.key, undefined);
      assert.equal(outputs.home, undefined);
      assert.deepEqual(exports, {});
      assert.equal(env.COREPACK_HOME, home);
    } else {
      assert.ok(outputs.key);
      assert.equal(exports.COREPACK_HOME, outputs.home);
      assert.equal(exports.CONFIGURE_NODEJS_MANAGED_COREPACK_HOME, outputs.home);
    }
  }
});

function condition(id, inputs, outputs) {
  const expression = stepValue(id, 'if')
    .replace(/steps\.([\w-]+)\.outputs\.([\w-]+)/g, (_, step, output) => `steps[${JSON.stringify(step)}]?.[${JSON.stringify(output)}]`)
    .replace(/inputs\.([\w-]+)/g, (_, input) => `inputs[${JSON.stringify(input)}]`);
  return new Function('inputs', 'steps', `return ${expression}`)(inputs, outputs);
}

test('completed step conditions enforce warm probe and strict consumer isolation', () => {
  for (const cacheMode of ['populate', 'restore']) for (const hit of ['true', 'false']) {
    const inputs = { 'dependency-cache': 'node-modules', 'cache-mode': cacheMode, 'lookup-only': 'false' };
    const steps = { 'resolve-cache-paths': { nodeVersionIsFloating: 'false' }, 'resolve-package-manager': { needsCorepack: 'true' }, 'cache-dependencies': { 'cache-hit': hit }, 'detect-cache-paths': { exists: 'true' } };
    const shouldPrepare = cacheMode === 'restore' || hit !== 'true';
    for (const id of ['setup-node', 'resolve-corepack-cache', 'prepare-package-manager']) assert.equal(condition(id, inputs, steps), shouldPrepare, `${id}/${cacheMode}/${hit}`);
    assert.equal(condition('save-dependencies', inputs, steps), cacheMode === 'populate' && hit !== 'true');
    assert.equal(condition('detect-cache-paths', inputs, steps), cacheMode === 'populate' && hit !== 'true');
  }
  assert.match(stepBlock('cache-dependencies').lines.join('\n'), /fail-on-cache-miss: .*cache-mode == 'restore'/);
  assert.match(stepBlock('cache-dependencies').lines.join('\n'), /lookup-only: .*cache-mode == 'populate'/);
  assert.doesNotMatch(actionYaml, /restore-keys:/);
});

function scriptFunction(id) {
  const step = stepBlock(id);
  const body = inlineScripts().find((block) => block.line >= step.first && block.line < step.last).body;
  return new (Object.getPrototypeOf(async function () {}).constructor)('core', 'require', 'process', 'exec', body);
}

test('executed strict prepare rejects misses and major/ABI mismatch without dependency execution', async (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'strict-prepare-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  fs.mkdirSync(path.join(cwd, 'node_modules/.pnpm'), { recursive: true });
  fs.mkdirSync(path.join(cwd, '.cache/configure-nodejs'), { recursive: true });
  const run = scriptFunction('prepare-package-manager');
  for (const scenario of ['miss', 'major', 'abi', 'compatible']) {
    const env = {
      GITHUB_ACTION_PATH: path.dirname(actionPath),
      CONFIGURE_NODEJS_ABSOLUTE_WORKING_DIRECTORY: cwd,
      CONFIGURE_NODEJS_PACKAGE_MANAGER: 'pnpm',
      CONFIGURE_NODEJS_PACKAGE_MANAGER_VERSION: '12.7.0',
      CONFIGURE_NODEJS_PNPM_STORE_PATH: path.join(cwd, '.pnpm-store'),
      CONFIGURE_NODEJS_NODE_CACHE_KEY_MAJOR: '24',
      CONFIGURE_NODEJS_INSTALLED_NODE_VERSION: scenario === 'major' ? '22.0.0' : '24.21.0',
      CONFIGURE_NODEJS_DEPENDENCY_CACHE: 'node-modules',
      CONFIGURE_NODEJS_CACHE_MODE: 'restore',
      CONFIGURE_NODEJS_CACHE_HIT: scenario === 'miss' ? 'false' : 'true',
      CONFIGURE_NODEJS_CACHE_KEY: 'exact-key',
      CONFIGURE_NODEJS_NEEDS_COREPACK: 'true',
    };
    fs.writeFileSync(path.join(cwd, '.cache/configure-nodejs/completed-tree.json'), JSON.stringify({ key: 'exact-key', nodeMajor: 24, nodeABI: scenario === 'abi' ? '999' : '137' }));
    const calls = [];
    const outputs = {};
    const core = { setOutput: (key, value) => { outputs[key] = value; }, exportVariable: () => {}, info: () => {} };
    const exec = {
      exec: async (command, args) => { calls.push([command, args]); },
      getExecOutput: async (command, args) => {
        calls.push([command, args]);
        if (command === 'node') return { stdout: '{"major":24,"abi":"137"}' };
        return { stdout: args[0] === '--version' ? '12.7.0' : path.join(cwd, '.pnpm-store/v11') };
      },
    };
    const result = run(core, createRequire(import.meta.url), { env, platform: process.platform }, exec);
    if (scenario === 'compatible') {
      await result;
      assert.equal(outputs.shouldInstall, 'false');
      assert.equal(env.PNPM_CONFIG_STORE_DIR, env.npm_config_store_dir);
    } else await assert.rejects(result, /miss|mismatch|Incompatible/);
    assert.ok(calls.every(([command, args]) => command !== 'pnpm' || !args.includes('install')));
    if (scenario === 'miss' || scenario === 'major') assert.deepEqual(calls, []);
  }
});

test('executed install failure and lifecycle lock mutation cannot complete population', async (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'failed-population-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  fs.writeFileSync(path.join(cwd, 'package.json'), '{}');
  const original = 'lockfileVersion: 9\n';
  const lockfile = path.join(cwd, 'pnpm-lock.yaml');
  const { installationInputsHash } = await import('../scripts/completed-tree.mjs');
  const run = scriptFunction('install-dependencies');
  for (const scenario of ['failure', 'lock-mutation']) {
    fs.writeFileSync(lockfile, original);
    const env = {
      GITHUB_ACTION_PATH: path.dirname(actionPath),
      CONFIGURE_NODEJS_ABSOLUTE_WORKING_DIRECTORY: cwd,
      CONFIGURE_NODEJS_DEPENDENCY_CACHE: 'node-modules',
      CONFIGURE_NODEJS_INSTALL_EXECUTABLE: 'pnpm',
      CONFIGURE_NODEJS_INSTALL_ARGUMENTS: '["install","--frozen-lockfile"]',
      CONFIGURE_NODEJS_LOCKFILE_PATH: 'pnpm-lock.yaml',
      CONFIGURE_NODEJS_LOCKFILE_SHA: crypto.createHash('sha256').update(original).digest('hex'),
      CONFIGURE_NODEJS_INPUTS_HASH: installationInputsHash({ cwd, lockfilePath: 'pnpm-lock.yaml' }),
    };
    await assert.rejects(run({ setOutput: () => {} }, createRequire(import.meta.url), { env }, { exec: async () => {
      if (scenario === 'failure') throw new Error('Install failed');
      fs.appendFileSync(lockfile, '# changed');
    } }), /failed|changed/);
    assert.equal(fs.existsSync(path.join(cwd, '.cache/configure-nodejs/completed-tree.json')), false);
  }
});
