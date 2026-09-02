import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { LY_DO_THA_SLA, danhGiaBaoCao } from '../check-golden-eval-report.mjs';

const SO_CA = 36;

/** Báo cáo mẫu: đủ số ca, verdict pass, không lỗi gì. */
function baoCaoDatChuan(soCa = SO_CA) {
  return {
    schemaVersion: 1,
    verdict: 'pass',
    aggregate: { total: soCa, counts: { pass: soCa, partial: 0, fail: 0, blocked: 0 } },
    sla: { ready: true },
  };
}

/** Báo cáo mẫu: verdict blocked chỉ vì SLA chưa được chủ ký (nhánh tha). */
function baoCaoThaSla(soCa = SO_CA) {
  return {
    schemaVersion: 1,
    verdict: 'blocked',
    aggregate: { total: soCa, counts: { pass: soCa, partial: 0, fail: 0, blocked: 0 } },
    sla: { ready: false, reason: LY_DO_THA_SLA },
  };
}

test('du so ca, verdict pass, khong loi gi -> khong loi', () => {
  const { loi, pass, total, reason } = danhGiaBaoCao(baoCaoDatChuan(), SO_CA);
  assert.deepEqual(loi, []);
  assert.equal(pass, SO_CA);
  assert.equal(total, SO_CA);
  assert.equal(reason, undefined);
});

test('thieu 1 ca so voi file eval -> loi khong du ca', () => {
  const { loi } = danhGiaBaoCao(baoCaoDatChuan(SO_CA - 1), SO_CA);
  assert.equal(loi.length, 1);
  assert.match(loi[0], /khong du 36 ca: 35/);
});

test('verdict blocked voi ly do SLA dung chuoi -> duoc tha, khong loi', () => {
  const { loi, reason } = danhGiaBaoCao(baoCaoThaSla(), SO_CA);
  assert.deepEqual(loi, []);
  assert.equal(reason, LY_DO_THA_SLA);
});

test('verdict blocked voi ly do khac -> loi, khong duoc tha', () => {
  const baoCao = { ...baoCaoThaSla(), sla: { ready: false, reason: 'model timeout' } };
  const { loi } = danhGiaBaoCao(baoCao, SO_CA);
  assert.equal(loi.length, 1);
  assert.match(loi[0], /verdict=blocked \(model timeout\)/);
});

test('dot bien: sua sai mot ky tu trong chuoi tha SLA -> phai do', () => {
  const chuoiSai = LY_DO_THA_SLA.replace('pending', 'PENDING');
  const baoCao = { ...baoCaoThaSla(), sla: { ready: false, reason: chuoiSai } };
  const { loi } = danhGiaBaoCao(baoCao, SO_CA);
  assert.equal(loi.length, 1, 'chuoi tha bi doi mot chu thi khong con duoc tha nua');
});

test('fail > 0 -> loi du verdict la gi', () => {
  const baoCao = {
    ...baoCaoDatChuan(),
    verdict: 'blocked',
    aggregate: { total: SO_CA, counts: { pass: SO_CA - 1, partial: 0, fail: 1, blocked: 0 } },
    sla: { ready: false, reason: LY_DO_THA_SLA },
  };
  const { loi } = danhGiaBaoCao(baoCao, SO_CA);
  assert.ok(loi.some((l) => l === 'fail=1'), JSON.stringify(loi));
});

test('partial > 0 -> loi', () => {
  const baoCao = {
    ...baoCaoDatChuan(),
    aggregate: { total: SO_CA, counts: { pass: SO_CA - 1, partial: 1, fail: 0, blocked: 0 } },
  };
  const { loi } = danhGiaBaoCao(baoCao, SO_CA);
  assert.ok(loi.some((l) => l === 'partial=1'), JSON.stringify(loi));
});

test('blocked count > 0 -> loi ngay ca khi verdict pass', () => {
  const baoCao = {
    ...baoCaoDatChuan(),
    aggregate: { total: SO_CA, counts: { pass: SO_CA - 1, partial: 0, fail: 0, blocked: 1 } },
  };
  const { loi } = danhGiaBaoCao(baoCao, SO_CA);
  assert.ok(loi.some((l) => l === 'blocked=1'), JSON.stringify(loi));
});

// ---- Kiểm CLI thật: exit code, fail-closed khi thiếu/hỏng file ----

const SCRIPT = fileURLToPath(new URL('../check-golden-eval-report.mjs', import.meta.url));

function chayCli(args) {
  try {
    const stdout = execFileSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', stdio: 'pipe' });
    return { ma: 0, stdout, stderr: '' };
  } catch (e) {
    return { ma: e.status ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

let thuMuc;

test('cli: setup thu muc tam', async () => {
  thuMuc = await mkdtemp(join(tmpdir(), 'golden-eval-report-'));
});

test('cli: bao cao hop le -> exit 0, in dong tom tat', async () => {
  const evalPath = join(thuMuc, 'eval.json');
  const baoCaoPath = join(thuMuc, 'bao-cao.json');
  await writeFile(evalPath, JSON.stringify({ cases: Array.from({ length: 3 }, (_, i) => ({ id: `C0${i + 1}` })) }));
  await writeFile(baoCaoPath, JSON.stringify(baoCaoDatChuan(3)));

  const { ma, stdout } = chayCli([baoCaoPath, '--eval', evalPath]);
  assert.equal(ma, 0);
  assert.match(stdout, /Copilot golden eval \(lane mock\): 3\/3 pass; SLA: undefined\./);
});

test('cli: thieu file bao cao -> exit 2 (fail-closed)', async () => {
  const evalPath = join(thuMuc, 'eval.json');
  const { ma, stderr } = chayCli([join(thuMuc, 'khong-ton-tai.json'), '--eval', evalPath]);
  assert.equal(ma, 2);
  assert.match(stderr, /khong doc\/parse duoc bao cao/);
});

test('cli: thieu file eval -> exit 2 (fail-closed)', async () => {
  const baoCaoPath = join(thuMuc, 'bao-cao.json');
  const { ma, stderr } = chayCli([baoCaoPath, '--eval', join(thuMuc, 'eval-khong-ton-tai.json')]);
  assert.equal(ma, 2);
  assert.match(stderr, /khong doc\/parse duoc file eval/);
});

test('cli: bao cao thieu ca -> exit 1', async () => {
  const evalPath = join(thuMuc, 'eval.json');
  const baoCaoPath = join(thuMuc, 'bao-cao-thieu.json');
  await writeFile(baoCaoPath, JSON.stringify(baoCaoDatChuan(2)));
  const { ma, stderr } = chayCli([baoCaoPath, '--eval', evalPath]);
  assert.equal(ma, 1);
  assert.match(stderr, /khong du 3 ca: 2/);
});

test('cli: don dep thu muc tam', async () => {
  await rm(thuMuc, { recursive: true, force: true });
});
