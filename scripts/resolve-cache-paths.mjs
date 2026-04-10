import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';

export function parseArgs(argv) {
  const args = {
    cwd: process.cwd(),
    workingDirectory: '.',
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

export function buildCachePaths(workingDirectory) {
  const base = workingDirectory === '.' ? '' : `${workingDirectory}/`;
  return [
    `${base}node_modules`,
    `${base}**/node_modules`,
    `!${base}node_modules/.cache`,
    `!${base}**/node_modules/.cache`,
  ];
}

export function buildResult({ cwd, workingDirectory }) {
  const resolvedWorkingDirectory = resolveWorkingDirectory(cwd, workingDirectory);

  return {
    absoluteWorkingDirectory: resolvedWorkingDirectory.absoluteWorkingDirectory,
    workingDirectory: resolvedWorkingDirectory.workingDirectory,
    workingDirectoryKey: buildWorkingDirectoryKey(
      resolvedWorkingDirectory.workingDirectory,
    ),
    cachePaths: buildCachePaths(resolvedWorkingDirectory.workingDirectory),
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
