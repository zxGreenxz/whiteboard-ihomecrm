import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { validateCspBuildAttestation } from '../check-csp-build-attestation.mjs';

test('repository keeps the CSP and build-attestation contract intact', () => {
  const problems = validateCspBuildAttestation(process.cwd());
  assert.deepEqual(problems, []);
});

test('checker rejects inline executable content and an unsafe CSP', () => {
  const root = mkdtempSync(join(tmpdir(), 'csp-build-attestation-'));
  writeFileSync(join(root, 'index.html'), '<script>alert(1)</script><style>body{}</style><link rel="preload" onload="bad()">');
  writeFileSync(
    join(root, 'vercel.json'),
    JSON.stringify({ headers: [{ source: '/(.*)', headers: [{ key: 'Content-Security-Policy', value: "script-src 'self' 'unsafe-eval'" }] }] }),
  );
  const problems = validateCspBuildAttestation(root);
  assert.ok(problems.some((problem) => /inline executable script/i.test(problem)));
  assert.ok(problems.some((problem) => /inline style/i.test(problem)));
  assert.ok(problems.some((problem) => /inline event handler/i.test(problem)));
  assert.ok(problems.some((problem) => /unsafe-eval/i.test(problem)));
});
