import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveNativeConfig } from '../lib/hermes-native-config.js';
import { nativeDirectory, nativePrivateRead } from '../lib/hermes-native-files.js';

/** Read-only validation, executed as the image's nonroot worker principal.
 * It imports no worker entrypoint, database, provider, model or listener. */
export function validateNativeDeployment(configDirectory, stateDirectory) {
  const configDir = nativeDirectory(configDirectory);
  const stateRoot = nativeDirectory(stateDirectory);
  const document = JSON.parse(nativePrivateRead(path.join(configDir, 'config.json'), 65536));
  const config = resolveNativeConfig(document, { createState: false });
  // The operator marker pins the host's canonical config path. Identical bind
  // targets preserve that identity; no copied config or path rewriting is used.
  if (document.stateRoot !== stateRoot || config.stateRoot !== stateRoot ||
      document.channels.some(channel => path.dirname(channel.tokenFile) !== configDir)) {
    throw new Error('native_deployment_mount_mismatch');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.length !== 4) throw new Error('native_deployment_arguments');
    validateNativeDeployment(...process.argv.slice(2));
  } catch {
    // Do not print raw parser/file errors, config, token bytes or file contents.
    console.error('native_deployment_preflight_failed');
    process.exitCode = 2;
  }
}
