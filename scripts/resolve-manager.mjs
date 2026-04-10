import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';

export const SUPPORTED_MANAGERS = new Set(['npm', 'pnpm', 'yarn']);
export const LOCKFILES = {
  npm: ['package-lock.json', 'npm-shrinkwrap.json'],
  pnpm: ['pnpm-lock.yaml'],
  yarn: ['yarn.lock'],
};

export function parseArgs(argv) {
  const args = {
    cwd: process.cwd(),
    packageManager: '',
    githubOutput: process.env.GITHUB_OUTPUT ?? '',
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === '--cwd') {
      args.cwd = argv[index + 1];
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

export function normalizeManager(manager) {
  const normalized = manager.trim().toLowerCase();
  if (normalized === '') {
    return '';
  }

  if (!SUPPORTED_MANAGERS.has(normalized)) {
    throw new Error(
      `Unsupported package manager "${manager}". Expected one of npm, yarn, pnpm.`,
    );
  }

  return normalized;
}

export function readPackageJson(cwd) {
  const packageJsonPath = path.join(cwd, 'package.json');
  if (!fs.existsSync(packageJsonPath)) {
    return null;
  }

  return {
    path: packageJsonPath,
    json: JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')),
  };
}

export function getManagerFromPackageJson(packageJson) {
  const packageManager = packageJson?.json?.packageManager;
  if (typeof packageManager !== 'string' || packageManager.trim() === '') {
    return { manager: '', version: '' };
  }

  const atIndex = packageManager.indexOf('@');
  if (atIndex === -1) {
    return {
      manager: normalizeManager(packageManager),
      version: '',
    };
  }

  return {
    manager: normalizeManager(packageManager.slice(0, atIndex)),
    version: packageManager.slice(atIndex + 1),
  };
}

export function detectLockfile(cwd) {
  const matches = [];

  for (const [manager, candidates] of Object.entries(LOCKFILES)) {
    for (const candidate of candidates) {
      const lockfilePath = path.join(cwd, candidate);
      if (fs.existsSync(lockfilePath)) {
        matches.push({
          manager,
          lockfileName: candidate,
          lockfilePath,
        });
        break;
      }
    }
  }

  if (matches.length === 0) {
    return null;
  }

  if (matches.length > 1) {
    throw new Error(
      `Found multiple lockfiles (${matches
        .map((match) => match.lockfileName)
        .join(', ')}). Set packageManager in package.json or pass --package-manager explicitly.`,
    );
  }

  return matches[0];
}

export function getLockfileForManager(cwd, manager) {
  for (const candidate of LOCKFILES[manager]) {
    const lockfilePath = path.join(cwd, candidate);
    if (fs.existsSync(lockfilePath)) {
      return {
        manager,
        lockfileName: candidate,
        lockfilePath,
      };
    }
  }

  throw new Error(
    `Could not find a ${manager} lockfile in ${cwd}. Expected one of: ${LOCKFILES[
      manager
    ].join(', ')}`,
  );
}

export function getYarnInstallCommand(packageManagerVersion, cwd) {
  const majorVersion = Number.parseInt(packageManagerVersion.split('.')[0] ?? '', 10);
  if (Number.isInteger(majorVersion) && majorVersion >= 2) {
    return 'yarn install --immutable';
  }

  if (Number.isInteger(majorVersion) && majorVersion === 1) {
    return 'yarn install --frozen-lockfile';
  }

  if (fs.existsSync(path.join(cwd, '.yarnrc.yml'))) {
    return 'yarn install --immutable';
  }

  return 'yarn install --frozen-lockfile';
}

export function buildResult({ cwd, explicitManager }) {
  const packageJson = readPackageJson(cwd);
  const packageJsonManager = getManagerFromPackageJson(packageJson);
  const manager = explicitManager || packageJsonManager.manager;
  const detectedLockfile = manager ? null : detectLockfile(cwd);
  const resolvedManager = manager || detectedLockfile?.manager;

  if (!resolvedManager) {
    throw new Error(
      'Could not determine package manager. Pass --package-manager, set packageManager in package.json, or add a supported lockfile.',
    );
  }

  const lockfile = manager ? getLockfileForManager(cwd, resolvedManager) : detectedLockfile;

  const lockfileSha = crypto
    .createHash('sha256')
    .update(fs.readFileSync(lockfile.lockfilePath))
    .digest('hex');

  const packageManagerVersion =
    resolvedManager === packageJsonManager.manager ? packageJsonManager.version : '';
  const normalizedPackageManagerVersion = packageManagerVersion || 'unspecified';

  let installCommand;
  if (resolvedManager === 'npm') {
    installCommand = 'npm ci';
  } else if (resolvedManager === 'pnpm') {
    installCommand = 'pnpm install --frozen-lockfile';
  } else {
    installCommand = getYarnInstallCommand(packageManagerVersion, cwd);
  }

  return {
    packageManager: resolvedManager,
    packageManagerVersion,
    managerCacheKey: `${resolvedManager}-${normalizedPackageManagerVersion}`,
    lockfileName: lockfile.lockfileName,
    lockfilePath: path.relative(cwd, lockfile.lockfilePath),
    lockfileSha,
    installCommand,
    needsCorepack: resolvedManager === 'npm' ? 'false' : 'true',
  };
}

export function writeGithubOutput(githubOutputPath, result) {
  if (!githubOutputPath) {
    return;
  }

  const lines = Object.entries(result).map(([key, value]) => `${key}=${value}`);
  fs.appendFileSync(githubOutputPath, `${lines.join('\n')}\n`);
}

export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const explicitManager = normalizeManager(args.packageManager);
  const result = buildResult({
    cwd: path.resolve(args.cwd),
    explicitManager,
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
