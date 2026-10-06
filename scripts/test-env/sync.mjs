#!/usr/bin/env node
// Đồng bộ MÔI TRƯỜNG TEST (project Supabase `ihomecrm-test`) = bản sao production.
//
//   npm run test-env:sync                 # đồng bộ đầy đủ
//   npm run test-env:sync -- --giu-dump   # giữ file dump sau khi xong (mặc định xoá)
//
// Luồng: xuất production trong MỘT snapshot → dừng cron TEST → xoá sạch schema ứng
// dụng TEST → nạp auth → bucket + dòng thông tin file (không chép byte ảnh) →
// pg_restore → tái lập phần cắm vào nền tảng → KIỂM vân tay + băm từng bảng khớp
// production tuyệt đối → hậu kỳ (mật khẩu TEST, push, cron) → ANALYZE → ghi lịch sử.
//
// Production CHỈ bị đọc. Mọi lệnh ghi đi qua batBuocDichTest() trước.
// Bản dump chứa dữ liệu cá nhân thật: ghi NGOÀI repo và xoá khi xong.

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { assertTestLease, withTestLock } from "./lock.mjs";
import { catalogDigest } from "./receipt.mjs";
import { kiemOwnersSnapshot, ownersDigest as digestOwners, sqlOwners } from "./owners.mjs";

import { cauHinhProjectTest } from "./cau-hinh.mjs";
import { capNhatThongKe, choApiSanSang, dungCronTest, datMatKhauTest, ghiLichSu, thayRefTrongHam, xoaPush } from "./hau-ky.mjs";
import { chuanBi, dungCron, khoiPhucApp, taiLapNenTang, xoaSach, xoaVaNapAuth } from "./khoi-phuc.mjs";
import { PROD_REF, credential, ghiLog, ketNoi, khiThoat, kiemCongCu, psqlJson } from "./lib.mjs";
import { dungBucket, guongDongObject } from "./tep.mjs";
import { soBam, soVanTay, sqlBamLo, sqlDanhSachBang, sqlVanTay } from "./van-tay.mjs";
import { xuatProduction } from "./xuat.mjs";

export async function syncTest({ argv = [], context, lease } = {}) {
  const batDau = new Date().toISOString();
  const giuDump = argv.includes("--giu-dump");
  kiemCongCu();
  const cred = context?.cred ?? credential();
  const { prod, test } = context ?? await ketNoi(cred);
  if (!lease) return withTestLock({ cred, test }, held => syncTest({ argv, context: { cred, prod, test }, lease: held }));
  await assertTestLease(lease, test);
  const testUrl = `https://${cred.testRef}.supabase.co`;
  ghiLog("bat-dau", `production ${PROD_REF} → TEST ${cred.testRef}`);

  const thuMuc = join(process.env.TEST_ENV_WORKDIR || join(homedir(), "ihomecrm-backups", "test-env"), batDau.replace(/[:.]/g, "-"));
  mkdirSync(thuMuc, { recursive: true });
  // Bản dump chứa dữ liệu cá nhân + hash mật khẩu thật: dọn trong finally và
  // đăng ký thêm exit cleanup; ngắt mềm vẫn giữ thời gian cho finally hoàn tất.
  const xoaDump = () => {
    if (giuDump) return;
    rmSync(join(thuMuc, "app.dump"), { force: true });
    rmSync(join(thuMuc, "auth.dump"), { force: true });
  };
  khiThoat(xoaDump);
  const moc = {};
  const buoc = async (ten, fn) => {
    const t0 = Date.now();
    ghiLog(ten, "…");
    await assertTestLease(lease, test);
    const r = await fn();
    moc[ten] = Math.round((Date.now() - t0) / 1000);
    return r;
  };

  try {
    ghiLichSu(test, { batDau, snapshotLuc: batDau, ketQua: "RUNNING", chiTiet: {} });
    const x = await buoc("xuat", () => xuatProduction({ prod, thuMuc }));
    const snapshotLuc = x.snapshotLuc;

    await buoc("dung-cron", () => dungCron(test));
    await buoc("xoa-sach", () => xoaSach(test));
    await buoc("auth", () => {
      xoaVaNapAuth(test, x.fileAuth);
      const [dem] = psqlJson(test, "select count(*) as n from auth.users");
      if (Number(dem.n) !== x.meta.user.length) {
        throw new Error(`auth.users TEST có ${dem.n} dòng, production ${x.meta.user.length} — dừng.`);
      }
      // NGAY sau khi nạp: hash mật khẩu thật không được sống qua bất kỳ bước nào khác.
      datMatKhauTest({ test, seed: cred.passwordSeed, users: x.meta.user });
    });
    await buoc("storage", async () => {
      await dungBucket(testUrl, cred.testSecretKey, x.meta.bucket);
      guongDongObject(test, x.meta.object);
    });
    await buoc("chuan-bi", () => chuanBi(test, x.meta));
    const kp = await buoc("pg-restore", () => khoiPhucApp(test, x.fileApp, thuMuc));
    await buoc("nen-tang", () => taiLapNenTang(test, x.meta));

    // KIỂM — trước mọi bước hậu kỳ, để so tuyệt đối với snapshot production.
    const kiem = await buoc("kiem", () => {
      const vtTest = psqlJson(test, sqlVanTay());
      // Khác biệt ĐÃ BIẾT: khoá ngoại dựng NOT VALID vì prod có dòng mồ côi (xem khoi-phuc.mjs).
      const daBiet = new Set(kp.fkNotValid.map((f) => `con:${f.bang}.${f.ten}`));
      const tatCa = soVanTay(x.vanTay, vtTest);
      const tuongDuong = tatCa.filter((l) => l.loai === "tương đương").map((l) => l.k);
      const lechVt = tatCa.filter((l) => l.loai !== "tương đương" && !(l.loai === "khác" && daBiet.has(l.k)));
      const bangs = psqlJson(test, sqlDanhSachBang());
      const bamTest = {};
      for (let i = 0; i < bangs.length; i += 40) {
        const [r] = psqlJson(test, sqlBamLo(bangs.slice(i, i + 40)));
        Object.assign(bamTest, r.j);
      }
      const lechBam = soBam(x.bam, bamTest);
      return { lechVt, lechBam, tuongDuong, soObject: x.vanTay.length, soBang: Object.keys(x.bam).length };
    });
    writeFileSync(join(thuMuc, "kiem.json"), JSON.stringify({ ...kiem, pgRestoreLoi: kp.loi, fkNotValid: kp.fkNotValid }, null, 2));
    ghiLog("kiem", `vân tay: ${kiem.soObject} object, lệch ${kiem.lechVt.length} · dữ liệu: ${kiem.soBang} bảng, lệch ${kiem.lechBam.length} · pg_restore ${kp.loi.length} lỗi`);
    for (const l of kiem.lechVt.slice(0, 25)) ghiLog("kiem", `  ✗ ${l.loai}: ${l.k}`);
    for (const l of kiem.lechBam.slice(0, 25)) ghiLog("kiem", `  ✗ dữ liệu ${l.k}: prod ${l.prod} · test ${l.test}`);
    if (kiem.tuongDuong.length) ghiLog("kiem", `  ~ ${kiem.tuongDuong.length} ràng buộc CHECK tương đương (chỉ khác ngoặc do pg_dump làm phẳng AND)`);
    for (const f of kp.fkNotValid) ghiLog("kiem", `  ~ đã biết: ${f.bang}.${f.ten} NOT VALID — ${f.chiTiet.slice(0, 140)}`);
    const dat = kiem.lechVt.length === 0 && kiem.lechBam.length === 0 && kp.loi.length === 0;

    await buoc("hau-ky", async () => {
      thayRefTrongHam(test, cred.testRef);
      xoaPush(test);
      dungCronTest(test, x.meta.cron);
    });
    await buoc("thong-ke", () => capNhatThongKe(test));
    await buoc("cau-hinh", () => cauHinhProjectTest(cred));
    const apiReady = await buoc("cho-api", () => choApiSanSang(testUrl, cred.testSecretKey));
    if (!apiReady) throw new Error("Data API TEST chưa sẵn sàng; không cấp biên nhận DAT.");
    const schemaDigest = catalogDigest(psqlJson(test, sqlVanTay()));
    const owners = psqlJson(test, sqlOwners())[0];
    kiemOwnersSnapshot(x.meta.owners, owners);
    const ownersDigest = digestOwners(owners);
    writeFileSync(join(thuMuc, "snapshot.json"), JSON.stringify({ snapshotLuc,
      sourceCatalogDigest: catalogDigest(x.vanTay), sourceOwnersDigest: digestOwners(x.meta.owners),
      schemaDigest, ownersDigest, tableHashes: x.bam, stages: moc }, null, 2));

    const ketQua = dat ? "DAT" : "LECH";
    ghiLichSu(test, {
      batDau, snapshotLuc, ketQua,
      chiTiet: { schemaDigest, ownersDigest, moc, lechVanTay: kiem.lechVt.length, lechDuLieu: kiem.lechBam.length, pgRestoreLoi: kp.loi.length, fkNotValid: kp.fkNotValid.map((f) => `${f.bang}.${f.ten}`), soFile: x.meta.object.length, soTaiKhoan: x.meta.user.length },
    });
    ghiLog("xong", `${dat ? "✅ TEST khớp snapshot production trước hậu kỳ" : "❌ TEST LỆCH snapshot — xem kiem.json"} · ${JSON.stringify(moc)}`);
    return dat ? 0 : 1;
  } catch (error) {
    try { ghiLichSu(test, { batDau, snapshotLuc: batDau, ketQua: "FAILED", chiTiet: { moc } }); } catch { /* original error retained */ }
    throw error;
  } finally {
    xoaDump();
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  syncTest({ argv: process.argv.slice(2) }).then((code) => { process.exitCode ||= code; }, (e) => {
    console.error(`❌ ${e.message}`);
    process.exitCode ||= 1;
  });
}
