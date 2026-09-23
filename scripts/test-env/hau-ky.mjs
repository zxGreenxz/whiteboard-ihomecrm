// Bước HẬU KỲ trên TEST — chạy SAU khi đã kiểm vân tay khớp production.
//
//   1. Thay ref production → ref TEST trong THÂN HÀM. Hiện chỉ có
//      append_income_expense_supplement_v1 ghim host storage production; để nguyên thì
//      mọi ảnh bổ sung chứng từ tải lên TEST đều bị hàm từ chối. Dữ liệu (URL cũ trong
//      các cột) GIỮ NGUYÊN như production — TEST không có byte ảnh nào nên các URL đó
//      không mở được dù trỏ đâu, còn bucket private chỉ ký được trên project đang dùng.
//   2. Xoá push_subscriptions — endpoint là thiết bị THẬT của nhân viên.
//   3. Đặt MẬT KHẨU TEST riêng cho mọi tài khoản (chủ chốt 23/09): mật khẩu thật không
//      đăng nhập được TEST, và agent/chủ đăng nhập được đúng vai của bất kỳ ai.
//   4. Dựng lại cron production (trừ CRON_BO_QUA).
//   5. Ghi lịch sử đồng bộ vào test_env.lich_su.

import { randomBytes } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";

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

/**
 * Mật khẩu TEST: vault (dòng `TEST_PASS <email> <mật khẩu>`) hoặc biến môi trường
 * TEST_ENV_USER_PASSWORDS (JSON {email: mật khẩu}) trên CI. Tài khoản mới chưa có mật
 * khẩu thì sinh ngẫu nhiên và — nếu chạy tại máy có vault — ghi thêm vào vault.
 */
function docMatKhauTest() {
  const map = {};
  if (process.env.TEST_ENV_USER_PASSWORDS) Object.assign(map, JSON.parse(process.env.TEST_ENV_USER_PASSWORDS));
  const p = duongDanVault();
  if (p) {
    for (const m of readFileSync(p, "utf8").matchAll(/^TEST_PASS (\S+) (\S+)\s*$/gm)) map[m[1].toLowerCase()] = m[2];
  }
  return map;
}

const sinhMatKhau = () => `Tt!${randomBytes(12).toString("base64").replace(/[^A-Za-z0-9]/g, "").slice(0, 14)}`;

export async function datMatKhauTest({ testUrl, testKey, users }) {
  const map = docMatKhauTest();
  const moi = [];
  const h = { apikey: testKey, "Content-Type": "application/json" };
  if (!testKey.startsWith("sb_")) h.Authorization = `Bearer ${testKey}`;
  let dat = 0;
  const loi = [];
  for (const u of users) {
    const email = String(u.email ?? "").toLowerCase();
    if (!email) continue;
    // Tài khoản fixture demo.* (không phải người thật) GIỮ mật khẩu production: bộ E2E
    // đăng nhập bằng FLEET_PASS_* và chạy được y nguyên trên TEST.
    if (/^demo\./.test(email)) continue;
    let pw = map[email];
    if (!pw) {
      pw = sinhMatKhau();
      moi.push([email, pw]);
    }
    const r = await fetch(`${testUrl}/auth/v1/admin/users/${u.id}`, { method: "PUT", headers: h, body: JSON.stringify({ password: pw }) });
    if (r.ok) dat += 1;
    else loi.push(`${email}: ${r.status}`);
  }
  if (moi.length) {
    const p = duongDanVault();
    if (p) {
      appendFileSync(p, `\n# Mật khẩu TEST (project ihomecrm-test) — sinh ${new Date().toISOString().slice(0, 10)}\n${moi.map(([e, pw]) => `TEST_PASS ${e} ${pw}`).join("\n")}\n`);
      ghiLog("hau-ky", `sinh mật khẩu TEST mới cho ${moi.length} tài khoản — đã ghi vault`);
    } else {
      ghiLog("hau-ky", `⚠ ${moi.length} tài khoản chưa có mật khẩu TEST và không có vault để lưu — chạy lại tại máy có vault`);
    }
  }
  ghiLog("hau-ky", `đặt mật khẩu TEST ${dat}/${users.length} tài khoản`);
  if (loi.length) throw new Error(`Đặt mật khẩu lỗi: ${loi.slice(0, 5).join(", ")}`);
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
