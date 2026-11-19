import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

test('meter worker Python fixtures run on the pinned runtime without zero tests or skips', () => {
  const runtime = JSON.parse(readFileSync(new URL('../../tooling/runtime-matrix.json', import.meta.url), 'utf8'));
  const version = spawnSync('python', ['--version'], { encoding: 'utf8' });
  assert.equal(version.status, 0, 'Python must be available; missing runtime is not a passing suite');
  assert.equal(version.stdout.trim(), `Python ${runtime.otherRuntimes.meterCapturePython}`);
  const result = spawnSync('python', ['-B', '-m', 'unittest', 'discover', '-s', '.', '-p', 'test_*.py', '-v'], {
    cwd: fileURLToPath(new URL('.', import.meta.url)), encoding: 'utf8', timeout: 60_000,
  });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 0, output);
  assert.match(output, /Ran [1-9]\d* tests? in/);
  assert.doesNotMatch(output, /\bskipped\b|\bexpected failures\b|\bunexpected successes\b/i);
  assert.match(output, /\bOK\b/);
});
