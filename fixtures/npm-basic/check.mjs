import pc from 'picocolors';

if (typeof pc.green !== 'function') {
  throw new Error('Expected picocolors.green to be available after npm install.');
}

console.log(pc.green('npm fixture dependency loaded'));
