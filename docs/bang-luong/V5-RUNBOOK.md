# V5 RUNBOOK — vận hành hệ lương v5 (cho chủ + dev)

> Đọc kèm [V5-IMPLEMENTATION-LOG.md](V5-IMPLEMENTATION-LOG.md) (bản đồ revert) và [V5-HE-THONG-LUONG-THUONG-THONG-NHAT.md](V5-HE-THONG-LUONG-THUONG-THONG-NHAT.md) Ch.11 (gates).

## 1. Việc chủ cần làm MỘT LẦN sau deploy

1. **Thêm env `CRON_SECRET` trên Vercel** (Settings → Environment Variables): giá trị = secret `CRON_SECRET` đã đặt trong Supabase → Edge Functions → Secrets. Chưa thêm thì Vercel Cron trả 500 — **worker watchdog vẫn tự chạy bù lúc 08h/09h VN** nên hệ không chết.
2. **Restart worker Zalo** (`worker/index.js`) để nạp block watchdog v5 (caveat cố hữu của worker — như án lệ Web Push).
3. Mở `/reports/coverage` → tab **Cài đặt v5**: đặt `stage = grace` khi bắt đầu chạy thử coverage.

## 2. Lịch job tự động (KHÔNG pg_cron)

| Job | Giờ VN | Kênh chính | Fallback |
|---|---|---|---|
| `nightly` (tier + score; **+ close_period nếu là ngày 1**) | 06:45 | Vercel Cron `45 23 * * *` UTC → `api/salary-v5-cron?job=nightly` | Watchdog worker 08:00 · Nút "nightly" tab Cài đặt v5 |
| `digest` (push tuyến, 1 tin/người/ngày) | 07:00 | Vercel Cron `0 0 * * *` UTC | Watchdog 09:00 · Nút "digest" |

- Mọi run ghi `cron_runs` (UNIQUE job+idem_key = idempotent, bấm lại vô hại).
- **Job không sinh tiền** — cron chết cả tuần không làm sai lương.
- Lệch lịch có chủ đích: close_period chạy 06:45 VN ngày 1 (gộp nightly) thay 03:00 — Vercel Hobby chỉ cho 2 cron/ngày.

## 3. 3 nút của chủ (<10 phút/ngày)

1. **Duyệt phép**: thông báo "Xin phép nghỉ có lương" → gọi RPC `approve_leave(user, date, true/false)` (UI hàng chờ sẽ bổ sung; tạm thời từ thông báo).
2. **Duyệt sự cố thiết bị**: thông báo "Báo sự cố thiết bị" → `approve_device_issue(session_id, true)` → hệ tick tay `MANUAL_DEVICE_ISSUE` có audit.
3. **Nghi án**: `/reports/coverage` tab Nghi án — máy chỉ flag (`v5_flag_day`), nhân viên có **48h kháng nghị** (`v5_appeal`), CHỦ kết án (`v5_verdict`). Xác nhận gian lận = huỷ công ngày đó + tước mốc chuỗi đã khoá của THÁNG (ngày sạch + sàn mềm giữ nguyên; không hồi tố tháng đã LOCK).

## 4. Chu kỳ tháng → chốt tiền v5

1. Ngày 1: job `close_period` tự chạy (chuyển khiên, bank mốc trọn-tháng, vật chất hoá config 💰 pending).
2. Chủ mở `/reports/coverage` tab **Đối soát tháng**: bảng từng người + **3 ASSERT** (trần 6tr/3tr · không nghi án mở · 100% tick PAYMENT join phiếu thu GPS thật).
3. Đủ ✅ và **flag `v5_money` = ON** → bấm **"Ghi tiền v5 vào bảng lương"** (`v5_apply_lock_adjustments` — idempotent, ghi 2 dòng `salary_adjustments` nguồn `ATTEND_V5`/`STREAK_V5`).
4. LOCK bảng lương như quy trình hiện hành (`/finance/salary`) — 2 dòng v5 nằm trong adjustments của tháng.

## 5. Kill-switch (đường lui v3 — diễn tập đã chạy 2026-07-03)

- Tab Cài đặt v5 → tắt **`v5_money`** → mọi lệnh ghi tiền v5 bị RAISE chặn ngay ("v5_money đang TẮT"); coverage/digest/SLA **giữ nguyên**; lương LOCK theo cơ chế cũ. Bật lại = ON.
- Biên bản diễn tập: test L1 (OFF → apply bị chặn) + L2 (ON → apply OK, idempotent) trong V5-IMPLEMENTATION-LOG S4.

## 6. Gates chuyển chặng (tóm tắt — số liệu tab Shadow/Gates)

`off → grace(14d) → shadow_coverage(4 tuần) → shadow_money(3 tháng tròn) → live`
- Thoát grace: 65NTG/32PVC/162NVK mỗi toà ≥1 FULL; không toà D>4 tuần cuối.
- Thoát shadow_coverage: 3 toà trắng giữ nhịp ≤4d 2 tuần liên tiếp; geofence-pass ≥90%; fail-dwell <15%.
- Thoát shadow_money: median best-streak ≥13 (thấp hơn → HẠ mốc bằng config trước); %full-streak 10–60%; variance tạm-tính vs LOCK-shadow = 0 sau khiếu nại.
- **BẬT TIỀN**: 100% quản lý bấm "Tôi đã hiểu" (banner /my-day) + ≥1 case "Báo sự cố thiết bị" duyệt thật trong shadow. Chỉ HẠ ngưỡng bằng config, KHÔNG NÂNG trên dữ liệu; không bật nửa vời từng người.

## 7. Sự cố thường gặp

| Triệu chứng | Xử lý |
|---|---|
| Digest không tới 07:00 | Xem `cron_runs` (tab Cài đặt v5). Thiếu heartbeat → chờ watchdog 09:00 hoặc bấm "digest". Kiểm CRON_SECRET Vercel. |
| "Làm xong sao không thấy công" | Query `salary_award_errors` theo staff/fn_name — mọi RPC v5 log lỗi tại đây, không nuốt im. |
| GPS lệch trong toà bê tông | Nhân viên bấm "Báo sự cố thiết bị" trong phiên (nút khiên) → chủ duyệt 1 chạm. |
| Sửa watchdog worker | Sửa block `V5 WATCHDOG` cuối `worker/index.js` → **PHẢI restart worker**. |
| Revert toàn bộ v5 | Xem V5-IMPLEMENTATION-LOG: `git revert` các commit `feat(salary-v5)` (hoặc tag `pre-v5-salary`) + chạy `scripts/v5_rollback_s{4,3,2,1}.sql` theo thứ tự ngược. |
