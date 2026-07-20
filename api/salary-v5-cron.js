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
import { timingSafeEqual } from "node:crypto";

function safeEqual(a, b) {
  const ba = Buffer.from(String(a), "utf8");
  const bb = Buffer.from(String(b), "utf8");
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
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

  if (!["nightly", "digest", "tier", "score", "close_period"].includes(job)) {
    res.status(400).json({ error: "job không hợp lệ" });
    return;
  }
  const r = await fetch(
    `https://tryymsxyyckgbrmmvozx.supabase.co/functions/v1/salary-v5-jobs?job=${encodeURIComponent(job)}`,
    { method: "POST", headers: { "x-cron-secret": secret } },
  );
  const text = await r.text();
  res.status(r.status).setHeader("Content-Type", "application/json").send(text);
}
