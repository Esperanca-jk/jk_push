import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const demo = fileURLToPath(new URL('../examples/mock-walkthrough.mjs', import.meta.url));

test('mock walkthrough completes without external provider credentials', () => {
  const result = spawnSync(process.execPath, [demo], { encoding: 'utf8', timeout: 15000 });
  assert.equal(result.status, 0, result.stderr || result.error?.message || result.stdout);
  assert.match(result.stdout, /Mock delivery accepted: 1/);
  assert.match(result.stdout, /simulated; no real notification sent/);
});
