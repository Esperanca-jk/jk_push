import { randomBytes } from 'node:crypto';
import { writeFile, chmod, access } from 'node:fs/promises';
import { resolve } from 'node:path';

const filename = resolve(process.cwd(), '.env');
try {
  await access(filename);
  console.error('.env already exists; not replacing keys that may encrypt existing devices.');
  process.exitCode = 1;
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
  const key = () => randomBytes(32).toString('base64url');
  const contents = [
    '# Keep this file private. Back up MASTER_KEY separately.',
    `ADMIN_KEY=${key()}`,
    `MASTER_KEY=${key()}`,
    'HOST=127.0.0.1',
    'PORT=8787',
    'DATABASE_PATH=./data/jk_push.sqlite',
    '# Mock mode is safe for your first test. Set 0 after configuring APNs/FCM.',
    'MOCK_DELIVERY=1',
    ''
  ].join('\n');
  await writeFile(filename, contents, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  if (process.platform !== 'win32') await chmod(filename, 0o600);
  console.log('Created .env with independent random keys. Keep it out of version control.');
  console.log('Run npm start and open http://127.0.0.1:8787/dashboard');
  console.log('Read ADMIN_KEY from .env to access the dashboard. Never expose your secrets publicly.');
}
