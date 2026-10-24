import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const worker = dirname(fileURLToPath(import.meta.url));
const docker = (args, options = {}) => execFileSync('docker', args, {
  encoding: 'utf8', timeout: 30_000, maxBuffer: 8 * 1024 * 1024, ...options,
});

test('pinned CPU image loads Paddle models and reads JPEG/H.264 synthetic meter evidence offline', { timeout: 1_380_000 }, () => {
  assert.equal(process.platform, 'linux', 'This runtime suite requires a Linux Docker engine; never skip it as passing.');
  assert.equal(docker(['info', '--format', '{{.OSType}}']).trim(), 'linux');
  docker(['compose', '--file', resolve(worker, 'compose.yaml'), 'config', '--quiet'], { env: {
    ...process.env, METER_CAPTURE_API_BASE_URL: 'https://fixture.invalid/functions/v1/meter-capture-worker',
    METER_CAPTURE_WORKER_TOKEN: 'synthetic-runtime-token-'.repeat(3),
    METER_CAPTURE_AI_BASE_URL: '', METER_CAPTURE_AI_KEY: '', METER_CAPTURE_AI_MODEL: 'fixture-model',
  } });
  const suffix = `${process.pid}-${Date.now()}`;
  const image = `meter-capture-smoke:${suffix}`;
  const container = `meter-capture-smoke-${suffix}`;
  let created = false;
  let built = false;
  try {
    docker(['build', '--platform', 'linux/amd64', '--tag', image, worker], { timeout: 900_000, stdio: 'inherit' });
    built = true;
    const imageId = docker(['image', 'inspect', image, '--format', '{{.Id}}']).trim();
    assert.match(imageId, /^sha256:[a-f0-9]{64}$/);
    docker([
      'create', '--name', container, '--platform', 'linux/amd64', '--init',
      '--network', 'none', '--read-only', '--user', '10001:10001',
      '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
      '--pids-limit', '96', '--memory', '4g', '--cpus', '2',
      '--tmpfs', '/tmp:rw,nosuid,nodev,noexec,size=1073741824,mode=1777',
      '--mount', `type=bind,src=${resolve(worker, 'runtime_smoke.py')},dst=/app/runtime_smoke.py,readonly`,
      '--env', 'HOME=/tmp', '--env', 'PYTHONDONTWRITEBYTECODE=1',
      '--entrypoint', 'python', imageId, '-B', '/app/runtime_smoke.py',
    ]);
    created = true;
    const output = docker(['start', '--attach', container], { timeout: 360_000 });
    process.stdout.write(output);
    const exitCode = Number(docker(['inspect', container, '--format', '{{.State.ExitCode}}']).trim());
    assert.equal(exitCode, 0, 'Real OCR/codec smoke process failed');
    const receipt = output.split('\n').map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    }).find((item) => item?.meter_runtime_smoke === 'pass');
    assert.ok(receipt, 'No successful runtime smoke receipt was emitted');
    assert.equal(receipt.realMeterAccuracyMeasured, false);
    assert.equal(receipt.photoValue, '12345.67');
    assert.equal(receipt.clipValue, '12345.67');
    assert.equal(new Set(receipt.evidenceTimestamps).size, 2);
  } finally {
    if (created) docker(['rm', '--force', '--volumes', container]);
    if (built) docker(['image', 'rm', image]);
  }
});
