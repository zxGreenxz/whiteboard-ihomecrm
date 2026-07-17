# RUNBOOK — Cutover domain #1: PAYMENT/CREDIT (§27.3)

> Trạng thái: `DRAFT — CHỜ OWNER ĐIỀN + GẬT`. Chuẩn bị 2026-07-17 trên commit
> `bf42b218304069ee051f0cbe9d2fcdf17d147a35` (branch `security/authz-preparation`).
> KHÔNG bước nào trong runbook này được chạy trên production khi chưa có chữ ký
> owner ở §OWNER-GATE. Evidence nền: ON-TARGET-VALIDATION-2026-07-17.md
> (15 suite/117 assertion PASS trên staging Supabase + superuser local).

## OWNER-GATE (owner điền — thiếu 1 ô = KHÔNG chạy)

| Trường | Giá trị owner điền |
|---|---|
| Maintenance window (UTC + giờ VN) | ____________________ |
| Canary org | `dddd0000-0000-4000-8000-000000000001` — "iHome CRM (Demo)" (đề xuất; org thật `aaaa…0001` KHÔNG canary vòng đầu) |
| Count cap / ngày | 10 (đề xuất) |
| VND cap / ngày | 5.000.000 (đề xuất) |
| Backup certification ID (dump tươi đầu window — điền lúc chạy) | ____________________ |
| Approval reference (chữ ký owner cho đúng slice này) | ____________________ |

## Phạm vi

- **BẬT**: `record_invoice_payment_v4` (writer canonical, flag-gated, chỉ canary org) — flag `payment.record.v1`.
- **KHÔNG ĐỔI**: `record_invoice_payment_v3` tiếp tục phục vụ mọi org (kể cả canary khi client chưa route v4). Không revoke/drain gì ở vòng canary.
- **KHÔNG bao gồm**: invoice/reversal (domain #2), mọi domain sau.

## P0 — Prerequisite gates (phải đóng TRƯỚC window, theo thứ tự)

| # | Gate | Trạng thái 2026-07-17 | Việc còn lại |
|---|---|---|---|
| P1 | **Gỡ bẫy merge-main**: merge main hiện đồng thời (a) kích hoạt meter frontend wiring KHÔNG flag-gate, (b) đưa workflow hardened lên main khi GitHub environment chưa cấu hình | **MỞ — gate duy nhất còn lại** | (a) flag-gate hoặc tách meter slice khỏi nhánh merge; (b) cấu hình GitHub environment `supabase-production` + reviewer + secret. Owner chọn phương án |
| P2 | **T1a → VERIFIED** | **ĐÓNG 2026-07-17** | Evidence: ACL production `{postgres,service_role}`-only trên cả 2 RPC; deny probe JWT thật đúng signature → 403/42501 cả hai; positive control `get_my_permissions` 200; 0 caller re-grep; observation >1 ngày làm việc không sự cố. Log-analytics của project trống (count=0 kể cả control) + `track_functions=none` — ghi trung thực là kênh không dùng được; kết luận hidden-caller dựa trên ACL-since-16/07 + 0 code caller + app hoạt động bình thường |
| P3 | **Build: tách DDL ledger** | **ĐÓNG 2026-07-17** | `t0_ledger_only.sql` + `t0_flag_hardening.sql` sinh bằng `build-t0-ledger.mjs` (byte-fidelity từ artifact 20260716180000). Test: fresh install + idempotent re-run trên `ledgertest` (restore sạch dump 095450Z), guard append-only probes 2/2, no-op an toàn trên staging (object đã tồn tại), constraint validated 2/2 |
| P4 | **Build: frontend adapter v4 + fallback** | **ĐÓNG 2026-07-17** | `src/lib/paymentRecordRpc.ts` + 29 Vitest PASS + typecheck baseline khớp. Fallback CHỈ trên: PGRST202 (v4 chưa deploy), 55000+"chưa bật" (rollout OFF), 42501 (coexistence — v3 vẫn là authority tới T7 drain, reason ghi telemetry). 23505/55000-khác/validation → throw, KHÔNG fallback. Kèm vá `t1b_01`: **cross-ledger guard** chặn key đã tiêu thụ bên v3 (retry vắt qua flip sẽ double-pay) → 23505 hiển thị; test T9 mới, suite 8/8 PASS staging + local. Residual ghi nhận: v3 KHÔNG voucher-mirror không stamp key → guard không thấy (gap có sẵn của v3) |
| P5 | **Recovery evidence cho window**: dump tươi + hash ngay đầu window (pipeline đã proven ~10 phút) | Pipeline sẵn (095450Z proven; delta storage đã explained+reconciled; off-machine VPS copy verified) | Chạy lúc window mở |

## Artifact + hash (điều kiện hiệu lực: ĐÚNG hash này, apply theo ĐÚNG thứ tự)

Pin 2026-07-17 (sau vòng P2–P4; commit pin = commit chứa runbook revision này):

| Thứ tự | File | SHA-256 | Ghi chú |
|---|---|---|---|
| 1 | `scripts/authz-prepared/t0_ledger_only.sql` | `4a0cb182e5d3dfc8594e9129ac11613b4737d542f4af1dc817700df47963839a` | ledger `canonical_write_operations` + guard append-only (generated `build-t0-ledger.mjs`) |
| 2 | `scripts/authz-prepared/t0_flag_hardening.sql` | `c1b886e0115088db7aaf58dd18dbe137f46445b052d524754f349070c92e5ba3` | storage-check finite/CANARY-complete cho `server_feature_flags` |
| 3 | `scripts/authz-prepared/t2_01_registry_override_possession.sql` | `c17950efdf5694a30d79fa902fb9ec4718678e79cb67b0341940b028974dacb1` | registry/override |
| 4 | `scripts/authz-prepared/t2_02_backfill_owner_and_candidates.sql` | `cd679db46ea25b625988985897337e1b8be83f581477c2b731ef8c4fd8f98bd0` | backfill owner/candidates |
| 5 | `scripts/authz-prepared/t2_03_resolver_v3.sql` | `1cf60ddfe8a1b2105ccdbf17ba50e30acf9dc88300b576849aa688309f3bb712` | resolver + `lock_org_for_decision_v1` |
| 6 | `scripts/authz-prepared/t5_01_rollout_cas.sql` | `cad9bf97c142710c8872da8e9defc70426ebc1de09be949040c9eade16791d73` | rollout CAS (flag mutation non-callable, chỉ qua CAS) |
| 7 | `scripts/authz-prepared/t1b_01_record_payment_v4.sql` | `444ae48b46dd4a97e61bdf85937b95f1b5dcd9975cd3e5a207710882ada730fc` | writer v4 + **cross-ledger guard chống double-pay flip-race**; REVOKE all client roles; flag check trong thân |
| — | Test suite đối chứng `t1b_90` | `247a3e6fe1b5d25d1ffaea10939b9a64ca0792e4e4a3bcd0968b2471290cb537` | **8/8 PASS** staging + local 2026-07-17 (T9 mới: legacy-key conflict) |
| — | Frontend adapter `src/lib/paymentRecordRpc.ts` + test | 29 Vitest PASS, typecheck baseline khớp | KHÔNG wire vào hook cho tới bước W (importer duy nhất là test của nó) |

Mọi edit làm đổi hash ⇒ runbook stale, phải re-hash + re-test staging trước.

## W — Trình tự trong window

1. **Freeze quan sát** (không cần write-fence toàn hệ vì slice additive + flag OFF): ghi UTC start, operator, HEAD SHA.
2. **Dump tươi + hash** → điền Backup certification ID vào OWNER-GATE. 3 replica local + upload sealed VPS (thủ tục 2026-07-17 đã proven).
3. **Baseline reconcile**: `node scripts/reconcile-money.mjs` + SUM 3 bảng tiền, lưu pre-state.
4. **Apply 7 artifact SQL** theo thứ tự bảng trên, `psql --single-transaction -v ON_ERROR_STOP=1` từng file, qua workflow hardened (hoặc psql trực tiếp nếu owner chọn — ghi rõ vào evidence). Deploy frontend adapter (wire hook → `recordInvoicePaymentWithFallback`) trong cùng window; trước flip, adapter tự fallback v3 nên hành vi không đổi.
5. **Verify inert** (flag còn OFF): `evaluate_feature_route('payment.record.v1', <org bất kỳ>)` = `LEGACY`; gọi v4 bằng JWT test → 55000 "writer chưa bật"; gọi v4 bằng `authenticated` trực tiếp trên implementation → 42501; v3 vẫn hoạt động (1 payment demo-org round-trip qua UI). Reconcile = baseline.
6. **Canary ON** (lệnh owner tại chỗ): qua rollout CAS đặt flag `payment.record.v1` = ON cho DUY NHẤT canary org + count cap + VND cap như OWNER-GATE (CAS yêu cầu commit_sha + migration_sha256 + window ID + approval_reference — điền từ bảng này).
7. **Canary test trực tiếp** (demo org, JWT thật): happy path thu tiền; retry cùng idempotency key → same result; khác payload cùng key → conflict; JWT không có `thu_tien.collect` → 42501; cross-org invoice id → deny; concurrency 2 phiên cùng key → đúng 1 effect. Đối chiếu `t1b_90` từng case.
8. **Browser smoke** (Playwright MCP, demo org): thu tiền 1 invoice qua UI, kiểm console/network, số dư/credit đúng.
9. **Reconcile ngay**: SUM tiền + payment count demo org khớp kỳ vọng; org thật KHÔNG đổi.
10. **Đóng window**: ghi UTC end + evidence (không credential) vào docs/authorization/, cập nhật tracker T1b → `APPLIED (canary)`.

## O — Observation (≥1 ngày làm việc trước khi mở rộng)

- Theo dõi: RPC error rate v4, deny bất thường, idempotency conflict, drift tiền demo org, độ trễ p95.
- Trong thời gian observation: KHÔNG mở org thật, KHÔNG tăng cap, KHÔNG domain kế.
- Hết observation sạch → owner quyết riêng: mở rộng org thật (cap mới) → drain v3 (bằng runtime evidence) → revoke direct DML/v3 theo signature (bước T7, gate riêng).

## ABORT (bất kỳ điều nào ⇒ flag OFF ngay, giữ evidence, KHÔNG xóa row tiền)

- Cross-org/unauthorized success bất kỳ; drift tài chính ≠ 0; duplicate payment/posting.
- Orphan/split operation (ledger có, hiệu ứng thiếu — hoặc ngược).
- Happy-path canary bị deny không giải thích được; 3 RPC fail liên tiếp hoặc >1%/5 phút; p95 >2× baseline 10 phút; mất monitoring/telemetry.
- **Rollback = flag OFF (route về LEGACY tức thì) + forward-fix.** Nếu đã post tiền sai: giữ nguyên row, reconcile, tạo reversal đối ứng có audit — cấm delete/revert.

## Ghi chú trung thực

- Runbook này CHƯA chạy được hôm nay: P1–P4 còn mở (P3/P4 là build item ~nửa ngày; P1 là quyết định tách branch + cấu hình GitHub; P2 là check log ~30 phút).
- Staging validation dùng data restore 17/07; production drift sau đó không ảnh hưởng logic writer (per-row state check trong thân hàm) nhưng reconcile baseline phải lấy TẠI window.
- `thu_tien.collect` đã tồn tại trong 212 permission key production; resolver v3 đọc registry chuẩn hóa — verify hiện diện ở bước W.5.
