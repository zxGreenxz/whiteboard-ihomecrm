// Vercel Cron → chuyển tiếp sang Supabase edge fn salary-v5-jobs (C5 — Vercel Cron là kênh chính).
// Cần env CRON_SECRET trên Vercel (trùng secret đã set ở Supabase Edge Function Secrets).
//
// BẢO MẬT (AUTHORIZATION-PLAN.md §15, §17 Sprint 0 deliverable 10):
// Route này TỰ gắn `x-cron-secret` khi forward, nên PHẢI xác thực caller trước —
// nếu không, bất kỳ ai biết URL đều kích hoạt được job. Vercel Cron tự gửi header
// `Authorization: Bearer <CRON_SECRET>` khi env CRON_SECRET được set, nên ta so
// khớp header đó (constant-time). Không set → 500; admin chạy lại từ UI sau khi sửa env.
//
// Ghi chú: Vercel Cron gọi bằng GET nên KHÔNG ép POST-only (ép POST sẽ làm hỏng
// cron thật). Kiểm soát an ninh cốt lõi là Bearer secret constant-time.
//
// push_drain (§D.0/§D.4/§D.5 — đặc tả thông báo & push):
//   Vercel Hobby ĐÃ DÙNG 2/2 slot cron (`45 23 * * *` nightly, `0 0 * * *` digest) ⇒ KHÔNG xin
//   slot thứ ba. Lượt drain push đi GHÉP vào lượt `job=digest`.
//   Việc ghép nằm TRONG edge function `salary-v5-jobs` (nó chạy digest xong thì chạy tiếp
//   push_drain) — cố ý đặt ở đó chứ không ở đây: nếu Vercel cắt request giữa chừng (Hobby cắt
//   sớm), edge function vẫn chạy nốt phần drain, còn nếu ghép ở route này thì drain không bao giờ
//   khởi động. Khối dưới chỉ là LƯỚI ĐỠ cho trường hợp bản edge function đang deploy còn cũ,
//   chưa biết push_drain: khi đó mới gọi thêm một lượt `job=push_drain`.
//   Gọi drain hai lần là VÔ HẠI (advisory lock + lease + push_send_log khử trùng) nhưng tốn một
//   invocation, nên vẫn kiểm tra trước khi gọi.
import { timingSafeEqual } from "node:crypto";

const EDGE_URL = "https://tryymsxyyckgbrmmvozx.supabase.co/functions/v1/salary-v5-jobs";
const JOBS = ["nightly", "digest", "tier", "score", "close_period", "push_drain"];

function safeEqual(a, b) {
  const ba = Buffer.from(String(a), "utf8");
  const bb = Buffer.from(String(b), "utf8");
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

async function forward(job, secret, timeoutMs) {
  const init = { method: "POST", headers: { "x-cron-secret": secret } };
  if (timeoutMs && typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function") {
    init.signal = AbortSignal.timeout(timeoutMs);
  }
  const r = await fetch(`${EDGE_URL}?job=${encodeURIComponent(job)}`, init);
  return { status: r.status, text: await r.text() };
}

function parseOrNull(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null; // 502/504 của cổng edge trả HTML — không được để JSON.parse ném ra ngoài
  }
}

export default async function handler(req, res) {
  const job = (req.query && req.query.job) || "";
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    res.status(500).json({ error: "CRON_SECRET chưa cấu hình trên Vercel — hãy cấu hình env rồi chạy lại job từ UI admin" });
    return;
  }

  // Xác thực caller: Vercel Cron gửi `Authorization: Bearer <CRON_SECRET>`.
  const authHeader = req.headers["authorization"] || req.headers["Authorization"] || "";
  const bearer = typeof authHeader === "string" && authHeader.startsWith("Bearer ")
    ? authHeader.slice(7)
    : "";
  if (!bearer || !safeEqual(bearer, secret)) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }

  if (!JOBS.includes(job)) {
    res.status(400).json({ error: "job không hợp lệ" });
    return;
  }

  const first = await forward(job, secret);
  let body = first.text;

  if (job === "digest") {
    const parsed = parseOrNull(first.text);
    const ran = parsed && Array.isArray(parsed.ran) ? parsed.ran : [];
    const drainDone = ran.some((x) => x && typeof x === "object" && x.job === "push_drain");
    if (!drainDone) {
      // Lưới đỡ: edge function bản cũ chưa tự ghép drain. Lỗi/timeout ở đây KHÔNG được đổi kết quả
      // của digest — digest mới là thứ Vercel Cron đang chấm.
      let drain;
      try {
        const second = await forward("push_drain", secret, 20000);
        drain = { httpStatus: second.status, result: parseOrNull(second.text) ?? second.text.slice(0, 500) };
      } catch (err) {
        drain = { httpStatus: null, error: String(err).slice(0, 300) };
      }
      body = JSON.stringify(parsed ? { ...parsed, push_drain_fallback: drain } : { digest_raw: first.text.slice(0, 2000), push_drain_fallback: drain });
    }
  }

  res.status(first.status).setHeader("Content-Type", "application/json").send(body);
}
