// Bước XUẤT: chụp production trong MỘT snapshot duy nhất.
//
// Một phiên psql mở transaction REPEATABLE READ READ ONLY và export snapshot; hai
// tiến trình pg_dump nhập đúng snapshot đó (--snapshot), còn phiên psql đo vân tay,
// băm từng bảng và đọc các mảnh "cắm vào nền tảng" (policy storage, trigger auth…)
// cũng trong snapshot đó. Nhờ vậy phép so ở bước kiểm là so khớp TUYỆT ĐỐI — không
// có "lệch vài dòng do cron ghi trong lúc dump" để phải dung sai.
//
// CHỈ ĐỌC production: transaction READ ONLY, pg_dump không ghi.

import { spawn } from "node:child_process";
import { mkdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { APP_SCHEMAS, PhienPsql, SET_CHUAN, congCu, ghiLog } from "./lib.mjs";
import { sqlBamLo, sqlDanhSachBang, sqlVanTay } from "./van-tay.mjs";

function chayPgDump(args, nhan) {
  return new Promise((ok, hong) => {
    const t0 = Date.now();
    const p = spawn(congCu("pg_dump"), args, { stdio: ["ignore", "ignore", "pipe"], env: process.env });
    let err = "";
    p.stderr.setEncoding("utf8");
    p.stderr.on("data", (d) => { err += d; });
    p.on("close", (code) => {
      if (code !== 0) return hong(new Error(`pg_dump ${nhan} thất bại (${code}): ${err.slice(0, 1200)}`));
      ok(Math.round((Date.now() - t0) / 1000));
    });
  });
}

// Định nghĩa các mảnh ứng dụng cắm vào schema nền tảng — pg_dump -n không mang theo.
const SQL_POLICY_NEN_TANG = `
select format('CREATE POLICY %I ON %I.%I AS %s FOR %s TO %s%s%s;',
         po.polname, n.nspname, c.relname,
         case when po.polpermissive then 'PERMISSIVE' else 'RESTRICTIVE' end,
         case po.polcmd when 'r' then 'SELECT' when 'a' then 'INSERT' when 'w' then 'UPDATE' when 'd' then 'DELETE' else 'ALL' end,
         coalesce((select string_agg(case when r = 0 then 'public' else quote_ident(r::regrole::text) end, ', ') from unnest(po.polroles) r), 'public'),
         case when po.polqual is not null then ' USING (' || pg_get_expr(po.polqual, po.polrelid) || ')' else '' end,
         case when po.polwithcheck is not null then ' WITH CHECK (' || pg_get_expr(po.polwithcheck, po.polrelid) || ')' else '' end) as ddl,
       n.nspname as sch, c.relname as bang, po.polname as ten
  from pg_policy po join pg_class c on c.oid = po.polrelid join pg_namespace n on n.oid = c.relnamespace
 where (n.nspname, c.relname) in (('storage','objects'),('storage','buckets'),('auth','users'))`;

const SQL_TRIGGER_NEN_TANG = `
select pg_get_triggerdef(t.oid) || ';' as ddl, t.tgenabled::text as bat, n.nspname as sch, c.relname as bang, t.tgname as ten
  from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace
  join pg_proc p on p.oid = t.tgfoid join pg_namespace pn on pn.oid = p.pronamespace
 where not t.tgisinternal and n.nspname in ('auth','storage')
   and pn.nspname in (${APP_SCHEMAS.map((s) => `'${s}'`).join(",")})`;

const SQL_EVENT_TRIGGER = `
select e.evtname as ten, e.evtevent as su_kien, e.evtfoid::regproc::text as ham, e.evttags as the, e.evtenabled::text as bat
  from pg_event_trigger e where e.evtowner <> 'supabase_admin'::regrole`;

const SQL_PUB = `select schemaname as sch, tablename as bang from pg_publication_tables where pubname = 'supabase_realtime'`;

const SQL_ROLE_CFG = `
select r.rolname as vai, s.setconfig as cfg from pg_db_role_setting s join pg_roles r on r.oid = s.setrole
 where r.rolname in ('anon','authenticated','service_role') and s.setdatabase = 0`;

const SQL_DACL = `
select coalesce(n.nspname, '') as sch, d.defaclobjtype::text as loai, d.defaclacl::text[] as acl
  from pg_default_acl d left join pg_namespace n on n.oid = d.defaclnamespace
 where d.defaclrole = 'postgres'::regrole`;

const SQL_CRON = `select jobname as ten, schedule as lich, command as lenh, active as bat from cron.job order by jobid`;

const SQL_BUCKET = `select id, name, public, file_size_limit, allowed_mime_types from storage.buckets order by id`;

const SQL_OBJECT = `
select id, bucket_id, name, owner, owner_id, created_at, updated_at, last_accessed_at, metadata, user_metadata, version
  from storage.objects order by bucket_id, name`;

const SQL_USER = `select id, email from auth.users order by email`;

export async function xuatProduction({ prod, thuMuc }) {
  mkdirSync(thuMuc, { recursive: true });
  const fileApp = join(thuMuc, "app.dump");
  const fileAuth = join(thuMuc, "auth.dump");

  const phien = new PhienPsql(prod);
  try {
    await phien.chay(SET_CHUAN);
    await phien.chay("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;");
    const snap = (await phien.chay("SELECT pg_export_snapshot();")).trim();
    if (!/^[0-9A-F-]+$/i.test(snap)) throw new Error(`Không export được snapshot: "${snap}"`);
    ghiLog("xuat", `snapshot ${snap}`);

    // pg_dump GIỮ ACL (không --no-acl): TEST phải mang đúng quyền production, kể cả
    // những REVOKE khỏi anon. --no-owner: mọi object ứng dụng trên prod đều thuộc
    // postgres, restore dưới postgres cho đúng chủ sở hữu đó.
    const appArgs = ["-d", prod, `--snapshot=${snap}`, "--format=custom", "--no-owner",
      "--no-publications", "--no-subscriptions", "-f", fileApp];
    for (const s of APP_SCHEMAS) appArgs.push("-n", s);
    const authArgs = ["-d", prod, `--snapshot=${snap}`, "--format=custom", "--data-only",
      "-t", "auth.users", "-t", "auth.identities", "-f", fileAuth];

    const dumpApp = chayPgDump(appArgs, "app");
    const dumpAuth = chayPgDump(authArgs, "auth");

    // Đo trong cùng snapshot, song song với pg_dump.
    const t0 = Date.now();
    const vanTay = await phien.json(sqlVanTay());
    const bangs = await phien.json(sqlDanhSachBang());
    const bam = {};
    for (let i = 0; i < bangs.length; i += 40) {
      const [r] = await phien.json(sqlBamLo(bangs.slice(i, i + 40)));
      Object.assign(bam, r.j);
    }
    const meta = {
      policyNenTang: await phien.json(SQL_POLICY_NEN_TANG),
      triggerNenTang: await phien.json(SQL_TRIGGER_NEN_TANG),
      eventTrigger: await phien.json(SQL_EVENT_TRIGGER),
      pub: await phien.json(SQL_PUB),
      roleCfg: await phien.json(SQL_ROLE_CFG),
      dacl: await phien.json(SQL_DACL),
      cron: await phien.json(SQL_CRON),
      bucket: await phien.json(SQL_BUCKET),
      object: await phien.json(SQL_OBJECT),
      user: await phien.json(SQL_USER),
    };
    ghiLog("xuat", `đo xong trong snapshot: ${vanTay.length} object, ${Object.keys(bam).length} bảng, ${meta.object.length} file — ${Math.round((Date.now() - t0) / 1000)}s`);

    const [sApp, sAuth] = await Promise.all([dumpApp, dumpAuth]);
    ghiLog("xuat", `pg_dump app ${sApp}s (${(statSync(fileApp).size / 1048576).toFixed(1)} MB), auth ${sAuth}s`);
    return { fileApp, fileAuth, vanTay, bam, meta };
  } finally {
    await phien.dong();
  }
}
