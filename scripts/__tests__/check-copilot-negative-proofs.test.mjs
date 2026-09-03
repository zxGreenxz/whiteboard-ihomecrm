import assert from 'node:assert/strict';
import test from 'node:test';

import { CAC_PROOF_BAT_BUOC, danhGiaBaoCao, timBaoCaoMoiNhat } from '../check-copilot-negative-proofs.mjs';

const SHA = '939fb75d59e5a1e6414b799e5ac9911f34e44f10';

/** Báo cáo mẫu: đủ 7 proof bắt buộc, mọi ca pass, verdict pass, ranAt hôm nay. */
function baoCaoDatChuan(ranAt = new Date().toISOString()) {
  return {
    schemaVersion: 1,
    buildSha: SHA,
    ranAt,
    cases: CAC_PROOF_BAT_BUOC.map((name) => ({ name, pass: true, detail: 'ok' })),
    verdict: 'pass',
  };
}

test('bao cao dat chuan -> khong loi', () => {
  const { loi } = danhGiaBaoCao(baoCaoDatChuan());
  assert.deepEqual(loi, []);
});

test('mot ca fail -> loi neu ro ca nao', () => {
  const baoCao = baoCaoDatChuan();
  baoCao.cases[2] = { name: baoCao.cases[2].name, pass: false, detail: 'SAI: cai gi do' };
  baoCao.verdict = 'blocked';
  const { loi } = danhGiaBaoCao(baoCao);
  assert.ok(loi.some((l) => l.includes(baoCao.cases[2].name) && l.includes('SAI: cai gi do')));
});

test('thieu mot proof bat buoc -> loi liet ke dung ten thieu', () => {
  const baoCao = baoCaoDatChuan();
  baoCao.cases = baoCao.cases.filter((c) => c.name !== 'plan_cancel');
  const { loi } = danhGiaBaoCao(baoCao);
  assert.ok(loi.some((l) => l.includes('plan_cancel')));
});

test('buildSha khong phai 40 hex -> loi', () => {
  const baoCao = { ...baoCaoDatChuan(), buildSha: 'abc' };
  const { loi } = danhGiaBaoCao(baoCao);
  assert.ok(loi.some((l) => l.includes('buildSha')));
});

test('bao cao qua han ngay -> loi neu ro so ngay', () => {
  const cu = new Date(Date.now() - 20 * 86_400_000).toISOString();
  const { loi } = danhGiaBaoCao(baoCaoDatChuan(cu), 14);
  assert.ok(loi.some((l) => l.includes('vượt hạn 14 ngày')));
});

test('bao cao dung han (13 ngay, han 14) -> khong loi ve tuoi', () => {
  const gan = new Date(Date.now() - 13 * 86_400_000).toISOString();
  const { loi } = danhGiaBaoCao(baoCaoDatChuan(gan), 14);
  assert.deepEqual(loi, []);
});

test('verdict khac pass -> loi', () => {
  const baoCao = { ...baoCaoDatChuan(), verdict: 'blocked' };
  const { loi } = danhGiaBaoCao(baoCao);
  assert.ok(loi.some((l) => l.startsWith('verdict=')));
});

test('ranAt o tuong lai -> loi', () => {
  const tuongLai = new Date(Date.now() + 3_600_000).toISOString();
  const { loi } = danhGiaBaoCao(baoCaoDatChuan(tuongLai));
  assert.ok(loi.some((l) => l.includes('TƯƠNG LAI')));
});

test('timBaoCaoMoiNhat: chon file co ranAt moi nhat, bo qua ten khong khop 40 hex', () => {
  const files = {
    [`${SHA}.json`]: JSON.stringify(baoCaoDatChuan('2026-09-01T00:00:00.000Z')),
    [`${'a'.repeat(40)}.json`]: JSON.stringify(baoCaoDatChuan('2026-09-03T00:00:00.000Z')),
    'khong-phai-sha.json': '{}',
    'README.md': 'khong phai json',
  };
  const ket = timBaoCaoMoiNhat(
    'gia-lap',
    (p) => {
      const ten = p.split(/[\\/]/).pop();
      return files[ten];
    },
    () => Object.keys(files),
  );
  assert.equal(ket.sha, 'a'.repeat(40));
});

test('timBaoCaoMoiNhat: thu muc rong -> loi ro rang', () => {
  const ket = timBaoCaoMoiNhat('gia-lap', () => '{}', () => []);
  assert.match(ket.loi, /không có file báo cáo nào/);
});
