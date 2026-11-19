import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

// Cổng node --test cho script Python (VPS chạy Python 3.10, chỉ thư viện chuẩn). Thiếu Python hoặc 0 test/skip là ĐỎ, không phải đạt.
const PYTHONS = process.platform === 'win32' ? ['python', 'py'] : ['python3', 'python'];

function findPython() {
  for (const command of PYTHONS) {
    const probe = spawnSync(command, ['-c', 'import sys; print("%d.%d" % sys.version_info[:2])'], { encoding: 'utf8' });
    if (probe.status === 0) return { command, version: probe.stdout.trim() };
  }
  return null;
}

test('learning_audit.py: test Python chạy đủ, không skip, trên Python ≥ 3.10', () => {
  const python = findPython();
  assert.ok(python, 'cần Python 3 trong PATH: thiếu runtime không phải là đạt');
  const [major, minor] = python.version.split('.').map(Number);
  assert.ok(major === 3 && minor >= 10, `Python ${python.version} < 3.10`);
  const result = spawnSync(python.command, ['-B', '-X', 'utf8', '-m', 'unittest', 'discover', '-s', '.', '-p', 'test_*.py', '-v'], {
    cwd: fileURLToPath(new URL('.', import.meta.url)), encoding: 'utf8', timeout: 120_000,
    env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONDONTWRITEBYTECODE: '1' },
  });
  const output = `${result.stdout}${result.stderr}`;
  assert.equal(result.status, 0, output);
  assert.match(output, /Ran [1-9]\d* tests? in/);
  assert.doesNotMatch(output, /\bskipped\b|\bexpected failures\b|\bunexpected successes\b/i);
  assert.match(output, /\bOK\b/);
});
