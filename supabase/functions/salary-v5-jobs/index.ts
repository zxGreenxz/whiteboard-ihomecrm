// salary-v5-jobs — edge function TRANSPORT cho các job v5 (logic nằm trong DB).
// Jobs: nightly (tier + score + close_period nếu là ngày 1 VN) · digest · hoặc job lẻ để "Chạy lại".
// Auth (1 trong 3): x-cron-secret == CRON_SECRET · Bearer service_role · JWT user là admin (nút Chạy lại).
// Idempotent qua cron_runs (job, idem_key=ngày VN); job KHÔNG SINH TIỀN — fail không sai lương.
import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const CRON_SECRET = Deno.env.get("CRON_SECRET") ?? "";

const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

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
        const res = await fetch(`${SUPABASE_URL}/functions/v1/send-push`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${SERVICE_KEY}`,
            apikey: SERVICE_KEY,
          },
          body: JSON.stringify({ userId: p.user_id, title: p.title, body: p.body, url: p.url, tag: `v5-digest-${idem}` }),
        });
        if (res.ok) sent++;
      } catch (_) { /* push lỗi không chặn digest */ }
    }
    await admin.rpc("v5_cron_finish", { p_job: "digest", p_idem: idem, p_rows: sent, p_error: null });
    return { job: "digest", pushes: (pushes ?? []).length, sent };
  } catch (err) {
    await admin.rpc("v5_cron_finish", { p_job: "digest", p_idem: idem, p_rows: 0, p_error: String(err) });
    throw err;
  }
}

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const job = url.searchParams.get("job") ?? "";
  const secretOk = CRON_SECRET !== "" && req.headers.get("x-cron-secret") === CRON_SECRET;
  const jwtOk = await isAdminJwt(req.headers.get("Authorization"));
  if (!secretOk && !jwtOk) {
    return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
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
    } else if (job === "tier" || job === "score") {
      out.push(await runOne(job, today));
    } else if (job === "close_period") {
      out.push(await runOne("close_period", today.slice(0, 7)));
    } else {
      return new Response(JSON.stringify({ error: "job không hợp lệ" }), { status: 400 });
    }
    return new Response(JSON.stringify({ ok: true, ran: out }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ ok: false, error: String(err), ran: out }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
});
