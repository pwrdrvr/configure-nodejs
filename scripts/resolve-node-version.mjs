import path from 'path';
import { pathToFileURL } from 'url';

// Native addons are compiled against NODE_MODULE_VERSION, which changes with
// every Node.js major release. A restored `node_modules` therefore has to come
// from the same major that will run it, so the dependency cache key has to
// carry the resolved major rather than the raw `node-version` input.
//
// `actions/setup-node` accepts semver ranges plus a handful of moving aliases.
// A spec is "pinned" only when every version satisfying it shares one major; in
// that case the major is known from the string alone and the cache can still be
// restored before Node is installed. Everything else is treated as floating,
// which costs a `setup-node` run before the restore. Classification is
// deliberately conservative: guessing "floating" for a pinned spec only costs
// the slower ordering, while guessing "pinned" for a floating spec is the bug
// this module exists to prevent.

export const FLOATING_ALIASES = new Set([
  '*',
  'x',
  'latest',
  'current',
  'node',
  'nightly',
  'rc',
  'lts',
]);

const OPEN_ENDED_OPERATORS = new Set(['>', '>=', '<', '<=']);

// Optional comparator, optional `v`, then the major. The lookahead keeps
// `24` and `24.x` and `24.0.0-nightly2024` in, and keeps `2410` out of `24`.
const SPEC_PATTERN = /^(>=|<=|>|<|=|~|\^)?\s*v?(\d+)(?=$|[.\-+])/;

export function parseArgs(argv) {
  const args = {
    nodeVersion: '',
    installedNodeVersion: '',
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === '--node-version') {
      args.nodeVersion = argv[index + 1] ?? '';
      index += 1;
    } else if (arg === '--installed-node-version') {
      args.installedNodeVersion = argv[index + 1] ?? '';
      index += 1;
    }
  }

  return args;
}

function floating(spec, reason) {
  return { spec, isFloating: true, major: null, reason };
}

export function parseNodeVersionSpec(nodeVersion) {
  const spec = String(nodeVersion ?? '').trim();

  if (spec === '') {
    return floating(spec, 'empty');
  }

  const lowered = spec.toLowerCase();

  // `lts/*` and `lts/-1` move with every release line. Named lines such as
  // `lts/jod` do pin a major, but a codename table goes stale the moment a new
  // line is named, so every `lts/` form takes the conservative path.
  if (lowered === 'lts' || lowered.startsWith('lts/')) {
    return floating(spec, 'lts-alias');
  }

  if (FLOATING_ALIASES.has(lowered)) {
    return floating(spec, 'moving-alias');
  }

  // Compound ranges (`>=20 <21`, `20 || 22`) can be single-major, but proving
  // it means intersecting comparator sets. Not worth the failure modes.
  if (/\s/.test(spec) || spec.includes('||')) {
    return floating(spec, 'compound-range');
  }

  const match = SPEC_PATTERN.exec(spec);
  if (!match) {
    return floating(spec, 'unrecognized');
  }

  const [, operator, major] = match;
  if (operator && OPEN_ENDED_OPERATORS.has(operator)) {
    return floating(spec, 'open-ended-range');
  }

  // `~` and `^` never cross a major for the ranges setup-node accepts, and a
  // bare or `=` prefixed version is exact.
  return {
    spec,
    isFloating: false,
    major: Number.parseInt(major, 10),
    reason: 'pinned-major',
  };
}

export function extractNodeMajor(version) {
  const match = /^v?(\d+)(?:$|[.\-+])/.exec(String(version ?? '').trim());
  return match ? Number.parseInt(match[1], 10) : null;
}

export function buildNodeCacheKeySegment(major) {
  if (!Number.isInteger(major) || major < 0) {
    throw new Error(
      `Expected a Node.js major version, got "${major}".`,
    );
  }

  return `node${major}`;
}

export function buildResult({ nodeVersion, installedNodeVersion = '' }) {
  const spec = parseNodeVersionSpec(nodeVersion);

  if (!spec.isFloating) {
    return {
      spec: spec.spec,
      isFloating: false,
      reason: spec.reason,
      resolvedFrom: 'spec',
      nodeMajor: spec.major,
      nodeCacheKeySegment: buildNodeCacheKeySegment(spec.major),
    };
  }

  const major = extractNodeMajor(installedNodeVersion);
  if (major === null) {
    throw new Error(
      `Node.js version "${spec.spec}" can resolve to more than one major version (${spec.reason}), so the dependency cache key must use the version actions/setup-node installed, but no resolved version was reported.`,
    );
  }

  return {
    spec: spec.spec,
    isFloating: true,
    reason: spec.reason,
    resolvedFrom: 'setup-node',
    nodeMajor: major,
    nodeCacheKeySegment: buildNodeCacheKeySegment(major),
  };
}

// Backstop for a spec this module classified as pinned that setup-node then
// resolved to a different major. That combination means the cache key is wrong
// for the ABI now on PATH, so the restored tree has to be discarded.
export function detectNodeMajorMismatch({
  cacheKeyNodeMajor,
  installedNodeVersion,
}) {
  const installedMajor = extractNodeMajor(installedNodeVersion);
  if (installedMajor === null) {
    return null;
  }

  const keyedMajor = Number.parseInt(cacheKeyNodeMajor, 10);
  if (!Number.isInteger(keyedMajor) || keyedMajor === installedMajor) {
    return null;
  }

  return { cacheKeyNodeMajor: keyedMajor, installedMajor };
}

export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const result = buildResult({
    nodeVersion: args.nodeVersion,
    installedNodeVersion: args.installedNodeVersion,
  });

  process.stdout.write(`${JSON.stringify(result)}\n`);
}

const entrypoint = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : null;

if (entrypoint === import.meta.url) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  }
}
