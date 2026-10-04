import fs from 'node:fs';
if (process.env.LIFECYCLE_LOG) fs.appendFileSync(process.env.LIFECYCLE_LOG, 'postinstall\n');
if (process.env.FAIL_INSTALL === 'true') throw new Error('Instrumented install failure');
if (process.env.MUTATE_LOCK === 'true') fs.appendFileSync('pnpm-lock.yaml', '\n# lifecycle mutation\n');
