#!/usr/bin/env node
// Helper chạy bằng ĐÚNG UID của worker Zalo (chủ của native-config, 0700/0600), do fleet.mjs (root) gọi:
//   list    các kênh trong cấu hình worker, KHÔNG có token (để lập kế hoạch và liệt kê)
//   export  bản chiếu kênh của MỘT hồ sơ (có token hzn_) ra stdout cho tiến trình cha; từ chối khi stdout là terminal
// Tạo/thu hồi kênh vẫn là việc của operator.mjs (cùng UID); helper này không ghi gì.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { nativeAbsolute, nativePrivateRead } from '../../worker/lib/hermes-native-files.js';
import { readNativeProfileChannel } from '../hermes-zalo-native/profile-provisioning.mjs';

const fail = code => { throw new Error(code); };

export function listChannels(configFile) {
  const file = nativeAbsolute(configFile);
  let raw;
  try { raw = nativePrivateRead(file, 65536); }
  catch (cause) { if (cause?.code === 'ENOENT') return { version: 1, present: false, channels: [] }; throw cause; }
  const document = JSON.parse(raw);
  if (!document || !Array.isArray(document.channels)) fail('fleet_native_config_invalid');
  return { version: 1, present: true, listenPort: document.listenPort, revision: createHash('sha256').update(raw).digest('hex'),
    configMtimeMs: Math.floor(fs.statSync(file).mtimeMs),
    channels: document.channels.map(channel => ({ profile: channel.profile, accountId: channel.accountId, ownUid: channel.ownUid,
      pairedUid: channel.pairedUid,
      // operator.mjs revoke thay token bằng file `<hồ sơ>.unissued.<uuid>.token`: kênh còn đó nhưng không ai giữ token.
      unissued: path.basename(String(channel.tokenFile)).startsWith(`${channel.profile}.unissued.`) })) };
}

export function runChannelHelper(argv, { write = text => process.stdout.write(text), error = text => process.stderr.write(text),
  isTTY = () => process.stdout.isTTY === true } = {}) {
  try {
    const [command, ...rest] = argv, options = {};
    for (let index = 0; index < rest.length; index += 2) {
      const name = { '--config': 'config', '--profile': 'profile' }[rest[index]], value = rest[index + 1];
      if (!name || Object.hasOwn(options, name) || typeof value !== 'string' || value.startsWith('--')) fail('fleet_arguments');
      options[name] = value;
    }
    if (command === 'list' && options.config && options.profile === undefined) { write(JSON.stringify(listChannels(options.config)) + '\n'); return 0; }
    if (command === 'export' && options.config && options.profile) {
      if (isTTY()) fail('fleet_refuse_terminal');
      write(JSON.stringify(readNativeProfileChannel({ configFile: nativeAbsolute(options.config), profile: options.profile })));
      return 0;
    }
    fail('fleet_arguments');
  } catch (cause) {
    error(JSON.stringify({ error: /^fleet_[a-z_]+$/.test(cause?.message ?? '') ? cause.message : 'fleet_channel_helper_failed' }) + '\n');
    return 1;
  }
}
const isMain = () => { try { return fs.realpathSync(path.resolve(process.argv[1] ?? '')) === fs.realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } };
if (isMain()) process.exitCode = runChannelHelper(process.argv.slice(2));
