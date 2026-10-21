// salary-v5-jobs — edge function TRANSPORT cho các job v5 (logic nằm trong DB).
// Jobs: nightly (tier + score + close_period nếu là ngày 1 VN) · digest · push_drain · hoặc job lẻ để "Chạy lại".
// Auth (1 trong 3): x-cron-secret == CRON_SECRET · Bearer service_role · JWT user là admin (nút Chạy lại).
// Idempotent qua cron_runs (job, idem_key=ngày VN); job KHÔNG SINH TIỀN — fail không sai lương.
//
// push_drain: từ 21/10/2026 (B12) drain hàng đợi push E1–E6 chạy CHÍNH ở edge `lifecycle-reminders`
// mỗi 15' (pg_cron + pg_net). Digest KHÔNG còn ghép drain. Job `push_drain` ở đây chỉ còn là nút
// "Chạy lại" của admin và lưới đỡ Vercel (api/salary-v5-cron.js), dùng CHUNG một module
// supabase/functions/_shared/push-drain.ts:
//     rpc notify_claim_push_batch_v2()  → claim + lease + gộp theo (người, công ty)
//     fetch send-push (service_role)    → contract §D.1a, LUÔN đọc `outcome`
//     rpc notify_settle_push_batch_v2() → đóng lô THEO OUTCOME, không theo HTTP status
//     rpc notify_drain_record_run_v1()  → ghi vết lượt chạy
// Chống chạy chồng do advisory xact lock trong RPC claim lo, KHÔNG dùng cron_runs: cron_runs khoá
// theo (job, ngày) nên đăng ký push_drain vào đó là tự cấm chạy lần thứ hai trong ngày — trái hẳn
// mục đích của một hàng đợi.
import { createClient } from "npm:@supabase/supabase-js@2";
import { callSendPush, DELIVERED_OUTCOMES, formatEdgeError, runGenericPushDrain } from "../_shared/push-drain.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const CRON_SECRET = Deno.env.get("CRON_SECRET") ?? "";

const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

// CORS: nút "Chạy lại" gọi thẳng từ trình duyệt (ptcrm.vercel.app) → cần preflight.
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

function vnDate(): string {
  return new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);
}

async function isAdminJwt(authHeader: string | null): Promise<boolean> {
  if (!authHeader?.startsWith("Bearer ")) return false;
  const token = authHeader.slice(7);
  if (token === SERVICE_KEY) return true;
  try {
    const userClient = createClient(SUPABASE_URL, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: authHeader } },
      auth: { persistSession: false },
    });
    const { data, error } = await userClient.rpc("is_admin");
    return !error && data === true;
  } catch {
    return false;
  }
}

async function runOne(job: "tier" | "score" | "close_period", idem: string) {
  const { data: started, error: e1 } = await admin.rpc("v5_cron_start", { p_job: job, p_idem: idem });
  if (e1) throw e1;
  if (!started) return { job, skipped: true }; // đã chạy (idempotent)
  try {
    const { data, error } = await admin.rpc("v5_run_job", { p_job: job });
    if (error) throw error;
    await admin.rpc("v5_cron_finish", { p_job: job, p_idem: idem, p_rows: 0, p_error: null });
    return { job, result: data };
  } catch (err) {
    // PostgrestError là object trần: String(err) = '[object Object]' (NOTIF-SERVER-3). Ghi JSON.
    await admin.rpc("v5_cron_finish", { p_job: job, p_idem: idem, p_rows: 0, p_error: formatEdgeError(err) });
    throw err;
  }
}

async function runDigest(idem: string) {
  const { data: started, error: e1 } = await admin.rpc("v5_cron_start", { p_job: "digest", p_idem: idem });
  if (e1) throw e1;
  if (!started) return { job: "digest", skipped: true };
  try {
    const { data: pushes, error } = await admin.rpc("v5_run_digest");
    if (error) throw error;
    let sent = 0;
    for (const p of pushes ?? []) {
      try {
        // idempotencyKey là BẮT BUỘC ở contract §D.1a (thiếu ⇒ 400 BAD_REQUEST). Namespace riêng
        // `v5-digest:` để không bao giờ đụng khoá md5 của drain.
        const r = await callSendPush(fetch, SUPABASE_URL, SERVICE_KEY, {
          idempotencyKey: `v5-digest:${idem}:${p.user_id}`,
          userId: p.user_id, title: p.title, body: p.body, url: p.url,
          tag: `v5-digest-${idem}`,
        });
        if (DELIVERED_OUTCOMES.has(r.outcome)) sent++;
      } catch (_) { /* push lỗi không chặn digest */ }
    }
    await admin.rpc("v5_cron_finish", { p_job: "digest", p_idem: idem, p_rows: sent, p_error: null });
    return { job: "digest", pushes: (pushes ?? []).length, sent };
  } catch (err) {
    await admin.rpc("v5_cron_finish", { p_job: "digest", p_idem: idem, p_rows: 0, p_error: formatEdgeError(err) });
    throw err;
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const url = new URL(req.url);
  const job = url.searchParams.get("job") ?? "";
  const secretOk = CRON_SECRET !== "" && req.headers.get("x-cron-secret") === CRON_SECRET;
  const jwtOk = await isAdminJwt(req.headers.get("Authorization"));
  if (!secretOk && !jwtOk) {
    return json({ error: "unauthorized" }, 401);
  }

  const today = vnDate();
  const out: unknown[] = [];
  try {
    if (job === "nightly") {
      out.push(await runOne("tier", today));
      out.push(await runOne("score", today));
      if (today.endsWith("-01")) {
        out.push(await runOne("close_period", today.slice(0, 7))); // idem theo tháng
      }
    } else if (job === "digest") {
      // Không ghép drain nữa: cron 15' ở lifecycle-reminders đã lo hàng đợi push.
      out.push(await runDigest(today));
    } else if (job === "push_drain") {
      // Một lần bấm "Chạy lại" = một lượt drain đầy đủ (lặp tới rỗng, tối đa 5 vòng claim).
      const drain = await runGenericPushDrain(
        (name, args) => admin.rpc(name, args),
        fetch,
        SUPABASE_URL,
        SERVICE_KEY,
      );
      out.push(drain);
      // Lỗi giao vận từng lô nằm trong drain.failures/outcomes (UI tự cảnh báo); 500 chỉ khi chuỗi
      // claim → settle → record_run hỏng, giống hành vi cũ (lỗi RPC ném ra tầng dưới).
      if (!drain.ok) return json({ ok: false, error: drain.error ?? drain.recordError, ran: out }, 500);
    } else if (job === "tier" || job === "score") {
      out.push(await runOne(job, today));
    } else if (job === "close_period") {
      out.push(await runOne("close_period", today.slice(0, 7)));
    } else {
      return json({ error: "job không hợp lệ" }, 400);
    }
    return json({ ok: true, ran: out });
  } catch (err) {
    return json({ ok: false, error: formatEdgeError(err), ran: out }, 500);
  }
});
