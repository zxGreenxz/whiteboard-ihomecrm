// Script triển khai skill chuẩn (infra/hermes-skills/deploy.sh, archive-stale-local.sh) chạy trên cây giả trong thư mục tạm: chạy khô
// không ghi gì; ghi thật đúng chủ/quyền + symlink nguyên tử + external_dirs (kiểm YAML bắt buộc); chạy lại không đổi gì; mỗi nhóm hồ
// sơ một link, đổi link mà có hồ sơ ngoài --profiles đang dùng thì dừng; --remove gỡ đúng khối đã nối. Ghi thật cần symlink thật +
// python3 ⇒ chỉ chạy trên Linux (CI).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, statSync, symlinkSync,
  utimesSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

const SKILLS = fileURLToPath(new URL('../hermes-skills/', import.meta.url));
const DEPLOY = join(SKILLS, 'deploy.sh'), ARCHIVE = join(SKILLS, 'archive-stale-local.sh');
const GIT_BASH = 'C:\\Program Files\\Git\\bin\\bash.exe';
const BASH = process.platform === 'win32' && existsSync(GIT_BASH) ? GIT_BASH : 'bash';
const LINUX = process.platform === 'linux';
const LINUX_ONLY = LINUX ? false : 'cần Linux (symlink thật, python3, chown) — chạy ở CI ubuntu';
const SHA1 = 'a'.repeat(40), SHA2 = 'b'.repeat(40);
const want = link => `/home/hermes/.hermes/ihome-official-skills/${link}`;
const CONFIG = 'model:\n  default: cx/gpt-6-luna\nmcp_servers:\n  ihomecrm:\n    url: http://172.17.0.1:8740/mcp\n    headers:\n      Authorization: Bearer TOKEN-A\ntimezone: Asia/Ho_Chi_Minh\n';
// js-yaml của repo (node_modules của checkout) — bản phát hành giả trỏ tới để deploy.sh có bộ kiểm YAML khi host thiếu PyYAML.
const JS_YAML = dirname(createRequire(import.meta.url).resolve('js-yaml/package.json'));
const skillNames = () => readdirSync(SKILLS).filter(name => name.startsWith('ihome-crm-')).sort();
const posix = path => path.replaceAll('\\', '/');

// Windows (chạy thử tại chỗ): python3 trên PATH thường là bí danh Microsoft Store ⇒ thay bằng lệnh báo "không có" cho tất định.
let windowsShim;
function shimPath() {
  if (process.platform !== 'win32') return {};
  if (!windowsShim) {
    windowsShim = mkdtempSync(join(tmpdir(), 'ihome-skills-shim-'));
    writeFileSync(join(windowsShim, 'python3'), '#!/usr/bin/env bash\nexit 127\n');
    process.on('exit', () => rmSync(windowsShim, { recursive: true, force: true }));
  }
  return { PATH: `${windowsShim};${process.env.PATH}` };
}
function bash(script, args, env = {}) {
  const result = spawnSync(BASH, [posix(script), ...args], { encoding: 'utf8', env: { ...process.env, ...shimPath(), ...env } });
  return { code: result.status, out: `${result.stdout}${result.stderr}` };
}
function release(dir, sha, { withYaml = true } = {}) {
  mkdirSync(join(dir, 'infra'), { recursive: true });
  cpSync(SKILLS, join(dir, 'infra', 'hermes-skills'), { recursive: true });
  writeFileSync(join(dir, 'RELEASE_SHA'), `${sha}\n`);
  if (withYaml) { mkdirSync(join(dir, 'node_modules'), { recursive: true }); symlinkSync(JS_YAML, join(dir, 'node_modules', 'js-yaml'), 'junction'); }
  return dir;
}
const PROFILES = ['owner', 'tkt', 'tkh', 'other', 'note'];
function fixture(t) {
  const tmp = mkdtempSync(join(tmpdir(), 'ihome-skills-'));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const root = join(tmp, 'hermes');
  const initial = {};
  for (const profile of PROFILES) {
    mkdirSync(join(root, 'profiles', profile, 'skills'), { recursive: true });
    // other: khối skills lạ. note: khối skills nhắc đường dẫn trong dòng chú thích và trong mục của khoá KHÁC external_dirs.
    const extra = profile === 'other' ? 'skills:\n  external_dirs:\n    - /somewhere/else\n'
      : profile === 'note' ? `skills:\n  # ${want('current')}\n  disabled:\n    - ${want('current')}\n` : '';
    initial[profile] = `${CONFIG}${extra}`;
    writeFileSync(join(root, 'profiles', profile, 'config.yaml'), initial[profile], { mode: 0o600 });
  }
  return { tmp, root, initial, rel1: release(join(tmp, 'rel1'), SHA1), bak: join(tmp, 'bak') };
}
const id = () => (LINUX ? `${process.getuid()}:${process.getgid()}` : '0:0');
const deployArgs = (fx, rel, profiles, ...extra) => ['--release', posix(rel), '--profiles', profiles, '--root', posix(fx.root),
  '--backup-dir', posix(fx.bak), '--owner', id(), ...extra];
const cfgPath = (fx, profile) => join(fx.root, 'profiles', profile, 'config.yaml');
const configOf = (fx, profile) => readFileSync(cfgPath(fx, profile), 'utf8');
const YAML_PASS = /Kiểm YAML \((PyYAML|js-yaml)\): đạt/;

test('deploy.sh / archive-stale-local.sh: cú pháp bash hợp lệ', () => {
  for (const script of [DEPLOY, ARCHIVE]) {
    const result = spawnSync(BASH, ['-n', posix(script)], { encoding: 'utf8' });
    assert.equal(result.status, 0, `${script}: ${result.stderr}`);
  }
});

test('deploy.sh --dry-run: kiểm YAML ứng viên, in kế hoạch, không ghi gì; tham số sai thì dừng', t => {
  const fx = fixture(t);
  const before = configOf(fx, 'owner');
  const run = bash(DEPLOY, deployArgs(fx, fx.rel1, 'owner tkt', '--dry-run'));
  assert.equal(run.code, 0, run.out);
  assert.match(run.out, /CHẠY KHÔ/);
  assert.match(run.out, new RegExp(`sẽ tạo .*${SHA1}`));
  assert.match(run.out, /sẽ nối khối skills\.external_dirs/);
  assert.match(run.out, YAML_PASS, 'bước kiểm YAML đã chạy');
  assert.ok(!existsSync(join(fx.root, 'ihome-official-skills')), 'chạy khô không tạo thư mục');
  assert.equal(configOf(fx, 'owner'), before);
  assert.ok(!existsSync(fx.bak));
  assert.notEqual(bash(DEPLOY, deployArgs(fx, fx.rel1, 'khong-co', '--dry-run')).code, 0, 'hồ sơ lạ');
  assert.notEqual(bash(DEPLOY, deployArgs(fx, fx.rel1, '*', '--dry-run')).code, 0, 'không mở rộng glob trong --profiles');
  // Chủ skill trùng uid Hermes ⇒ Hermes ghi được skill chuẩn ⇒ ghi thật bị từ chối.
  const hermesOwner = bash(DEPLOY, [...deployArgs(fx, fx.rel1, 'owner'), '--owner', '10003:10003']);
  assert.notEqual(hermesOwner.code, 0);
  assert.match(hermesOwner.out, /trùng uid của Hermes/);
});

test('deploy.sh ghi thật: cây skill đúng quyền, symlink tương đối, external_dirs có kiểm YAML; chạy lại không đổi gì; đổi bản ⇒ đổi symlink + chạm config; chết giữa chừng ⇒ lần sau chạm lại', { skip: LINUX_ONLY }, t => {
  const fx = fixture(t);
  const first = bash(DEPLOY, deployArgs(fx, fx.rel1, 'owner tkt owner'));
  assert.equal(first.code, 0, first.out);
  assert.match(first.out, /Kiểm YAML \((PyYAML|js-yaml)\): đạt — owner/);
  const base = join(fx.root, 'ihome-official-skills'), dest = join(base, SHA1, 'ihome-crm');
  assert.equal(readFileSync(join(dest, 'DESCRIPTION.md'), 'utf8'), readFileSync(join(SKILLS, 'DESCRIPTION.md'), 'utf8'));
  for (const name of skillNames()) {
    assert.equal(readFileSync(join(dest, name, 'SKILL.md'), 'utf8'), readFileSync(join(SKILLS, name, 'SKILL.md'), 'utf8'), name);
    assert.equal(statSync(join(dest, name, 'SKILL.md')).mode & 0o777, 0o644);
    assert.equal(statSync(join(dest, name)).mode & 0o777, 0o755);
  }
  assert.ok(lstatSync(join(base, 'current')).isSymbolicLink());
  assert.equal(readlinkSync(join(base, 'current')), SHA1, 'đích tương đối để container đọc được');
  for (const profile of ['owner', 'tkt']) {
    const text = configOf(fx, profile);
    assert.ok(text.startsWith(CONFIG), 'chỉ nối thêm, không sửa phần cũ');
    assert.deepEqual(yaml.load(text), { ...yaml.load(CONFIG), skills: { external_dirs: [want('current')] } });
    assert.equal(statSync(cfgPath(fx, profile)).mode & 0o777, 0o600, 'giữ quyền 0600 (config có token)');
  }
  const backups = readdirSync(fx.bak);
  assert.equal(backups.length, 1);
  assert.equal(readFileSync(join(fx.bak, backups[0], 'owner', 'config.yaml'), 'utf8'), CONFIG, 'hồ sơ lặp trong --profiles không đè sao lưu');
  assert.equal(readFileSync(join(base, '.current.touched'), 'utf8').trim(), SHA1);
  for (const profile of ['other', 'note', 'tkh']) assert.equal(configOf(fx, profile), fx.initial[profile], `${profile} không bị đụng`);

  // Chạy lại cùng bản: không đổi gì (config không bị chạm).
  const mtime = statSync(cfgPath(fx, 'owner')).mtimeMs;
  const again = bash(DEPLOY, deployArgs(fx, fx.rel1, 'owner tkt'));
  assert.equal(again.code, 0, again.out);
  assert.match(again.out, /KHÔNG ĐỔI GÌ/);
  assert.equal(statSync(cfgPath(fx, 'owner')).mtimeMs, mtime);

  // Bản mới chỉ cho owner trong khi tkt cũng trỏ link current ⇒ dừng, không đổi symlink.
  const rel2 = release(join(fx.tmp, 'rel2'), SHA2);
  const shared = bash(DEPLOY, deployArgs(fx, rel2, 'owner'));
  assert.notEqual(shared.code, 0);
  assert.match(shared.out, /hồ sơ ngoài --profiles dùng: tkt/);
  assert.equal(readlinkSync(join(base, 'current')), SHA1);

  // Bản mới cho cả nhóm: symlink đổi, config các hồ sơ trỏ tới link được chạm (nội dung giữ nguyên), sha cũ còn để lùi.
  const old = new Date('2020-01-01T00:00:00Z');
  const backdate = () => { for (const profile of ['owner', 'tkt']) utimesSync(cfgPath(fx, profile), old, old); };
  backdate();
  const before = configOf(fx, 'owner');
  const next = bash(DEPLOY, deployArgs(fx, rel2, 'owner tkt'));
  assert.equal(next.code, 0, next.out);
  assert.equal(readlinkSync(join(base, 'current')), SHA2);
  assert.ok(existsSync(join(base, SHA1, 'ihome-crm')));
  assert.equal(configOf(fx, 'owner'), before);
  for (const profile of ['owner', 'tkt']) assert.ok(statSync(cfgPath(fx, profile)).mtimeMs > old.getTime(), `${profile} được chạm`);

  // Lần trước chết sau khi đổi symlink, trước khi chạm config (dấu vẫn là sha cũ) ⇒ chạy lại thì chạm, rồi mới "không đổi gì".
  writeFileSync(join(base, '.current.touched'), `${SHA1}\n`);
  backdate();
  const recover = bash(DEPLOY, deployArgs(fx, rel2, 'owner tkt'));
  assert.equal(recover.code, 0, recover.out);
  assert.match(recover.out, /chạm config\.yaml/);
  for (const profile of ['owner', 'tkt']) assert.ok(statSync(cfgPath(fx, profile)).mtimeMs > old.getTime(), `${profile} được chạm lại`);
  assert.match(bash(DEPLOY, deployArgs(fx, rel2, 'owner tkt')).out, /KHÔNG ĐỔI GÌ/);

  // Nhóm hồ sơ khác dùng link riêng (--link test): không đụng symlink current và config của owner / tkt.
  const ownerMtime = statSync(cfgPath(fx, 'owner')).mtimeMs;
  const testLink = bash(DEPLOY, deployArgs(fx, fx.rel1, 'tkh', '--link', 'test'));
  assert.equal(testLink.code, 0, testLink.out);
  assert.equal(readlinkSync(join(base, 'test')), SHA1);
  assert.equal(readlinkSync(join(base, 'current')), SHA2);
  assert.deepEqual(yaml.load(configOf(fx, 'tkh')).skills, { external_dirs: [want('test')] });
  assert.equal(statSync(cfgPath(fx, 'owner')).mtimeMs, ownerMtime, 'owner không bị chạm');

  // Khối skills lạ / khối chỉ có dòng chú thích nhắc đường dẫn ⇒ dừng, không sửa, không đổi symlink. Nội dung sha bị đổi ⇒ dừng.
  for (const profile of ['other', 'note']) {
    const before = configOf(fx, profile);
    const refused = bash(DEPLOY, deployArgs(fx, fx.rel1, profile));
    assert.notEqual(refused.code, 0, profile);
    assert.match(refused.out, /thêm tay vào skills\.external_dirs/);
    assert.equal(configOf(fx, profile), before);
  }
  assert.equal(readlinkSync(join(base, 'current')), SHA2, 'kiểm hết trước khi đổi: không đổi symlink');
  const tamperedSkill = join(fx.rel1, 'infra', 'hermes-skills', skillNames()[0], 'SKILL.md');
  writeFileSync(tamperedSkill, `${readFileSync(tamperedSkill, 'utf8')}\nthêm một dòng\n`);
  const tampered = bash(DEPLOY, deployArgs(fx, fx.rel1, 'owner tkt'));
  assert.notEqual(tampered.code, 0);
  assert.match(tampered.out, /khác bản phát hành — không ghi đè/);
  assert.equal(readlinkSync(join(base, 'current')), SHA2, 'không đổi symlink khi dừng');
});

test('deploy.sh --remove gỡ đúng khối đã nối, giữ phần config đổi sau đó (token đã xoay); ghi thật không có bộ kiểm YAML ⇒ dừng', { skip: LINUX_ONLY }, t => {
  const fx = fixture(t);
  assert.equal(bash(DEPLOY, deployArgs(fx, fx.rel1, 'owner tkt')).code, 0);
  // Token của owner được xoay SAU khi triển khai: gỡ khối không được đưa token cũ trở lại.
  writeFileSync(cfgPath(fx, 'owner'), configOf(fx, 'owner').replace('TOKEN-A', 'TOKEN-B'));
  const dry = bash(DEPLOY, deployArgs(fx, fx.rel1, 'owner tkt', '--remove', '--dry-run'));
  assert.equal(dry.code, 0, dry.out);
  assert.match(dry.out, /sẽ gỡ khối/);
  const removed = bash(DEPLOY, deployArgs(fx, fx.rel1, 'owner tkt', '--remove'));
  assert.equal(removed.code, 0, removed.out);
  assert.match(removed.out, YAML_PASS);
  assert.equal(configOf(fx, 'tkt'), CONFIG, 'tkt về đúng bản trước khi triển khai');
  assert.equal(configOf(fx, 'owner'), CONFIG.replace('TOKEN-A', 'TOKEN-B'), 'owner giữ token mới, chỉ mất khối skills');
  assert.equal(statSync(cfgPath(fx, 'owner')).mode & 0o777, 0o600);
  assert.match(bash(DEPLOY, deployArgs(fx, fx.rel1, 'owner tkt', '--remove')).out, /KHÔNG ĐỔI GÌ/);
  // Khối đã bị sửa tay (thêm mục) ⇒ không tự gỡ.
  assert.equal(bash(DEPLOY, deployArgs(fx, fx.rel1, 'tkt')).code, 0);
  writeFileSync(cfgPath(fx, 'tkt'), `${configOf(fx, 'tkt')}    - /extra/dir\n`);
  const edited = bash(DEPLOY, deployArgs(fx, fx.rel1, 'tkt', '--remove'));
  assert.notEqual(edited.code, 0);
  assert.match(edited.out, /gỡ tay/);
  // Không có PyYAML lẫn js-yaml mà cần sửa config ⇒ ghi thật dừng trước khi đổi gì.
  const bare = release(join(fx.tmp, 'rel-bare'), SHA2, { withYaml: false });
  const noPython = join(fx.tmp, 'no-python');
  mkdirSync(noPython);
  writeFileSync(join(noPython, 'python3'), '#!/usr/bin/env bash\nexit 1\n');
  chmodSync(join(noPython, 'python3'), 0o755);
  const before = configOf(fx, 'tkh');
  const unchecked = bash(DEPLOY, deployArgs(fx, bare, 'tkh', '--link', 'test'), { PATH: `${noPython}:${process.env.PATH}` });
  assert.notEqual(unchecked.code, 0);
  assert.match(unchecked.out, /không có bộ kiểm YAML/);
  assert.equal(configOf(fx, 'tkh'), before);
  assert.ok(!existsSync(join(fx.root, 'ihome-official-skills', 'test')), 'không tạo link khi dừng');
});

// Lệnh Hermes giả: `--profile <p> curator archive|restore|pin|unpin <skill>` như hermes_cli/curator.py (archive chuyển thư mục vào
// skills/.archive/<tên>, restore đặt phẳng skills/<tên>); ghi nhật ký lời gọi.
const FAKE_CLI = `#!/usr/bin/env bash
set -eu
[ "$1" = --profile ] && [ "$3" = curator ] || exit 64
p="$2"; op="$4"; s="$5"; base="$FAKE_ROOT/profiles/$p/skills"
echo "$p $op $s" >> "$FAKE_LOG"
[ "$op $s" != "archive \${FAKE_FAIL_ARCHIVE:-}" ] || exit 1
case "$op" in
  archive) src="$(dirname "$(grep -rl --include=SKILL.md "^name: $s\\$" "$base" | grep -v '/\\.archive/' | head -n 1)")"; mkdir -p "$base/.archive"; mv "$src" "$base/.archive/$s" ;;
  restore) mv "$base/.archive/$s" "$base/$s" ;;
  pin|unpin) ;;
  *) exit 65 ;;
esac
`;
function archiveFixture(t) {
  const fx = fixture(t);
  const skills = join(fx.root, 'profiles', 'owner', 'skills');
  for (const name of ['crm-task-management', 'crm-room-communications']) {
    mkdirSync(join(skills, 'productivity', name), { recursive: true });
    writeFileSync(join(skills, 'productivity', name, 'SKILL.md'), `---\nname: ${name}\ndescription: cũ.\n---\n\nnội dung cũ\n`);
  }
  writeFileSync(join(skills, '.usage.json'), JSON.stringify({ 'crm-task-management': { pinned: false }, 'crm-room-communications': { pinned: true } }, null, 2));
  const cli = join(fx.tmp, 'fake-hermes.sh');
  writeFileSync(cli, FAKE_CLI);
  const log = join(fx.tmp, 'cli.log');
  const env = { FAKE_ROOT: posix(fx.root), FAKE_LOG: posix(log) };
  const args = (...extra) => ['--profiles', 'owner', '--root', posix(fx.root), '--backup-dir', posix(fx.bak), '--cli', `bash ${posix(cli)}`, ...extra];
  return { fx, skills, log, env, args };
}

test('archive-stale-local.sh mặc định chạy khô: in kế hoạch, không gọi Hermes, không đụng skill', t => {
  const { fx, skills, log, env, args } = archiveFixture(t);
  const run = bash(ARCHIVE, args(), env);
  assert.equal(run.code, 0, run.out);
  assert.match(run.out, /CHẠY KHÔ/);
  assert.match(run.out, /owner\/crm-task-management: ở skills\/productivity\/crm-task-management/);
  assert.match(run.out, /curator archive crm-room-communications/);
  assert.ok(!existsSync(log), 'chạy khô không gọi lệnh Hermes');
  assert.ok(existsSync(join(skills, 'productivity', 'crm-task-management', 'SKILL.md')));
  assert.ok(!existsSync(fx.bak));
});

test('archive-stale-local.sh --apply cất bằng curator (bỏ ghim trước), sao lưu + manifest; chạy lại không đổi gì; --restore trả về chỗ cũ và ghim lại', { skip: LINUX_ONLY }, t => {
  const { fx, skills, log, env, args } = archiveFixture(t);
  const run = bash(ARCHIVE, args('--apply'), env);
  assert.equal(run.code, 0, run.out);
  for (const name of ['crm-task-management', 'crm-room-communications']) {
    assert.ok(existsSync(join(skills, '.archive', name, 'SKILL.md')), `${name} đã vào .archive`);
    assert.ok(!existsSync(join(skills, 'productivity', name)));
  }
  assert.deepEqual(readFileSync(log, 'utf8').trim().split('\n'),
    ['owner archive crm-task-management', 'owner unpin crm-room-communications', 'owner archive crm-room-communications']);
  const manifests = readFileSync(join(fx.bak, 'archive-manifests.list'), 'utf8').trim().split('\n');
  assert.equal(manifests.length, 1);
  assert.deepEqual(readFileSync(manifests[0], 'utf8').trim().split('\n'), ['owner\tcrm-task-management\tproductivity/crm-task-management\t0',
    'owner\tcrm-room-communications\tproductivity/crm-room-communications\t1']);
  const again = bash(ARCHIVE, args('--apply'), env);
  assert.equal(again.code, 0, again.out);
  assert.match(again.out, /KHÔNG ĐỔI GÌ/);
  const restore = bash(ARCHIVE, args('--restore', '--apply'), env);
  assert.equal(restore.code, 0, restore.out);
  for (const name of ['crm-task-management', 'crm-room-communications']) {
    assert.ok(existsSync(join(skills, 'productivity', name, 'SKILL.md')), `${name} về đúng productivity/`);
  }
  assert.match(readFileSync(log, 'utf8'), /owner pin crm-room-communications\n$/);
  // Người dùng bỏ ghim rồi cất lại: khôi phục theo manifest MỚI NHẤT (không ghim), không theo dòng cũ (ghim).
  writeFileSync(join(skills, '.usage.json'), JSON.stringify({ 'crm-task-management': { pinned: false }, 'crm-room-communications': { pinned: false } }));
  assert.equal(bash(ARCHIVE, args('--apply'), env).code, 0);
  const second = bash(ARCHIVE, args('--restore', '--apply'), env);
  assert.equal(second.code, 0, second.out);
  assert.match(readFileSync(log, 'utf8'), /owner restore crm-task-management\nowner restore crm-room-communications\n$/);
});

test('archive-stale-local.sh: Hermes cất lỗi ⇒ ghim lại skill vừa bỏ ghim rồi dừng; sửa xong chạy lại thì cất được và khôi phục vẫn ghim', { skip: LINUX_ONLY }, t => {
  const { fx, skills, log, env, args } = archiveFixture(t);
  const failed = bash(ARCHIVE, args('--apply'), { ...env, FAKE_FAIL_ARCHIVE: 'crm-room-communications' });
  assert.notEqual(failed.code, 0);
  assert.match(failed.out, /crm-room-communications chưa được cất/);
  assert.deepEqual(readFileSync(log, 'utf8').trim().split('\n'), ['owner archive crm-task-management', 'owner unpin crm-room-communications',
    'owner archive crm-room-communications', 'owner pin crm-room-communications']);
  assert.ok(existsSync(join(skills, 'productivity', 'crm-room-communications', 'SKILL.md')), 'skill lỗi vẫn ở chỗ cũ');
  const retry = bash(ARCHIVE, args('--apply'), env);
  assert.equal(retry.code, 0, retry.out);
  assert.equal(readFileSync(join(fx.bak, 'archive-manifests.list'), 'utf8').trim().split('\n').length, 2, 'sổ giữ cả hai lần cất');
  const restore = bash(ARCHIVE, args('--restore', '--apply'), env);
  assert.equal(restore.code, 0, restore.out);
  for (const name of ['crm-task-management', 'crm-room-communications']) assert.ok(existsSync(join(skills, 'productivity', name, 'SKILL.md')), name);
  assert.match(readFileSync(log, 'utf8'), /owner pin crm-room-communications\n$/);
});

test('archive-stale-local.sh --apply TỪ CHỐI khi SOUL.md còn gọi tên skill sắp cất; SOUL đã trỏ sang ihome-crm-* thì cất được', { skip: LINUX_ONLY }, t => {
  const { skills, log, env, args, fx } = archiveFixture(t);
  const soul = join(fx.root, 'profiles', 'owner', 'SOUL.md');
  writeFileSync(soul, 'Skill có sẵn: `crm-room-communications` và `crm-task-management`. Gọi skill_view đúng hai tên này.\n');
  const dry = bash(ARCHIVE, args(), env);
  assert.equal(dry.code, 0, dry.out);
  assert.match(dry.out, /CẢNH BÁO: SOUL\.md còn gọi tên skill sắp cất: owner:crm-task-management owner:crm-room-communications/);
  const refused = bash(ARCHIVE, args('--apply'), env);
  assert.notEqual(refused.code, 0);
  assert.match(refused.out, /SOUL\.md còn gọi tên skill sắp cất/);
  assert.ok(!existsSync(log), 'không gọi Hermes khi từ chối');
  assert.ok(existsSync(join(skills, 'productivity', 'crm-task-management', 'SKILL.md')));
  // ihome-crm-* không bị nhận nhầm là tên cũ (ranh giới tên).
  writeFileSync(soul, 'Skill có sẵn: ihome-crm-ghi-chung, ihome-crm-cong-viec, ihome-crm-phong-sale-nhom.\n');
  const ok = bash(ARCHIVE, args('--apply'), env);
  assert.equal(ok.code, 0, ok.out);
  assert.ok(existsSync(join(skills, '.archive', 'crm-task-management', 'SKILL.md')));
});
