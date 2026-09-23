#!/usr/bin/env node
// Đồng bộ MÔI TRƯỜNG TEST (project Supabase `ihomecrm-test`) = bản sao production.
//
//   npm run test-env:sync                 # đồng bộ đầy đủ
//   npm run test-env:sync -- --giu-dump   # giữ file dump sau khi xong (mặc định xoá)
//
// Luồng: xuất production trong MỘT snapshot → dừng cron TEST → xoá sạch schema ứng
// dụng TEST → nạp auth → bucket + dòng thông tin file (không chép byte ảnh) →
// pg_restore → tái lập phần cắm vào nền tảng → KIỂM vân tay + băm từng bảng khớp
// production tuyệt đối → hậu kỳ (mật khẩu TEST, push, cron) → ghi lịch sử.
//
// Production CHỈ bị đọc. Mọi lệnh ghi đi qua batBuocDichTest() trước.
// Bản dump chứa dữ liệu cá nhân thật: ghi NGOÀI repo và xoá khi xong.

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { cauHinhProjectTest } from "./cau-hinh.mjs";
import { choApiSanSang, dungCronTest, datMatKhauTest, ghiLichSu, thayRefTrongHam, xoaPush } from "./hau-ky.mjs";
import { chuanBi, dungCron, khoiPhucApp, taiLapNenTang, xoaSach, xoaVaNapAuth } from "./khoi-phuc.mjs";
import { PROD_REF, PhienPsql, batBuocDichTest, credential, ghiLog, ketNoi, khiThoat, kiemCongCu, psqlJson } from "./lib.mjs";
import { dungBucket, guongDongObject } from "./tep.mjs";
import { soBam, soVanTay, sqlBamLo, sqlDanhSachBang, sqlVanTay } from "./van-tay.mjs";
import { xuatProduction } from "./xuat.mjs";

async function main(argv) {
  const batDau = new Date().toISOString();
  const giuDump = argv.includes("--giu-dump");
  kiemCongCu();
  const cred = credential();
  const { prod, test } = await ketNoi(cred);
  const testUrl = `https://${cred.testRef}.supabase.co`;

  await batBuocDichTest(cred, test);

  // KHOÁ: đúng một lượt đồng bộ tại một thời điểm. Hai lượt chạy chồng nhau sẽ xoá/nạp
  // đè lên nhau (đã suýt xảy ra 23/09/2026 khi một lệnh shell vô tình khởi chạy lượt
  // thứ hai). Advisory lock mức PHIÊN, giữ suốt lượt chạy qua một phiên psql riêng.
  const khoa = new PhienPsql(test);
  const duocKhoa = (await khoa.chay("SELECT pg_try_advisory_lock(hashtext('test-env-sync'));")).trim();
  if (duocKhoa !== "t") {
    await khoa.dong();
    throw new Error("Đang có một lượt đồng bộ TEST khác chạy — dừng, không đụng vào gì.");
  }
  ghiLog("bat-dau", `production ${PROD_REF} → TEST ${cred.testRef}`);

  const thuMuc = join(process.env.TEST_ENV_WORKDIR || join(homedir(), "ihomecrm-backups", "test-env"), batDau.replace(/[:.]/g, "-"));
  mkdirSync(thuMuc, { recursive: true });
  // Bản dump chứa dữ liệu cá nhân + hash mật khẩu thật: xoá cả khi tiến trình bị ngắt
  // (SIGINT/SIGTERM gọi process.exit, khối finally không kịp chạy).
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
    const r = await fn();
    moc[ten] = Math.round((Date.now() - t0) / 1000);
    return r;
  };

  try {
    const x = await buoc("xuat", () => xuatProduction({ prod, thuMuc }));
    const snapshotLuc = new Date().toISOString();

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
    await buoc("chuan-bi", () => chuanBi(test));
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
    await buoc("cau-hinh", () => cauHinhProjectTest(cred));
    await buoc("cho-api", () => choApiSanSang(testUrl, cred.testSecretKey));

    const ketQua = dat ? "DAT" : "LECH";
    ghiLichSu(test, {
      batDau, snapshotLuc, ketQua,
      chiTiet: { moc, lechVanTay: kiem.lechVt.length, lechDuLieu: kiem.lechBam.length, pgRestoreLoi: kp.loi.length, fkNotValid: kp.fkNotValid.map((f) => `${f.bang}.${f.ten}`), soFile: x.meta.object.length, soTaiKhoan: x.meta.user.length },
    });
    ghiLog("xong", `${dat ? "✅ TEST khớp production tuyệt đối" : "❌ TEST LỆCH production — xem kiem.json"} · ${JSON.stringify(moc)}`);
    return dat ? 0 : 1;
  } finally {
    try { await khoa.chay("SELECT pg_advisory_unlock(hashtext('test-env-sync'));"); } catch { /* đóng phiên cũng nhả */ }
    await khoa.dong();
    xoaDump();
  }
}

main(process.argv).then((code) => process.exit(code), (e) => {
  console.error(`❌ ${e.message}`);
  process.exit(1);
});
