// salary-v5-jobs — edge function TRANSPORT cho các job v5 (logic nằm trong DB).
// Jobs: nightly (tier + score + close_period nếu là ngày 1 VN) · digest · push_drain · hoặc job lẻ để "Chạy lại".
// Auth (1 trong 3): x-cron-secret == CRON_SECRET · Bearer service_role · JWT user là admin (nút Chạy lại).
// Idempotent qua cron_runs (job, idem_key=ngày VN); job KHÔNG SINH TIỀN — fail không sai lương.
//
// push_drain (§D.0/§D.4): đường giao vận push. pg_net ĐÃ BỊ BÁC (bật lên là mở schema `net` cho
// `anon` vĩnh viễn — §D.0 mục 1-3), nên vòng claim → gửi → settle nằm ở ĐÂY, nơi duy nhất đọc được
// phản hồi HTTP đồng bộ:
//     rpc notify_claim_push_batch_v1()  → claim + lease + gộp theo NGƯỜI
//     fetch send-push (service_role)    → contract §D.1a, LUÔN có `outcome`
//     rpc notify_settle_push_batch_v1() → đóng lô THEO OUTCOME, không theo HTTP status
// Chống chạy chồng do advisory xact lock trong RPC claim lo, KHÔNG dùng cron_runs: cron_runs khoá
// theo (job, ngày) nên đăng ký push_drain vào đó là tự cấm chạy lần thứ hai trong ngày — trái hẳn
// mục đích của một hàng đợi.
import { createClient } from "npm:@supabase/supabase-js@2";

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

// ────────────────────────────────────────────────────────────────────────────────────────────
// send-push — MỘT cửa duy nhất, LUÔN trả outcome.
//
// 🔴 `if (res.ok) sent++` (bản trước, dòng 76) LÀ SAI với contract §D.1a: 207 PARTIAL và 422
// NO_DEVICE đều KHÔNG `res.ok` nhưng 207 là đã gửi được, còn 200 cũ của send-push v15/v17 trả
// HTTP 200 kể cả khi sent=0/failed=N. Suy delivery từ HTTP status là điều §L.3 cấm thẳng.
// Ở đây chỉ đọc `outcome`; status chỉ dùng khi thân phản hồi KHÔNG có outcome (send-push chưa lên
// bản §D.1a) và khi đó suy ra theo sent/failed/total.
// ────────────────────────────────────────────────────────────────────────────────────────────
type PushOutcome =
  | "SENT" | "PARTIAL" | "NO_DEVICE" | "ALL_FAILED" | "DUPLICATE"
  | "PROVIDER_ERROR" | "CONFIG_ERROR" | "BAD_REQUEST" | "UNAUTHORIZED";

interface PushResult {
  outcome: PushOutcome;
  retryable: boolean;
  error: string | null;
  sent: number;
  failed: number;
  httpStatus: number | null;
}

const RETRYABLE_STATUS = (s: number) => s === 408 || s === 429 || s >= 500;

async function callSendPush(payload: Record<string, unknown>): Promise<PushResult> {
  let res: Response;
  try {
    res = await fetch(`${SUPABASE_URL}/functions/v1/send-push`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${SERVICE_KEY}`,
        apikey: SERVICE_KEY,
      },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    // Mạng đứt / cold start quá hạn: CHƯA biết có gửi hay không ⇒ retryable, và khoá khử trùng
    // (push_send_log) bảo đảm lượt sau không gửi trùng.
    return { outcome: "PROVIDER_ERROR", retryable: true, error: String(err).slice(0, 300), sent: 0, failed: 0, httpStatus: null };
  }

  const text = await res.text();
  let body: Record<string, unknown> | null = null;
  try {
    body = text ? JSON.parse(text) as Record<string, unknown> : null;
  } catch {
    body = null; // 502/504 của cổng edge trả HTML — không được để JSON.parse ném ra ngoài
  }

  const errText = (() => {
    const e = body?.error ?? body?.message;
    if (typeof e === "string" && e) return e.slice(0, 300);
    const devices = body?.devices;
    if (Array.isArray(devices)) {
      const bad = devices.find((d) => d && typeof d === "object" && (d as Record<string, unknown>).status !== "sent");
      if (bad) return JSON.stringify(bad).slice(0, 300);
    }
    const errors = body?.errors;
    if (Array.isArray(errors) && errors.length) return JSON.stringify(errors[0]).slice(0, 300);
    if (!res.ok) return `HTTP ${res.status} ${text.slice(0, 200)}`;
    return null;
  })();

  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  const sent = num(body?.sent);
  const failed = num(body?.failed);

  // Đường chính: send-push bản §D.1a tự khai outcome + retryable.
  if (body && typeof body.outcome === "string") {
    const outcome = body.outcome as PushOutcome;
    const retryable = typeof body.retryable === "boolean"
      ? body.retryable
      : RETRYABLE_STATUS(res.status);
    return { outcome, retryable, error: errText, sent, failed, httpStatus: res.status };
  }

  // Đường lùi: send-push v17 (chưa có contract) — suy từ sent/failed/total, KHÔNG từ res.ok.
  const total = num(body?.total);
  if (!res.ok) {
    return {
      outcome: res.status === 401 || res.status === 403 ? "UNAUTHORIZED" : "PROVIDER_ERROR",
      retryable: RETRYABLE_STATUS(res.status),
      error: errText, sent, failed, httpStatus: res.status,
    };
  }
  if (total === 0 && sent === 0 && failed === 0) {
    return { outcome: "NO_DEVICE", retryable: false, error: errText, sent, failed, httpStatus: res.status };
  }
  if (sent > 0 && failed > 0) {
    return { outcome: "PARTIAL", retryable: false, error: errText, sent, failed, httpStatus: res.status };
  }
  if (sent > 0) {
    return { outcome: "SENT", retryable: false, error: null, sent, failed, httpStatus: res.status };
  }
  return { outcome: "ALL_FAILED", retryable: true, error: errText, sent, failed, httpStatus: res.status };
}

const DELIVERED = (o: PushOutcome) => o === "SENT" || o === "PARTIAL" || o === "DUPLICATE";

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
    await admin.rpc("v5_cron_finish", { p_job: job, p_idem: idem, p_rows: 0, p_error: String(err) });
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
        const r = await callSendPush({
          idempotencyKey: `v5-digest:${idem}:${p.user_id}`,
          userId: p.user_id, title: p.title, body: p.body, url: p.url,
          tag: `v5-digest-${idem}`,
        });
        if (DELIVERED(r.outcome)) sent++;
      } catch (_) { /* push lỗi không chặn digest */ }
    }
    await admin.rpc("v5_cron_finish", { p_job: "digest", p_idem: idem, p_rows: sent, p_error: null });
    return { job: "digest", pushes: (pushes ?? []).length, sent };
  } catch (err) {
    await admin.rpc("v5_cron_finish", { p_job: "digest", p_idem: idem, p_rows: 0, p_error: String(err) });
    throw err;
  }
}

interface ClaimRow {
  notification_ids: string[];
  user_id: string;
  idem_key: string;
  title: string;
  body: string;
  url: string;
  tag: string;
}

// §D.4c — claim → gửi → settle. Một lượt = một lô ≤ p_limit dòng, gộp theo NGƯỜI.
async function runPushDrain(limit = 100) {
  // Hai RPC nằm ở app_private (§D.4) và được BỌC bởi hai hàm cùng tên trong schema `public`:
  // PostgREST chỉ expose api/public/graphql_public và service_role KHÔNG có USAGE trên app_private,
  // nên gọi thẳng app_private qua supabase-js là bất khả thi.
  const { data: batch, error: eClaim } = await admin.rpc("notify_claim_push_batch_v1", { p_limit: limit });
  if (eClaim) throw eClaim;
  const rows = (batch ?? []) as ClaimRow[];

  const results: Array<{ idem_key: string; outcome: PushOutcome; retryable: boolean; error: string | null }> = [];
  const tally: Record<string, number> = {};
  for (const b of rows) {
    const r = await callSendPush({
      idempotencyKey: b.idem_key,
      notificationIds: b.notification_ids,
      userId: b.user_id,
      title: b.title,
      body: b.body,
      url: b.url,
      tag: b.tag,
    });
    tally[r.outcome] = (tally[r.outcome] ?? 0) + 1;
    results.push({ idem_key: b.idem_key, outcome: r.outcome, retryable: r.retryable, error: r.error });
  }

  let settled = 0;
  if (results.length) {
    // Settle CHẠY DÙ CÓ LỖI GÌ Ở TRÊN: bỏ qua bước này thì cả lô nằm SENDING tới khi lease 15'
    // hết hạn rồi mới được gửi lại — chậm đúng một chu kỳ cron (hiện là MỘT NGÀY).
    const { data, error: eSettle } = await admin.rpc("notify_settle_push_batch_v1", { p_results: results });
    if (eSettle) throw eSettle;
    settled = Number(data ?? 0);
  }
  // ⚠ outcome 'SENT' = dịch vụ push ĐÃ NHẬN. KHÔNG chứng minh máy đã hiện thông báo (§L.3).
  return { job: "push_drain", batches: rows.length, settled, outcomes: tally };
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
      out.push(await runDigest(today));
      // §D.5: Vercel Hobby đã dùng 2/2 slot cron ⇒ push_drain ĐI GHÉP vào lượt digest, không xin
      // slot thứ ba. Bọc try/catch riêng: drain hỏng KHÔNG được làm digest bị coi là fail rồi
      // Vercel retry cả cụm.
      try {
        out.push(await runPushDrain());
      } catch (err) {
        out.push({ job: "push_drain", ok: false, error: String(err) });
      }
    } else if (job === "push_drain") {
      out.push(await runPushDrain());
    } else if (job === "tier" || job === "score") {
      out.push(await runOne(job, today));
    } else if (job === "close_period") {
      out.push(await runOne("close_period", today.slice(0, 7)));
    } else {
      return json({ error: "job không hợp lệ" }, 400);
    }
    return json({ ok: true, ran: out });
  } catch (err) {
    return json({ ok: false, error: String(err), ran: out }, 500);
  }
});
