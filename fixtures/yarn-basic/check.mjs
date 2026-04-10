import pc from 'picocolors';

if (typeof pc.green !== 'function') {
  throw new Error('Expected picocolors.green to be available after yarn install.');
}

console.log(pc.green('yarn fixture dependency loaded'));

