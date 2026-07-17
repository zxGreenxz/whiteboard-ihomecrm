# T9 — Retention clock + cleanup runbook (khởi tạo 2026-07-18)

> T9 KHÔNG phải "xoá ngay". Bản chất T9 = GIỮ legacy read-only tối thiểu một
> retention window, rồi MỚI cleanup sau khi có bằng chứng zero-legacy-traffic +
> backup mới + audit. Mọi drop/revoke là cửa 1 chiều trên dữ liệu tài chính →
> khoá theo lịch, KHÔNG bỏ qua kể cả khi owner nói "làm hết".

## Đồng hồ retention

| Mốc | Giá trị |
|---|---|
| T0 retention (bắt đầu giữ) | **2026-07-18** (frozen dump `20260717T173258Z-frozen-full`, sha `408e59e0…`) |
| Retention tối thiểu | **90 ngày** → sớm nhất **2026-10-16** |
| Điều kiện thêm | ≥1 chu kỳ nghiệp vụ đầy đủ (month-close + salary + profit) sau cutover đủ ổn |
| Backup post-cutover | `20260717T175241Z-postcutover` (sha `2905b6e5…`), sealed VPS (cipher `f5cc45ef…`) |

## Trạng thái legacy (parachute) — GIỮ NGUYÊN read-write cho tới khi drain

Các đường legacy CÒN LIVE và CHƯA revoke (đúng thiết kế coexistence):
- `record_invoice_payment_v3` (payment) — song song v4, adapter fallback.
- Legacy income-expense / invoice / cashbook / salary / contract hooks + RPC — UI
  các domain này VẪN gọi legacy (canonical writer live nhưng chưa wire UI).
- Legacy authorization: `can_do_on_building` (staff_assignments JSONB) — resolver
  v3 chạy song song; owner đã parity, non-owner staff CHƯA parity.

## Điều kiện BẮT BUỘC trước mỗi bước cleanup (mục 27.6 + T9 spec)

Không drop/revoke bất cứ gì cho tới khi TẤT CẢ đúng:
1. Retention ≥90 ngày + ≥1 business cycle đã qua.
2. **Zero legacy traffic proof**: telemetry chứng minh không caller nào còn dùng
   đường legacy của domain đó (không suy diễn — cần log/metric thật; lưu ý
   log-analytics project hiện TRỐNG, phải bật observability trước).
3. Non-owner staff **parity Gate G = zero unexplained mismatch** (hiện 75 mismatch).
4. Frontend mọi domain đã wire canonical + browser-tested.
5. Backup/recovery mới + restore rehearsal ngay trước cleanup.
6. Independent review ký từng bước.

## Thứ tự cleanup (khi đủ điều kiện — tương lai, KHÔNG phải hôm nay)

Theo tranche nhỏ, mỗi bước một PR + backup + reconcile:
1. Drain: chứng minh runtime evidence không còn caller legacy per-domain.
2. Revoke direct DML + legacy RPC EXECUTE theo đúng signature, từng domain, theo
   thứ tự §27.3 (payment → invoice → income-expense → cashbook → meter →
   deposit/contract → salary).
3. Rotate recovery credentials (database password đã từng qua chat — mục
   CLAUDE.local.md; rotate qua Management API rồi verify pooler login) + update
   escrow key (DPAPI local-only hiện tại → export cho fault-domain).
4. Drop legacy policy/RPC/JSON-fallback/cột thừa theo tranche.
5. Reconcile ledger migration + regen types/docs.
6. Final independent security audit + blank-environment restore certification
   (mục 27.6) → chỉ khi đó mới mark toàn chương trình VERIFIED.

## KHÔNG làm trong window hiện tại (dù có mandate "làm hết")

- KHÔNG drop bảng/cột/policy/RPC legacy.
- KHÔNG revoke legacy EXECUTE/DML (parachute còn load-bearing cho non-owner staff).
- KHÔNG rotate credential đang dùng cho chính window (rotate ở bước cleanup).

Lý do: đây là các cửa 1 chiều trên dữ liệu tài chính thật. Retention là biện pháp
bảo hiểm cuối; bỏ nó đi để "xong sớm" là đúng thứ mà vòng audit 15/07 đã phải sửa.
