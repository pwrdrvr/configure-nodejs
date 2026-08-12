import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';

export const ELECTRON_CACHE_SCHEMA_VERSION = 'v1';

export function parseArgs(argv) {
  const args = {
    cwd: process.cwd(),
    workingDirectory: '.',
    cacheKeySuffix: '',
    cacheElectron: 'false',
    packageManager: '',
    githubOutput: process.env.GITHUB_OUTPUT ?? '',
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === '--cwd') {
      args.cwd = argv[index + 1];
      index += 1;
    } else if (arg === '--working-directory') {
      args.workingDirectory = argv[index + 1] ?? '.';
      index += 1;
    } else if (arg === '--cache-key-suffix') {
      args.cacheKeySuffix = argv[index + 1] ?? '';
      index += 1;
    } else if (arg === '--cache-electron') {
      args.cacheElectron = argv[index + 1] ?? '';
      index += 1;
    } else if (arg === '--package-manager') {
      args.packageManager = argv[index + 1] ?? '';
      index += 1;
    } else if (arg === '--github-output') {
      args.githubOutput = argv[index + 1] ?? '';
      index += 1;
    }
  }

  return args;
}

export function normalizeRelativePath(relativePath) {
  const normalized = relativePath === '' ? '.' : relativePath;
  return normalized.split(path.sep).join('/');
}

export function resolveWorkingDirectory(cwd, workingDirectory = '.') {
  const absoluteCwd = path.resolve(cwd);
  const absoluteWorkingDirectory = path.resolve(absoluteCwd, workingDirectory);
  const relativeWorkingDirectory = path.relative(absoluteCwd, absoluteWorkingDirectory);
  const normalizedWorkingDirectory = normalizeRelativePath(relativeWorkingDirectory);

  if (
    normalizedWorkingDirectory.startsWith('../') ||
    normalizedWorkingDirectory === '..'
  ) {
    throw new Error(
      `Working directory "${workingDirectory}" resolves outside the repository root.`,
    );
  }

  if (!fs.existsSync(absoluteWorkingDirectory)) {
    throw new Error(
      `Working directory "${normalizedWorkingDirectory}" does not exist.`,
    );
  }

  if (!fs.statSync(absoluteWorkingDirectory).isDirectory()) {
    throw new Error(
      `Working directory "${normalizedWorkingDirectory}" is not a directory.`,
    );
  }

  return {
    absoluteWorkingDirectory,
    workingDirectory: normalizedWorkingDirectory,
  };
}

export function buildWorkingDirectoryKey(workingDirectory) {
  if (workingDirectory === '.') {
    return 'root';
  }

  const slug = workingDirectory.replace(/[\\/]+/g, '__').replace(/[^A-Za-z0-9_.-]/g, '-');
  const digest = crypto.createHash('sha1').update(workingDirectory).digest('hex').slice(0, 8);
  return `${slug}-${digest}`;
}

export function normalizeCacheKeySuffix(cacheKeySuffix) {
  const normalized = cacheKeySuffix.trim();
  if (normalized === '') {
    return '';
  }

  return normalized.replace(/[^A-Za-z0-9_.-]+/g, '-');
}

export function normalizeCacheElectron(cacheElectron = 'false') {
  const normalized = String(cacheElectron).trim().toLowerCase();

  if (normalized === 'true') {
    return true;
  }

  if (normalized === 'false') {
    return false;
  }

  throw new Error(
    `Invalid cache-electron value "${cacheElectron}". Expected "true" or "false".`,
  );
}

export function normalizePackageManager(packageManager) {
  const normalized = packageManager.trim().toLowerCase();
  if (normalized === '') {
    return '';
  }

  if (!['npm', 'pnpm', 'yarn'].includes(normalized)) {
    throw new Error(
      `Unsupported package manager "${packageManager}". Expected one of npm, yarn, pnpm.`,
    );
  }

  return normalized;
}

export function buildElectronCachePaths(workingDirectory) {
  const base = workingDirectory === '.' ? '' : `${workingDirectory}/`;

  return [
    `${base}.cache/configure-nodejs/npm`,
    `${base}.cache/configure-nodejs/electron`,
  ];
}

function isPathWithin(boundaryPath, candidatePath, allowEqual = true) {
  const relativePath = path.relative(boundaryPath, candidatePath);
  return (
    (allowEqual || relativePath !== '') &&
    relativePath !== '..' &&
    !relativePath.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relativePath)
  );
}

function findNearestExistingPath(candidatePath) {
  let currentPath = candidatePath;

  while (true) {
    try {
      fs.lstatSync(currentPath);
      return currentPath;
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') {
        throw error;
      }
    }

    const parentPath = path.dirname(currentPath);
    if (parentPath === currentPath) {
      throw new Error(`Could not find an existing parent for "${candidatePath}".`);
    }
    currentPath = parentPath;
  }
}

export function assertPathWithinDirectory({
  boundaryPath,
  candidatePath,
  description,
  allowEqual = false,
}) {
  const absoluteBoundaryPath = path.resolve(boundaryPath);
  const absoluteCandidatePath = path.resolve(candidatePath);

  if (!isPathWithin(absoluteBoundaryPath, absoluteCandidatePath, allowEqual)) {
    throw new Error(
      `${description} "${candidatePath}" resolves outside "${boundaryPath}".`,
    );
  }

  const realBoundaryPath = fs.realpathSync(absoluteBoundaryPath);
  const existingCandidatePath = findNearestExistingPath(absoluteCandidatePath);
  const realExistingCandidatePath = fs.realpathSync(existingCandidatePath);

  if (!isPathWithin(realBoundaryPath, realExistingCandidatePath, true)) {
    throw new Error(
      `${description} "${candidatePath}" escapes "${boundaryPath}" through a symbolic link.`,
    );
  }
}

export function assertElectronCachePathsSafe({
  cwd,
  absoluteWorkingDirectory,
  absoluteElectronCachePaths,
}) {
  assertPathWithinDirectory({
    boundaryPath: cwd,
    candidatePath: absoluteWorkingDirectory,
    description: 'Working directory',
    allowEqual: true,
  });

  for (const absoluteCachePath of absoluteElectronCachePaths) {
    assertPathWithinDirectory({
      boundaryPath: absoluteWorkingDirectory,
      candidatePath: absoluteCachePath,
      description: 'Electron cache path',
    });
  }
}

export function buildCachePaths(
  workingDirectory,
  packageManager = '',
  electronCachePaths = [],
) {
  const base = workingDirectory === '.' ? '' : `${workingDirectory}/`;

  if (packageManager === 'pnpm') {
    return [`${base}.pnpm-store`, ...electronCachePaths];
  }

  return [
    `${base}node_modules`,
    `${base}**/node_modules`,
    `!${base}node_modules/.cache`,
    `!${base}**/node_modules/.cache`,
    ...electronCachePaths,
  ];
}

export function buildPrimaryCachePath(workingDirectory, packageManager = '') {
  const base = workingDirectory === '.' ? '' : `${workingDirectory}/`;
  return packageManager === 'pnpm' ? `${base}.pnpm-store` : `${base}node_modules`;
}

export function buildCacheKeyPrefix(packageManager = '') {
  return packageManager === 'pnpm' ? 'pnpm-store' : 'node-modules';
}

export function buildResult({
  cwd,
  workingDirectory,
  cacheKeySuffix = '',
  cacheElectron = 'false',
  packageManager = '',
}) {
  const resolvedWorkingDirectory = resolveWorkingDirectory(cwd, workingDirectory);
  const normalizedCacheKeySuffix = normalizeCacheKeySuffix(cacheKeySuffix);
  const normalizedCacheElectron = normalizeCacheElectron(cacheElectron);
  const normalizedPackageManager = normalizePackageManager(packageManager);
  const electronCachePaths = normalizedCacheElectron
    ? buildElectronCachePaths(resolvedWorkingDirectory.workingDirectory)
    : [];
  const absoluteElectronCachePaths = normalizedCacheElectron
    ? [
        path.resolve(
          resolvedWorkingDirectory.absoluteWorkingDirectory,
          '.cache',
          'configure-nodejs',
          'npm',
        ),
        path.resolve(
          resolvedWorkingDirectory.absoluteWorkingDirectory,
          '.cache',
          'configure-nodejs',
          'electron',
        ),
      ]
    : [];

  if (normalizedCacheElectron) {
    assertElectronCachePathsSafe({
      cwd,
      absoluteWorkingDirectory: resolvedWorkingDirectory.absoluteWorkingDirectory,
      absoluteElectronCachePaths,
    });
  }

  const primaryCachePath = buildPrimaryCachePath(
    resolvedWorkingDirectory.workingDirectory,
    normalizedPackageManager,
  );

  return {
    absoluteWorkingDirectory: resolvedWorkingDirectory.absoluteWorkingDirectory,
    workingDirectory: resolvedWorkingDirectory.workingDirectory,
    workingDirectoryKey: buildWorkingDirectoryKey(
      resolvedWorkingDirectory.workingDirectory,
    ),
    cachePaths: buildCachePaths(
      resolvedWorkingDirectory.workingDirectory,
      normalizedPackageManager,
      electronCachePaths,
    ),
    cacheElectron: normalizedCacheElectron,
    electronCachePaths,
    absolutePrebuildCachePath: absoluteElectronCachePaths[0] ?? '',
    absoluteElectronCachePath: absoluteElectronCachePaths[1] ?? '',
    electronCacheKeySegment: normalizedCacheElectron
      ? `-electron-true-${ELECTRON_CACHE_SCHEMA_VERSION}`
      : '',
    primaryCachePath,
    absolutePrimaryCachePath: path.resolve(cwd, primaryCachePath),
    cacheKeyPrefix: buildCacheKeyPrefix(normalizedPackageManager),
    cacheKeySuffix: normalizedCacheKeySuffix,
    cacheKeySuffixSegment:
      normalizedCacheKeySuffix === '' ? '' : `-${normalizedCacheKeySuffix}`,
  };
}

export function writeGithubOutput(githubOutputPath, result) {
  if (!githubOutputPath) {
    return;
  }

  for (const [key, value] of Object.entries(result)) {
    if (Array.isArray(value)) {
      fs.appendFileSync(
        githubOutputPath,
        `${key}<<__CONFIGURE_NODEJS__\n${value.join('\n')}\n__CONFIGURE_NODEJS__\n`,
      );
      continue;
    }

    fs.appendFileSync(githubOutputPath, `${key}=${value}\n`);
  }
}

export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const result = buildResult({
    cwd: args.cwd,
    workingDirectory: args.workingDirectory,
    cacheKeySuffix: args.cacheKeySuffix,
    cacheElectron: args.cacheElectron,
    packageManager: args.packageManager,
  });

  writeGithubOutput(args.githubOutput, result);
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
