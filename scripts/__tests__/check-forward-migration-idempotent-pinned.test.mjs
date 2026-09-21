import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";

import { danhGiaMienTruPinned, docLoiSql, kiemMienTruPinned } from "../check-forward-migration-idempotent.mjs";
import { danhGiaRetirement, taoTruyVanRetirement, loaiRetiredKhoiSo, keHoachDoMigration } from "../check-forward-migration-idempotent.mjs";

const file = "20260909172332_reservation_deposit_settlement_v1.sql";
const digest = "32008e7d10b730ceef4840fb307288e033be5d868842597ed30f27136e6da2e6";
const entry = {
  sha256: digest,
  expectedSqlState: "42P07",
  expectedMessage: 'relation "reservation_deposit_settlements" already exists',
  appliedEvidencePath: "docs/generated/schema-change-evidence/evidence.json",
};
const evidence = {
  file: `supabase/migrations/${file}`,
  sha256: digest,
  appliedAt: "2026-09-10T01:02:03.000Z",
  projectRef: "tryymsxyyckgbrmmvozx",
  authorization: { loai: "bien-nhan-backup", chiTiet: "16d825" },
};
const failureText = JSON.stringify({ code: "42P07", message: entry.expectedMessage });
const actualProjectRef = evidence.projectRef;
const read = () => JSON.stringify(evidence);

describe("ngoại lệ idempotency pinned", () => {
  it("chỉ EXEMPT khi digest, lỗi SQL và evidence đều khớp chính xác", () => {
    expect(kiemMienTruPinned({ entry, file, digest, failureText, actualProjectRef, root: "C:/repo", read })).toMatchObject({ ok: true });
  });

  it("không đổi ngoại lệ pinned thành PASS khi migration bất ngờ chạy lại được", () => {
    expect(danhGiaMienTruPinned({ entry, file, digest, failureText: "", queryOk: true, actualProjectRef, root: "C:/repo", read })).toMatchObject({
      ok: false, vi: expect.stringMatching(/không được coi là idempotent PASS/),
    });
  });

  it.each([
    ["digest", { digest: "sai" }, /sha256/],
    ["SQLSTATE", { failureText: JSON.stringify({ code: "42703", message: entry.expectedMessage }) }, /lỗi thực tế/],
    ["message", { failureText: JSON.stringify({ code: "42P07", message: "khác" }) }, /lỗi thực tế/],
  ])("từ chối khi %s lệch pin", (_name, changed, expected) => {
    expect(kiemMienTruPinned({ entry, file, digest, failureText, actualProjectRef, root: "C:/repo", read, ...changed })).toMatchObject({ ok: false, vi: expect.stringMatching(expected) });
  });

  it("từ chối path traversal", () => {
    expect(kiemMienTruPinned({ entry: { ...entry, appliedEvidencePath: "../evidence.json" }, file, digest, failureText, actualProjectRef, root: "C:/repo", read })).toMatchObject({ ok: false, vi: expect.stringMatching(/không an toàn/) });
  });

  it("từ chối evidence thiếu giấy phép apply thật", () => {
    const readBad = () => JSON.stringify({ ...evidence, authorization: { loai: "tu-khai" } });
    expect(kiemMienTruPinned({ entry, file, digest, failureText, actualProjectRef, root: "C:/repo", read: readBad })).toMatchObject({ ok: false, vi: expect.stringMatching(/dấu mốc apply thật/) });
  });

  it("từ chối evidence của project khác", () => {
    expect(kiemMienTruPinned({ entry, file, digest, failureText, actualProjectRef: "project-khac", root: "C:/repo", read })).toMatchObject({ ok: false, vi: expect.stringMatching(/dấu mốc apply thật/) });
  });

  it("ghim migration thay thế và biên nhận apply khi ngoại lệ do trạng thái mới hơn", () => {
    const successorFile = "20260921014754_sale_bonus_resolved_source_consistency.sql";
    const successorSql = "successor sql";
    const successorDigest = createHash("sha256").update(successorSql).digest("hex");
    const successorEvidencePath = "docs/generated/schema-change-evidence/successor.json";
    const successorEvidence = {
      ...evidence,
      file: `supabase/migrations/${successorFile}`,
      sha256: successorDigest,
      appliedAt: "2026-09-21T03:59:35.000Z",
    };
    const supersededEntry = {
      ...entry,
      supersededBy: {
        file: successorFile,
        sha256: successorDigest,
        appliedEvidencePath: successorEvidencePath,
      },
    };
    const readSupersession = (path) => path.endsWith("successor.json")
      ? JSON.stringify(successorEvidence)
      : path.endsWith(successorFile)
        ? successorSql
        : JSON.stringify(evidence);

    expect(kiemMienTruPinned({
      entry: supersededEntry,
      file,
      digest,
      failureText,
      actualProjectRef,
      root: "C:/repo",
      read: readSupersession,
    })).toMatchObject({ ok: true });
    expect(kiemMienTruPinned({
      entry: { ...supersededEntry, supersededBy: { ...supersededEntry.supersededBy, sha256: "sai" } },
      file,
      digest,
      failureText,
      actualProjectRef,
      root: "C:/repo",
      read: readSupersession,
    })).toMatchObject({ ok: false, vi: expect.stringMatching(/sha256 migration thay thế/) });
  });

  it("đọc đúng lỗi JSON của Management API", () => {
    expect(docLoiSql(failureText)).toEqual({ sqlState: "42P07", message: entry.expectedMessage });
  });

  it("đọc đúng wrapper lỗi một dòng thực tế và không nuốt DETAIL", () => {
    const actual = JSON.stringify({ message: `Failed to run sql query: ERROR:  42P07: ${entry.expectedMessage}\n` });
    expect(docLoiSql(actual)).toEqual({ sqlState: "42P07", message: entry.expectedMessage });
    const withContext = JSON.stringify({ message: `Failed to run sql query: ERROR:  42P07: ${entry.expectedMessage}\nCONTEXT:  PL/pgSQL function inline_code_block line 5 at RAISE\n` });
    expect(docLoiSql(withContext)).toEqual({ sqlState: "42P07", message: entry.expectedMessage });
    const withDetail = JSON.stringify({ message: `Failed to run sql query: ERROR:  42P07: ${entry.expectedMessage}\nDETAIL: extra\n` });
    expect(docLoiSql(withDetail).sqlState).toBe("");
  });
});

const originalFile = '20260920192452_old.sql';
const compensationFile = '20260921085952_restore.sql';
const sqlDigest = (text) => createHash('sha256').update(text).digest('hex');
function retirementFixture() {
  const original = { file: originalFile, sha256: sqlDigest('old sql'), appliedEvidencePath: 'docs/generated/schema-change-evidence/old.json' };
  const compensation = { file: compensationFile, sha256: sqlDigest('restore sql'), appliedEvidencePath: 'docs/generated/schema-change-evidence/restore.json' };
  const before = { md5: 'a'.repeat(32), owner: 'postgres', acl: '{postgres=X/postgres}' };
  const after = { ...before, md5: 'b'.repeat(32) };
  const removed = { signature: 'public.removed_fn()', ...before };
  const removedTrigger = { relation: 'public.vouchers', name: 'removed_trigger', md5: 'c'.repeat(32), enabled: 'O' };
  const retainedTrigger = { relation: 'public.vouchers', name: 'retained_trigger', md5: 'd'.repeat(32), enabled: 'O' };
  const group = {
    id: 'settlement-restore', compensation, migrations: [original],
    expectedCounts: { migrations: 1, functions: 1, removedFunctions: 1, removedTriggers: 1, retainedTriggers: 1 },
    witness: { functions: [{ signature: 'public.old_fn()', before, after }], removedFunctions: [removed], removedTriggers: [removedTrigger], retainedTriggers: [retainedTrigger], role: 'reader_role' },
  };
  const receipt = (migration, date) => ({ ...evidence, file: `supabase/migrations/${migration.file}`, sha256: migration.sha256, appliedAt: date });
  const storage = new Map([
    [`supabase/migrations/${original.file}`, 'old sql'],
    [`supabase/migrations/${compensation.file}`, 'restore sql'],
    [original.appliedEvidencePath, JSON.stringify(receipt(original, '2026-09-20T01:00:00Z'))],
    [compensation.appliedEvidencePath, JSON.stringify(receipt(compensation, '2026-09-21T01:00:00Z'))],
  ]);
  const read = (path) => {
    const key = String(path).replaceAll('\\', '/').replace(/^.*?fixture\//, '');
    if (!storage.has(key)) throw Object.assign(new Error('missing fixture'), { code: 'ENOENT' });
    return storage.get(key);
  };
  const restoredCatalog = {
    functions: [{ signature: 'public.old_fn()', ...after }, { signature: removed.signature, md5: null, owner: null, acl: null }],
    triggers: [{ ...removedTrigger, md5: null, enabled: null }, { ...retainedTrigger }], rolePresent: false,
  };
  const activeCatalog = {
    functions: [{ signature: 'public.old_fn()', ...before }, removed], triggers: [removedTrigger, retainedTrigger], rolePresent: true,
  };
  return { group, storage, read, restoredCatalog, activeCatalog };
}
async function evaluateRetirement(f, catalog = f.restoredCatalog) {
  return danhGiaRetirement({ group: f.group, root: '/fixture', read: f.read, actualProjectRef, query: async () => catalog });
}

describe('retirement theo compensation receipt và catalog sống', () => {
  it('RETIRE chỉ khi lịch sử, biên nhận mới và catalog khớp; không kết luận idempotent', async () => {
    const f = retirementFixture();
    expect(await evaluateRetirement(f)).toMatchObject({ ok: true, state: 'retired', files: [originalFile] });
  });
  it('trước apply: thiếu receipt mới nhưng catalog đầy đủ bản cũ thì giữ active', async () => {
    const f = retirementFixture(); f.storage.delete(f.group.compensation.appliedEvidencePath);
    expect(await evaluateRetirement(f, f.activeCatalog)).toMatchObject({ ok: true, state: 'active', files: [] });
  });
  it('catalog đã phục hồi mà thiếu receipt phải đỏ, không replay feature để sửa', async () => {
    const f = retirementFixture(); f.storage.delete(f.group.compensation.appliedEvidencePath);
    expect(await evaluateRetirement(f)).toMatchObject({ ok: false });
  });
  it('receipt mới có nhưng catalog còn active phải đỏ', async () => {
    const f = retirementFixture();
    expect(await evaluateRetirement(f, f.activeCatalog)).toMatchObject({ ok: false });
  });
  it.each(['functions', 'removedFunctions', 'removedTriggers', 'retainedTriggers'])('witness %s rỗng không thành xanh rỗng', async (field) => {
    const f = retirementFixture(); f.group.witness[field] = [];
    expect(await evaluateRetirement(f)).toMatchObject({ ok: false });
  });
  it('danh sách migration rỗng phải đỏ', async () => {
    const f = retirementFixture(); f.group.migrations = [];
    expect(await evaluateRetirement(f)).toMatchObject({ ok: false });
  });
  it.each(['old sql', 'restore sql'])('digest của %s đổi phải đỏ', async (text) => {
    const f = retirementFixture(); for (const [key, value] of f.storage) if (value === text) f.storage.set(key, value + '-- altered');
    expect(await evaluateRetirement(f)).toMatchObject({ ok: false });
  });
  it.each(['old.json', 'restore.json'])('receipt %s thiếu/giả không được bỏ qua', async (name) => {
    const f = retirementFixture(); const path = `docs/generated/schema-change-evidence/${name}`;
    const forged = JSON.parse(f.storage.get(path)); forged.authorization = { loai: 'tu-khai' };
    f.storage.set(path, JSON.stringify(forged));
    expect(await evaluateRetirement(f)).toMatchObject({ ok: false });
  });
  it('receipt project sai hoặc áp trước migration gốc phải đỏ', async () => {
    for (const mutation of [{ projectRef: 'another-project' }, { appliedAt: '2020-01-01T00:00:00Z' }]) {
      const f = retirementFixture(); const path = f.group.compensation.appliedEvidencePath;
      f.storage.set(path, JSON.stringify({ ...JSON.parse(f.storage.get(path)), ...mutation }));
      expect(await evaluateRetirement(f)).toMatchObject({ ok: false });
    }
  });
  it('thiếu receipt gốc và response catalog không đọc được đều không được fallback replay', async () => {
    const f = retirementFixture(); f.storage.delete(f.group.migrations[0].appliedEvidencePath);
    expect(await evaluateRetirement(f)).toMatchObject({ ok: false });
    const g = retirementFixture();
    await expect(danhGiaRetirement({ group: g.group, root: '/fixture', read: g.read, actualProjectRef, query: async () => { throw Error('HTTP 401'); } })).rejects.toThrow('HTTP 401');
  });
  it.each(['hash', 'acl', 'owner', 'helper', 'trigger', 'retained', 'role', 'empty'])('catalog drift %s phải đỏ', async (kind) => {
    const f = retirementFixture(); const c = f.restoredCatalog;
    if (kind === 'hash') c.functions[0].md5 = 'a'.repeat(32);
    if (kind === 'acl') c.functions[0].acl += ',anon=X/postgres';
    if (kind === 'owner') c.functions[0].owner = 'other';
    if (kind === 'helper') c.functions[1] = f.activeCatalog.functions[1];
    if (kind === 'trigger') c.triggers[0] = f.activeCatalog.triggers[0];
    if (kind === 'retained') c.triggers[1].enabled = 'D';
    if (kind === 'role') c.rolePresent = true;
    if (kind === 'empty') c.functions = [];
    expect(await evaluateRetirement(f, c)).toMatchObject({ ok: false });
  });
  it('catalog partial trước apply cũng phải đỏ', async () => {
    const f = retirementFixture(); f.storage.delete(f.group.compensation.appliedEvidencePath);
    f.activeCatalog.functions[0] = f.restoredCatalog.functions[0];
    expect(await evaluateRetirement(f, f.activeCatalog)).toMatchObject({ ok: false });
  });
  it('receipt path traversal và duplicate signature không được chấp nhận', async () => {
    const f = retirementFixture(); f.group.compensation.appliedEvidencePath = '../receipt.json';
    expect(await evaluateRetirement(f)).toMatchObject({ ok: false });
    const g = retirementFixture(); g.group.witness.removedFunctions[0].signature = 'public.old_fn()';
    expect(await evaluateRetirement(g)).toMatchObject({ ok: false });
  });
  it('catalog query chỉ đọc định nghĩa thật; comment không phải witness', () => {
    const sql = taoTruyVanRetirement(retirementFixture().group);
    expect(sql).toContain('pg_get_functiondef');
    expect(sql).toContain('pg_get_triggerdef');
    expect(sql).not.toMatch(/\b(?:CREATE|ALTER|DROP|UPDATE|INSERT|DELETE)\s/i);
    expect(sql).not.toContain('obj_description');
  });
  it('không ghi hoặc giữ PASS cache cho retired migration, compensation vẫn giữ', () => {
    expect(loaiRetiredKhoiSo({ [originalFile]: { ketQua: 'chay-lai-duoc' }, [compensationFile]: { ketQua: 'chay-lai-duoc' } }, new Set([originalFile])))
      .toEqual({ [compensationFile]: { ketQua: 'chay-lai-duoc' } });
  });
  it.each([true, false])('retired không replay kể cả explicit=%s; compensation mới vẫn phải đo', (explicit) => {
    const f = retirementFixture();
    const plan = keHoachDoMigration({ files: [originalFile, compensationFile], digest: new Map([[originalFile, f.group.migrations[0].sha256], [compensationFile, f.group.compensation.sha256]]), so: {}, mienTru: new Map([[originalFile, entry]]), retired: new Set([originalFile]), explicit });
    expect(plan.dsChay).toEqual([compensationFile]);
    expect(plan.daChung).toEqual([]);
    expect([...plan.pinned]).toEqual([]);
  });
  it('retired cache không thành đã chứng nhận; compensation cached vẫn tuân theo explicit', () => {
    const f = retirementFixture(); const digest = new Map([[originalFile, f.group.migrations[0].sha256], [compensationFile, f.group.compensation.sha256]]);
    const args = { files: [originalFile, compensationFile], digest, so: Object.fromEntries([...digest].map(([file, sha256]) => [file, { sha256, ketQua: 'chay-lai-duoc' }])), mienTru: new Map([[originalFile, entry]]), retired: new Set([originalFile]) };
    expect(keHoachDoMigration(args)).toMatchObject({ dsChay: [], daChung: [compensationFile] });
    expect(keHoachDoMigration({ ...args, explicit: true })).toMatchObject({ dsChay: [compensationFile], daChung: [] });
  });
});
