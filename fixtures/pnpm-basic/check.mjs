import pc from 'picocolors';

if (typeof pc.green !== 'function') {
  throw new Error('Expected picocolors.green to be available after pnpm install.');
}

console.log(pc.green('pnpm fixture dependency loaded'));
