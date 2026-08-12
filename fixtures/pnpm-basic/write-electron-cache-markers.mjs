import fs from 'node:fs';
import path from 'node:path';

const cacheRoots = [
  process.env.npm_config_cache,
  process.env.electron_config_cache,
];
const expectedCacheRoot = path.join(
  process.cwd(),
  '.cache',
  'configure-nodejs',
);

// The fixture remains inert in the existing default-mode tests.
if (
  cacheRoots.some(
    (cacheRoot) =>
      !cacheRoot ||
      path.dirname(path.resolve(cacheRoot)) !== expectedCacheRoot,
  )
) {
  process.exit(0);
}

for (const cacheRoot of cacheRoots) {
  const relativePath = path.relative(process.cwd(), path.resolve(cacheRoot));
  if (
    relativePath === '..' ||
    relativePath.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativePath)
  ) {
    throw new Error(`Lifecycle cache escaped the fixture: ${cacheRoot}`);
  }
}

fs.mkdirSync(path.join(process.env.npm_config_cache, '_prebuilds'), {
  recursive: true,
});
fs.writeFileSync(
  path.join(process.env.npm_config_cache, '_prebuilds', 'native-abi.marker'),
  'native prebuild\n',
);
fs.mkdirSync(process.env.electron_config_cache, { recursive: true });
fs.writeFileSync(
  path.join(process.env.electron_config_cache, 'electron-runtime.marker'),
  'electron runtime\n',
);
