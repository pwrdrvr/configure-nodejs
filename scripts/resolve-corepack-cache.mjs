import crypto from 'node:crypto';
import path from 'node:path';

// Only immutable version selectors can safely reuse an immutable cache entry.
export function resolveCorepackCache({ manager, version, runnerTemp, os, arch }) {
  if (!['pnpm', 'yarn'].includes(manager) ||
      !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+sha(?:224|256|384|512)\.[0-9a-fA-F]+)?$/.test(version)) {
    return null;
  }
  const digest = crypto.createHash('sha256').update(`${manager}@${version}`).digest('hex');
  return {
    home: path.join(runnerTemp, 'configure-nodejs-corepack', digest),
    key: `corepack-v1-${os}-${arch}-${manager}-${digest}`,
  };
}
