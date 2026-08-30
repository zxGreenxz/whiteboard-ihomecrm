#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function collectHeaders(value) {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => Array.isArray(entry?.headers) ? entry.headers : []);
}

export function validateCspBuildAttestation(root) {
  const problems = [];
  const indexPath = join(root, 'index.html');
  const vercelPath = join(root, 'vercel.json');
  const index = existsSync(indexPath) ? readFileSync(indexPath, 'utf8') : '';
  const vercel = existsSync(vercelPath) ? readJson(vercelPath) : null;
  const vite = existsSync(join(root, 'vite.config.ts')) ? readFileSync(join(root, 'vite.config.ts'), 'utf8') : '';
  const metadata = existsSync(join(root, 'src', 'buildMetadata.ts'))
    ? readFileSync(join(root, 'src', 'buildMetadata.ts'), 'utf8')
    : '';
  const main = existsSync(join(root, 'src', 'main.tsx')) ? readFileSync(join(root, 'src', 'main.tsx'), 'utf8') : '';
  const e2eHelper = existsSync(join(root, '.e2e-fleet', 'specs', 'buildAttestation.ts'))
    ? readFileSync(join(root, '.e2e-fleet', 'specs', 'buildAttestation.ts'), 'utf8')
    : '';

  if (!index) problems.push('index.html is missing');
  if (/<script(?![^>]*\bsrc=)[^>]*>[\s\S]*?<\/script>/i.test(index)) {
    problems.push('index.html contains an inline executable script');
  }
  if (/<style(?:\s[^>]*)?>[\s\S]*?<\/style>/i.test(index)) {
    problems.push('index.html contains an inline style block');
  }
  if (/\bon(?:load|error|click|submit)\s*=\s*["']/i.test(index)) {
    problems.push('index.html contains an inline event handler');
  }
  for (const asset of ['/pwa-entry-watchdog.js', '/pwa-splash.css', '/pwa-font-loader.js']) {
    if (!index.includes(`"${asset}"`)) problems.push(`index.html must reference ${asset}`);
    if (!existsSync(join(root, 'public', asset.slice(1)))) problems.push(`missing public asset ${asset}`);
  }
  if (!/meta\s+name=["']build-sha["'][^>]*content=["'][^"']+/.test(index)) {
    problems.push('index.html must declare the build-sha meta tag');
  }
  if (!/%VITE_BUILD_SHA%/.test(index)) problems.push('build-sha meta tag must use the Vite build placeholder');
  if (!vite.includes('transformIndexHtml') || !vite.includes("process.env.VERCEL_GIT_COMMIT_SHA")) {
    problems.push('vite.config.ts must replace the build-sha placeholder using the Vercel commit SHA fallback');
  }
  if (!metadata.includes('shaHopLe') || !metadata.includes("meta[name=\"build-sha\"]")) {
    problems.push('src/buildMetadata.ts must validate and publish the build SHA');
  }
  if (main.indexOf('ganMetaBuildSha()') < 0 || main.indexOf('ganMetaBuildSha()') > main.indexOf('createRoot(')) {
    problems.push('src/main.tsx must publish build metadata before React mounts');
  }
  if (!e2eHelper.includes('EXPECTED_SOURCE_SHA') || !e2eHelper.includes('meta[name="build-sha"]')) {
    problems.push('Copilot E2E must compare EXPECTED_SOURCE_SHA with the build-sha meta tag');
  }

  const headers = collectHeaders(vercel?.headers);
  const csp = headers.find((header) => String(header?.key).toLowerCase() === 'content-security-policy');
  if (!csp?.value || typeof csp.value !== 'string') {
    problems.push('vercel.json must define a Content-Security-Policy header');
  } else {
    if (csp.value.includes("'unsafe-eval'")) problems.push("Content-Security-Policy must not contain 'unsafe-eval'");
    if (!/script-src\s[^;]*'self'/i.test(csp.value)) problems.push("Content-Security-Policy script-src must allow 'self'");
    for (const directive of ['connect-src', 'font-src', 'img-src', 'frame-src', 'worker-src']) {
      if (!new RegExp(`(?:^|;)\\s*${directive}\\s`, 'i').test(csp.value)) {
        problems.push(`Content-Security-Policy must define ${directive}`);
      }
    }
  }
  return problems;
}

function main() {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const problems = validateCspBuildAttestation(root);
  if (problems.length) {
    console.error(`CSP/build attestation gate: ${problems.length} problem(s)`);
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exitCode = 1;
    return;
  }
  console.log('CSP/build attestation gate: contract is intact.');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
