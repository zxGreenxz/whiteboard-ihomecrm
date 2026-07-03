# Quy trình nghiệp vụ tổng — từ Lead đến Lợi nhuận

> Tài liệu **xuyên suốt** mọi domain. Nó không lặp lại chi tiết từng bảng/RPC (đã có trong 18 file domain `01`–`18`) mà nối chúng thành **một dòng chảy end-to-end**: từ khi một phòng trống được **chia sẻ công khai** / một khách hẹn (lead) xuất hiện, đi qua cọc (tự khoá phòng `RESERVED`) → ký hợp đồng → vận hành hàng tháng (chỉ số → hoá đơn → thu tiền → sổ quỹ → **bàn giao tiền & đối soát sổ**) → báo cáo → và cuối cùng **chia lợi nhuận cho cổ đông**; song song là 2 nhánh mới: **dấu chân lương v5** (việc/kiểm tra nhà → ngày-công → bảng lương) và **Chat Zalo** phục vụ CSKH. Mỗi khâu chỉ ra: **ai làm**, **page nào**, **hook/RPC/bảng nào ghi**, **trigger/side-effect gì**, **chứng từ sinh ra**. *(Cập nhật 2026-07-03.)*
>
> Đọc kèm: [01-phan-quyen-nhan-su](01-phan-quyen-nhan-su.md), [02-co-cau-toa-nha-phong-dich-vu](02-co-cau-toa-nha-phong-dich-vu.md), [03-khach-hang-lead-ho-so](03-khach-hang-lead-ho-so.md), [04-coc-giu-cho](04-coc-giu-cho.md), [05-hop-dong](05-hop-dong.md), [06-cong-to-chi-so](06-cong-to-chi-so.md), [07-hoa-don-thanh-toan](07-hoa-don-thanh-toan.md), [08-thu-chi-so-quy](08-thu-chi-so-quy.md), [09-kho-vat-tu](09-kho-vat-tu.md), [10-tai-san](10-tai-san.md), [11-cong-viec-su-co](11-cong-viec-su-co.md), [12-co-dong-loi-nhuan](12-co-dong-loi-nhuan.md), [13-bao-cao-dashboard-thong-bao](13-bao-cao-dashboard-thong-bao.md), [14-cai-dat-danh-muc-tai-lieu](14-cai-dat-danh-muc-tai-lieu.md), [15-kenh-cong-khai-sale-thu-tien](15-kenh-cong-khai-sale-thu-tien.md), [16-thanh-ly-hop-dong](16-thanh-ly-hop-dong.md), [17-luong-thuong](17-luong-thuong.md), [18-zalo-chat](18-zalo-chat.md).

---

## 0. Tiền đề: nền tảng cấu hình & phân quyền

Trước khi *bất kỳ* chứng từ nào được tạo, hai domain "nền" phải sẵn sàng:

- **Phân quyền & nhân sự** ([01](01-phan-quyen-nhan-su.md)): mỗi request được phân loại caller theo cây logic `super_admin → owner → tenant_admin (role __superadmin) → staff thường → cổ đông`. Engine RLS hiện hành là bộ helper **RBAC theo toà** (`can_access_building` / `can_do_on_building` / `can_access_org_entity` / `building_of_*` — Tier-2 aware qua `COALESCE(sa.permissions, r.permissions)`, xem [01] §4.3) + `is_super_admin` / `is_admin` (bypass); `staff_can` chỉ còn **legacy trên 3 bảng** accounts/settings/notifications ([01] §4.4). `get_my_permissions()` trả snapshot quyền (Tier 1 role template → Tier 2 `staff_assignments.permissions` override).
- **Cơ cấu BĐS + danh mục** ([02](02-co-cau-toa-nha-phong-dich-vu.md), [14](14-cai-dat-danh-muc-tai-lieu.md)): phải có **toà → tầng → phòng** (`buildings → floors → rooms`; `areas` chỉ là nhãn nhóm toà tuỳ chọn — ô LỌC toà toàn app là `BuildingFilterSelect` phẳng đơn-chọn, `BuildingMultiSelect` chỉ còn cho màn scope/cấu hình, xem [00 §7]) và **dịch vụ/định mức** (`services`, `building_services`, `service_quotas`). `code_sequences` + `generate_code` / `generate_next_code` là engine sinh mã **mồ côi** (FE/trigger không gọi — số HĐ/hoá đơn sinh bằng trigger riêng, xem [14] §4.5). `settings` (JSONB key-value) trên danh nghĩa là **công tắc hành vi** (`invoice_auto_approve`, `invoice_payment_deadline_days`, `contract_e_signing_enabled`…) nhưng ⚠️ hiện **chỉ `payment_auto_approve` có consumer thật** — 19/20 key là "cấu hình ma" ([14] §5.1). `seed_default_settings(p_user_id)` gieo ~20 key mặc định.

Mọi `building_id` / `room_id` xuất hiện ở các khâu sau đều **neo về domain [02]** này; mọi `user_id` (owner) + quyền staff đều neo về **[01]**.

---

## 1. Bản đồ vòng đời tổng

```mermaid
flowchart TD
    classDef cfg fill:#eef,stroke:#669
    classDef doc fill:#efe,stroke:#393
    classDef money fill:#fee,stroke:#933
    classDef branch fill:#fff3d6,stroke:#c90
    classDef pub fill:#e6f7ff,stroke:#28a

    subgraph NEN["Nền tảng (luôn-sẵn-sàng)"]
        RBAC["Phân quyền · Staff · RLS<br/>[01]"]:::cfg
        BDS["Khu vực→Toà→Tầng→Phòng + Dịch vụ<br/>[02]"]:::cfg
        CFG["settings · code_sequences · mẫu in<br/>[14]"]:::cfg
    end

    subgraph PUB["0b· KÊNH CÔNG KHAI [15]"]
        direction TB
        SP["Sale Phòng /sale-phong<br/>token chia sẻ + ảnh sale + sơ đồ tầng"]:::pub
        RT["Khách xem /r/:token (anon)<br/>get_public_available_rooms"]:::pub
        QD["Cọc nhanh 1 chạm (live 4b4f1cd)<br/>QuickDepositModal → phiếu thu is_deposit"]:::pub
        SP --> RT
        RT -.sale đăng nhập có quyền create_deposit.-> QD
    end

    ZL["Chat Zalo — CSKH song song<br/>tư vấn lead · chăm khách trọ · Web Push tin mới<br/>worker zca-js ngoài Vercel · /chat-zalo [18]"]:::pub

    L1["1· LEAD / Khách hẹn<br/>leads (B1→B2→B3) [03]"]:::doc
    D1["2· CỌC giữ chỗ = phiếu thu IE is_deposit mồ côi<br/>(bảng deposits legacy ĐÃ CHẾT) [04]"]:::doc
    RSV["rooms.status = RESERVED (tự động)<br/>recompute_room_reservation [04]"]:::branch
    HD["3· KÝ HỢP ĐỒNG<br/>contracts ACTIVE [05]"]:::doc
    CHK{"Đủ cọc?<br/>recompute_contract_deposit_paid"}:::branch
    CS0["4· Chốt chỉ số đầu<br/>initial_*_reading + meter_readings [06]"]:::doc
    INV0["5· Hoá đơn tháng đầu (cọc thiếu GỘP item 'Tiền cọc')<br/>invoices APPROVED — tổng làm tròn 900đ [07]"]:::money

    subgraph VH["6· VẬN HÀNH HÀNG THÁNG (lặp)"]
        direction TB
        MR["6a· Ghi chỉ số<br/>meter_readings [06]"]:::doc
        MRA["6b· Duyệt chỉ số<br/>(FE thường tạo thẳng APPROVED) [06]"]:::doc
        GEN["6c· Sinh hoá đơn kỳ<br/>generate_invoices_for_building_v2 [07]"]:::money
        PAY["6d· Thu tiền HĐ — 3 luồng:<br/>dialog đơn · bulk · /thu-tien mobile [07][15]"]:::money
        IE["6e· Vào SỔ QUỸ — 1 phiếu thu/lần thu<br/>income_expenses (kqkd_amount loại phần cọc) [08]"]:::money
        BG["6f· BÀN GIAO TIỀN<br/>create/confirm_cash_handover [08]"]:::money
        DS["6g· ĐỐI SOÁT / chốt số sổ<br/>cashbook_reconciliations [08]"]:::money
        MR --> MRA --> GEN --> PAY --> IE --> BG --> DS
    end

    OPS["Vận hành phụ: Sự cố/Công việc [11]<br/>→ xuất vật tư [09] · tài sản [10]"]:::doc
    V5["Dấu chân lương v5: tick ngày-công/chuỗi<br/>inspection_sessions · salary_attendance_day [17]"]:::doc
    SAL["BẢNG LƯƠNG quản lý (v3 + v5)<br/>salary_monthly LOCK → phiếu chi lương [17]"]:::money

    RPT["7· BÁO CÁO + DASHBOARD<br/>+ THÔNG BÁO [13]"]:::cfg
    PROF["8· CHỐT LN THÁNG/TOÀ — fa_monthly_pnl_accrual<br/>trừ lương điều hành → profit_monthly LOCKED [12]"]:::money
    DIST["9· CHIA LN cổ đông<br/>income_expenses EXPENSE (toà ảo Chung) [12]"]:::money

    GIAHAN["Gia hạn — GIỮ ACTIVE<br/>renew_contract + ghi contract_extensions [05]"]:::branch
    CHUYEN["Chuyển phòng / Nhượng HĐ<br/>transfer_room / transfer_contract [05]"]:::branch
    TL_OUT["Thanh lý move-out<br/>terminate_contract_move_out<br/>(net settlement qua sổ CỌC) [05]"]:::branch
    TL_FF["Bỏ cọc<br/>terminate_contract_forfeit<br/>(cọc→doanh thu) [05]"]:::branch
    END(("TERMINATED / EXPIRED")):::branch

    NEN -.cấp scope + cấu hình.-> L1
    NEN -.token + ảnh + layout.-> PUB
    RT -.khách liên hệ Gọi/Zalo.-> L1
    ZL -.nhắn 2 chiều.-> L1
    QD --> D1
    L1 -->|convert| D1
    L1 -.có thể bỏ qua cọc.-> HD
    D1 -.trigger.-> RSV
    D1 --> HD
    HD --> CHK
    CHK -->|Thiếu & chưa ack| HD
    CHK -->|Đủ / đã ack nợ cọc| CS0
    CS0 --> INV0
    INV0 --> VH
    VH --> RPT
    VH -.song song.-> OPS
    OPS --> RPT
    OPS -->|việc COMPLETED có ảnh · phiên kiểm tra nhà| V5
    PAY -.GPS thu tiền.-> V5
    V5 --> SAL
    SAL -.phiếu chi lương + gạch nợ tiền phòng.-> IE
    RPT --> PROF --> DIST

    HD -. mỗi kỳ .-> GIAHAN --> VH
    HD -.-> CHUYEN --> VH
    HD -.-> TL_OUT --> END
    HD -.-> TL_FF --> END
    DIST --> END
```

**Nguyên tắc bất biến xuyên suốt:**

- **Một phòng chỉ có một HĐ đang hiệu lực** tại một thời điểm. "Đang hiệu lực" từ 2026-06-06 **CHỈ là `ACTIVE`** (`isContractInEffect()` / `ACTIVE_CONTRACT_STATUSES = ['ACTIVE']` — [contract.ts](../../src/types/contract.ts)). **`EXTENDED` đã NGƯNG GHI** ([20260606140000](../../supabase/migrations/20260606140000_contract_extended_decouple.sql)): gia hạn GIỮ `ACTIVE`, "đã gia hạn" suy từ `contract_extensions` (`useRenewedContracts` + `RenewedBadge`); guard `IN ('ACTIVE','EXTENDED')` còn sót trong trigger/RPC DB chỉ là lớp **tương thích dữ liệu cũ**.
- **Phòng trống có cọc giữ chỗ tự khoá `RESERVED`** — [`recompute_room_reservation`](../../supabase/migrations/20260608000000_room_reservation_reconcile.sql) (SECURITY DEFINER, idempotent) chuyển `AVAILABLE ↔ RESERVED` theo việc phòng còn cọc chưa-link-HĐ (`deposits` PENDING/CONFIRMED **hoặc** phiếu thu IE có item `is_deposit` — **kể cả phiếu chưa duyệt**, chỉ loại CANCELLED); không đụng OCCUPIED/MAINTENANCE/UNAVAILABLE. Phòng RESERVED ẩn khỏi bucket "trống" toàn FE và hiện như `rented` trên `/r/:token`.
- **`income_expenses` (APPROVED, `deleted_at IS NULL`) là canonical ledger** — nguồn sự thật duy nhất cho số dư sổ quỹ, dòng tiền và P&L; tránh double-count bằng cách báo cáo luôn đọc về đây. Từ 2026-07-02 (`20260702120000`) **P&L cộng `SUM(kqkd_amount)`** — hạch toán KQKD ở mức **hạng mục**: phiếu trộn doanh thu + cọc chỉ tính phần không-cọc, `counts_in_business_result` chỉ còn là cờ filter/badge (xem [08] §4.5).
- **Cọc thực nộp = Σ phiếu thu `is_deposit`**, KHÔNG phải `deposits.status` (xem [04]). Tiền cọc nằm trên sổ quỹ riêng **"CỌC (giữ hộ khách)"** (1 sổ/owner — `get_or_create_deposit_account`); thanh lý tất toán sổ này về 0 cho mỗi HĐ (xem [05] §4.3/§4.4).
- **Tiền chỉ "có thật" khi phiếu IE ở trạng thái APPROVED** — DRAFT/UNAPPROVED/CANCELLED không vào số dư.

---

## 2. Từng giai đoạn — mô tả từng bước

### Giai đoạn 0b — KÊNH CÔNG KHAI: chia sẻ phòng trống → khách xem → cọc nhanh · [15]

Nhánh **tiền-lead** mới (2026-06), chạy song song trước Giai đoạn 1–2:

- **Chuẩn bị (owner/sale có quyền `sale_phong`):** trang [SalePhongPage](../../src/pages/sale-phong/SalePhongPage.tsx) (`/sale-phong`, gate `RequirePermission module="sale_phong"`) — 4 tab: tạo/thu hồi **token chia sẻ** (`public_room_share_tokens`), cài đặt hiển thị (`public_room_settings`: `soon_days`, hotline), upload **ảnh sale** (`rooms.images`/`buildings.images` → bucket **PUBLIC** `room-sale-images` — ngoại lệ duy nhất của quy ước bucket private), editor kéo-thả **sơ đồ tầng** (`buildings.floor_layouts` jsonb).
- **Khách xem (anon, không đăng nhập):** mở `/r/:token` ([PhongTrongPage](../../src/pages/phong-trong/PhongTrongPage.tsx), route ngoài `ProtectedRoute`, lazy-load CSS cô lập) → RPC public `get_public_available_rooms` (SECURITY DEFINER, grant `anon`, scope theo owner của token). `status_public` (`free`/`soon`/`rented`) suy từ **hợp đồng** `ACTIVE/EXTENDED` (không phải `rooms.status`); phòng `RESERVED` rơi vào nhánh `ELSE 'rented'` → **ẩn khỏi danh sách trống**. Khách bấm **Gọi / Zalo / Chỉ đường / Chia sẻ** → trở thành lead (Giai đoạn 1) — không ghi gì vào DB.
- **Cọc nhanh 1 chạm (live từ 4b4f1cd):** sale **đang đăng nhập** mở cùng link, có quyền `sale_phong.create_deposit` → [QuickDepositModal](../../src/pages/phong-trong/QuickDepositModal.tsx) tạo **phiếu thu** `income_expenses` INCOME `contract_id=NULL` vào sổ **"CỌC (giữ hộ khách)"** (`get_or_create_deposit_account`) + hạng mục "Tiền cọc" `is_deposit=TRUE` (RPC [`ensure_room_deposit_type`](../../supabase/migrations/20260608100000_ensure_room_deposit_type_rpc.sql)) → trigger khoá phòng `RESERVED` realtime, phòng rời danh sách trống của **mọi** link chia sẻ (xem [15] §4.6). Đi tiếp vào Giai đoạn 2.

### Giai đoạn 1 — LEAD (Khách hẹn) · [03]

- **Ai:** sale/staff được giao toà. **Page:** [LeadsPage.tsx](../../src/pages/leads/LeadsPage.tsx) (phễu Kanban B1→B2→B3).
- **Bước:** staff tạo lead (nguồn `lead_source`: FACEBOOK/ZALO/PHONE/REFERRAL/WALK_IN/WEBSITE/OTHER), gán `assigned_staff_id` (→ `profiles`), `building_id`/`room_id` quan tâm.
- **Ghi:** bảng `leads`; mỗi tương tác ghi `lead_activities`.
- **Side-effect:** trigger `update_lead_score()` (BEFORE I/U) gán `NEW.lead_score`; `calculate_lead_score()` dùng để backfill. Kéo thẻ qua các cột đổi `lead_status`: `B1_LEAD → B2_APPOINTMENT → B3_CONSULTATION`.
- **Kết quả:** lead chuyển trạng thái `CONVERTED` (đi tiếp sang cọc/HĐ) hoặc `FAILED`. ⚠️ Convert đi đường **legacy và hiện hỏng runtime**: dialog tạo `deposits` PENDING + `tenants` DEPOSITED nhưng gửi key `hold_until_date` trong khi cột DB là `hold_until` → INSERT fail; hook chỉ set `leads.status='CONVERTED'`, **KHÔNG** ghi `leads.deposit_id`/`conversion_date` (FK mồ côi), không tạo `customers`, không đi qua kiến trúc cọc mới (IE `is_deposit` → `deposit_remaining`/RESERVED) — xem [03] §5.1, [04] §5.4.

### Giai đoạn 2 — CỌC giữ chỗ · [04]

- **Ai:** sale. **Page:** [DepositsPage.tsx](../../src/pages/deposits/DepositsPage.tsx) (4 tab: Tổng quan / Đủ-Thiếu cọc / Hoàn-Bỏ cọc / Phiếu giữ chỗ).
- **Bước:** bảng `deposits` là **legacy đã chết** (0 dòng dữ liệu, không UI nào còn ghi — [04] §2.1). **Cọc giữ chỗ THẬT = phiếu thu IE "mồ côi"**: `income_expenses` INCOME `contract_id=NULL` với item loại `is_deposit=TRUE`, tạo từ 3 entry-point cùng đích dữ liệu — ① nút "Tạo đặt cọc" (dialog đã viết lại sang `income_expenses` — [04] §5.4), ② form Thu-chi thường ([08]), ③ **Cọc nhanh** trên trang công khai `/r/:token` (Giai đoạn 0b — sổ "CỌC (giữ hộ khách)", RPC `ensure_room_deposit_type`). Tab "Phiếu giữ chỗ" đọc `useReservationDeposits` từ IE, thống nhất 1 nguồn.
- **Side-effect giữ phòng (tự động — 2026-06-07):** mọi biến động trên `deposits` / `income_expenses` (+items) / `rooms` kích trigger gọi [`recompute_room_reservation`](../../supabase/migrations/20260608000000_room_reservation_reconcile.sql): phòng `AVAILABLE` còn cọc chưa-link-HĐ (deposits PENDING/CONFIRMED **hoặc** phiếu thu có item `is_deposit` — **kể cả phiếu chưa duyệt**, chỉ loại CANCELLED) → `rooms.status='RESERVED'`; hết cọc / huỷ / hoàn / link HĐ → tự gỡ về `AVAILABLE`. Không can thiệp khi phòng có HĐ hiệu lực (OCCUPIED do HĐ sở hữu). FE tách bucket **"Đã cọc"** riêng; trang công khai `/r/:token` xếp RESERVED vào `rented`.
- **Side-effect khi tạo HĐ:** trigger `trg_contract_link_orphan_deposits` tự **link** các phiếu IE cọc "mồ côi" cùng phòng (cửa sổ 7 ngày) vào HĐ; trigger `trg_ie_recompute_contract_deposit` + `trg_ie_items_recompute_deposit` gọi `recompute_contract_deposit_paid` để đẩy Σ cọc APPROVED vào `contracts.deposit_paid`.
- **Chứng từ:** phiếu thu cọc `is_deposit` (mã `PT…` của thu chi). Mã `DCxxxxxx` của bảng `deposits` chỉ còn ý nghĩa lịch sử.
- **Lưu ý:** `deposit_status` (PENDING/CONFIRMED/CONVERTED/REFUNDED/FORFEITED) **không phải nguồn sự thật** — bảng đã chết, RPC thanh lý không cập nhật cột này; các dòng `deposits` PENDING/CONFIRMED cũ chưa-link-HĐ (nếu còn) vẫn tham gia predicate giữ phòng RESERVED ở trên. Riêng **convert lead** vẫn đi đường legacy hỏng runtime (tạo `deposits` với key sai `hold_until_date`, không qua kiến trúc IE — xem [03] §5.1).

### Giai đoạn 3 — KÝ HỢP ĐỒNG · [05]

- **Ai:** staff có quyền `contracts:create` trên toà. **Page:** [ContractsPage.tsx](../../src/pages/contracts/ContractsPage.tsx) → ContractFormDialog.
- **Bước:** chọn phòng + khách (qua junction `contract_customers`, đúng **1 đại diện** — trigger `check_contract_representative()`), nhập `rent_price`, `payment_cycle`, `total_deposit`, dịch vụ áp dụng (`contract_services` với đơn giá riêng + chỉ số đầu).
- **Kiểm tra cọc (gate):** form tính `deposit_remaining = total_deposit − deposit_paid`. Nếu thiếu, **chặn ký** trừ khi admin đặt `deposit_debt_mode` = `DEBT` (cho nợ, kèm `deposit_debt_reason` + `deposit_topup_due_date`) hoặc `FIRST_INVOICE` (thu đủ trong hoá đơn đầu) và bật `deposit_debt_acknowledged`. (Sơ đồ tuần tự ở mục 3b.)
- **Ghi:** `contracts` (status set thẳng `ACTIVE`, `contract_number` sinh bởi trigger, `public_code` 6 ký tự cho link QR `/c/:code`), `contract_customers`, `contract_services`.
- **Side-effect:** trigger `update_room_status_on_contract_change()` đặt `rooms.status = OCCUPIED` (active-set của trigger vẫn là `IN ('ACTIVE','EXTENDED')` — lớp tương thích, xem [05] §4.1); từ lúc HĐ hiệu lực, `recompute_room_reservation` **bỏ qua** phòng này (RESERVED chỉ áp cho phòng chưa có HĐ). Trigger `trg_contract_link_orphan_deposits` link phiếu cọc mồ côi cùng phòng vào HĐ — form cảnh báo trước số cọc giữ chỗ đã thu (`useOrphanDepositVouchers`). Form tạo HĐ **tự tạo phiếu thu cọc** vào sổ **"CỌC (giữ hộ khách)"** (`get_or_create_deposit_account` — 1 sổ/owner, xem [05] §4.4) — từ df24746 phiếu auto **chỉ ghi PHẦN CHÊNH** `deposit_paid − Σ phiếu mồ côi` (hết double-count) — và có thể mở **phiếu hoa hồng** (CommissionVoucherModal) trạng thái UNAPPROVED trong `income_expenses` ([08]). Nếu HĐ tạo từ flow Cọc giữ chỗ (prefill `depositId`) → phiếu `deposits` flip `CONVERTED` + gắn `contract_id` **sau khi** HĐ tạo thành công.
- **Chứng từ:** HĐ + phiếu thu cọc (sổ CỌC) + (tuỳ cấu hình) hoá đơn tháng đầu.

### Giai đoạn 4 — CHỐT CHỈ SỐ ĐẦU · [06]

- **Ai:** staff vận hành. **Page:** form HĐ (cột `initial_electricity_reading` / `initial_water_reading`) và/hoặc [MeterReadingsPage.tsx](../../src/pages/meter-readings/MeterReadingsPage.tsx).
- **Bước:** ghi mốc chỉ số điện/nước lúc nhận phòng. Đây là **previous** cho kỳ chỉ số đầu tiên — `consumption` (cột generated) của kỳ sau = current − previous.
- **Ghi:** `contracts.initial_*_reading` + (nếu lập reading) `meter_readings` (gắn `meters` theo room+service). Trigger `auto_populate_previous_reading` lấy chỉ số kỳ trước.
- **Kết quả:** hệ thống có đủ mốc để tính tiền điện/nước cho dịch vụ `pricing_type = DON_GIA_CO_DINH_DONG_HO`.

### Giai đoạn 5 — HOÁ ĐƠN THÁNG ĐẦU (cọc thiếu GỘP vào) · [07]

- **Ai:** staff. **Page:** [InvoicesPage.tsx](../../src/pages/invoices/InvoicesPage.tsx) hoặc tạo ngay trong flow ký HĐ (preview hoá đơn tháng đầu chỉnh được trong ContractFormDialog, kèm KM tháng đầu — xem [05] §5.1).
- **Bước:** dựng hoá đơn tháng đầu = tiền thuê (theo `start_billing_date`) + dịch vụ. Mode "Đóng đủ" (c09eda2, 2026-06-21): **phần cọc còn thiếu = 1 item `OTHER` mô tả đúng chuỗi "Tiền cọc" GỘP TRONG hoá đơn tháng đầu** — cọc là khoản phải thu của HĐ, không phải phiếu thu lẻ ngoài HĐ; chuỗi "Tiền cọc" là hợp đồng ngầm với flow thu tiền (6e). Mode "Nợ cọc" không gộp — chỉ theo dõi qua `contracts.deposit_remaining`. `firstInvoiceBuilder` đánh dấu dòng điện/nước `METERED_PRICING`.
- **Ghi:** `invoices` + `invoice_items`. Số HĐ sinh bởi trigger `generate_invoice_number_v2`; **`total_amount` làm tròn phần lẻ 900đ về bội 1.000** qua [roundInvoiceTotal](../../src/lib/invoiceUtils.ts) (971abd1 — mọi đường tạo/sửa HĐ ở FE, xem [07] §4.13); trạng thái **FE tạo thẳng `APPROVED`** (key settings `invoice_auto_approve` là "cấu hình ma" — không code nào đọc, xem [14] §5.1).
- **Chứng từ:** hoá đơn tháng đầu (kèm item "Tiền cọc" nếu thiếu cọc).

### Giai đoạn 6 — VẬN HÀNH HÀNG THÁNG (vòng lặp lõi)

Lặp lại mỗi kỳ `billing_month` (YYYY-MM):

1. **6a · Ghi chỉ số** ([06]): staff nhập `meter_readings` (mã `CSS{YYMM}{seq}`), hoặc import Excel qua `bulk_create_meter_readings(p_readings jsonb)` (⚠️ hiện **hỏng runtime** — hook gửi `p_user_id` không có trong signature live → PGRST202, xem [06] §4.7). Triggers `auto_populate_meter_reading_fields` / `auto_populate_previous_reading` / `auto_generate_reading_code` điền sẵn trường (settlement_month/previous_reading bị trigger **ghi đè** kể cả khi client truyền — [06] §4.1/§4.2).
2. **6b · Duyệt** ([06]): RPC `approve_meter_reading` / `bulk_approve_meter_readings` tồn tại nhưng các hook duyệt FE là **dead code** — đường chạy thật: form Thêm chỉ số tạo **thẳng APPROVED**; các dialog hoá đơn (Generate/Excel) cũng tự INSERT reading APPROVED khi lập hoá đơn điện ([06] §6). Chỉ chỉ số APPROVED mới được chọn lên hoá đơn.
3. **6c · Sinh hoá đơn kỳ** ([07]): `generate_invoices_for_building_v2(p_building_id, p_billing_month, p_invoice_type)` (RBAC, delegate xuống v1). Dòng điện/nước = `consumption × unit_price`; tiền thuê + dịch vụ cố định từ `contract_services`/`building_services` + bậc thang `service_quota_tiers`; cộng `previous_debt` (nợ kỳ trước, lưu `previous_debt_sources`); tổng **làm tròn 900đ** (`roundInvoiceTotal` — [07] §4.13). Trigger `recompute_invoice_for_id` suy `status` + `paid_amount` net.
4. **6d · Thu tiền** ([07]): **3 luồng cùng đích dữ liệu** — ① dialog đơn lẻ: `record_invoice_payment_v2(p_invoice_id, p_amount, p_payment_method, p_payment_date, …)` — kiểm `can_do_on_building`, tạo dòng `payments` (TM/TK/TT); khách trả thừa → `excess_amounts` (credit theo HĐ); ② **thu hàng loạt** (BulkRecordPaymentDialog → `useBulkRecordPayment`, insert trực tiếp); ③ trang mobile **`/thu-tien`** ([15] §4.7): `useQuickCollect` bọc `useBulkRecordPayment` đúng 1 item **TM-only**, `user_id` của payment/phiếu = **owner hoá đơn** (không phải staff), resolve sổ TM theo **TÊN** ("…Thu" → "Chung" → trùng tên toà — throw nếu thiếu), tự làm tròn residual < 10K qua sổ "Làm tròn tiền thiếu", kèm GPS nền cho dấu chân v5 ([17] §5.5). ⚠️ Luồng bulk/quick-collect **từ chối HĐ gộp cọc** ("vui lòng thu qua màn hình hoá đơn") — tránh cọc lọt vào KQKD.
5. **6e · Vào sổ quỹ** ([08]): RPC `record_invoice_payment_v2` **không** chèn `income_expenses` — phiếu thu INCOME do **hook FE `useRecordPaymentRPC`** ([useInvoicePayments.ts](../../src/hooks/useInvoicePayments.ts)) mirror **sau** khi RPC trả `payment_id`, và **chỉ khi có `account_id`**. Từ 2026-07-02 ([20260702120000](../../supabase/migrations/20260702120000_kqkd_item_level.sql)): **1 lần thu = ĐÚNG 1 phiếu thu** — với HĐ gộp cọc, phần cọc tách bằng hàm thuần `allocateDepositPortion` (quy ước **PHÒNG-TRƯỚC, CỌC-SAU**) thành **hạng mục `is_deposit` trên CÙNG phiếu**; cột **`kqkd_amount`** (trigger DB) tự loại phần cọc khỏi P&L (mô hình cũ tách 2 phiếu riêng — đã backfill đúng số). Phiếu INCOME gắn `invoice_id + payment_id`, `account_id` đẩy tiền vào sổ quỹ tương ứng (gợi ý `buildings.default_account_id_tt/tk`). Trigger item recompute số dư `accounts_with_balance`. Trigger `recompute_invoice_for_id` trên `payments` đọc Σ payments (trừ phiếu chi "Tiền thối" trong IE) để tính `paid_amount` **net**, suy `status` = PAID/PARTIAL_PAID/APPROVED và làm tròn dư < 10K (OVERDUE suy ở tầng hiển thị theo `due_date`, không do trigger set).
6. **6f · Bàn giao tiền & đối soát sổ** ([08] §4.17, §5.11–5.12): tiền mặt staff đang giữ được **nộp lên** qua `create_cash_handover` (phiên PENDING chọn phiếu gốc; guard người nhận phải **cùng đội** — `same_team()`); người nhận `confirm_cash_handover` → sinh **1 phiếu CHI trên sổ nguồn (chọn được — HandoverSheet "Sổ bàn giao") + 1 phiếu THU tổng kèm hạng mục** trên sổ người nhận; phiếu gốc bị khoá sửa/xoá (`handover_id` + `ie_handover_guard`). Định kỳ chủ/quản lý **đối soát/chốt số sổ** — `cashbook_reconciliations` (system_balance theo NGÀY `as_of`); theo dõi ở 2 báo cáo `/reports/finance/ban-giao` (còn phải nộp = số dư) và `/reports/finance/thu-ban-giao` (chu kỳ Thu→Bàn giao point-in-time, RPC `manager_collection_cycle_report`).

> **Vận hành phụ song song** ([09]/[10]/[11]): khách/staff báo **sự cố** (`issues`, có SLA + workflow) hoặc lập **công việc** (`jobs`, mã `JOB-YYYYMMDD-NNNN`). Khi xử lý có thể **xuất vật tư** (`material_usages.job_id`, snapshot `unit_cost_at_usage`) hoặc bàn giao **tài sản** (`asset_handovers.contract_id`). Chi phí này hiện chưa tự sinh phiếu IE nhưng là dữ liệu chi phí cho phân tích.
>
> **Nhánh lương-thưởng song song** ([17]): hoàn thành việc → `award_job_bonus` (popup BonusToast + Web Push, dedup qua `notifications`) **và** `v5_tick_from_job` (tick ngày-công `salary_attendance_day`); phiên **kiểm tra nhà** (`inspection_sessions` FULL/QUICK, ảnh sha256 + GPS audit) và **GPS thu tiền** (`record_payment_gps`) là 2 nguồn dấu chân còn lại — tất cả đổ về chuỗi/coverage v5 (flags OFF — tiền v5 chỉ vào lương khi chủ bật `v5_money` và bấm chốt). Cuối tháng: chốt **bảng lương v3** (`salary_monthly` LOCK + snapshot ledger) → phiếu chi "Lương quản lý" (toà ảo Chung, ngoài KQKD) + gạch nợ tiền phòng bằng payment `CT`.
>
> **Chat Zalo song song** ([18]): tư vấn lead / chăm sóc khách trọ / nhắc nợ 2 chiều tại `/chat-zalo` (worker zca-js ngoài Vercel, Web Push tin mới) — hiện **chưa nối dữ liệu** với customers/leads/contracts (FK chừa sẵn).

### Giai đoạn 7 — BÁO CÁO · DASHBOARD · THÔNG BÁO · [13]

- **Đọc tổng hợp:** Dashboard KPI (lấp đầy, doanh thu tháng, công nợ) + ~19 báo cáo BĐS/Tài chính, tất cả **read-only** (không RPC riêng), đọc canonical từ `income_expenses` (dòng tiền) + `invoices`/`payments` (công nợ) + `contracts`/`rooms` (occupancy — quét chỉ HĐ `ACTIVE`, phòng `RESERVED` là bucket riêng "Đã cọc", xem [13] §4.3).
- **Cảnh báo đẩy:** `runScheduledNotifications()` (client, [notificationScheduler.ts](../../src/lib/notificationScheduler.ts)) gọi 4 check → ghi `notifications` (CONTRACT_EXPIRING / PAYMENT_REMINDER / OVERDUE_INVOICE / DEPOSIT_SHORTFALL), trạng thái PENDING(=chưa đọc)→READ.

### Giai đoạn 8 — CHỐT LỢI NHUẬN THÁNG / TOÀ · [12]

- **Ai:** owner. **Page:** [ProfitHubPage](../../src/pages/reports/finance/ProfitHubPage.tsx) (`/reports/finance/profit-distribution` — trang gộp từ 4b5aed3; URL cũ `/finance/shareholder-profit` redirect).
- **Bước:** chọn tháng + toà → RPC **`fa_monthly_pnl_accrual`** (dồn tích theo kỳ áp dụng, **item-level `kqkd_amount`**, IE APPROVED của **mọi user** — hết lệch phiếu do staff tạo; `monthly_building_profit` là **legacy FE không còn gọi**) tính **LN = thu KQKD − chi KQKD** trên tòa thật (`is_virtual = false`). **Trừ lương điều hành TRƯỚC khi chia** (653172f): quy tắc `profit_manager_salaries` (`FIXED`/`PERCENT` × `PER_BUILDING`/`TOTAL_GROUP`) → `distributable = adjusted_profit − management_salary`. Khoá tháng qua `useLockProfitMonth` → upsert `profit_monthly` `DRAFT → LOCKED` (snapshot cả `management_salary`) và **snapshot** phân bổ vào `profit_allocations` (tỷ lệ `building_shareholders` trên **distributable**) + `profit_manager_allocations` (phần lương quản lý).
- **Chứng từ:** dòng chốt LN (`profit_monthly`) + 2 snapshot phân bổ.

### Giai đoạn 9 — CHIA LỢI NHUẬN CỔ ĐÔNG · [12]

- **Bước:** `useCreateProfitDistribution` sinh **phiếu chi** `income_expenses` (EXPENSE) gắn `shareholder_id`, đặt trên **toà ảo "Chung"** (`is_virtual = true`) và set `business_result_accounting = false` → **`kqkd_amount = 0`** (không vào P&L, không tự trừ ngược lợi nhuận toà — tránh vòng lặp; phiếu chi lương điều hành gắn `profit_manager_id` cùng cơ chế), chọn `account_id` để trừ số dư sổ quỹ. Cổ đông có `auth_user_id` link → đăng nhập chỉ còn **đúng 1 quyền `shareholder_profit.view`** (3cd0d90, 2026-07-02 — hết nhánh cổ đông trong `can_access_building`, không còn đọc bảng vận hành); tên toà trên trang LN lấy qua RPC `get_my_share_buildings`.
- **Kết quả:** lợi nhuận biến thành **dòng tiền phân phối** thực cho người góp vốn — khép vòng đời.

### Nhánh biến động HĐ (có thể xảy ra bất cứ lúc nào ở Giai đoạn 6)

- **Gia hạn:** `renew_contract → renew_contract_impl` (bản hiện hành [20260606140000](../../supabase/migrations/20260606140000_contract_extended_decouple.sql)) — gia hạn **TẠI CHỖ** (UPDATE `end_date`/`rent_price`/`total_deposit`) và **GIỮ `status='ACTIVE'`** (KHÔNG còn chuyển `EXTENDED`); ghi `contract_extensions` (`extension_type='UPDATE_EXISTING'`, INSERT chắc — không nuốt lỗi). "Đã gia hạn" hiển thị qua `RenewedBadge` (suy từ `contract_extensions`), không từ status. KHÔNG tạo HĐ mới / `parent_contract_id` — 'tạo-mới' chỉ ở RPC `create_new_contract_extension` (bản mới set HĐ cũ → `EXPIRED`; đã REVOKE client). Trang chi tiết `/contracts/:id` từ df24746 (2026-06-10) dùng **cùng `RenewDialog`/`TerminateDialog` (RPC) như trang danh sách** — bộ dialog legacy (`ExtendContractDialog`/`TerminateContractDialog` + hook deprecated) đã xoá (xem [05] §5.2).
- **Chuyển phòng:** `transfer_room` — đổi `room_id` chính HĐ, chặn phòng bận, tự free phòng cũ / chiếm phòng mới.
- **Nhượng HĐ:** `transfer_contract → transfer_contract_impl` — đổi khách đại diện (`contract_customers`) + `rent_price`/`total_deposit`/`notes`; **GIỮ status `ACTIVE`** (reader-guard `ACTIVE/EXTENDED` chỉ là tương thích dữ liệu cũ), KHÔNG sang TRANSFERRED. Status TRANSFERRED chỉ do RPC legacy `create_tenant_transfer`/`create_room_transfer` (đã REVOKE client, dead-code).
- **Thanh lý move-out:** `terminate_contract_move_out` (bản hiện hành [20260627000001](../../supabase/migrations/20260627000001_termination_extra_charges.sql) — **1 bước, net settlement qua sổ CỌC + thu thêm**; deep-dive [16]): ① `_ensure_initial_deposit_voucher` đảm bảo cọc HĐ nằm trên sổ "CỌC (giữ hộ khách)" (backfill nếu thiếu); ② khu **"Thu thêm"** (`p_extra_charges` — tiền phòng lẻ ngày, chốt điện cuối kỳ ghi `meter_readings`, phí khác — thay ô Phí phạt cũ) **GỘP vào hoá đơn thanh lý**, mọi hoá đơn nợ được đánh `PAID` bằng payment **`TM`** nhãn "Quyết toán khi thanh lý" (bản 19→27/06 từng gạch bằng `CT` + phiếu sổ ảo TK000055 — đã bỏ; hồi quy ô TM dashboard ghi nhận ở [16] §2.3); ③ **chuyển khoản nội bộ** phần cấn trừ (applied = LEAST(cọc+thừa, nợ+thu thêm)): phiếu CHI sổ CỌC (`is_deposit`, ngoài KQKD) + phiếu THU sổ vận hành **"Doanh thu thanh lý"** (**VÀO KQKD** của toà; sổ chọn ưu tiên `buildings.default_account_id_tt` — `_termination_pick_account`); ④ phần ròng `S = (cọc + thừa) − (nợ + thu thêm)`: `S>0` → 1 phiếu CHI sổ CỌC trả khách; `S<0` → phiếu THU sổ vận hành "Khách trả thêm". Sổ CỌC tất toán về **0 cho mỗi HĐ**. Audit `contract_terminations` ghi `refund_amount = GREATEST(S,0)` (⚠️ trigger legacy `auto_calculate_termination_financials` đè vài cột tài chính — xem [05] §4.2).
- **Bỏ cọc:** `terminate_contract_forfeit` — `termination_type = FORFEIT`, luồng **2 bước** ([16] §4): RPC tạo hoá đơn thanh lý + phiếu thu **UNAPPROVED chờ duyệt**; số cọc bị bỏ = **`LEAST(total_deposit, deposit_paid)`** (chỉ phần cọc **thực thu** — 20260617000001); khi **Duyệt** phiếu, trigger `trg_forfeit_settle_on_approve` insert payment **`CT`** (cấn trừ) đánh `PAID` hoá đơn thanh lý → **cọc = doanh thu**; hoá đơn nợ cũ bị **HUỶ** (CANCELLED); thu thêm (nếu có) → **hoá đơn AR riêng** chờ thu (tháng trống kế). HĐ thành **TERMINATED** (giữ payment đã thu). (Enum `contract_status` không có CANCELLED — CANCELLED chỉ thuộc `invoice_status`.)
- Tất cả đặt `actual_end_date`, đổi `status → TERMINATED`, trigger đồng bộ `rooms.status → AVAILABLE`. ⚠️ Ngay sau đó trigger reconcile gọi `recompute_room_reservation` — nếu phòng còn **cọc giữ chỗ mồ côi** (chưa link HĐ, chưa huỷ) thì phòng bị đặt lại `RESERVED` ngay (xem [04] §4.11).

---

## 3. Sơ đồ tuần tự — 2 luồng then chốt

### 3a. Sinh hoá đơn hàng tháng → khách thanh toán → vào sổ quỹ

```mermaid
sequenceDiagram
    autonumber
    actor Staff as Staff vận hành
    participant UI as InvoicesPage / MeterReadingsPage
    participant DBmr as meter_readings
    participant RPCgen as generate_invoices_for_building_v2
    participant INV as invoices + invoice_items
    participant RPCpay as record_invoice_payment_v2
    participant PAY as payments
    participant IE as income_expenses (INCOME)
    participant ACC as accounts_with_balance

    Staff->>UI: Ghi chỉ số kỳ (YYYY-MM)
    UI->>DBmr: INSERT meter_readings (auto previous + code)
    Staff->>UI: Duyệt chỉ số
    UI->>DBmr: approve_meter_reading → status=APPROVED
    Note over DBmr: consumption = current − previous (generated)<br/>Thực tế FE tạo THẲNG APPROVED — hook duyệt là dead code [06]

    Staff->>UI: "Sinh hoá đơn toà X tháng YYYY-MM"
    UI->>RPCgen: generate_invoices_for_building_v2(building, month, type)
    RPCgen->>RPCgen: check can_do_on_building('invoices','create')
    RPCgen->>INV: INSERT hoá đơn (RENT + điện/nước = consumption×giá + dịch vụ + previous_debt<br/>— total roundInvoiceTotal làm tròn 900đ)
    INV-->>INV: trigger generate_invoice_number_v2 + recompute_invoice_for_id (status=APPROVED)

    Staff->>UI: Khách trả tiền (TM/TK/TT)
    Note over UI,RPCpay: Sơ đồ vẽ luồng dialog đơn lẻ (RPC v2).<br/>2 luồng khác cùng đích dữ liệu: BulkRecordPaymentDialog và<br/>trang mobile /thu-tien (useQuickCollect → useBulkRecordPayment,<br/>TM-only, INSERT trực tiếp payments + IE, user_id = owner) [15]
    UI->>RPCpay: record_invoice_payment_v2(invoice, amount, method, date)
    RPCpay->>RPCpay: check can_do_on_building('invoices','edit')
    Note over RPCpay: backend gate bằng 'edit'<br/>(dù UI có quyền record_payment riêng)
    RPCpay->>PAY: INSERT payments → RETURNING payment_id
    alt trả thừa
        RPCpay->>PAY: tạo excess_amounts (credit theo HĐ)
    end
    RPCpay-->>UI: { payment_id, ... }
    opt có account_id (hook FE sau khi nhận payment_id)
        UI->>IE: INSERT ĐÚNG 1 phiếu thu INCOME/lần thu (invoice_id + payment_id, account_id)<br/>HĐ gộp cọc → tách allocateDepositPortion (PHÒNG-TRƯỚC, CỌC-SAU)<br/>thành hạng mục is_deposit trên CÙNG phiếu — kqkd_amount loại phần cọc
        IE-->>ACC: trigger item recompute số dư sổ quỹ + kqkd_amount
    end
    PAY-->>INV: trigger recompute_invoice_for_id đọc Σ payments − tiền thối<br/>→ paid_amount net → status PAID / PARTIAL_PAID / APPROVED
    Note over IE,ACC: Tiền mặt staff giữ sau đó đi tiếp:<br/>create_cash_handover → confirm_cash_handover (1 phiếu CHI sổ nguồn + 1 phiếu THU tổng)<br/>→ đối soát/chốt số sổ cashbook_reconciliations — [08] §4.17, §5.11
```

### 3b. Ký HĐ có kiểm tra cọc (chặn ký thiếu cọc)

```mermaid
sequenceDiagram
    autonumber
    actor Sale
    participant UI as ContractFormDialog
    participant IE as income_expenses (is_deposit)
    participant TRG as trg_ie_recompute_contract_deposit
    participant RPCdep as recompute_contract_deposit_paid
    participant C as contracts
    participant ROOM as rooms

    Note over Sale,IE: Trước đó: phiếu thu cọc đã ghi vào IE (loại is_deposit=TRUE)
    IE-->>TRG: INSERT/UPDATE phiếu cọc kích trigger
    TRG->>RPCdep: recompute_contract_deposit_paid(contract_id)
    RPCdep->>RPCdep: v_total, v_count = Σ IE cọc APPROVED đã link
    alt v_count > 0
        RPCdep->>C: SET deposit_paid = v_total (deposit_remaining = total_deposit − paid, GENERATED)
    else v_count = 0
        RPCdep-->>C: KHÔNG override (giữ giá trị auto cũ)
    end
    IE-->>ROOM: trigger reconcile → recompute_room_reservation<br/>AVAILABLE → RESERVED (giữ phòng chờ ký — kể cả phiếu CHƯA duyệt)

    Sale->>UI: Bấm "Ký hợp đồng"
    UI->>UI: tính remaining = total_deposit − deposit_paid
    alt remaining > 0 và CHƯA ack
        UI-->>Sale: ❌ Chặn ký — yêu cầu chọn cách xử lý thiếu cọc
        Sale->>UI: chọn deposit_debt_mode = DEBT (lý do + ngày hẹn) hoặc FIRST_INVOICE
        UI->>UI: set deposit_debt_acknowledged = true
    end
    UI->>C: INSERT contracts (status=ACTIVE, public_code, deposit_debt_*)
    C-->>ROOM: trigger update_room_status_on_contract_change → OCCUPIED
    C-->>IE: trg_contract_link_orphan_deposits link phiếu cọc mồ côi cùng phòng
    Note over ROOM: Từ đây HĐ hiệu lực SỞ HỮU trạng thái phòng —<br/>recompute_room_reservation bỏ qua (RESERVED chỉ áp khi chưa có HĐ)
    UI-->>Sale: ✅ HĐ đã ký
```

---

## 4. Sơ đồ trạng thái

### 4a. `contract_status` (HĐ) · [05]

```mermaid
stateDiagram-v2
    [*] --> DRAFT: tạo nháp (hiếm)
    DRAFT --> ACTIVE: ký HĐ (FE tạo thẳng ACTIVE)
    [*] --> ACTIVE: tạo từ UI
    ACTIVE --> ACTIVE: renew_contract — gia hạn TẠI CHỖ, GIỮ ACTIVE + ghi contract_extensions
    note right of ACTIVE
        Từ 2026-06-06 (20260606140000_contract_extended_decouple):
        EXTENDED NGƯNG GHI — gia hạn GIỮ status ACTIVE.
        "Đã gia hạn" suy từ contract_extensions
        (useRenewedContracts + RenewedBadge), KHÔNG từ status.
        isContractInEffect() = ACTIVE-only.
        transfer_contract (nhượng HĐ) chỉ đổi đại diện
        contract_customers + rent_price/total_deposit/notes —
        cũng GIỮ ACTIVE, KHÔNG sang TRANSFERRED.
        Dữ liệu cũ còn EXTENDED: reader-guard DB
        IN ('ACTIVE','EXTENDED') chỉ là lớp TƯƠNG THÍCH —
        các HĐ đó vẫn thanh lý/hết hạn được như ACTIVE.
    end note
    ACTIVE --> TRANSFERRED: chỉ qua RPC legacy create_tenant_transfer / create_room_transfer (đã REVOKE — dead-code)
    ACTIVE --> TERMINATED: terminate_contract_move_out / _forfeit
    ACTIVE --> EXPIRED: hết hạn không gia hạn · create_new_contract_extension (legacy) đóng HĐ cũ
    TERMINATED --> [*]
    TRANSFERRED --> [*]
    EXPIRED --> [*]
```

### 4b. `invoice_status` (hoá đơn) · [07]

```mermaid
stateDiagram-v2
    [*] --> APPROVED: FE tạo thẳng — auto-duyệt vô điều kiện (key settings invoice_auto_approve KHÔNG được code đọc)
    [*] --> DRAFT: tạo nháp
    DRAFT --> PENDING_APPROVAL: gửi duyệt
    PENDING_APPROVAL --> APPROVED: duyệt
    APPROVED --> PARTIAL_PAID: record_invoice_payment_v2 (trả 1 phần)
    APPROVED --> PAID: record_invoice_payment_v2 (trả đủ)
    PARTIAL_PAID --> PAID: thu nốt
    APPROVED --> OVERDUE: quá due_date chưa đủ
    PARTIAL_PAID --> OVERDUE: quá hạn
    OVERDUE --> PAID: thu đủ
    APPROVED --> CANCELLED: huỷ / bỏ cọc giữ tiền
    PARTIAL_PAID --> CANCELLED: super_admin_force_cancel_invoice
    CANCELLED --> APPROVED: restore
    PAID --> [*]
    note right of PAID
        trigger recompute_invoice_for_id suy ra
        PAID / PARTIAL_PAID / APPROVED (giữ CANCELLED)
        từ paid_amount net (Σ payments − tiền thối).
        OVERDUE KHÔNG do trigger set — là trạng thái
        SUY DIỄN ở tầng hiển thị theo due_date
        (src/lib/invoiceUtils.ts → isOverdue).
    end note
```

### 4c. `deposit_status` (phiếu cọc) · [04]

```mermaid
stateDiagram-v2
    [*] --> PENDING: lập phiếu giữ chỗ
    PENDING --> CONFIRMED: xác nhận nhận cọc
    CONFIRMED --> CONVERTED: lead/cọc → ký HĐ
    CONFIRMED --> REFUNDED: hoàn cọc (move-out)
    CONFIRMED --> FORFEITED: bỏ cọc (forfeit)
    note right of CONVERTED
        ⚠ Bảng deposits là LEGACY ĐÃ CHẾT (0 dòng,
        không UI nào còn ghi — [04] §2.1); sơ đồ này
        chỉ mô tả dữ liệu lịch sử. deposit_status
        KHÔNG phải nguồn sự thật. Cọc thực nộp =
        Σ IE is_deposit → contracts.deposit_paid.
        RPC thanh lý KHÔNG cập nhật cột này;
        hoàn/bỏ cọc lấy từ contract_terminations.
        Dòng cũ PENDING/CONFIRMED chưa link HĐ vẫn
        tham gia predicate recompute_room_reservation
        → giữ phòng RESERVED; rời 2 status này
        (hoặc link HĐ) → nhả phòng.
        Cọc giữ chỗ hiện hành = phiếu thu IE mồ côi,
        xem tab "Phiếu giữ chỗ" ([04] §5.4).
    end note
    CONVERTED --> [*]
    REFUNDED --> [*]
    FORFEITED --> [*]
```

### 4d. `lead_status` (khách hẹn) · [03]

```mermaid
stateDiagram-v2
    [*] --> B1_LEAD: tạo lead (lead_source)
    B1_LEAD --> B2_APPOINTMENT: đặt lịch hẹn
    B2_APPOINTMENT --> B3_CONSULTATION: tư vấn / xem phòng
    B3_CONSULTATION --> CONVERTED: chốt → tạo deposits PENDING + tenant (legacy)
    B1_LEAD --> FAILED: rớt
    B2_APPOINTMENT --> FAILED: rớt
    B3_CONSULTATION --> FAILED: rớt
    note right of CONVERTED
        trigger update_lead_score() gán lead_score mỗi I/U
        (điểm KHÔNG hiển thị ở UI nào — xem [03] §4.1).
        ⚠ Convert CHỈ set status='CONVERTED' — KHÔNG ghi
        leads.deposit_id / conversion_date (FK mồ côi);
        tạo deposits PENDING + tenants legacy, KHÔNG đi qua
        kiến trúc cọc mới (IE is_deposit / RESERVED) và INSERT
        deposits hiện fail vì key hold_until_date
        (xem [03] §5.1, [04] §5.4).
    end note
    CONVERTED --> [*]
    FAILED --> [*]
```

---

## 5. Vận hành định kỳ tự động (pg_cron + client scheduler)

| Cơ chế | Lịch | Gọi gì | Kết quả |
|---|---|---|---|
| **Phiếu lặp định kỳ** ([08]) | pg_cron `0 18 * * *` (= 01:00 giờ VN), job `recurring_vouchers_daily` | `run_recurring_vouchers_job()` (SECURITY DEFINER) → `generate_recurring_vouchers(NULL)` cho **mọi owner** | Sinh phiếu IE con từ phiếu cha `repeat_cycle` (WEEK/MONTH/QUARTER/YEAR); `add_cycle` neo ngày chống drift. Xem [migration cron](../../supabase/migrations/20260603000011_recurring_vouchers_cron.sql). Lưu ý dùng `generate_recurring_vouchers(NULL)` chứ không `_v2` vì v2 cần `auth.uid()` (NULL trong ngữ cảnh cron). |
| **Sinh hoá đơn hàng loạt** ([07]) | thủ công theo nút (chưa cron) | `generate_invoices_for_building_v2(building, month, type)` | Hoá đơn cả toà cho `billing_month`. |
| **Thông báo theo lịch** ([13]) | client mỗi ~6h ([useScheduledNotifications.ts](../../src/hooks/useScheduledNotifications.ts)) | `runScheduledNotifications()` → `checkContractExpiryReminders` / `checkInvoicePaymentReminders` / `checkOverdueInvoices` / `checkDepositTopupReminders` | Ghi `notifications`: `CONTRACT_EXPIRING` (HĐ sắp hết hạn — quét chỉ HĐ `ACTIVE`), `PAYMENT_REMINDER` / `OVERDUE_INVOICE` (hoá đơn), `DEPOSIT_SHORTFALL` (thiếu cọc theo `deposit_topup_due_date`). ⚠️ Mọi check `.eq('user_id', userId)` — **scope theo OWNER**, chỉ sinh khi chính owner online (xem [13] §4.2). |
| **Jobs hệ lương v5** ([17] §4.10 — **KHÔNG pg_cron**) | **Vercel Cron** (`vercel.json crons`): nightly 23:45 UTC (=06:45 VN), digest 00:00 UTC (=07:00 VN); tầng 2 = **watchdog trong worker Zalo** (30'/lần, lỡ giờ gọi bù); tầng 3 = nút "Chạy lại" tab Cài đặt v5 | [api/salary-v5-cron.js](../../api/salary-v5-cron.js) (`x-cron-secret`) → edge fn `salary-v5-jobs` → `v5_run_job` trong DB (`tier` / `score` / `digest` / `close_period` — idempotent 2 lớp qua `cron_runs`) | Dọn phiên/SAD quá hạn, làm nóng `v5_daily_missions` (tuyến gợi ý), digest Web Push "Tuyến hôm nay", chốt kỳ tháng (ngày 1 VN). **Job không sinh tiền** — cron chết 1 tuần không làm sai lương. |
| **Worker Chat Zalo** ([18]) | vòng lặp poll 2s — tiến trình **ngoài Vercel** (local/VPS, pm2) | [worker/index.js](../../worker/index.js) (service-role): đọc `zalo_send_queue` gửi đi qua zca-js, nghe WebSocket Zalo ghi `zalo_messages` (Realtime đẩy sang FE), gọi edge fn `send-push` khi có tin đến | Tin nhắn 2 chiều realtime + Web Push tin Zalo mới. |

---

## 6. Ma trận: Sự kiện nghiệp vụ → bảng bị ghi → báo cáo bị ảnh hưởng

| # | Sự kiện (ai) | Page / RPC | Bảng bị GHI (+trigger/side-effect) | Báo cáo / số liệu bị ảnh hưởng |
|---|---|---|---|---|
| 1 | Tạo & nuôi lead (sale) | LeadsPage | `leads`, `lead_activities` (trg `update_lead_score`) | New-leases pipeline, Dashboard sale |
| 2 | Nhận cọc (sale) | DepositsPage nút "Tạo đặt cọc" / form Thu-chi / QuickDepositModal | `income_expenses` is_deposit — phiếu mồ côi `contract_id=NULL` (bảng `deposits` legacy **đã chết**, không ghi) (trg recompute `contracts.deposit_paid`; trg `recompute_room_reservation` → `rooms.status=RESERVED`) | Tab Phiếu giữ chỗ, số dư sổ quỹ (sổ CỌC), bucket "Đã cọc" Dashboard, phòng rời danh sách `/r/:token` (DepositsReport legacy luôn rỗng) |
| 3 | Ký HĐ (staff) | ContractFormDialog | `contracts` (ACTIVE), `contract_customers`, `contract_services`; phiếu thu cọc → sổ **CỌC** (`get_or_create_deposit_account`); trg `rooms.status=OCCUPIED` + link cọc mồ côi; (tuỳ) phiếu hoa hồng UNAPPROVED | Occupancy, New-leases, lấp đầy Dashboard |
| 4 | Chốt chỉ số đầu (staff) | form HĐ / MeterReadings | `contracts.initial_*_reading`, `meter_readings` | (mốc cho hoá đơn điện/nước) |
| 5 | Ghi chỉ số (staff) | MeterReadings (FE tạo **thẳng APPROVED** — hook duyệt dead code) + dialog hoá đơn tự INSERT reading | `meter_readings` (APPROVED, consumption generated) | Thống kê chỉ số, đầu vào hoá đơn |
| 6 | Sinh hoá đơn kỳ (staff) | `generate_invoices_for_building_v2` | `invoices`, `invoice_items` (trg số HĐ + recompute) | Doanh thu, công nợ (CustomerDebtReport), Dashboard |
| 7 | Khách thanh toán (staff) | `record_invoice_payment_v2` + hook FE | `payments`, (thừa→`excess_amounts`); `income_expenses` INCOME do **hook FE mirror sau RPC** khi có `account_id` — từ 20260702120000 **ĐÚNG 1 phiếu/lần thu**, HĐ gộp cọc thêm hạng mục `is_deposit` cùng phiếu (trg tính `kqkd_amount` loại phần cọc); trg recompute invoice → status | Dòng tiền (CashFlow/DailyCashbook), công nợ, doanh thu (P&L cộng `kqkd_amount`), số dư sổ quỹ |
| 8 | Chi phí vận hành (staff) | IncomeExpensePage | `income_expenses` EXPENSE (+ items) | Dòng tiền, tỉ lệ chi phí (ExpenseRatio), P&L |
| 9 | Sự cố / công việc (staff) | TaskManagement | `issues` (SLA), `jobs` (JOB-…); (tuỳ) `material_usages` trừ kho | Dashboard sự cố, chi phí vật tư |
| 10 | Gia hạn (staff) | `renew_contract` | `contracts` (UPDATE end_date/giá — **GIỮ ACTIVE**), `contract_extensions` (UPDATE_EXISTING — nguồn duy nhất của "đã gia hạn") | Renewals-transfers (đọc `contract_extensions`), expiring |
| 11 | Chuyển phòng/Nhượng (staff) | `transfer_room` / `transfer_contract` | `contracts` (room_id; status **GIỮ ACTIVE** — `transfer_contract` chỉ đổi đại diện `contract_customers`), `contract_transfers`; trg `rooms.status` | Renewals-transfers, occupancy |
| 12 | Thanh lý move-out (staff) | `terminate_contract_move_out` (+`p_extra_charges` — bản 20260627) | `contracts` (TERMINATED, actual_end_date), `contract_terminations`, hoá đơn thanh lý **gộp thu thêm** (chốt điện → `meter_readings`), hoá đơn nợ → PAID bằng payment **TM** "Quyết toán khi thanh lý", cặp phiếu **CHI sổ CỌC + THU sổ vận hành "Doanh thu thanh lý"** (KQKD) + phiếu CHI trả khách ròng / THU "Khách trả thêm"; trg `rooms.status=AVAILABLE` (tái-RESERVED nếu còn cọc giữ chỗ mồ côi) | Terminations, phòng trống (Vacant), cọc, dòng tiền, P&L toà |
| 13 | Bỏ cọc (staff) | `terminate_contract_forfeit` (2 bước: tạo UNAPPROVED → duyệt) | `contracts` (TERMINATED), `contract_terminations` (FORFEIT, cọc = `LEAST(total_deposit, deposit_paid)`), hoá đơn nợ cũ CANCELLED; **duyệt phiếu** → trg `trg_forfeit_settle_on_approve` insert payment **CT** → hoá đơn thanh lý PAID, cọc = doanh thu; thu thêm → hoá đơn AR riêng | Terminations, doanh thu, cọc, thẻ `payment_ct` dashboard |
| 14 | Phiếu lặp tự sinh (cron) | `run_recurring_vouchers_job` | `income_expenses` con | Dòng tiền, P&L |
| 15 | Cảnh báo định kỳ (client) | `runScheduledNotifications` | `notifications` | Trung tâm thông báo, badge Dashboard |
| 16 | Chốt LN tháng (owner) | ProfitHubPage / `fa_monthly_pnl_accrual` (kqkd_amount, mọi user — `monthly_building_profit` legacy) + trừ **lương điều hành** trước khi chia | `profit_monthly` (LOCKED, snapshot `management_salary`), `profit_allocations` (trên distributable), `profit_manager_allocations` | Báo cáo chia LN (ProfitDistribution), bảng lương quản lý (cột Đầu tư) |
| 17 | Chia LN cổ đông (owner) | `useCreateProfitDistribution` | `income_expenses` EXPENSE shareholder_id (toà ảo Chung, `business_result_accounting=false` → `kqkd_amount=0`); trg trừ số dư sổ quỹ | Số dư sổ quỹ, ProfitDistribution; **KHÔNG** vào P&L (`kqkd_amount=0` + nằm trên tòa ảo `is_virtual=true`) |
| 18 | Vận hành kênh công khai (owner/sale) | SalePhongPage (4 tab) [15] | `public_room_share_tokens` (tạo/thu hồi), `public_room_settings` (soon_days, hotline), `rooms.images`/`buildings.images` (bucket **PUBLIC** `room-sale-images`), `buildings.floor_layouts`, `rooms.sale_note`/`sale_bonus_note` | Nội dung trang công khai `/r/:token` |
| 19 | Khách xem phòng trống (anon) | `/r/:token` → `get_public_available_rooms` [15] | (read-only — KHÔNG ghi bảng nào) | — (đầu vào lead/cọc ở ngoài hệ thống) |
| 20 | Cọc nhanh từ `/r/:token` (sale đăng nhập, quyền `sale_phong.create_deposit` — live 4b4f1cd) | QuickDepositModal / RPC `ensure_room_deposit_type` [15] | `income_expenses` INCOME `is_deposit` (sổ CỌC, `contract_id=NULL`) + items; trg `recompute_room_reservation` → `rooms.status=RESERVED` | Phòng trống công khai (rời danh sách), cọc, số dư sổ quỹ |
| 21 | Thu tiền mặt mobile (staff) | `/thu-tien` → `useQuickCollect` [15] | `payments` (TM, `user_id` = **owner** HĐ) + `income_expenses` INCOME (sổ resolve theo TÊN "…Thu" ưu tiên `is_default`→"Chung"→tên toà; làm tròn <10K → metadata + sổ "Làm tròn tiền thiếu"); GPS nền → `income_expenses.collect_*` (dấu chân v5, không chặn phiếu); trg recompute invoice → PAID/PARTIAL_PAID | Dòng tiền, công nợ, số dư sổ quỹ (cùng đích với #7); tick ngày-công v5 |
| 22 | Bàn giao tiền mặt (staff → quản lý/chủ) | Nút Bàn giao `/thu-tien` · HandoverSheet → `create_cash_handover` / `confirm_cash_handover` [08][15] | `cash_handovers`; phiếu gốc gắn `handover_id` (guard khoá sửa/xoá); khi xác nhận: **1 phiếu CHI sổ nguồn (chọn được) + 1 phiếu THU tổng kèm hạng mục** (`handover_transfer_id`) | Báo cáo bàn giao (`/reports/finance/ban-giao`), Chu kỳ Thu→Bàn giao, số dư sổ quỹ |
| 23 | Đối soát / chốt số sổ (chủ/quản lý) | `/reports/finance/ban-giao` [08] | `cashbook_reconciliations` (system_balance theo NGÀY `as_of`; đồng đội-không-chủ không tự chốt hộ) | Còn-phải-nộp, mốc chốt chu kỳ thu, `cashbook_settlement_report` |
| 24 | Hoàn thành việc / kiểm tra nhà (staff) | TaskCompleteDialog → `award_job_bonus` + `v5_tick_from_job`; InspectionRunner (FULL/QUICK) [11][17] | `notifications` SALARY_BONUS (dedup), `salary_attendance_day` (tick — chỉ qua RPC SECDEF), `salary_streak_state`, `inspection_sessions`(+`_photos` sha256/GPS), `jobs.attachments`; "Có vấn đề" → tự sinh job sửa | BonusToast + Web Push, `/my-day`, `/reports/coverage`; **tiền v5 chỉ vào lương khi LOCK + flag `v5_money` BẬT** |
| 25 | Chốt & trả lương quản lý (owner) | `/finance/salary` → `useLockSalaryMonth` / `useSalaryPayout` [17] | `salary_monthly` (LOCKED) + `salary_work_ledger_snapshot` (đóng băng); phiếu CHI "Lương quản lý" (toà ảo Chung, `business_result_accounting=false`) + payment **CT** gạch nợ hoá đơn phòng ở + phiếu THU khấu trừ cùng sổ | Số dư sổ quỹ, self-view lương nhân viên; **KHÔNG** vào P&L |
| 26 | Chat Zalo (staff có quyền `chat_zalo`) | `/chat-zalo` → RPC `zalo_send_message`/… + worker zca-js [18] | `zalo_messages`, `zalo_send_queue` (worker poll 2s), `zalo_conversations` (preview/unread), `zalo_labels` | Không đụng báo cáo tài chính; Web Push tin mới (edge fn `send-push`) |

---

### Phụ lục — quy ước trạng thái "tiền có thật"

- **Số dư sổ quỹ & dòng tiền** chỉ tính `income_expenses` có `approval_status = APPROVED` và `deleted_at IS NULL`.
- **P&L / lợi nhuận** (`fa_monthly_pnl_accrual` / `fa_monthly_pnl` — `monthly_building_profit` chỉ còn legacy): từ `20260702120000` cộng **`SUM(kqkd_amount)`** (hạch toán **item-level** — phiếu trộn doanh thu + cọc chỉ tính phần không-cọc) **VÀ** chỉ tính tòa thật (`is_virtual = false`). Phần cọc `is_deposit` tự bị loại bởi công thức trigger (`business_result_accounting` NULL → `total − Σ item is_deposit`); phiếu chia LN / lương điều hành / lương quản lý đặt `business_result_accounting = false` → `kqkd_amount = 0` (kiêm nằm trên **tòa ảo "Chung"**). Cờ nhị phân `counts_in_business_result` (= `COALESCE(business_result_accounting, NOT has_deposit)`) chỉ còn dùng cho filter/badge — tránh nhầm nó là nguồn số P&L.
- **`contracts.deposit_paid`** chỉ bị `recompute_contract_deposit_paid` ghi đè khi có **≥ 1** phiếu IE cọc APPROVED đã link (`v_count > 0`); ngược lại giữ giá trị cũ. (Trigger legacy `trigger_auto_calculate_deposit_paid` từng điền cột này từ `deposits` đã **DROP** 2026-06-10 — [04] §4.6.)
- **`invoice.status` và `paid_amount`** luôn là **kết quả suy diễn** của trigger `recompute_invoice_for_id` (Σ payments − tiền thối, làm tròn < 10K), không set tay.
