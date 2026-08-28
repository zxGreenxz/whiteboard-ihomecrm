# Runbook — đường hoàn cọc mới: kiểm, diễn tập, và điều kiện khoá đường cũ

**Lập:** 28/08/2026 · thay cho runbook mà Plan 2 Task 8 hứa nhưng chưa từng tồn tại
(`docs/superpowers/runbooks/` trước hôm nay là thư mục không có thật, và kịch bản
rehearsal trong plan gọi 10 tên migration không tên nào nằm trên đĩa).

**Đọc kèm:** `docs/audits/AUDIT-PLAN2-ROOM-LIFECYCLE-REFUND-2026-08-27.md` (11 finding)
và phụ lục kiểm toán cuối `docs/superpowers/plans/2026-07-30-room-lifecycle-refund-v2.md`.

---

## 1. Chuỗi migration THẬT của đường hoàn cọc (thứ tự áp dụng)

Kịch bản rehearsal của Plan 2 Task 8 Step 1 **không chạy được** — nó gọi tên file
theo kế hoạch, còn thi hành đã đổi tên. Chuỗi thật, theo thứ tự:

| # | File | Vai trò |
|---|---|---|
| 1 | `20260731050000_contract_transfer_audit_hardening.sql` | Task 0 — khoá audit hai đường đổi phòng |
| 2 | `20260731051000_room_residence_segments.sql` | Task 0 — RPC segment cư trú (đọc) |
| 3 | `20260731060000_realtime_lifecycle_tables.sql` | publication `contract_terminations` + `contract_transfers` |
| 4 | `20260731063000_signed_deposit_basis.sql` | `resolve_signed_contract_deposit_basis_v1` (cọc thật) |
| 5 | `20260731090000_termination_refund_obligation.sql` | bảng nghĩa vụ + preview + record |
| 6 | `20260731100000_termination_refund_writer.sql` | writer sinh phiếu (CHỜ DUYỆT) |
| 7 | `20260731110000_refund_preview_accept_contract.sql` | preview/record nhận cả id hợp đồng |
| 8 | `20260822093000_termination_customer_refund_items.sql` | các khoản trả khách ngoài cọc |
| 9 | `20260822113000_refund_kpi_split_deposit_vs_other.sql` | KPI tách cọc / không-phải-cọc |
| 10 | `20260828090000_termination_refund_writer_hardening.sql` | **vá F1/F2/F3/F11** (audit 27/08) |

Năm file plan hứa mà **chưa từng được viết** (đừng đi tìm):
`termination_settlement_snapshot`, `termination_writer_canonicalization`,
`termination_refund_read_rpcs`, `room_lifecycle_read_rpc`, `termination_lifecycle_backfill`.

Diễn tập trên clone: apply đúng thứ tự trên bằng
`node scripts/apply-reviewed-migration.mjs <file>` (dry-run mặc định, `--apply` tự backup).
Mỗi file đều tự preflight tiền đề và tự selfcheck — file nào kêu thiếu tiền đề là
chuỗi đang sai thứ tự.

## 2. Bộ kiểm — chạy được NGAY HÔM NAY, lệnh thật

### 2.1 Test SQL (rollback sạch, chỉ đụng org DEMO)

```bash
# Chạy nội dung file này qua Management API (POST /database/query).
# 10 ca: chặn-không-ép / lý-do-ngắn / sổ-ảo / ép-đúng-cách / marker F1 /
# gọi-lại / dấu-vết / lách-phiên-bản (F2) / hồ-sơ-DRAFT (F3).
scripts/tests/test-termination-refund-writer.sql
```

Chạy lần cuối 28/08/2026: **10/10 xanh** trên chính hàm production.
Fixture thẩm quyền là SUPER ADMIN vì org DEMO không có binding `TENANT_OWNER`
cho tới 28/08 (đã gán cho `demo.chunha` — xem §4).

### 2.2 E2E đọc (an toàn chạy bất kỳ lúc nào)

```bash
cd .e2e-fleet
FLEET_PASS_CHUNHA=... npx playwright test \
  specs/termination-refund.spec.ts specs/deposit-refund-status.spec.ts
```

- `termination-refund.spec.ts` — dialog tính số, không tự duyệt (2 ca)
- `deposit-refund-status.spec.ts` — hai bất biến tiền của `/deposits`:
  "Đã hoàn" phải dẫn được mã phiếu; net âm hiện "Khách còn nợ", cấm "Đã hoàn 0đ" (2 ca)

### 2.3 E2E GHI trọn vòng (điều kiện §17.6) — cần fixture

```bash
node scripts/seed-demo-hoan-coc.mjs --seed      # in ra contract number
cd .e2e-fleet
FLEET_FIXTURE_CONTRACT='HD-...' FLEET_PASS_CHUNHA=... \
  npx playwright test specs/termination-refund-full-cycle.spec.ts
cd .. && node scripts/seed-demo-hoan-coc.mjs --don   # BẮT BUỘC dọn
```

Chu trình: hồ sơ thanh lý → nghĩa vụ → phiếu hoàn (đường ép của chủ tổ chức,
kèm lý do) → phiếu ra **CHỜ DUYỆT** → gọi lại lần hai phải trả **đúng phiếu cũ**.

**Chạy lần đầu 28/08/2026: XANH.** Bằng chứng khoá F2 sống: lần bấm thứ hai
record ra phiên bản nghĩa vụ thứ 2 nhưng vẫn chỉ **1 phiếu sống** (`--xem` đo
được `nghia_vu: 2, phieu_song: 1` trước khi dọn).

## 3. Điều kiện khoá đường thanh lý cũ — trạng thái 28/08/2026

§17.6 (31/07): *"khoá đường cũ chỉ sau khi đường mới chạy trót lọt một ca thật"*.

| Điều kiện | Trạng thái |
|---|---|
| E2E trọn vòng thanh lý → nghĩa vụ → phiếu hoàn trên DEMO | ✅ **ĐẠT 28/08** (spec §2.3) |
| 4 lỗi chặn của audit 27/08 (F1/F2/F3 + F4) | ✅ đã vá, đã lên prod (`20260828090000` + commit `dfd44d42`) |
| Một ca hoàn cọc **thật** (org thật, người thật duyệt) đi trọn đường mới | ❌ **chưa** — prod vẫn 0 nghĩa vụ |
| Quyết định của chủ về thời điểm khoá | ⏸ **CHỦ QUYẾT 28/08: TẠM DỪNG** — "đợt 4 tạm dừng lại giữ như cũ tính sau". Đường cũ giữ nguyên; mọi việc ở mục "Khi khoá (Đợt 4)" bên dưới CHƯA được làm và không được tự ý làm khi chủ chưa gật lại |

**Khi khoá (Đợt 4), việc phải làm** — theo Task 2 của plan + F6 của audit:
1. REVOKE `EXECUTE` khỏi `authenticated` trên `terminate_contract_move_out`,
   `terminate_contract_forfeit` (route giữa — chỉ để `_with_credit_v1` gọi).
2. Bỏ `EXCEPTION WHEN OTHERS THEN RAISE WARNING` quanh audit trong
   `terminate_contract_move_out_impl` (`20260822093000_...:380-382`) và
   `terminate_contract_forfeit_impl` — thanh lý mà không ghi được hồ sơ thì DỪNG.
3. Sửa `approve_contract_termination_v1`: thôi `v_refund := coalesce(refund_amount,0)`
   (cột GENERATED), thôi set `refund_date`/`COMPLETED` trước khi có phiếu,
   INSERT phải mang `system_source`.
4. **Ràng buộc cứng:** không đổi chuỗi ghi chú `Quyết toán khi thanh lý DD/MM/YYYY`
   — guard regex trên `payments` đang khớp nó (điều kiện §17.6 ghi rõ).

## 4. Sổ tay sự cố & quyết định trong lúc dựng bộ kiểm (28/08)

- **DEMO không có chủ tổ chức** — vai "Chủ công ty" của DEMO thiếu
  `system_key='TENANT_OWNER'` (org thật có). Đã sửa seed:
  `UPDATE organization_roles SET system_key='TENANT_OWNER', is_system=true`
  cho role `53419790-…` — từ đó `demo.chunha` ép sinh phiếu được trong UI.
  (`system_key` có CHECK đòi `is_system=true` — đặt key mà quên cờ là 23514.)
- **`refund_method` là enum `payment_method` `{TM,TK,TT,CT}`** — không phải text
  tự do; 'CASH' là 22P02. Fixture dùng `TM`.
- Trang `/reports/real-estate/terminations` liệt kê **hợp đồng** TERMINATED/EXPIRED,
  không phải hồ sơ thanh lý — fixture vì thế phải chuyển hợp đồng sang TERMINATED
  và cleanup trả về ACTIVE (seeder chỉ chọn hợp đồng đang ACTIVE để cleanup xác định).
  Nút "Kiểm tra" truyền **contract id** — đó là lý do `20260731110000` tồn tại.
- Trang `/deposits` mở ở chế độ triage "Cần xử lý"; bốn tab sổ cọc chỉ render sau
  khi bấm "Sổ cọc đầy đủ". Spec nào đi thẳng vào tab sẽ treo 20s rồi chết.
- Mã phiếu của badge "Đã hoàn" nằm trong thuộc tính `title` (tooltip), không nằm
  trong text — assert bằng `getAttribute('title')`.

## 5. Rollback

Mỗi lần `--apply` qua lane đều kèm backup full tự động (biên nhận in đường dẫn
manifest, ví dụ 28/08: `ihomecrm-full-2026-08-27T17-27-20-595Z.dump`, 582 bảng).
Khôi phục theo `docs/engineering/PROJECT_CONTRACT.md` (Restore Drill đã diễn tập
trong CI — job `restore-drill`). Riêng các vá hàm: mọi migration của chuỗi này
đều idempotent, muốn quay bản hàm cũ thì re-apply file cũ hơn **chỉ khi** hiểu
rõ selfcheck của file mới sẽ không còn được thoả — an toàn hơn là viết forward-fix.


## 6. Đợt 2 — ĐÃ ĐIỀN 4 BẢNG LUẬT (28/08/2026, chủ chốt "chạy hết")

Điền qua 4 RPC chính thống (`set_commission_tier_v1`, `set_utility_ceiling_v1`,
`set_sale_bonus_cap_v1`, `set_maintenance_rule_v1`) với phiên super admin —
versioned, có `created_by`, retire/đổi được bất kỳ lúc nào bằng chính các RPC đó.

**Nguyên tắc chọn số: KHÔNG bịa. Mọi con số đều là hiện trạng đo được:**

| Bảng | Đã điền | Nguồn số |
|---|---|---|
| `commission_tier_versions` | **46 bậc / 23 toà** | Chép nguyên `buildings.commission_tiers` đang chạy (nguồn client prefill — 34/41 phiếu lịch sử là tiếng vọng của chính nó). VD 102LVT: 5-6 tháng 50%, 10-12 tháng 70% |
| `utility_ceiling_versions` | **24 trần (toà × điện/nước)** | Đỉnh lịch sử phiếu APPROVED của CHÍNH toà đó, chỉ toà ≥2 phiếu. VD 102LVT ELECTRIC = 24.964.000đ |
| `sale_bonus_cap_versions` | **2** (org thật + DEMO, 500.000đ) | Đỉnh lịch sử 19 phiếu Thưởng nóng Sale (max 500k, trung vị 200k) — chưa phiếu nào từng vượt |
| `maintenance_rule_versions` | **2** (org thật + DEMO, máy lạnh) | Giãn cách 5 tháng · `counts_history=FALSE` (KHÔNG khoá 59 phòng lịch sử — bảng tự thiết kế sẵn lối an toàn này) · `enforcement=WARN` (không chặn cứng phòng 2 máy) · KHÔNG đặt giá chuẩn/trần (mới 1 điểm dữ liệu) |

**Đã probe sau khi điền** (28/08): `commission_rate_for_v1(102LVT, 12 tháng)` = 70% ·
`(6 tháng)` = 50% · trần điện 102LVT: bằng đỉnh → `WITHIN_LIMIT`, đỉnh+1 →
`OVER_CEILING` · cap = 500.000.

**Việc nối dây đi kèm** — đo trước khi điền thì động cơ trần điện/nước có **0 caller**:
migration `20260828140000_utility_ceiling_wired_into_pay_bill.sql` nối
`utility_ceiling_check_v1` vào `pay_utility_bill`: vượt trần ⇒ phiếu hạ về
**CHỜ DUYỆT** (kể cả người có quyền duyệt — phải nhìn cảnh báo một lần), lý do nối
vào notes; chưa công bố trần ⇒ hành vi y cũ. Mọi chốt cũ (chống trùng B1, bắt khai
công tơ B2, ngưỡng, maker-can-approve, MẪU NEO) tự kiểm lại trong selfcheck.

**Còn nợ của Đợt 2:** động cơ bảo trì hiện chỉ có `preview_maintenance_rule_v1`
(advisory) và **chưa UI nào gọi** — luật 5 tháng đã đăng nhưng người dùng chưa
thấy cảnh báo trên màn bảo trì. Nối preview vào `MAINTENANCE_BATCH` flow của
/thanh-toan là việc riêng, chưa làm.

**Đổi số về sau:** gọi lại đúng RPC `set_*_v1` (phiên bản mới tự retire bản cũ
cùng slot). Muốn tắt hẳn một luật: retire bằng cách đặt lại rồi xoá? — KHÔNG,
đặt version mới với giá trị chủ muốn; các bảng là append-only có chủ đích.
