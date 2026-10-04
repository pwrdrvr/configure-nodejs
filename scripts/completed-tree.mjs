import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { assertPathWithinDirectory } from './resolve-cache-paths.mjs';

export const METADATA_PATH = '.cache/configure-nodejs/completed-tree.json';

export function validateCacheMode({ dependencyCache = 'default', cacheMode = 'auto', lookupOnly = 'false', packageManager, packageManagerVersion }) {
  if (!['default', 'node-modules'].includes(dependencyCache)) {
    throw new Error('dependency-cache must be default or node-modules.');
  }
  if (dependencyCache === 'default') {
    if (cacheMode !== 'auto') throw new Error('cache-mode requires dependency-cache: node-modules.');
    return;
  }
  if (!['populate', 'restore'].includes(cacheMode)) throw new Error('Completed trees require explicit cache-mode: populate or restore.');
  if (lookupOnly !== 'false') throw new Error('Completed trees use cache-mode instead of lookup-only.');
  if (packageManager && (packageManager !== 'pnpm' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+sha\d+\.[0-9a-f]+)?$/.test(packageManagerVersion))) {
    throw new Error('Completed trees require an exact pnpm pin in package.json#packageManager.');
  }
}

function digestFiles(root, names, boundary = root) {
  const hash = crypto.createHash('sha256');
  for (const name of [...new Set(names)].sort()) {
    const file = path.resolve(root, name);
    assertPathWithinDirectory({ boundaryPath: boundary, candidatePath: file, description: 'Installation input' });
    const bytes = fs.existsSync(file) ? fs.readFileSync(file) : null;
    hash.update(JSON.stringify([name.split(path.sep).join('/'), bytes?.length ?? null]));
    if (bytes) hash.update(bytes);
  }
  return hash.digest('hex');
}

// Include workspace manifests/config without globbing materialized dependencies.
export function installationInputsHash({ cwd, lockfilePath, cacheInputs = '', repositoryRoot = cwd }) {
  cwd = path.resolve(cwd);
  repositoryRoot = path.resolve(repositoryRoot);
  const names = [lockfilePath, 'package.json', 'pnpm-workspace.yaml', '.npmrc', '.pnpmfile.cjs'];
  const ignored = new Set(['.git', 'node_modules', '.pnpm-store', '.cache', '.yarn']);
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory() && !ignored.has(entry.name)) visit(file);
      else if (entry.isFile() && ['package.json', '.npmrc', 'pnpm-workspace.yaml', '.pnpmfile.cjs'].includes(entry.name)) {
        names.push(path.relative(cwd, file));
      }
    }
  };
  visit(cwd);
  assertPathWithinDirectory({ boundaryPath: repositoryRoot, candidatePath: cwd, description: 'Working directory', allowEqual: true });
  for (let ancestor = path.dirname(cwd); ancestor !== path.dirname(repositoryRoot); ancestor = path.dirname(ancestor)) {
    if (path.resolve(cwd) === path.resolve(repositoryRoot)) break;
    for (const name of ['package.json', '.npmrc', 'pnpm-workspace.yaml', '.pnpmfile.cjs']) {
      names.push(path.relative(cwd, path.join(ancestor, name)));
    }
    if (ancestor === path.resolve(repositoryRoot)) break;
  }
  for (const name of cacheInputs.split(/\r?\n/).map((value) => value.trim()).filter(Boolean)) {
    if (path.isAbsolute(name)) throw new Error('cache-inputs paths must be relative to working-directory.');
    if (!fs.existsSync(path.resolve(cwd, name))) throw new Error(`Additional installation input does not exist: ${name}`);
    names.push(name);
  }
  return digestFiles(cwd, names, repositoryRoot);
}

export function actionSourceHash(actionPath) {
  return digestFiles(actionPath, ['action.yml', ...fs.readdirSync(path.join(actionPath, 'scripts')).filter((name) => name.endsWith('.mjs')).map((name) => `scripts/${name}`)]);
}

export function buildCompletedKey({ nodeMajor, packageManagerVersion, os, arch, imageOS = '', workingDirectory, inputsHash, actionRevision, cacheKeySuffix = '', cacheElectron = false }) {
  // Hash raw policy suffixes: sanitizing them would let distinct policies collide.
  const policy = crypto.createHash('sha256').update(JSON.stringify({
    os, arch, imageOS, workingDirectory, inputsHash, actionRevision, cacheKeySuffix, cacheElectron,
  })).digest('hex');
  return `completed-node-modules-v1-node${nodeMajor}-pnpm-${packageManagerVersion}-${policy}`;
}

export function verifyLockfile({ cwd, lockfilePath, lockfileSha }) {
  const sha = crypto.createHash('sha256').update(fs.readFileSync(path.join(cwd, lockfilePath))).digest('hex');
  if (sha !== lockfileSha) throw new Error('Frozen installation changed the original lockfile; refusing to save completed dependencies.');
}

export function removeMaterializedDependencies(cwd) {
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.name === 'node_modules') fs.rmSync(file, { recursive: true, force: true });
      else if (entry.isDirectory() && !['.git', '.pnpm-store', '.cache'].includes(entry.name)) visit(file);
    }
  };
  visit(cwd);
  fs.rmSync(path.join(cwd, '.pnpm-store'), { recursive: true, force: true });
  fs.rmSync(path.join(cwd, METADATA_PATH), { force: true });
}

export function verifyCompletedTree({ cwd, key, nodeMajor, nodeABI }) {
  const metadata = JSON.parse(fs.readFileSync(path.join(cwd, METADATA_PATH), 'utf8'));
  if (metadata.key !== key || metadata.nodeMajor !== Number(nodeMajor) || metadata.nodeABI !== String(nodeABI)) {
    throw new Error('Incompatible completed dependency tree key, Node major or ABI; installation/repair is forbidden.');
  }
  if (!fs.existsSync(path.join(cwd, 'node_modules/.pnpm'))) throw new Error('Completed pnpm dependency tree is missing its virtual store.');
}

export function completePopulation({ cwd, key, nodeMajor, nodeABI, lockfilePath, lockfileSha, inputsHash, cacheInputs = '', repositoryRoot = cwd }) {
  verifyLockfile({ cwd, lockfilePath, lockfileSha });
  if (installationInputsHash({ cwd, lockfilePath, cacheInputs, repositoryRoot }) !== inputsHash) {
    throw new Error('Installation changed an input; refusing to save completed dependencies.');
  }
  if (!fs.existsSync(path.join(cwd, 'node_modules/.pnpm'))) throw new Error('Installation did not produce a pnpm virtual store.');
  const metadataPath = path.join(cwd, METADATA_PATH);
  assertPathWithinDirectory({ boundaryPath: cwd, candidatePath: metadataPath, description: 'Completed tree metadata' });
  fs.mkdirSync(path.dirname(metadataPath), { recursive: true });
  fs.writeFileSync(metadataPath, JSON.stringify({ key, nodeMajor: Number(nodeMajor), nodeABI: String(nodeABI), lockfileSha }));
  verifyCompletedTree({ cwd, key, nodeMajor, nodeABI });
}
