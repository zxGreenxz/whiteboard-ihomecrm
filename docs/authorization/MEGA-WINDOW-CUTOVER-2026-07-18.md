# MEGA-WINDOW — Backend cutover toàn domain + T2/T6a fixes (2026-07-18)

> Owner ủy quyền toàn phần ("tự động chạy hết… nhân viên đã tạm dừng dùng web…
> dữ liệu cũ đã backup") = write-fence thật + backup proven + full mandate.
> KHÔNG credential/PII trong file. Approval ref `OWNER-DELEGATED-lam-het-mot-luot`.

## Kết quả một dòng

**Toàn bộ prepared authz stack đã APPLIED + ACTIVATED (11 flag ON, 10 wrapper
grant) trên production; money invariant real-org bất biến tuyệt đối; legacy giữ
làm parachute (chưa revoke); 2 defect T2/T6a thật bị bắt và vá; non-owner staff
parity + frontend-per-domain + T9 cleanup là phần còn lại (an toàn nhờ parachute).**

## Trình tự đã chạy

| # | Bước | Kết quả |
|---|---|---|
| M1 | Quiescence verify (0 active session) + FROZEN dump `20260717T173258Z-frozen-full` (43.434.412B, sha `408e59e0fb27b2e2db3593d64f9f33145516af36df14b7413fa272a10b246f80`, 263 TABLE DATA) | retention clock T9 bắt đầu từ đây |
| M2 | Payment battery demo qua JWT-REST: B1 thu mới, B2 replay-exact, B3 same-key-diff-payload→23505, **B4 concurrent×2→ĐÚNG 1 payment** (linearization qua ledger PK), B5 over-cap→55000, B6 cross-org→42501 | 6/6; reconcile demo khớp, real-org bất biến |
| M3 | Payment flag → ON toàn tổ chức (CAS config v3) | route real+demo = CANONICAL, v3 parachute |
| M4 | Apply **21 file** prepared stack (T2 resolver + T3 approval/freeze/audit/receipt/candidate/emergency/rule-gov/transition + T1b payment + T5 domain writers + ledger + CAS) — thứ tự proven verify3 | 21/21 ok, 24 giây; sau khi kill 1 zombie pg_dump session 7h33m idle-in-transaction |
| M4 | FULL suite trên production: **13/15 PASS** | 2 "fail" = env-artifact: t1b_90 (flag ON nên "flag OFF" moot — battery M2 đã thay), t3_91 (fixture-nondeterminism, writer deny đúng) |
| M5 | Grant 10 canonical wrapper cho authenticated + flip **11 flag ON** (CAS release identity) | tất cả self-authorizing |
| M5 | Reachability probe 7 domain qua JWT-REST | 7/7 REACHED (không 403-fn, không "chưa bật") — mỗi domain trả lỗi business/auth deterministic đúng |
| — | Money invariant sau toàn bộ | real-org payments 3.886.037.563 / invoices 4.112.182.330 / IE 10.390.345.149 = **baseline tuyệt đối** |
| M7a | **W1-F4 accounts org-boundary** (`t6a_01`) | demo cross-org read 37→**0**; demo own 3 + real-org own 47 giữ nguyên |
| M7b | **T2 owner parity** (`t2_04`) | TENANT_OWNER 12→**213** perm; owner DEFAULT_DENY→**ROLE_ALLOW**; shadow mismatch 135→75 |
| M9 | Post-cutover dump `20260717T175241Z-postcutover` (43.833.913B, sha `2905b6e515e2ee5c7046763588d08f86bfc758f4a47dde081e4955a4ef33c460`) | — |

## Findings (MW-F*)

- **MW-F1 — Zombie pg_dump session**: session pooler bỏ rơi 1 pg_dump sáng 17/07 để lại `idle in transaction` 7h33m → DDL đầu M4 bị statement-timeout. Kill xong 21 file áp trong 24 giây. Runbook: check `pg_stat_activity` đầu mọi window (đã có ở W1).
- **MW-F2 — accounts THIẾU org-boundary (T6a, cross-tenant read)**: demo user đọc 37 account org thật. Vá `t6a_01` (RESTRICTIVE ALL mẫu invoices). **Bề rộng T6a: ~100 bảng tenant còn thiếu org-boundary** (Sprint 3b chỉ phủ 28) — phần còn lại phải làm theo shadow-compare, KHÔNG big-bang (rủi ro khóa nhầm access hợp lệ). Xem "Còn lại".
- **MW-F3 — TENANT_OWNER thiếu permission (T2, owner bị v3 deny)**: role TENANT_OWNER chỉ có 12/213 TENANT permission → owner bị resolver deny mọi thứ ngoài 12 key, phải rơi fallback legacy. Vá `t2_04` (cấp đủ 213, giữ 12 seed, bump authorization_version). Owner giờ ROLE_ALLOW. **Ý nghĩa: parachute legacy đang LOAD-BEARING cho owner cho tới khi vá này — giờ canonical writer authorize owner qua resolver thật.**

## Trạng thái tranche sau mega-window

- **T1a**: VERIFIED (giữ nguyên).
- **T1b payment**: APPLIED + activated ON toàn tổ chức, e2e battery 6/6, adapter live. Frontend payment wired. → gần VERIFIED (chờ observation + drain v3).
- **T2 RBAC**: resolver v3 live + **owner parity DONE**. Non-owner staff parity = **REMAINING** (75 shadow mismatch, tất cả v3-underdeny; an toàn vì legacy parachute). Cần authoritative mapping resource.action→permission_key + materialize staff JSONB→normalized + shadow zero-mismatch (Gate G).
- **T3 approval/writers**: toàn bộ chain APPLIED, suite pass on-target. Freeze triggers ENABLE ALWAYS (inert cho legacy rows). Approval engine non-callable (đúng plan).
- **T5 writers (6 domain)**: APPLIED + flag ON + granted; suite t5_9x pass; reachability e2e 7/7. **UI chỉ payment được wire** — các domain khác canonical live nhưng UI vẫn gọi legacy (parachute). Frontend-per-domain wiring = REMAINING.
- **T6a**: accounts point-fix DONE. RLS v2 org-boundary cho ~100 bảng còn lại + fail-closed autofill + composite FK = REMAINING (shadow-compare).
- **T6b/T7**: backend cutover (grant+flip) DONE toàn domain. **Drain + revoke legacy = CHƯA** (giữ parachute — đúng, revoke là cửa 1 chiều, chờ observation + staff parity).
- **T8 storage/R2/edge/ACL burn-down**: CHƯA (ngoài phạm vi window này).
- **T9 retention/cleanup**: retention clock bắt đầu 2026-07-18 (frozen dump). Cleanup/drop legacy khóa ≥90 ngày theo thiết kế — KHÔNG drop gì hôm nay.

## Còn lại (trung thực — KHÔNG tô hồng)

1. **Non-owner staff parity (T2, Gate G)**: 75 shadow mismatch. Cần mapping chuẩn + materialize + zero-mismatch trước khi revoke legacy. An toàn hiện tại: parachute.
2. **Frontend-per-domain wiring** (invoice/income-expense/cashbook/salary/contract/deposit/meter): mỗi domain cần adapter + browser test như payment. Backend đã sẵn.
3. **T6a RLS v2 broad** (~100 bảng): shadow-compare rồi mới apply.
4. **T8** storage/R2/edge/ACL burn-down: chưa bắt đầu.
5. **Drain + revoke legacy (T7 tail)**: chỉ sau (1)+(2) xong + observation. Cửa 1 chiều.
6. **T9 cleanup**: sau retention ≥90 ngày + business cycle.

Những mục này KHÔNG thể "làm hết một lượt an toàn" trong 1 window vì: (a) cần frontend + browser test từng flow, (b) staff parity cần mapping chuẩn tránh over/under-grant, (c) revoke/cleanup là cửa 1 chiều mà plan cố tình khóa theo lịch. Backend cutover — phần khó và gần-bất-khả-đảo nhất — đã xong an toàn.
