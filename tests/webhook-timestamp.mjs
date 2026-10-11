// Run with Node.js 18+: node tests/webhook-timestamp.mjs
// Exercises the documented verifier using synthetic, locally signed payloads.
import { readFileSync } from 'node:fs';
import { createHmac } from 'node:crypto';
import assert from 'node:assert/strict';

const manifest = readFileSync(new URL('../skills/hang-loyalty/SKILL.md', import.meta.url), 'utf8');
const block = manifest.replaceAll('\r\n', '\n').split('```ts\n')[1]?.split('```')[0];
assert(block?.includes('function verify'), 'Documented verifier must be present');
const code = block.replace('function verify(rawBody: string, headers: Headers, secret: string)', 'function verify(rawBody, headers, secret)');
const { verify } = await import('data:text/javascript;base64,' + Buffer.from(code + '\nexport { verify };').toString('base64'));
const body = '{"test":"synthetic"}';
const secret = 'synthetic-test-secret';
const now = Math.floor(Date.now() / 1000);
for (const [timestamp, expected] of [
  [String(now), true],
  [String(now - 600), false],
  [String(now + 600), false],
  ['not-a-timestamp', false],
  ['Infinity', false],
  ['', false],
]) {
  const signature = createHmac('sha256', secret).update(body + timestamp).digest('base64');
  const headers = new Headers({ 'hang-timestamp': timestamp, 'hang-signature': signature });
  assert.equal(verify(body, headers, secret), expected, `timestamp ${timestamp}`);
}
assert.equal(verify(body, new Headers(), secret), false, 'Missing headers rejected');
const timestamp = String(now);
const signature = createHmac('sha256', 'different-secret').update(body + timestamp).digest('base64');
assert.equal(verify(body, new Headers({ 'hang-timestamp': timestamp, 'hang-signature': signature }), secret), false, 'Wrong signature rejected');
console.log('Eight synthetic webhook cases passed.');
