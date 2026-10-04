import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';

export function containsNodeModules(root) {
  const pending = [root];

  while (pending.length > 0) {
    const current = pending.pop();

    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name === 'node_modules') {
        return true;
      }

      if (entry.isDirectory() && entry.name !== '.git') {
        pending.push(path.join(current, entry.name));
      }
    }
  }

  return false;
}

export function hasCacheableDependencyPath({
  packageManager,
  absolutePrimaryCachePath,
  absoluteWorkingDirectory,
  dependencyCache = 'default',
}) {
  if (dependencyCache === 'node-modules') {
    return fs.existsSync(path.join(absoluteWorkingDirectory, '.cache/configure-nodejs/completed-tree.json')) &&
      fs.existsSync(absolutePrimaryCachePath) && containsNodeModules(absoluteWorkingDirectory);
  }
  if (packageManager === 'pnpm') {
    return fs.existsSync(absolutePrimaryCachePath);
  }

  return containsNodeModules(absoluteWorkingDirectory);
}

const entrypoint = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : null;

if (entrypoint === import.meta.url) {
  const [packageManager, absolutePrimaryCachePath, absoluteWorkingDirectory] =
    process.argv.slice(2);
  const exists = hasCacheableDependencyPath({
    packageManager,
    absolutePrimaryCachePath,
    absoluteWorkingDirectory,
  });
  process.stdout.write(`${exists}\n`);
}
