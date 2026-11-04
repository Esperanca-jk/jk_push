import { openDatabase } from './db.js';
import { readMasterKey } from './crypto.js';
import { createWorker } from './worker.js';
import { createApi } from './api.js';

const env = process.env;
const masterKey = readMasterKey(env.MASTER_KEY);
const adminKey = env.ADMIN_KEY;
const db = openDatabase(env.DATABASE_PATH || './data/jk_push.sqlite');
const worker = createWorker({ db, masterKey, mock: env.MOCK_DELIVERY === '1' });
const server = createApi({ db, adminKey, masterKey, worker });
const port = Number(env.PORT || 8787);
const host = env.HOST || '127.0.0.1';
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT');
server.listen(port, host, () => {
  worker.start();
  console.log(`JK Push listening on http://${host}:${port}`);
  if (env.MOCK_DELIVERY === '1') console.warn('MOCK_DELIVERY is enabled. Notifications are not sent to APNs or FCM.');
});
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    worker.stop();
    server.close(() => { db.close(); process.exit(0); });
  });
}
