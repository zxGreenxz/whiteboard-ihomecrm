#!/usr/bin/env node
// One local TEST lane. Never promotes or changes production.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { runHarness } from '../test-voucher-detail-read-authz.mjs';
import { credential, ghiLog, ketNoi, kiemCongCu, psqlJson, repoRoot } from './lib.mjs';
import { assertTestLease, withTestLock } from './lock.mjs';
import { assertSuite, catalogDigest, checkSnapshot } from './receipt.mjs';
import { syncTest } from './sync.mjs';
import { sqlVanTay } from './van-tay.mjs';

export function sourceIdentity() {
  const git = args => execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8', maxBuffer: 30 * 1024 * 1024 });
  const sha = git(['rev-parse', 'HEAD']).trim();
  const changes = git(['status', '--porcelain', '--untracked-files=all']);
  const hash = createHash('sha256').update(sha).update(git(['diff', 'HEAD', '--binary']));
  for (const file of git(['ls-files', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean).sort()) {
    hash.update(file).update(readFileSync(join(repoRoot, file)));
  }
  return { sha, dirty: Boolean(changes.trim()), digest: hash.digest('hex') };
}

export async function checkTest(argv = []) {
  if (argv.includes('--help')) {
    console.log('npm run test-env:check -- [--sync] [--max-age-hours 24]\nQuick requires a recent successful sync receipt. --sync replaces TEST before running data + Chrome.');
    return;
  }
  let full = false, maxAgeHours = 24;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--sync') full = true;
    else if (argv[i] === '--max-age-hours') maxAgeHours = Number(argv[++i]);
    else throw new Error(`Tham số không hợp lệ: ${argv[i]}`);
  }
  if (!Number.isFinite(maxAgeHours) || maxAgeHours <= 0) throw new Error('--max-age-hours phải là số dương.');
  kiemCongCu();
  const cred = credential();
  if (!cred.testPublishableKey) throw new Error('Thiếu TEST_SUPABASE_PUBLISHABLE_KEY; không dùng secret key làm phiên người dùng.');
  const context = { cred, ...await ketNoi(cred), url: `https://${cred.testRef}.supabase.co` };
  const source = sourceIdentity();
  const reportDir = join(homedir(), 'ihomecrm-backups', 'test-env-checks', new Date().toISOString().replace(/[:.]/g, '-'));
  mkdirSync(reportDir, { recursive: true });
  const report = { startedAt: new Date().toISOString(), mode: full ? 'sync-and-check' : 'quick', source, targetRef: cred.testRef, status: 'RUNNING', steps: [] };
  const save = () => writeFileSync(join(reportDir, 'result.json'), JSON.stringify(report, null, 2));
  const sanitize = error => {
    let message = String(error?.message ?? error);
    for (const [key, value] of Object.entries(cred)) {
      if (typeof value === 'string' && value.length > 8 && !/Ref|PoolerHost/.test(key)) message = message.replaceAll(value, '[REDACTED]');
    }
    return message.replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[JWT]').slice(0, 2000);
  };
  const step = async (name, fn) => {
    ghiLog(name, '…'); const start = Date.now();
    try {
      const result = await fn(); report.steps.push({ name, status: 'PASS', seconds: (Date.now() - start) / 1000, result }); save(); return result;
    } catch (error) {
      report.steps.push({ name, status: 'FAIL', seconds: (Date.now() - start) / 1000, error: sanitize(error) }); save(); throw error;
    }
  };
  save();
  try {
    await withTestLock(context, async lease => {
      if (full) await step('sync', async () => {
        const code = await syncTest({ context, lease });
        if (code !== 0) throw new Error('Đồng bộ TEST lệch snapshot; không chạy tiếp.');
        return { exitCode: code };
      });
      report.snapshot = await step('snapshot', async () => {
        await assertTestLease(lease, context.test);
        const [exists] = psqlJson(context.test, "select to_regclass('test_env.lich_su') is not null as ready");
        const latest = exists.ready ? psqlJson(context.test, 'select ket_qua, snapshot_prod, chi_tiet from test_env.lich_su order by id desc limit 1')[0] : null;
        return checkSnapshot(latest, { digest: catalogDigest(psqlJson(context.test, sqlVanTay())), maxAgeHours });
      });
      await step('data-jwt', async () => assertSuite(await runHarness({ context, lease, reportPath: join(reportDir, 'jwt-report.md') }), 33));
      await step('chrome', async () => {
        await assertTestLease(lease, context.test);
        const { runChrome } = await import('./chrome.mjs');
        const result = await runChrome({ ...context, reportDir, buildSha: source.sha });
        return assertSuite(result, 12);
      });
      await step('source-unchanged', async () => {
        const after = sourceIdentity();
        if (after.digest !== source.digest) throw new Error('Mã nguồn đổi trong khi kiểm; biên nhận không đại diện một bản mã cố định.');
        return after;
      });
    });
    report.status = 'PASS';
  } catch (error) {
    report.status = 'FAIL'; report.error = sanitize(error); throw new Error(report.error);
  } finally {
    report.finishedAt = new Date().toISOString();
    report.seconds = (Date.parse(report.finishedAt) - Date.parse(report.startedAt)) / 1000;
    save(); ghiLog('report', `${report.status} · ${join(reportDir, 'result.json')}`);
  }
  return report;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  checkTest(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
}
