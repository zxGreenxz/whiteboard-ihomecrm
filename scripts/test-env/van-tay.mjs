// "Vân tay" của một database: mỗi object ứng dụng thành một cặp (khoá, md5), cộng
// mã băm NỘI DUNG từng bảng. Chạy y hệt trên production (trong snapshot của bản dump)
// và trên TEST (ngay sau khôi phục, trước mọi bước hậu kỳ) rồi so từng khoá.
//
// VÌ SAO KHÔNG ĐẾM: số đếm bảng/hàm/policy khớp không chứng minh gì — một hàm mất
// quyền REVOKE vẫn là "1 hàm", một policy sai điều kiện vẫn là "1 policy". Repo này
// từng khôi phục "đủ số" mà mở lại cửa anon (xem kiem-bao-mat-sau-khoi-phuc.mjs).
// Phép so ở đây bắt đúng những thứ đó: thân hàm, ACL (bỏ grantor), điều kiện policy,
// định nghĩa trigger/index/constraint, cột, default privileges, và từng dòng dữ liệu.
//
// Quy ước: các câu SQL giả định phiên đã chạy SET_CHUAN (search_path = pg_catalog)
// để pg_get_* in tên đầy đủ schema ở cả hai phía.

import { APP_SCHEMAS, lit, ident } from "./lib.mjs";

const S = APP_SCHEMAS.map(lit).join(",");

// Bảng nền tảng mà ứng dụng cắm policy/trigger vào.
const BANG_NEN_TANG = "(('auth','users'),('storage','objects'),('storage','buckets'))";

// ACL chuẩn hoá: thay NULL bằng acldefault, bỏ phần "/grantor" (pg_restore cấp lại
// quyền dưới tên người chạy restore, nên grantor khác nhau là bình thường), sắp xếp.
const acl = (cot, loai, owner) =>
  `coalesce((select string_agg(regexp_replace(a::text, '/.*$', ''), ',' order by regexp_replace(a::text, '/.*$', '')) from unnest(coalesce(${cot}, acldefault(${loai}, ${owner}))) a), '')`;

/**
 * Câu SELECT trả các dòng {k, v}. `thay` = [tuChuoi, thanhChuoi] để chuẩn hoá ref
 * project trong thân hàm (TEST sau hậu kỳ mang ref TEST thay cho ref production).
 */
export function sqlVanTay({ thay } = {}) {
  const chuan = (expr) => (thay ? `replace(${expr}, ${lit(thay[0])}, ${lit(thay[1])})` : expr);
  return `
with ext as (select objid from pg_depend where deptype = 'e'),
ns as (select oid, nspname from pg_namespace where nspname in (${S}))
select 'nsp:' || n.nspname as k, md5(${acl("n.nspacl", "'n'", "n.nspowner")}) as v
  from pg_namespace n where n.nspname in (${S})
union all
select 'fn:' || ns.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')',
       md5(case when p.prokind in ('f','p') then ${chuan("pg_get_functiondef(p.oid)")} else p.prokind::text end
           || '|' || ${acl("p.proacl", "'f'", "p.proowner")})
  from pg_proc p join ns on ns.oid = p.pronamespace
 where p.oid not in (select objid from ext)
union all
select 'rel:' || ns.nspname || '.' || c.relname,
       md5(c.relkind::text || '|' || c.relrowsecurity || '|' || c.relforcerowsecurity || '|' || c.relpersistence::text
           || '|' || coalesce(array_to_string(c.reloptions, ','), '')
           || '|' || ${acl("c.relacl", "case when c.relkind = 'S' then 's'::\"char\" else 'r'::\"char\" end", "c.relowner")}
           || '|' || coalesce((select string_agg(a.attname || ':' || format_type(a.atttypid, a.atttypmod) || ':' || a.attnotnull
                        || ':' || a.attgenerated::text || ':' || a.attidentity::text || ':' || coalesce(pg_get_expr(d.adbin, d.adrelid), '')
                        || ':' || coalesce(regexp_replace(array_to_string(a.attacl, ','), '/[^,]*', '', 'g'), ''),
                        ',' order by a.attnum)
                   from pg_attribute a left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
                  where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped), '')
           || '|' || case when c.relkind in ('v','m') then md5(pg_get_viewdef(c.oid)) else '' end
           || '|' || coalesce(pg_get_partkeydef(c.oid), '') || '|' || coalesce(pg_get_expr(c.relpartbound, c.oid), ''))
  from pg_class c join ns on ns.oid = c.relnamespace
 where c.relkind in ('r','p','v','m','S','f','c') and c.oid not in (select objid from ext)
union all
select 'idx:' || ns.nspname || '.' || c.relname, md5(pg_get_indexdef(i.indexrelid))
  from pg_index i join pg_class c on c.oid = i.indexrelid join ns on ns.oid = c.relnamespace
 where c.oid not in (select objid from ext)
union all
select 'con:' || ns.nspname || '.' || coalesce(tc.relname, tt.typname) || '.' || co.conname,
       md5(pg_get_constraintdef(co.oid) || '|' || co.convalidated || '|' || co.condeferrable || '|' || co.condeferred)
  from pg_constraint co join ns on ns.oid = co.connamespace
  left join pg_class tc on tc.oid = co.conrelid left join pg_type tt on tt.oid = co.contypid
union all
select 'trg:' || n.nspname || '.' || c.relname || '.' || t.tgname, md5(pg_get_triggerdef(t.oid) || '|' || t.tgenabled::text)
  from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace
  join pg_proc p on p.oid = t.tgfoid join pg_namespace pn on pn.oid = p.pronamespace
 where not t.tgisinternal
   and (n.nspname in (${S}) or ((n.nspname, c.relname) in ${BANG_NEN_TANG} and pn.nspname in (${S})))
union all
select 'pol:' || n.nspname || '.' || c.relname || '.' || po.polname,
       md5(po.polpermissive || '|' || po.polcmd::text
           || '|' || coalesce((select string_agg(case when r = 0 then 'public' else r::regrole::text end, ',' order by 1) from unnest(po.polroles) r), '')
           || '|' || coalesce(pg_get_expr(po.polqual, po.polrelid), '') || '|' || coalesce(pg_get_expr(po.polwithcheck, po.polrelid), ''))
  from pg_policy po join pg_class c on c.oid = po.polrelid join pg_namespace n on n.oid = c.relnamespace
 where n.nspname in (${S}) or (n.nspname, c.relname) in ${BANG_NEN_TANG}
union all
select 'type:' || ns.nspname || '.' || t.typname,
       md5(t.typtype::text || '|' || coalesce((select string_agg(e.enumlabel, ',' order by e.enumsortorder) from pg_enum e where e.enumtypid = t.oid), '')
           || '|' || coalesce(format_type(t.typbasetype, t.typtypmod), '') || '|' || ${acl("t.typacl", "'T'", "t.typowner")})
  from pg_type t join ns on ns.oid = t.typnamespace
 where t.typtype in ('e','d','c','r','m') and t.oid not in (select objid from ext)
   and not exists (select 1 from pg_class c where c.reltype = t.oid and c.relkind <> 'c')
union all
select 'dacl:' || coalesce(n.nspname, '*') || ':' || d.defaclobjtype::text,
       md5(${acl("d.defaclacl", "'r'", "d.defaclrole")})
  from pg_default_acl d left join pg_namespace n on n.oid = d.defaclnamespace
 where d.defaclrole = 'postgres'::regrole
union all
select 'evt:' || e.evtname, md5(e.evtevent || '|' || e.evtfoid::regproc::text || '|' || coalesce(array_to_string(e.evttags, ','), '') || '|' || e.evtenabled::text)
  from pg_event_trigger e where e.evtowner <> 'supabase_admin'::regrole
union all
select 'pub:' || pt.schemaname || '.' || pt.tablename, 'x'
  from pg_publication_tables pt where pt.pubname = 'supabase_realtime'
union all
select 'rolecfg:' || r.rolname, md5(array_to_string(s.setconfig, ','))
  from pg_db_role_setting s join pg_roles r on r.oid = s.setrole
 where r.rolname in ('anon', 'authenticated', 'service_role')
union all
select 'role:' || r.rolname, md5(r.rolcanlogin || '|' || r.rolinherit || '|' || r.rolbypassrls
           || '|' || coalesce((select string_agg(m.rolname, ',' order by m.rolname) from pg_auth_members am join pg_roles m on m.oid = am.member where am.roleid = r.oid), ''))
  from pg_roles r where r.rolname = 'ie_canonical_writer'
union all
select 'ext:' || e.extname, n.nspname from pg_extension e join pg_namespace n on n.oid = e.extnamespace
 where e.extname in ('vector', 'pg_trgm', 'btree_gist', 'pg_cron', 'pgcrypto', 'uuid-ossp')
union all
select 'bucket:' || b.id, md5(b.public || '|' || coalesce(b.file_size_limit::text, '') || '|' || coalesce(array_to_string(b.allowed_mime_types, ','), ''))
  from storage.buckets b
`;
}

const COT_AUTH = {
  "auth.users": ["id", "email", "encrypted_password", "email_confirmed_at", "raw_app_meta_data", "raw_user_meta_data", "created_at", "banned_until", "deleted_at"],
  "auth.identities": ["id", "user_id", "provider", "provider_id", "identity_data", "created_at"],
};

/** Danh sách bảng (lá, có dữ liệu thật) cần băm nội dung. */
export function sqlDanhSachBang() {
  return `
select n.nspname as sch, c.relname as bang
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
 where c.relkind = 'r' and (n.nspname in (${S}) or (n.nspname, c.relname) in (('auth','users'),('auth','identities')))
   and c.oid not in (select objid from pg_depend where deptype = 'e')
 order by 1, 2`;
}

/**
 * Một câu SELECT băm cả lô bảng: {"s.t": "md5:count"}. Băm từng dòng rồi băm chuỗi
 * các mã đã sắp xếp ⇒ không phụ thuộc thứ tự vật lý, và hai phía chỉ khớp khi mọi
 * dòng khớp. Phiên phải chạy SET_CHUAN để định dạng ngày giờ/số giống nhau.
 */
export function sqlBamLo(bangs) {
  const cot = bangs.map(({ sch: s, bang: t }) => {
    // Bảng auth: chỉ băm cột CHUNG hai phía — project TEST mới có thể chạy bản GoTrue
    // mới hơn với cột thêm, băm cả dòng sẽ lệch dù dữ liệu y hệt.
    const dong = COT_AUTH[`${s}.${t}`] ? `row(${COT_AUTH[`${s}.${t}`].map((c) => `x.${c}`).join(", ")})::text` : "x::text";
    return `${lit(`${s}.${t}`)}, (select md5(coalesce(string_agg(h, '' order by h), '')) || ':' || count(*) from (select md5(${dong}) h from ${ident(s)}.${ident(t)} x) q)`;
  });
  return `select json_build_object(${cot.join(",\n")}) as j`;
}

/** So hai tập vân tay. Trả danh sách khác biệt (rỗng = khớp). */
export function soVanTay(prod, test) {
  const mp = new Map(prod.map((r) => [r.k, r.v]));
  const mt = new Map(test.map((r) => [r.k, r.v]));
  const lech = [];
  for (const [k, v] of mp) {
    if (!mt.has(k)) lech.push({ k, loai: "thiếu trên TEST" });
    else if (mt.get(k) !== v) lech.push({ k, loai: "khác" });
  }
  for (const k of mt.keys()) if (!mp.has(k)) lech.push({ k, loai: "thừa trên TEST" });
  return lech.sort((a, b) => a.k.localeCompare(b.k));
}

export function soBam(prod, test) {
  const lech = [];
  for (const [k, v] of Object.entries(prod)) {
    if (!(k in test)) lech.push({ k, prod: v, test: null });
    else if (test[k] !== v) lech.push({ k, prod: v, test: test[k] });
  }
  for (const k of Object.keys(test)) if (!(k in prod)) lech.push({ k, prod: null, test: test[k] });
  return lech;
}
