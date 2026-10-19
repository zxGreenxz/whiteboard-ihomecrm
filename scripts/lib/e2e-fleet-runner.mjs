// Phần thuần của runner biên nhận E2E fleet (scripts/e2e-fleet-bien-nhan.mjs):
// kiểm cây làm việc sạch và XÁC MINH đích thật sự dùng project Supabase TEST.
//
// Nhãn tự khai (FLEET_TARGET_ENV=TEST) không đủ: dev server loopback dựng từ `.env`
// của worktree mặc định trỏ PRODUCTION; một lần quên ghi đè VITE_* là spec ghi dữ liệu
// chạy trên sổ thật trong khi biên nhận vẫn ghi TEST. Nên runner đọc ref Supabase từ
// chính HTML/JS mà đích phục vụ, và chỉ chạy khi tập ref tìm thấy đúng bằng {TEST}.

import { PROD_SUPABASE_REF, TEST_SUPABASE_REF } from './gate-e2e-local-evidence.mjs';

/** Dòng `git status --porcelain --untracked-files=all` khác rỗng ⇒ cây bẩn. */
export function dirtyEntries(porcelain) {
  return String(porcelain ?? '').split(/\r?\n/).map((line) => line.trimEnd()).filter(Boolean);
}

/** Mọi ref `<20 ký tự>.supabase.co` xuất hiện trong văn bản. */
export function extractSupabaseRefs(text) {
  return [...new Set([...String(text ?? '').matchAll(/\b([a-z0-9]{20})\.supabase\.co\b/g)].map((m) => m[1]))].sort();
}

/** `<meta name="build-sha" content="…">` nếu là SHA đủ 40 ký tự; ngược lại null. */
export function extractBuildSha(html) {
  const tag = String(html ?? '').match(/<meta\b[^>]*\bname=["']build-sha["'][^>]*>/i)?.[0];
  const value = tag?.match(/\bcontent=["']([^"']*)["']/i)?.[1]?.trim().toLowerCase();
  return value && /^[0-9a-f]{40}$/.test(value) ? value : null;
}

/** URL script/module cùng origin được tham chiếu trong HTML hoặc JS (Vite build lẫn dev server). */
export function referencedScripts(text, baseUrl, origin) {
  const found = new Set();
  const add = (spec) => {
    try {
      const url = new URL(spec, baseUrl);
      if (url.origin === origin && /\.(?:m?js|tsx?)$/.test(url.pathname)) found.add(url.origin + url.pathname);
    } catch { /* không phải URL */ }
  };
  const source = String(text ?? '');
  for (const m of source.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["']/gi)) add(m[1]);
  for (const m of source.matchAll(/<link\b[^>]*\bhref=["']([^"']+\.m?js)["']/gi)) add(m[1]);
  for (const m of source.matchAll(/["'`]((?:\.{1,2}\/|\/)[^"'`\s?#]+?\.(?:m?js|tsx?))["'`]/g)) add(m[1]);
  // __vite__mapDeps liệt kê "assets/x.js" tương đối với gốc site.
  for (const m of source.matchAll(/["'`](assets\/[^"'`\s?#]+?\.m?js)["'`]/g)) add(`${origin}/${m[1]}`);
  return [...found];
}

/**
 * Đọc HTML và lần theo script cùng origin (giới hạn số file) tới khi thấy ref Supabase.
 * `fetchText(url) → Promise<string>` ném khi lỗi; runner cấp bản thật, test cấp bản giả.
 */
export async function probeTarget({ origin, fetchText, maxFiles = 120 }) {
  const html = await fetchText(`${origin}/`);
  const refs = new Set(extractSupabaseRefs(html));
  // Dev server Vite phục vụ module nguồn đã gắn import.meta.env; build thì trả lại index.html.
  const queue = [`${origin}/src/integrations/supabase/client.ts`, ...referencedScripts(html, `${origin}/`, origin)];
  const seen = new Set(); let fetched = 0;
  while (queue.length && fetched < maxFiles && refs.size === 0) {
    const url = queue.shift();
    if (seen.has(url)) continue;
    seen.add(url); fetched++;
    let body;
    try { body = await fetchText(url); } catch { continue; }
    for (const ref of extractSupabaseRefs(body)) refs.add(ref);
    for (const next of referencedScripts(body, url, origin)) if (!seen.has(next)) queue.push(next);
  }
  return { supabaseRefs: [...refs].sort(), buildSha: extractBuildSha(html), filesScanned: fetched };
}

/** Chỉ đúng {TEST}. Thiếu, lẫn production hay ref lạ đều dừng — không chạy spec. */
export function verifyTestTarget({ supabaseRefs }) {
  if (!supabaseRefs?.length) return { ok: false, problem: 'Không đọc được project Supabase của đích (HTML/JS không lộ <ref>.supabase.co; preview cần VERCEL_AUTOMATION_BYPASS_SECRET?)' };
  if (supabaseRefs.includes(PROD_SUPABASE_REF)) return { ok: false, problem: 'Đích dùng Supabase PRODUCTION — dừng, không chạy spec.' };
  if (supabaseRefs.length !== 1 || supabaseRefs[0] !== TEST_SUPABASE_REF) return { ok: false, problem: `Đích dùng project Supabase không phải TEST: ${supabaseRefs.join(', ')}` };
  return { ok: true, ref: TEST_SUPABASE_REF };
}
