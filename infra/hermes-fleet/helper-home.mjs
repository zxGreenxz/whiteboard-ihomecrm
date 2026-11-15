#!/usr/bin/env node
// Helper chạy bằng ĐÚNG UID của trợ lý mới (chủ home riêng), do fleet.mjs (root) gọi sau khi Hermes đã tự tạo khung hồ sơ:
//   seed --profile-dir <…/.hermes/profiles/<tên>>
// stdin (JSON ≤ 1 MiB, từ root): {"version":1,"configYaml":…,"env":…,"soul":…}. `env` mang khoá nhà cung cấp và token kênh
// ⇒ chỉ đi qua stdin, không bao giờ qua đối số hay log. Plugin lấy từ chính bản phát hành chứa file này.
// Chỉ gieo MỘT lần: đã có dấu `.ihome-fleet-seeded` thì không ghi gì (hồ sơ sống đang giữ mã CRM trong config.yaml).
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { SEED_MARKER } from './fleet-plan.mjs';

export const SEED_INPUT_MAX_BYTES = 1048576;
const RELEASE_INFRA = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const PLUGINS = Object.freeze({
  'ihome-zalo-native': { from: 'hermes-zalo-native', files: ['plugin.yaml', '__init__.py', 'adapter.py'] },
  'ihome-session-reset': { from: 'hermes-session-reset', files: ['plugin.yaml', '__init__.py', 'policy.py', 'hook.py'] },
});
const fail = code => { throw new Error(code); };
const text = (value, max) => typeof value === 'string' && value.length > 0 && Buffer.byteLength(value) <= max && !value.includes('\0');

function writeAtomic(file, contents, mode) {
  const temp = path.join(path.dirname(file), `.ihome-fleet.${randomUUID()}.tmp`);
  const fd = fs.openSync(temp, 'wx', mode);
  try { fs.writeFileSync(fd, contents); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  try { fs.chmodSync(temp, mode); fs.renameSync(temp, file); }
  catch (cause) { try { fs.unlinkSync(temp); } catch { /* giữ lỗi gốc */ } throw cause; }
}
function ownDirectory(directory) {
  const info = fs.lstatSync(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || fs.realpathSync(directory) !== directory ||
      (process.platform !== 'win32' && info.uid !== process.getuid())) fail('fleet_profile_refused');
  return info;
}
const assignments = raw => raw.split(/\r?\n/).some(line => /^\s*(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*\s*=/.test(line));

export function seedProfile({ profileDir, request, pluginRoot = RELEASE_INFRA, now = () => new Date() }) {
  if (typeof profileDir !== 'string' || !path.isAbsolute(profileDir) || path.resolve(profileDir) !== profileDir) fail('fleet_arguments');
  if (!request || Object.keys(request).sort().join() !== 'configYaml,env,soul,version' || request.version !== 1 ||
      !text(request.configYaml, 65536) || !text(request.env, 8192) || !text(request.soul, 524288)) fail('fleet_seed_input');
  const info = ownDirectory(profileDir), marker = path.join(profileDir, SEED_MARKER);
  if (fs.existsSync(marker)) return { version: 1, status: 'already_seeded', changed: false };
  const envFile = path.join(profileDir, '.env'), configFile = path.join(profileDir, 'config.yaml');
  // `hermes profile create` có thể để lại config.yaml/.env mặc định; một .env đã có biến thì không phải khung mới ⇒ dừng.
  if (fs.existsSync(envFile) && assignments(fs.readFileSync(envFile, 'utf8'))) fail('fleet_profile_not_fresh');
  for (const file of [envFile, configFile, path.join(profileDir, 'SOUL.md')]) {
    if (fs.existsSync(file) && (fs.lstatSync(file).isSymbolicLink() || !fs.lstatSync(file).isFile())) fail('fleet_profile_refused');
  }
  // Bộ ghi mã (profile-provisioning) đòi thư mục hồ sơ 0700 và hai file 0600 của đúng chủ.
  if (process.platform !== 'win32' && (info.mode & 0o777) !== 0o700) fs.chmodSync(profileDir, 0o700);
  if (fs.existsSync(configFile)) fs.renameSync(configFile, path.join(profileDir, 'config.yaml.upstream-default'));
  writeAtomic(configFile, request.configYaml, 0o600);
  writeAtomic(envFile, request.env, 0o600);
  writeAtomic(path.join(profileDir, 'SOUL.md'), request.soul, 0o644);
  const pluginsDir = path.join(profileDir, 'plugins');
  fs.mkdirSync(pluginsDir, { recursive: true, mode: 0o755 });
  for (const [name, source] of Object.entries(PLUGINS)) {
    const target = path.join(pluginsDir, name);
    fs.mkdirSync(target, { recursive: true, mode: 0o755 });
    for (const file of source.files) writeAtomic(path.join(target, file), fs.readFileSync(path.join(pluginRoot, source.from, file)), 0o644);
  }
  writeAtomic(marker, JSON.stringify({ version: 1, seededAt: now().toISOString() }) + '\n', 0o600);
  return { version: 1, status: 'seeded', changed: true, plugins: Object.keys(PLUGINS) };
}

async function readInput(input) {
  const chunks = []; let length = 0;
  for await (const chunk of input) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += bytes.length; if (length > SEED_INPUT_MAX_BYTES) fail('fleet_seed_input');
    chunks.push(bytes);
  }
  const bytes = Buffer.concat(chunks);
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { fail('fleet_seed_input'); }
  finally { bytes.fill(0); for (const chunk of chunks) chunk.fill(0); }
}
export async function runHomeHelper(argv, { input = process.stdin, write = line => process.stdout.write(line),
  error = line => process.stderr.write(line) } = {}) {
  try {
    if (argv.length !== 3 || argv[0] !== 'seed' || argv[1] !== '--profile-dir') fail('fleet_arguments');
    write(JSON.stringify(seedProfile({ profileDir: argv[2], request: await readInput(input) })) + '\n');
    return 0;
  } catch (cause) {
    // Không in nội dung lỗi của hệ thống: đường dẫn/khối dữ liệu có thể mang một phần đầu vào.
    error(JSON.stringify({ error: /^fleet_[a-z_]+$/.test(cause?.message ?? '') ? cause.message : 'fleet_home_helper_failed' }) + '\n');
    return 1;
  }
}
const isMain = () => { try { return fs.realpathSync(path.resolve(process.argv[1] ?? '')) === fs.realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } };
if (isMain()) process.exitCode = await runHomeHelper(process.argv.slice(2));
