// Bước STORAGE: dựng bucket + chép DÒNG THÔNG TIN file (không chép nội dung ảnh).
//
// Chủ chốt 23/09/2026: "đừng copy ảnh, chỉ dữ liệu text thuần". Nên TEST KHÔNG có
// byte của file nào từ production — mở ảnh cũ trên TEST sẽ báo không tìm thấy.
//
// Nhưng vẫn phải chép DÒNG storage.objects (tên, id, kích thước, owner — toàn chữ):
// app_private.ie_supplement_objects có khoá ngoại object_id → storage.objects.id, thiếu
// dòng thì pg_restore không dựng được ràng buộc, và mọi hàm SQL hỏi "file này có tồn
// tại/thuộc ai" sẽ trả khác production. id phải GIỮ ĐÚNG giá trị production vì chính
// khoá ngoại đó.
//
// Bucket được dựng giống production (công khai/giới hạn/MIME) để tính năng TẢI LÊN
// trên TEST vẫn thử được bình thường.
//
// Chạy trong "cửa sổ trống" sau khi xoá sạch schema ứng dụng: trigger ứng dụng trên
// storage.objects (a00_storage_object_link, a00_ie_supplement_storage_guard) đã gỡ, nên
// ghi dòng không kích hoạt chúng. Chúng được dựng lại ở bước tái lập nền tảng.

import { ghiLog, lit, psql, psqlJson } from "./lib.mjs";

function tieuDe(key) {
  // Key kiểu mới (sb_secret_…) không phải JWT: chỉ gửi qua `apikey`.
  return key.startsWith("sb_") ? { apikey: key } : { apikey: key, Authorization: `Bearer ${key}` };
}

export async function dungBucket(testUrl, testKey, buckets) {
  const h = { ...tieuDe(testKey), "Content-Type": "application/json" };
  const r = await fetch(`${testUrl}/storage/v1/bucket`, { headers: h });
  if (!r.ok) throw new Error(`Liệt kê bucket TEST lỗi ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const coSan = new Set((await r.json()).map((b) => b.id));
  for (const b of buckets) {
    const than = { id: b.id, name: b.name, public: b.public, file_size_limit: b.file_size_limit, allowed_mime_types: b.allowed_mime_types };
    const res = coSan.has(b.id)
      ? await fetch(`${testUrl}/storage/v1/bucket/${encodeURIComponent(b.id)}`, { method: "PUT", headers: h, body: JSON.stringify(than) })
      : await fetch(`${testUrl}/storage/v1/bucket`, { method: "POST", headers: h, body: JSON.stringify(than) });
    if (!res.ok) throw new Error(`Dựng bucket ${b.id} lỗi ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  ghiLog("storage", `${buckets.length} bucket giống production`);
}

/**
 * Gương hoá bảng storage.objects: xoá dòng TEST không có trên prod, chèn/cập nhật
 * mọi dòng prod với ĐÚNG id. Chỉ dòng thông tin — không có byte nào.
 */
export function guongDongObject(test, objects) {
  const rows = objects.map((o) => ({
    i: o.id, b: o.bucket_id, n: o.name, ow: o.owner, oi: o.owner_id, c: o.created_at, u: o.updated_at,
    la: o.last_accessed_at, m: o.metadata, um: o.user_metadata, v: o.version,
  }));
  // Xoá dòng thừa. Supabase chặn DELETE thẳng trên storage.objects (trigger
  // protect_delete) trừ khi bật cờ phiên này — hợp lệ ở đây vì TEST không giữ byte
  // của các dòng chép từ prod.
  const khoa = JSON.stringify(rows.map((r) => ({ i: r.i })));
  const { stdout: xoa } = psql(test, `BEGIN;
SET LOCAL storage.allow_delete_query = 'true';
WITH d AS (DELETE FROM storage.objects o
  WHERE NOT EXISTS (SELECT 1 FROM json_to_recordset(${lit(khoa)}::json) AS x(i uuid) WHERE x.i = o.id) RETURNING 1)
SELECT 'XOA=' || count(*) FROM d;
COMMIT;`);
  let them = 0;
  for (let i = 0; i < rows.length; i += 1000) {
    const lo = rows.slice(i, i + 1000);
    const { stdout } = psql(test, `WITH x AS (
  SELECT * FROM json_to_recordset(${lit(JSON.stringify(lo))}::json)
    AS x(i uuid, b text, n text, ow uuid, oi text, c timestamptz, u timestamptz, la timestamptz, m jsonb, um jsonb, v text))
, g AS (
  INSERT INTO storage.objects (id, bucket_id, name, owner, owner_id, created_at, updated_at, last_accessed_at, metadata, user_metadata, version)
  SELECT i, b, n, ow, oi, c, u, la, m, um, v FROM x
  ON CONFLICT (id) DO UPDATE SET bucket_id = excluded.bucket_id, name = excluded.name, owner = excluded.owner,
    owner_id = excluded.owner_id, created_at = excluded.created_at, updated_at = excluded.updated_at,
    last_accessed_at = excluded.last_accessed_at, metadata = excluded.metadata, user_metadata = excluded.user_metadata,
    version = excluded.version
  RETURNING 1)
SELECT 'GHI=' || count(*) FROM g;`);
    them += Number(/GHI=(\d+)/.exec(stdout)?.[1] ?? 0);
  }
  const [dem] = psqlJson(test, "select count(*) as n from storage.objects");
  ghiLog("storage", `dòng thông tin file: xoá ${/XOA=(\d+)/.exec(xoa)?.[1] ?? "?"} · ghi ${them} · TEST có ${dem.n}/${rows.length} (không chép byte)`);
  if (Number(dem.n) !== rows.length) throw new Error(`storage.objects TEST ${dem.n} dòng, production ${rows.length}.`);
}
