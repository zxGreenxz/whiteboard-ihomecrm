# W1 — Window cutover PAYMENT/CREDIT (canary demo org) — EVIDENCE

> Thực thi 2026-07-17 23:52 → 2026-07-18 00:5x ICT (16:52 → 17:5x UTC 17/07).
> Owner ủy quyền toàn phần qua chat ("bạn tự làm hết luôn đi") — approval reference
> `OWNER-DELEGATED-CHAT-2026-07-17-lam-het`. Không credential/PII trong file này.

## Kết quả một dòng

**Canary CANONICAL sống trên production cho DUY NHẤT org Demo; org thật LEGACY,
tiền khớp baseline từng đồng; 3 defect bị bắt + vá TRONG window nhờ chính các
lớp phòng thủ của thiết kế; 2 phát hiện dữ liệu lớp T6a có giá trị lâu dài.**

## Danh tính window

| Trường | Giá trị |
|---|---|
| Backup cert | `20260717T165216Z-db-portable` — full.custom 43.289.898B, sha256 `8ba8b0af5a15ed1c64ded3e4b33b59b5f9ae4187d73ec19122d9ea92f22d2a75`, TOC 4.728, đủ TABLE DATA các bảng tiền |
| Frontend deploy | main `e4eec85d…ca440d` (Vercel Ready 37s, project `ihomecrm`, domain chillhome.io.vn/ptcrm.vercel.app) |
| SQL applied (theo thứ tự) | t0_ledger_only `4a0cb182…`, t0_flag_hardening `c1b886e0…`, t2_01 `c17950ef…`, t2_02 `cd679db4…`, t2_03 `1cf60ddf…`, t5_01 `cad9bf97…`, t1b_01 **final** `5041ac2ed625850c418c81ebdd3c704c7e0d0718e5631ad3177960694655a934` (2 hotfix trong window, xem F2/F3) |
| Flag | `invoice.record_payment.v1` = CANARY (config v2), starts now → +7d, cap 10 ops / 5tr đơn / 5tr tổng; canary org `dddd…0001` (iHome CRM Demo) |
| Wrapper ACL | `record_invoice_payment_v4`: `{postgres, authenticated}` (grant tại flip; xem F5) |
| Canary actor | `demo.ketoan@…local` (demo STAFF; password reset qua GoTrue admin cho window — owner đổi lại sau observation) |

## Trình tự + bằng chứng

1. **Pre-flight**: catalog production sạch (0 object prepared); route LEGACY.
2. **W.2 dump** + hash như bảng trên.
3. **W.3 baseline**: real 957 payments/3.886.037.563 · 837 inv/4.112.182.330 · IE 10.390.345.149; demo 3/11.140.000 · 6/29.920.000 · IE 700.000.
4. **W.4a apply 7 artifact** — lần 1 fail statement-timeout do **F1 zombie**; sau kill: 7/7 ok trong 8 giây.
5. **W.5 inert**: route LEGACY cả 2 org; v4 ACL postgres-only; v3 nguyên; sums == baseline.
6. **Fixture**: membership demo + staff perms + override `thu_tien.collect` cho test-account (RLS `*_hide_demo_admin` giấu demo khỏi admin → F6) và demo.ketoan (3 lớp verify: `can_do=t`, resolver `MEMBER_ALLOW`, RLS thấy hoá đơn demo).
7. **PRE-FLIP e2e (browser production-preview, demo.ketoan)**: thu 10.000đ B101 → network `v4 403 → v3 200`; payment+voucher tạo, ledger v4 = 0 row. **Fallback adapter đúng thiết kế trên production.**
8. **W.4b merge main** → Vercel Ready.
9. **W.6 FLIP**: canary_orgs + CAS CANARY (release identity đầy đủ) + grant wrapper → route demo CANONICAL / real LEGACY.
10. **W.7 POST-FLIP**:
    - UI thu 20.000đ: v4 chạy nhưng resolver deny `TARGET_CROSS_ORG_OR_MISSING` (→ **F4**), adapter fallback v3 200 — user không gãy, đúng coexistence.
    - Direct REST (JWT demo.ketoan, sổ + loại thu DEMO hợp lệ): **v4 200 CANONICAL** — payment `5f8790c1…`, voucher `fdcd8223…`, paid 60.000, ledger completed, ops-row 30.000.
    - **Replay cùng key**: lần đầu 23505 SAI (→ **F3**, vá + re-test 10/10 + re-apply) → sau vá: **200 trả đúng payment_id gốc**.
    - **Over-cap 6tr**: 55000 "vượt hạn mức đơn lẻ canary" (→ enforce sống nhờ **F2**).
    - Cross-org account/type: 42501 (bằng chứng sống của F4).
11. **W.9 reconcile**: real org **khớp baseline tuyệt đối** (957/3.886.037.563/4.112.182.330/10.390.345.149); demo +3 payments = 60.000đ đúng bằng 3 op test; `demo voucher → sổ org thật` = **0** (sau forward-fix); route demo CANONICAL/real LEGACY.

## Findings (đánh số W1-F*)

- **F1 — Zombie session**: pg_dump sáng 17/07 bị pooler drop để lại session `idle in transaction` **7h33m** giữa COPY → DDL statement-timeout. Kill `pg_terminate_backend`; bài học runbook: check `pg_stat_activity` đầu window.
- **F2 — Ops-cap gap (thiết kế)**: v4 không ghi `server_feature_flag_operations` → count-cap không bao giờ tăng, VND-cap không ai enforce → cap canary chỉ là config suông. Vá trong t1b_01 (FOR UPDATE flag, enforce single/total cho CANARY, insert ops-row idempotent) + test T10. Enforce sống đã probe (6tr → 55000).
- **F3 — Guard-order bug (do chính window này thêm ở P4)**: cross-ledger guard đặt TRƯỚC replay-lookup → voucher do v4 tự stamp key làm replay 23505 nhầm. t1b_90 không lộ vì replay-test không kèm voucher. Vá (guard chỉ cho claim mới, sau replay-return) + test T5b; replay live trả original chuẩn.
- **F4 — Cross-org defaults trong flow demo (lớp T6a, GIÁ TRỊ LÂU DÀI)**: màn Thu tiền của demo dùng mặc định **sổ quỹ "Chung" (org THẬT)** và **loại thu "Thu tiền hoá đơn" (org THẬT)**. Legacy v3 nuốt → 2 phiếu window (10k/20k) dính, đã forward-fix về "DEMO Quản Lý Thu"; quét lịch sử = 0 tồn dư khác. v4+resolver chặn đúng cả hai. Kéo theo: demo user ĐỌC được account org thật (RLS gap cross-org read trên `accounts`) — backlog T6a; và UI demo cần config sổ/loại thu demo trước khi flow UI demo route CANONICAL (hiện fallback v3 an toàn).
- **F5 — Re-apply wipe grant (vận hành)**: t1b_01 kết thúc bằng `revoke all` (by design). Mọi lần re-apply SAU flip phải kèm re-grant wrapper. Đã thêm vào mục Ghi chú runbook.
- **F6 — `*_hide_demo_admin`**: policy có sẵn giấu dữ liệu demo khỏi admin thật → canary actor phải là user demo. Không phải defect.
- Ghi chú nhỏ: PostgREST map 55000 → HTTP 500 (adapter phân loại theo `code` nên không ảnh hưởng hành vi).

## Trạng thái sau window + việc còn lại

- T1b: **APPLIED (canary demo)** — observation ≥1 ngày làm việc trước khi owner quyết mở org thật.
- Org thật: 100% LEGACY (v3), không đổi hành vi, tiền bất biến.
- Theo dõi observation: RPC v4 error-rate, `[payment-w1] v4 denied` telemetry (console), ops-rows, drift demo.
- Owner nên: đổi lại password `demo.ketoan`; quyết thời điểm mở rộng org thật (CAS mode ON hoặc canary_orgs += real org, cap mới); backlog F4 (config demo UI + RLS accounts read).
- 3 payment test (60.000đ) + 3 voucher nằm ở org Demo — giữ làm chứng cứ, không xoá (no-delete).
