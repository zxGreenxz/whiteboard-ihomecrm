import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

// Plugin chạy trong Hermes (Python 3.14 ở container hermes-owner); test chỉ dùng stdlib nên cần
// Python >= 3.11. Thiếu Python hoặc bash là CHƯA KIỂM, không phải đạt.
function findPython() {
  for (const command of ['python3', 'python']) {
    const probe = spawnSync(command, ['-c', 'import sys; print("%d %d" % sys.version_info[:2])'], { encoding: 'utf8' });
    if (probe.status !== 0) continue;
    const [major, minor] = probe.stdout.trim().split(' ').map(Number);
    if (major === 3 && minor >= 11) return command;
  }
  return null;
}

test('ihome-session-reset: unittest stdlib chạy đủ, không test nào bị bỏ qua', () => {
  const python = findPython();
  assert.ok(python, 'Cần Python >= 3.11 trên PATH (python3 hoặc python)');
  assert.equal(spawnSync('bash', ['--version'], { encoding: 'utf8' }).status, 0, 'test_ops.py cần bash');
  const result = spawnSync(python, ['-B', '-m', 'unittest', 'discover', '-s', 'tests', '-p', 'test_*.py', '-v'], {
    cwd: fileURLToPath(new URL('.', import.meta.url)),
    encoding: 'utf8',
    timeout: 900_000, // test_ops.py sinh nhiều tiến trình bash: Linux CI ~10 s, Windows vài phút
    env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
  });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 0, output);
  assert.match(output, /Ran [1-9]\d* tests? in/);
  assert.doesNotMatch(output, /\bskipped\b|\bexpected failures\b|\bunexpected successes\b/i);
  assert.match(output, /\bOK\b/);
});
