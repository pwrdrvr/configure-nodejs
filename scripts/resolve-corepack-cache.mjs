import crypto from 'node:crypto';
import path from 'node:path';

// Only immutable version selectors can safely reuse an immutable cache entry.
export function resolveCorepackCache({
  manager, version, runnerTemp, os, arch,
  enabled = true, corepackHome = '', managedCorepackHome = '',
}) {
  // A previous invocation may have exported our home for later workflow steps.
  // Only that exact value is action-owned; every other supplied home is external.
  if (!enabled || (corepackHome !== '' && corepackHome !== managedCorepackHome)) {
    return null;
  }
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
