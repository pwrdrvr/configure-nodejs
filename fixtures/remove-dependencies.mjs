import fs from 'node:fs';
import path from 'node:path';
for (const directory of ['node_modules', '.pnpm-store', '.cache']) {
  fs.rmSync(path.join(process.env.FIXTURE, directory), { recursive: true, force: true });
}
