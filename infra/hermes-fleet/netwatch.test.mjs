// Kiểm netwatch/fleet-netwatch.sh bằng docker/curl/logger giả. Cần bash ⇒ chỉ chạy ở Linux (CI); máy khác báo SKIP, không tính là đạt.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'netwatch', 'fleet-netwatch.sh');
const skip = process.platform !== 'linux' && process.env.FLEET_NETWATCH_TEST_FORCE !== '1' ? 'cần bash (chạy ở CI Linux)' : false;
const WORKER_ID = 'a'.repeat(64);

// docker giả: FAKE_SIDECARS = danh sách tên; FAKE_DOWN = tên mất mạng (curl trong container trả 000); FAKE_HEAL = tên tự khỏi ở lần
// đo thứ hai; FAKE_STALE = tên bám network namespace của worker cũ. Mọi lệnh được ghi vào $FAKE_LOG.
const DOCKER = `#!/usr/bin/env bash
echo "docker $*" >> "$FAKE_LOG"
has() { case " $1 " in *" $2 "*) return 0;; esac; return 1; }
case "$1" in
  ps) for n in $FAKE_SIDECARS; do echo "$n"; done ;;
  inspect)
    if [ "$4" = "\${FAKE_WORKER:-ihome-zalo-worker}" ]; then [ "\${FAKE_NO_WORKER:-}" = 1 ] && exit 1; echo "${WORKER_ID}"; exit 0; fi
    if has "\${FAKE_STALE:-}" "$4"; then echo "container:${'b'.repeat(64)}"; else echo "container:${WORKER_ID}"; fi ;;
  exec)
    n="$2"; count_file="$FAKE_DIR/count.$n"; c=0; [ -f "$count_file" ] && c=$(cat "$count_file"); c=$((c+1)); echo "$c" > "$count_file"
    if has "\${FAKE_DOWN:-}" "$n" && ! { has "\${FAKE_HEAL:-}" "$n" && [ "$c" -ge 2 ]; }; then printf 000; else printf 200; fi ;;
  restart) : ;;
esac
`;
const CURL = `#!/usr/bin/env bash\necho "curl $*" >> "$FAKE_LOG"\nprintf "\${FAKE_HOST_CODE:-200}"\n`;
const LOGGER = `#!/usr/bin/env bash\necho "logger $*" >> "$FAKE_LOG"\n`;

function run(t, env) {
  const dir = mkdtempSync(join(tmpdir(), 'fleet-netwatch-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const [name, body] of [['docker', DOCKER], ['curl', CURL], ['logger', LOGGER]]) { writeFileSync(join(dir, name), body); chmodSync(join(dir, name), 0o755); }
  const log = join(dir, 'log');
  const result = spawnSync('bash', [SCRIPT], { encoding: 'utf8', env: { PATH: process.env.PATH, DOCKER: join(dir, 'docker'), CURL: join(dir, 'curl'), LOGGER: join(dir, 'logger'),
    RETRY_SLEEP: '0', FAKE_LOG: log, FAKE_DIR: dir, FAKE_SIDECARS: 'hermes-owner hermes-lan', ...env } });
  const lines = existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : [];
  return { status: result.status, lines, restarts: lines.filter(line => line.startsWith('docker restart')).map(line => line.split(' ')[2]),
    logged: lines.filter(line => line.startsWith('logger')) };
}

test('mọi sidecar còn mạng: không khởi động lại, không ghi log', { skip }, t => {
  const result = run(t, {});
  assert.equal(result.status, 0); assert.deepEqual(result.restarts, []); assert.deepEqual(result.logged, []);
  assert.equal(result.lines.filter(line => line.startsWith('docker exec')).length, 2);         // đo từng sidecar, kể cả trợ lý mới
});

test('chỉ sidecar mất mạng ở cả hai lần đo mới bị khởi động lại; sidecar khác không bị đụng', { skip }, t => {
  const result = run(t, { FAKE_DOWN: 'hermes-lan' });
  assert.equal(result.status, 0); assert.deepEqual(result.restarts, ['hermes-lan']);
  assert.equal(result.logged.length, 1); assert.match(result.logged[0], /-t ihome-hermes-fleet-netwatch hermes-lan mat mang/);
  const healed = run(t, { FAKE_DOWN: 'hermes-lan', FAKE_HEAL: 'hermes-lan' });
  assert.deepEqual(healed.restarts, []); assert.deepEqual(healed.logged, []);                   // chập chờn một lần: không khởi động lại
  const both = run(t, { FAKE_DOWN: 'hermes-owner hermes-lan' });
  assert.deepEqual(both.restarts, ['hermes-owner', 'hermes-lan']);
});

test('nhà cung cấp hỏng từ phía host, hoặc không thấy worker: không làm gì', { skip }, t => {
  const provider = run(t, { FAKE_HOST_CODE: '502', FAKE_DOWN: 'hermes-owner hermes-lan' });
  assert.equal(provider.status, 0); assert.deepEqual(provider.restarts, []);
  assert.equal(provider.lines.filter(line => line.startsWith('docker')).length, 0);
  const noWorker = run(t, { FAKE_NO_WORKER: '1', FAKE_DOWN: 'hermes-lan' });
  assert.equal(noWorker.status, 0); assert.deepEqual(noWorker.restarts, []);
});

test('sidecar bám worker cũ: restart không cứu được ⇒ chỉ ghi một dòng mức err, không khởi động lại', { skip }, t => {
  const result = run(t, { FAKE_DOWN: 'hermes-lan', FAKE_STALE: 'hermes-lan' });
  assert.deepEqual(result.restarts, []);
  assert.equal(result.logged.length, 1); assert.match(result.logged[0], /-p user\.err .*tao-lai-sidecar/);
});

test('tên container lạ từ docker ps bị bỏ qua, không đưa vào lệnh', { skip }, t => {
  const result = run(t, { FAKE_SIDECARS: 'hermes-lan Bad;name', FAKE_DOWN: 'Bad;name' });
  assert.deepEqual(result.restarts, []);
  assert(!result.lines.some(line => line.includes('Bad')));
});
