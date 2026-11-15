#!/usr/bin/env node
// Một lệnh quản trị cho "mỗi người một trợ lý Hermes". Chạy bằng root trên máy chủ, từ bản phát hành đã ghim:
//   node fleet.mjs them-nguoi --config /etc/ihome-hermes-fleet/fleet.json --ten <tên> --connector <khoá> \
//        --assistant-id <uuid> --user-id <uuid> --organization-id <uuid> --binding-id <uuid> [--ram-mb N] [--uid N]
//   node fleet.mjs them-nguoi … --thu-khong-kenh --connection-id <uuid>     # người thử trên connector TEST, không kênh Zalo
//   node fleet.mjs go-nguoi --config … --ten <tên>
//   node fleet.mjs tao-lai-sidecar --config … [--chi <container>]…
//   node fleet.mjs liet-ke --config …
//   node fleet.mjs don-handoff --config … --connector <khoá> --connection-id <uuid>…
// Mặc định chỉ in kế hoạch và `expectedRevision`. Ghi thật: chạy lại ĐÚNG lệnh đó kèm `--apply --expect <expectedRevision>`.
// Đầu ra là JSON, không chứa mã kết nối, token kênh hay khoá. Runbook: README.md cùng thư mục.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BLOCK_TEXT, FleetError, validateFleetConfig } from './fleet-plan.mjs';
import { applyAdd, applyRecreate, applyRemove, planFor, pruneHandoff, realSystem } from './fleet-host.mjs';

const fail = (code, detail) => { throw new FleetError(code, detail); };
const ACTIONS = ['them-nguoi', 'go-nguoi', 'tao-lai-sidecar', 'liet-ke', 'don-handoff'];
const FLAGS = { '--config': 'config', '--ten': 'name', '--connector': 'connector', '--assistant-id': 'assistantId', '--user-id': 'userId',
  '--organization-id': 'organizationId', '--binding-id': 'bindingId', '--ram-mb': 'memoryMb', '--uid': 'uid', '--expect': 'expect' };
const LOCK = '/run/ihome-hermes-fleet.lock';

export function parseArguments(argv) {
  const [action, ...rest] = argv, options = { connectionIds: [], only: [] };
  if (!ACTIONS.includes(action)) fail('lenh_la');
  for (let index = 0; index < rest.length; index++) {
    const flag = rest[index];
    if (flag === '--apply' && !options.apply) { options.apply = true; continue; }
    if (flag === '--thu-khong-kenh' && !options.trial) { options.trial = true; continue; }
    const value = rest[++index];
    if (typeof value !== 'string' || value.startsWith('--')) fail('tham_so_sai', flag);
    if (flag === '--connection-id') { options.connectionIds.push(value); continue; }
    if (flag === '--chi') { options.only.push(value); continue; }
    const name = FLAGS[flag];
    if (!name || Object.hasOwn(options, name)) fail('tham_so_sai', flag);
    if (['memoryMb', 'uid'].includes(name) && !/^[0-9]{1,6}$/.test(value)) fail('tham_so_sai', flag);
    options[name] = ['memoryMb', 'uid'].includes(name) ? Number(value) : value;
  }
  if (typeof options.config !== 'string' || !path.isAbsolute(options.config)) fail('tham_so_sai', '--config');
  if ((options.apply === true) !== (options.expect !== undefined)) fail('tham_so_sai', '--apply phải đi cùng --expect');
  const allowed = { 'them-nguoi': ['name', 'connector', 'assistantId', 'userId', 'organizationId', 'bindingId', 'memoryMb', 'uid', 'trial', 'connectionIds'],
    'go-nguoi': ['name'], 'tao-lai-sidecar': ['only'], 'liet-ke': [], 'don-handoff': ['connector', 'connectionIds'] }[action];
  for (const [key, value] of Object.entries(options)) {
    if (['config', 'apply', 'expect'].includes(key) || allowed.includes(key)) continue;
    if (Array.isArray(value) ? value.length : value !== undefined) fail('tham_so_sai', key);
  }
  if (action === 'liet-ke' && options.apply) fail('tham_so_sai', 'liet-ke chỉ đọc');
  let input;
  if (action === 'them-nguoi') {
    if (options.connectionIds.length > 1) fail('tham_so_sai', '--connection-id');
    input = { name: options.name, connector: options.connector, assistantId: options.assistantId, userId: options.userId, organizationId: options.organizationId,
      ...(options.bindingId === undefined ? {} : { bindingId: options.bindingId }), ...(options.connectionIds.length ? { connectionId: options.connectionIds[0] } : {}),
      ...(options.trial ? { trial: true } : {}), ...(options.memoryMb === undefined ? {} : { memoryMb: options.memoryMb }), ...(options.uid === undefined ? {} : { uid: options.uid }) };
  } else if (action === 'go-nguoi') input = { name: options.name };
  else if (action === 'tao-lai-sidecar') input = { only: options.only };
  else if (action === 'don-handoff') input = { connector: options.connector, connectionIds: options.connectionIds };
  else input = {};
  return { action, input, config: options.config, apply: options.apply === true, expect: options.expect };
}

/** Cấu hình môi trường thuộc root, 0600, không symlink: nó quyết định UID, đường dẫn và image mà root sẽ chạy. */
export function loadFleetConfig(file, { io = fs, platform = process.platform } = {}) {
  const info = io.lstatSync(file);
  if (!info.isFile() || info.isSymbolicLink() || io.realpathSync(file) !== file ||
      (platform !== 'win32' && (info.uid !== 0 || (info.mode & 0o777) !== 0o600))) fail('cau_hinh_sai', 'file cấu hình phải của root, 0600, không symlink');
  if (info.size > 65536) fail('cau_hinh_sai', 'file cấu hình quá lớn');
  let parsed; try { parsed = JSON.parse(io.readFileSync(file, 'utf8')); } catch { fail('cau_hinh_sai', 'JSON'); }
  return validateFleetConfig(parsed);
}
const explain = result => Array.isArray(result?.blocks) && result.blocks.length ?
  { ...result, blocksText: result.blocks.map(code => `${code}: ${BLOCK_TEXT[code] ?? 'xem mã trong fleet-plan.mjs'}`) } : result;

export function runFleet(argv, { sys = realSystem(), loadConfig = loadFleetConfig, write = text => process.stdout.write(text),
  error = text => process.stderr.write(text), isRoot = () => process.platform !== 'win32' && process.getuid() === 0, lockDir = LOCK, io = fs } = {}) {
  let locked = false;
  try {
    if (argv.length === 1 && ['--help', 'help'].includes(argv[0])) {
      write(JSON.stringify({ commands: ACTIONS, preview: 'Mặc định chỉ in kế hoạch; ghi thật cần --apply --expect <expectedRevision>.', runbook: 'infra/hermes-fleet/README.md' }, null, 2) + '\n');
      return 0;
    }
    const { action, input, config: configFile, apply, expect } = parseArguments(argv);
    // Cả xem trước cũng cần root: đọc docker và gọi helper dưới UID khác qua setpriv.
    if (!isRoot()) fail('can_root');
    const config = loadConfig(configFile);
    if (apply) {
      // Hai lệnh ghi không chạy song song. Khoá còn lại sau một lần chết giữa chừng KHÔNG tự phá: xem xét rồi gỡ tay.
      try { io.mkdirSync(lockDir, { mode: 0o700 }); locked = true; } catch (cause) { if (cause.code === 'EEXIST') fail('dang_co_lenh_ghi_khac', lockDir); throw cause; }
    }
    let result;
    if (action === 'don-handoff') result = pruneHandoff(sys, config, { ...input, apply, expect });
    else if (!apply) result = planFor(sys, config, action, input);
    else if (action === 'them-nguoi') result = applyAdd(sys, config, input, expect);
    else if (action === 'go-nguoi') result = applyRemove(sys, config, input.name, expect);
    else result = applyRecreate(sys, config, input, expect);
    write(JSON.stringify(explain(result), null, 2) + '\n');
    return result.status === 'blocked' ? 3 : result.runtimeStatus === 'unverified' && apply && action === 'them-nguoi' ? 4 : 0;
  } catch (cause) {
    const known = cause instanceof FleetError;
    // Lỗi hệ thống (ENOENT, EXDEV…) chỉ mang mã, lời gọi và đường dẫn trên máy chủ: đủ để biết bước nào hỏng, không có bí mật.
    const system = !known && typeof cause?.code === 'string' ? { code: cause.code, syscall: cause.syscall ?? null, path: cause.path ?? null } : undefined;
    error(JSON.stringify({ error: known ? cause.code : 'loi_khong_ro', ...(known && cause.detail !== undefined ? { detail: cause.detail } : {}),
      ...(system ? { detail: system } : {}),
      ...(known && Array.isArray(cause.detail) ? { blocksText: cause.detail.map(code => `${code}: ${BLOCK_TEXT[code] ?? ''}`) } : {}),
      instruction: 'Chạy lại lệnh KHÔNG có --apply để xem bước nào đã xong; bước đã xong sẽ được bỏ qua. Không xoá gì để thử lại.' }, null, 2) + '\n');
    return known && cause.code === 'ke_hoach_bi_chan' ? 3 : 1;
  } finally { if (locked) try { io.rmdirSync(lockDir); } catch { /* báo ở lần chạy sau */ } }
}
const isMain = () => { try { return fs.realpathSync(path.resolve(process.argv[1] ?? '')) === fs.realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } };
if (isMain()) process.exitCode = runFleet(process.argv.slice(2));
