// Bước KHÔI PHỤC vào project TEST. Mọi hàm ở đây GHI — chỉ gọi sau batBuocDichTest().
//
// Trình tự và lý do:
//   1. dừng cron TEST — job chạy giữa chừng sẽ ghi vào bảng đang bị xoá/nạp.
//   2. xoá sạch schema ứng dụng THEO LÔ — DROP SCHEMA … CASCADE một phát trên ~500
//      bảng + 1.250 hàm vượt max_locks_per_transaction ("out of shared memory"),
//      bài học từ dien-tap-khoi-phuc-baseline.mjs.
//   3. nạp lại auth.users/identities TRƯỚC dữ liệu ứng dụng — khoá ngoại public → auth
//      được kiểm lúc pg_restore dựng constraint.
//   4. TRUNG HOÀ default privileges của postgres — Supabase mặc định cấp quyền cho
//      anon/authenticated trên mọi object mới trong public. pg_dump chỉ ghi ACL dưới
//      dạng chênh lệch so với acldefault, nên nếu để nguyên, mọi hàm production đã
//      REVOKE khỏi anon sẽ được cấp lại quyền trên TEST. (Repo từng dính đúng lỗi này
//      khi dựng lại bằng --no-acl — xem kiem-bao-mat-sau-khoi-phuc.mjs.)
//   5. pg_restore, rồi tái lập phần cắm vào nền tảng mà pg_dump -n không mang theo.

import { spawn, spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";

import { APP_SCHEMAS, congCu, ghiLog, ident, lit, psql, psqlJson } from "./lib.mjs";

const S = APP_SCHEMAS.map(lit).join(",");

export function dungCron(test) {
  psql(test, `DO $$ DECLARE j record; BEGIN
    IF to_regclass('cron.job') IS NULL THEN RETURN; END IF;
    FOR j IN SELECT jobid FROM cron.job LOOP PERFORM cron.unschedule(j.jobid); END LOOP;
  END $$;`);
}

export function xoaSach(test) {
  // Phần cắm vào nền tảng trước: event trigger (nếu không, mỗi DROP còn kích hoạt
  // nó), trigger ứng dụng trên auth/storage, mọi policy trên storage.
  psql(test, `DO $$ DECLARE r record; BEGIN
    FOR r IN SELECT evtname FROM pg_event_trigger WHERE evtowner <> 'supabase_admin'::regrole LOOP
      EXECUTE format('DROP EVENT TRIGGER IF EXISTS %I', r.evtname);
    END LOOP;
    FOR r IN SELECT n.nspname, c.relname, t.tgname FROM pg_trigger t
             JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
             JOIN pg_proc p ON p.oid = t.tgfoid JOIN pg_namespace pn ON pn.oid = p.pronamespace
            WHERE NOT t.tgisinternal AND n.nspname IN ('auth','storage') AND pn.nspname IN (${S}) LOOP
      EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I.%I', r.tgname, r.nspname, r.relname);
    END LOOP;
    FOR r IN SELECT schemaname, tablename, policyname FROM pg_policies
            WHERE (schemaname, tablename) IN (('storage','objects'),('storage','buckets'),('auth','users')) LOOP
      EXECUTE format('DROP POLICY IF EXISTS %I ON %I.%I', r.policyname, r.schemaname, r.tablename);
    END LOOP;
  END $$;`);

  const hoiDs = (sql) => psqlJson(test, sql).map((r) => r.x);
  const thu = (sql) => { try { psql(test, sql); } catch { /* vòng sau nhặt lại */ } };
  const loaiTru = "and c.oid not in (select objid from pg_depend where deptype = 'e')";
  for (const ns of APP_SCHEMAS) {
    for (const [kind, lenh] of [["'m'", "drop materialized view if exists"], ["'v'", "drop view if exists"], ["'r','p','f'", "drop table if exists"], ["'S'", "drop sequence if exists"]]) {
      for (let i = 0; i < 60; i += 1) {
        const ds = hoiDs(`select quote_ident(n.nspname)||'.'||quote_ident(c.relname) as x from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname=${lit(ns)} and c.relkind in (${kind}) and c.relispartition = false ${loaiTru} limit 40`);
        if (ds.length === 0) break;
        thu(`${lenh} ${ds.join(",")} cascade`);
      }
    }
    for (let i = 0; i < 120; i += 1) {
      const f = hoiDs(`select quote_ident(n.nspname)||'.'||quote_ident(p.proname)||'('||pg_get_function_identity_arguments(p.oid)||')' as x from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname=${lit(ns)} and p.prokind in ('f','p') and p.oid not in (select objid from pg_depend where deptype='e') limit 40`);
      if (f.length === 0) break;
      thu(`drop routine if exists ${f.join(",")} cascade`);
    }
    for (let i = 0; i < 20; i += 1) {
      const t = hoiDs(`select quote_ident(n.nspname)||'.'||quote_ident(t.typname) as x from pg_type t join pg_namespace n on n.oid=t.typnamespace where n.nspname=${lit(ns)} and t.typtype in ('e','d','c','r','m') and t.oid not in (select objid from pg_depend where deptype='e') and not exists (select 1 from pg_class c where c.reltype=t.oid) limit 40`);
      if (t.length === 0) break;
      thu(`drop type if exists ${t.join(",")} cascade`);
    }
    if (ns !== "public") thu(`drop schema if exists ${ident(ns)} cascade`);
  }
  const con = psqlJson(test, `select n.nspname as x from pg_namespace n where n.nspname in (${S}) and n.nspname <> 'public'
    union all select 'public.' || c.relname from pg_class c where c.relnamespace = 'public'::regnamespace and c.oid not in (select objid from pg_depend where deptype='e')
    union all select 'public.' || p.proname || '()' from pg_proc p where p.pronamespace = 'public'::regnamespace and p.oid not in (select objid from pg_depend where deptype='e')`);
  if (con.length) throw new Error(`Xoá sạch chưa hết: còn ${con.length} object (vd ${con.slice(0, 5).map((r) => r.x).join(", ")})`);
}

export function xoaVaNapAuth(test, fileAuth) {
  // Xoá user cũ của TEST (cascade sang identities/sessions/refresh_tokens/mfa).
  psql(test, "DELETE FROM auth.users;");
  const r = spawnSync(congCu("pg_restore"), ["-d", test, "--data-only", "--no-owner", "--exit-on-error", fileAuth], {
    encoding: "utf8",
    env: process.env,
    timeout: 20 * 60 * 1000,
  });
  if (r.status !== 0) throw new Error(`Nạp auth lỗi: ${String(r.stderr).slice(0, 1500)}`);
}

export function chuanBi(test) {
  psql(test, `
CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public;
CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;
CREATE EXTENSION IF NOT EXISTS btree_gist WITH SCHEMA public;
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA pg_catalog;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ie_canonical_writer') THEN
    CREATE ROLE ie_canonical_writer NOLOGIN NOINHERIT;
  END IF;
END $$;
GRANT ie_canonical_writer TO postgres;
DO $$ DECLARE r record; g text; BEGIN
  FOR r IN SELECT d.defaclnamespace, n.nspname, d.defaclobjtype, d.defaclacl
             FROM pg_default_acl d LEFT JOIN pg_namespace n ON n.oid = d.defaclnamespace
            WHERE d.defaclrole = 'postgres'::regrole LOOP
    FOR g IN SELECT DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE quote_ident(a.grantee::regrole::text) END
               FROM aclexplode(r.defaclacl) a WHERE a.grantee <> 'postgres'::regrole LOOP
      EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE postgres %s REVOKE ALL ON %s FROM %s',
        CASE WHEN r.defaclnamespace = 0 THEN '' ELSE format('IN SCHEMA %I', r.nspname) END,
        CASE r.defaclobjtype WHEN 'r' THEN 'TABLES' WHEN 'S' THEN 'SEQUENCES' WHEN 'f' THEN 'FUNCTIONS'
                             WHEN 'T' THEN 'TYPES' WHEN 'n' THEN 'SCHEMAS' END, g);
    END LOOP;
  END LOOP;
END $$;`);
}

function chayPgRestore(args, nhan) {
  return new Promise((ok, hong) => {
    const t0 = Date.now();
    const p = spawn(congCu("pg_restore"), args, { stdio: ["ignore", "ignore", "pipe"], env: process.env });
    let err = "";
    p.stderr.setEncoding("utf8");
    p.stderr.on("data", (d) => { err += d; });
    p.on("close", (code) => {
      const giay = Math.round((Date.now() - t0) / 1000);
      if (code !== 0 && !/ERROR/.test(err)) return hong(new Error(`pg_restore ${nhan} thoát ${code}: ${err.slice(0, 800)}`));
      ok({ code, err, giay });
    });
  });
}

/** Tách stderr pg_restore thành từng khối lỗi {loi, chiTiet, lenh}. */
export function tachLoiPgRestore(err) {
  const khoi = [];
  for (const phan of err.split(/^pg_restore: error: could not execute query: /m).slice(1)) {
    const loi = (/^ERROR:\s*(.*)$/m.exec(phan)?.[1] ?? "").trim();
    const chiTiet = (/^DETAIL:\s*(.*)$/m.exec(phan)?.[1] ?? "").trim();
    // Câu lệnh kéo dài NHIỀU dòng tới dòng trống. Không dùng `$` với cờ m — nó dừng ở
    // cuối dòng ĐẦU, cắt mất "ADD CONSTRAINT …" (lỗi thật 23/09: 16 khoá ngoại bị bỏ qua).
    const sau = phan.split(/^Command was: /m)[1] ?? "";
    const lenh = sau.split(/\r?\n[ \t]*\r?\n/)[0].trim();
    khoi.push({ loi, chiTiet, lenh });
  }
  return khoi;
}

/**
 * pg_restore dữ liệu + schema ứng dụng, HAI lượt:
 *
 *   Lượt 0 — CHỈ các hàm. Cột sinh `rooms.name_sort` gọi room_sort_key(), hàm SQL
 *   này được inline lúc tạo bảng và đòi natural_sort_key() đã tồn tại. pg_dump không
 *   biết phụ thuộc nằm trong THÂN hàm, nên theo thứ tự của nó `rooms` được tạo trước
 *   → hỏng, kéo theo ~80 lỗi dây chuyền (view, policy, khoá ngoại trỏ vào rooms). Bài
 *   diễn tập baseline cũng dính đúng chỗ này (xem dien-tap-khoi-phuc-baseline.mjs).
 *   Hàm trả về kiểu bảng (SETOF public.rooms) hỏng ở lượt 0 là bình thường — lượt 1
 *   dựng lại.
 *   Lượt 1 — mọi thứ còn lại, bỏ các hàm đã có.
 *
 * Bỏ mục DEFAULT ACL không thuộc postgres (postgres không có quyền đổi default
 * privileges của supabase_admin — TEST đã có sẵn đúng các dòng đó từ nền tảng).
 */
export async function khoiPhucApp(test, fileApp, thuMuc) {
  const list = spawnSync(congCu("pg_restore"), ["--list", fileApp], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  if (list.status !== 0) throw new Error(`pg_restore --list lỗi: ${list.stderr}`);
  const dong = list.stdout.split(/\r?\n/).filter((l) => !(/ DEFAULT ACL /.test(l) && !/ postgres$/.test(l.trim())));
  const laHam = (l) => /^\d+; \d+ \d+ FUNCTION /.test(l);

  const list0 = `${thuMuc}/app.ham.list`;
  writeFileSync(list0, dong.filter(laHam).join("\n"), "utf8");
  const r0 = await chayPgRestore(["-d", test, "--no-owner", "-L", list0, fileApp], "lượt hàm");
  const daCo = new Set(psqlJson(test, `select n.nspname || ' ' || p.proname || '(' || oidvectortypes(p.proargtypes) || ')' as x
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname in (${S})`).map((r) => r.x));
  const conLai = dong.filter((l) => {
    const m = /^\d+; \d+ \d+ FUNCTION (\S+) (.+) \S+$/.exec(l);
    return !(m && daCo.has(`${m[1]} ${m[2]}`));
  });
  ghiLog("khoi-phuc", `lượt hàm ${r0.giay}s: ${daCo.size} hàm đã dựng · lượt chính ${conLai.filter((l) => /^\d+;/.test(l)).length} mục`);

  const list1 = `${thuMuc}/app.list`;
  writeFileSync(list1, conLai.join("\n"), "utf8");
  // Số luồng: 4 tại máy (đã kiểm); CI đặt cao hơn để bù độ trễ Mỹ ↔ Singapore mỗi câu lệnh.
  const luong = String(Math.max(1, Math.min(16, Number(process.env.TEST_ENV_PG_RESTORE_JOBS) || 4)));
  const r1 = await chayPgRestore(["-d", test, "--no-owner", "-j", luong, "-L", list1, fileApp], "lượt chính");
  writeFileSync(`${thuMuc}/pg_restore.stderr.txt`, r1.err, "utf8");
  const loi = tachLoiPgRestore(r1.err);

  // Khoá ngoại vấp dòng MỒ CÔI có sẵn trên production (dòng tham chiếu tới bản ghi
  // đã xoá khi chạy session_replication_role=replica — FK không được kiểm lúc đó, nên
  // trên prod ràng buộc vẫn mang cờ "đã kiểm"). Dựng lại NOT VALID: vẫn chặn mọi dòng
  // GHI MỚI, chỉ không kiểm dữ liệu cũ. Trả về danh sách để báo cáo là khác biệt ĐÃ BIẾT.
  const fkNotValid = [];
  const daXuLy = new Set();
  for (const k of loi.filter((x) => /violates foreign key constraint/.test(x.loi))) {
    const m = /^ALTER TABLE ONLY (\S+)\s+ADD CONSTRAINT (\S+) FOREIGN KEY [\s\S]+;$/.exec(k.lenh);
    if (!m) continue; // không nhận dạng được câu lệnh ⇒ để lại là LỖI, không nuốt
    psql(test, `${k.lenh.replace(/;\s*$/, "")} NOT VALID;`);
    fkNotValid.push({ bang: m[1], ten: m[2], chiTiet: k.chiTiet });
    daXuLy.add(k);
  }
  // CHẠY LẠI TUẦN TỰ: -j 4 dựng DDL song song và đôi khi deadlock (đo 23/09: hai CREATE
  // POLICY khoá chéo nhau — không tất định). Phát lại mọi câu lỗi theo đúng thứ tự, tối
  // đa 3 vòng tới khi hết tiến triển: nạn nhân deadlock lẫn object phụ thuộc vào nó
  // (lỗi "does not exist") được dựng lại. COPY dữ liệu không phát lại được — để là lỗi.
  const daThuLai = [];
  for (let vong = 1; vong <= 3; vong += 1) {
    const con = loi.filter((x) => !daXuLy.has(x) && x.lenh && !/^COPY /.test(x.lenh)
      && !/schema "public" already exists/.test(x.loi));
    let tien = 0;
    for (const k of con) {
      try {
        psql(test, /;\s*$/.test(k.lenh) ? k.lenh : `${k.lenh};`);
        daXuLy.add(k);
        daThuLai.push(k.lenh.split("\n")[0].slice(0, 120));
        tien += 1;
      } catch { /* vòng sau thử lại, hoặc giữ là lỗi */ }
    }
    if (tien === 0) break;
  }
  if (daThuLai.length) ghiLog("khoi-phuc", `chạy lại tuần tự thành công ${daThuLai.length} câu: ${daThuLai.slice(0, 5).join(" | ")}`);
  // "schema public already exists": pg_dump -n public luôn phát CREATE SCHEMA public — vô hại.
  const loiKhac = loi.filter((x) => !daXuLy.has(x) && !/schema "public" already exists/.test(x.loi));
  ghiLog("khoi-phuc", `lượt chính ${r1.giay}s · ${fkNotValid.length} khoá ngoại dựng NOT VALID (dòng mồ côi trên prod) · ${loiKhac.length} lỗi khác`);
  for (const k of loiKhac.slice(0, 10)) ghiLog("khoi-phuc", `  ! ${k.loi.slice(0, 160)}`);
  return { loi: loiKhac, fkNotValid };
}

const DAC_QUYEN = {
  r: { a: "INSERT", r: "SELECT", w: "UPDATE", d: "DELETE", D: "TRUNCATE", x: "REFERENCES", t: "TRIGGER", m: "MAINTAIN" },
  S: { r: "SELECT", w: "UPDATE", U: "USAGE" },
  f: { X: "EXECUTE" },
  T: { U: "USAGE" },
  n: { U: "USAGE", C: "CREATE" },
};
const TEN_LOAI = { r: "TABLES", S: "SEQUENCES", f: "FUNCTIONS", T: "TYPES", n: "SCHEMAS" };

/** Sinh lệnh ALTER DEFAULT PRIVILEGES tái lập đúng bộ default ACL của postgres trên prod. */
export function sqlDefaultAcl(daclRows) {
  const out = [];
  for (const { sch, loai, acl } of daclRows) {
    const pham = sch ? ` IN SCHEMA ${ident(sch)}` : "";
    for (const item of acl) {
      const m = /^([^=]*)=([^/]*)\//.exec(item);
      if (!m) continue;
      const [, grantee, quyen] = m;
      if (grantee === "postgres") continue;
      const ten = [...quyen.replace(/\*/g, "")].map((c) => DAC_QUYEN[loai]?.[c]).filter(Boolean);
      if (!ten.length) continue;
      const ai = grantee === "" ? "PUBLIC" : ident(grantee.replace(/^"|"$/g, ""));
      out.push(`ALTER DEFAULT PRIVILEGES FOR ROLE postgres${pham} GRANT ${ten.join(", ")} ON ${TEN_LOAI[loai]} TO ${ai};`);
    }
  }
  return out.join("\n");
}

export function taiLapNenTang(test, meta) {
  const cau = [];
  for (const { vai, cfg } of meta.roleCfg) {
    for (const kv of cfg) {
      const i = kv.indexOf("=");
      cau.push(`ALTER ROLE ${ident(vai)} SET ${kv.slice(0, i)} = ${lit(kv.slice(i + 1))};`);
    }
  }
  for (const p of meta.policyNenTang) cau.push(p.ddl);
  for (const t of meta.triggerNenTang) {
    cau.push(t.ddl);
    if (t.bat === "A") cau.push(`ALTER TABLE ${ident(t.sch)}.${ident(t.bang)} ENABLE ALWAYS TRIGGER ${ident(t.ten)};`);
    if (t.bat === "D") cau.push(`ALTER TABLE ${ident(t.sch)}.${ident(t.bang)} DISABLE TRIGGER ${ident(t.ten)};`);
  }
  for (const { sch, bang } of meta.pub) {
    cau.push(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname='supabase_realtime' AND schemaname=${lit(sch)} AND tablename=${lit(bang)})
      THEN ALTER PUBLICATION supabase_realtime ADD TABLE ONLY ${ident(sch)}.${ident(bang)}; END IF; END $$;`);
  }
  cau.push(sqlDefaultAcl(meta.dacl));
  for (const e of meta.eventTrigger) {
    const the = e.the?.length ? ` WHEN TAG IN (${e.the.map(lit).join(", ")})` : "";
    cau.push(`CREATE EVENT TRIGGER ${ident(e.ten)} ON ${e.su_kien}${the} EXECUTE FUNCTION ${e.ham}();`);
    if (e.bat !== "O") cau.push(`ALTER EVENT TRIGGER ${ident(e.ten)} ${e.bat === "D" ? "DISABLE" : e.bat === "A" ? "ENABLE ALWAYS" : "ENABLE REPLICA"};`);
  }
  psql(test, cau.join("\n"));
}
