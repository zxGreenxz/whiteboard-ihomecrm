import { loadConfig } from './config.mjs';
import { createRpcClient } from './db.mjs';
import { createGoogleClient } from './google.mjs';
import { createHttpServer } from './http.mjs';
import { runClaimCycle } from './sync.mjs';

const config = loadConfig();
const rpc = createRpcClient(config);
const google = createGoogleClient({ clientId: config.googleClientId, clientSecret: config.googleClientSecret,
  redirectUri: config.googleRedirectUri });
const server = createHttpServer({ config, key: config.key, rpc, google });
const bindHost = process.env.BANK_EMAIL_BIND_HOST ?? '127.0.0.1';
if (!['127.0.0.1', '0.0.0.0'].includes(bindHost)) throw new Error('Invalid bind host');

let stopping = false;
let timer;
async function cycle() {
  if (stopping) return;
  try {
    await runClaimCycle({ rpc, google, key: config.key, topic: config.googlePubsubTopic });
  } catch {
    console.error('bank-email claim cycle failed');
  }
  if (!stopping) timer = setTimeout(cycle, 10_000);
}

server.listen(config.port, bindHost, () => {
  console.info('bank-email worker listening');
  void cycle();
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    stopping = true;
    clearTimeout(timer);
    server.close();
  });
}
