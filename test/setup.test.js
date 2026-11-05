import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const script = resolve('scripts/init.mjs');

test('init generates separate keys and refuses to overwrite existing configuration', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jk-push-init-'));
  try {
    const command = () => spawnSync(process.execPath, [script], { cwd: dir, encoding: 'utf8' });
    const first = command();
    assert.equal(first.status, 0);
    const data = readFileSync(join(dir, '.env'), 'utf8');
    const keys = Object.fromEntries(data.split('\n').filter(line => /^(?:ADMIN_KEY|MASTER_KEY)=/.test(line))
      .map(line => line.split('=')));
    assert.ok(keys.ADMIN_KEY.length >= 32);
    assert.ok(keys.MASTER_KEY.length >= 32);
    assert.notEqual(keys.ADMIN_KEY, keys.MASTER_KEY);
    assert.match(data, /MOCK_DELIVERY=1/);
    if (process.platform !== 'win32') assert.equal(statSync(join(dir, '.env')).mode & 0o777, 0o600);
    const second = command();
    assert.notEqual(second.status, 0);
    assert.equal(readFileSync(join(dir, '.env'), 'utf8'), data);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
