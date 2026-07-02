// Vercel Cron → chuyển tiếp sang Supabase edge fn salary-v5-jobs (C5 — Vercel Cron là kênh chính).
// Cần env CRON_SECRET trên Vercel (trùng secret đã set ở Supabase Edge Function Secrets).
// Nếu chưa cấu hình env: trả 500 — worker watchdog sẽ tự gọi lại edge fn (fallback tầng 2).
export default async function handler(req, res) {
  const job = (req.query && req.query.job) || "";
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    res.status(500).json({ error: "CRON_SECRET chưa cấu hình trên Vercel — watchdog worker sẽ tự chạy bù" });
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
