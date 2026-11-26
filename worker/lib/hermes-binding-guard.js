import http from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const managedChannel = channel => channel.profile.startsWith('nv-');

// Check each operation. An outage leaves the channel closed.
function check(configFile, { profile, accountId, ownUid, pairedUid }, expected) {
  return new Promise(resolve => {
    const req = http.request({
      socketPath: path.join(path.dirname(configFile), 'activation.sock'),
      path: expected ? '/verify' : '/authorize',
      method: 'POST',
      signal: AbortSignal.timeout(6000),
      headers: { 'content-type': 'application/json' },
    }, res => {
      res.resume();
      resolve(res.statusCode === 204);
    });
    req.on('error', () => resolve(false));
    req.end(JSON.stringify({ profile, accountId, ownUid, pairedUid, expected }));
  });
}

export const bindingAllowed = (configFile, channel) => check(configFile, channel);

// Fleet runs this entry point as the live worker's UID; never exposes tokens or sends a DM.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { readNativeConfig } = await import('./hermes-native-config.js');
    const [profile, bindingId, connectionId, revision] = process.argv.slice(2);
    const configFile = process.env.HERMES_ZALO_NATIVE_CONFIG;
    const channel = readNativeConfig(configFile).channels.find(item => item.profile === profile);
    if (!channel || !(await check(configFile, channel, { bindingId, connectionId, revision: Number(revision) }))) process.exitCode = 1;
  } catch { process.exitCode = 1; }
}
