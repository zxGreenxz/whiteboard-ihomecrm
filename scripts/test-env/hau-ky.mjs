// Bước HẬU KỲ trên TEST — chạy SAU khi đã kiểm vân tay khớp production.
//
//   1. Thay ref production → ref TEST trong THÂN HÀM. Hiện chỉ có
//      append_income_expense_supplement_v1 ghim host storage production; để nguyên thì
//      mọi ảnh bổ sung chứng từ tải lên TEST đều bị hàm từ chối. Dữ liệu (URL cũ trong
//      các cột) GIỮ NGUYÊN như production — TEST không có byte ảnh nào nên các URL đó
//      không mở được dù trỏ đâu, còn bucket private chỉ ký được trên project đang dùng.
//   2. Xoá push_subscriptions — endpoint là thiết bị THẬT của nhân viên.
//   3. (datMatKhauTest — gọi NGAY sau khi nạp auth, xem hàm) mật khẩu TEST riêng cho mọi
//      tài khoản: mật khẩu thật không đăng nhập được TEST.
//   4. Dựng lại cron production (trừ CRON_BO_QUA).
//   5. Ghi lịch sử đồng bộ vào test_env.lich_su.

import { createHmac, randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

import { CRON_BO_QUA, PROD_REF, TEST_ENV_SCHEMA, duongDanVault, ghiLog, lit, psql, psqlJson } from "./lib.mjs";

export function thayRefTrongHam(test, testRef) {
  const ds = psqlJson(test, `select p.oid::regprocedure::text as ten from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname in ('public','app_private') and p.prokind in ('f','p') and p.prosrc like ${lit(`%${PROD_REF}%`)}`);
  if (!ds.length) return 0;
  // CREATE OR REPLACE giữ nguyên ACL/owner của hàm.
  psql(test, `DO $$ DECLARE r record; BEGIN
    FOR r IN SELECT p.oid FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
              WHERE n.nspname IN ('public','app_private') AND p.prokind IN ('f','p') AND p.prosrc LIKE ${lit(`%${PROD_REF}%`)} LOOP
      EXECUTE replace(pg_get_functiondef(r.oid), ${lit(PROD_REF)}, ${lit(testRef)});
    END LOOP;
  END $$;`);
  ghiLog("hau-ky", `thay ref trong ${ds.length} hàm: ${ds.map((d) => d.ten).join(", ")}`);
  return ds.length;
}

export function xoaPush(test) {
  const [r] = psqlJson(test, "select count(*) as n from public.push_subscriptions");
  psql(test, "BEGIN; SET LOCAL session_replication_role = replica; DELETE FROM public.push_subscriptions; COMMIT;");
  ghiLog("hau-ky", `xoá ${r.n} đăng ký push (thiết bị thật)`);
}

/** Mật khẩu TEST của một email — TẤT ĐỊNH theo seed, nên vault và CI luôn ra cùng một giá trị. */
export function matKhauTest(seed, email) {
  return `Tt!${createHmac("sha256", seed).update(String(email).toLowerCase()).digest("base64url").slice(0, 16)}`;
}

/**
 * Đặt MẬT KHẨU TEST cho mọi tài khoản, NGAY sau khi nạp auth.users — trước mọi bước dễ
 * lỗi, để lượt đồng bộ đứt giữa chừng cũng không để lại hash mật khẩu THẬT trên TEST
 * (review 23/09, T1). Ghi thẳng hash bcrypt bằng pgcrypto, không qua API.
 *
 * - demo.* (fixture E2E, không phải người thật) giữ mật khẩu production: bộ E2E đăng
 *   nhập bằng FLEET_PASS_* chạy y nguyên trên TEST.
 * - Tài khoản không có email: mật khẩu ngẫu nhiên không ai biết (vẫn xoá hash thật).
 *
 * Kiểm: mọi tài khoản đã đặt phải khớp đúng mật khẩu TEST ⇒ mật khẩu thật hết hiệu lực.
 */
export function datMatKhauTest({ test, seed, users }) {
  const dong = [];
  const vault = [];
  for (const u of users) {
    const email = String(u.email ?? "").toLowerCase();
    if (/^demo\./.test(email)) continue;
    const pw = email ? matKhauTest(seed, email) : randomBytes(24).toString("base64url");
    dong.push({ i: u.id, p: pw });
    if (email) vault.push([email, pw]);
  }
  const x = `json_to_recordset(${lit(JSON.stringify(dong))}::json) AS x(i uuid, p text)`;
  psql(test, `UPDATE auth.users u SET encrypted_password = extensions.crypt(x.p, extensions.gen_salt('bf', 10))
  FROM ${x} WHERE u.id = x.i;`);
  const [dem] = psqlJson(test, `select count(*) as n from auth.users u join ${x} on u.id = x.i
    where u.encrypted_password = extensions.crypt(x.p, u.encrypted_password)`);
  if (Number(dem.n) !== dong.length) {
    throw new Error(`Chỉ ${dem.n}/${dong.length} tài khoản mang đúng mật khẩu TEST — dừng.`);
  }
  ghiVaultMatKhau(vault);
  ghiLog("auth", `mật khẩu TEST: ${dong.length} tài khoản (mật khẩu thật hết hiệu lực) · giữ ${users.length - dong.length} fixture demo.*`);
}

/** Làm mới danh sách mật khẩu TEST trong vault (chỉ tại máy có vault, không trên CI). */
function ghiVaultMatKhau(ds) {
  const p = duongDanVault();
  if (!p || process.env.CI) return;
  const cu = readFileSync(p, "utf8");
  const bo = cu.split(/\r?\n/).filter((l) => !/^TEST_PASS /.test(l) && !/^# Mật khẩu TEST/.test(l));
  while (bo.length && bo[bo.length - 1].trim() === "") bo.pop();
  const khoi = [
    "",
    `# Mật khẩu TEST (tất định từ TEST_ENV_PASSWORD_SEED — project ihomecrm-test) — cập nhật ${new Date().toISOString().slice(0, 10)}`,
    ...ds.sort((a, b) => a[0].localeCompare(b[0])).map(([e, pw]) => `TEST_PASS ${e} ${pw}`),
    "",
  ];
  writeFileSync(p, `${bo.join("\n")}\n${khoi.join("\n")}`);
}

export function dungCronTest(test, cron) {
  const giu = cron.filter((j) => !(j.ten in CRON_BO_QUA));
  const cau = giu.map((j) => `SELECT cron.schedule(${lit(j.ten)}, ${lit(j.lich)}, ${lit(j.lenh)});` +
    (j.bat ? "" : `\nUPDATE cron.job SET active = false WHERE jobname = ${lit(j.ten)};`));
  if (cau.length) psql(test, cau.join("\n"));
  ghiLog("hau-ky", `dựng ${giu.length} cron · bỏ qua ${cron.length - giu.length}: ${cron.filter((j) => j.ten in CRON_BO_QUA).map((j) => j.ten).join(", ")}`);
}

export function ghiLichSu(test, ketQua) {
  psql(test, `CREATE TABLE IF NOT EXISTS ${TEST_ENV_SCHEMA}.lich_su (
  id bigserial PRIMARY KEY, bat_dau timestamptz NOT NULL, ket_thuc timestamptz NOT NULL DEFAULT now(),
  snapshot_prod timestamptz, ket_qua text NOT NULL, chi_tiet jsonb);
REVOKE ALL ON ${TEST_ENV_SCHEMA}.lich_su FROM PUBLIC, anon, authenticated;
INSERT INTO ${TEST_ENV_SCHEMA}.lich_su (bat_dau, snapshot_prod, ket_qua, chi_tiet)
VALUES (${lit(ketQua.batDau)}, ${lit(ketQua.snapshotLuc)}, ${lit(ketQua.ketQua)}, ${lit(JSON.stringify(ketQua.chiTiet))}::jsonb);`);
}
