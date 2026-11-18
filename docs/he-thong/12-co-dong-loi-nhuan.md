# Cổ đông, Profit Close V2 và ví cá nhân

> **Reviewed:** 2026-10-21 (mục 5–7 viết lại 2026-11-18 theo luồng tạm ứng + chốt chi theo tháng)
> Nguồn hiện hành: `src/components/shareholders/**`, `src/hooks/useShareholderProfit.ts`, `src/hooks/income-expenses/specialized.ts`, `src/lib/profitLedger/**`, `src/hooks/profit-ledger/**` và migrations `20260720210000`–`20260720223000`, `20261118041911` (tạm ứng cổ đông + chốt chi lợi nhuận).

## 1. Phạm vi

Domain này trả lời bốn câu hỏi:

1. Lợi nhuận của từng toà trong tháng là bao nhiêu?
2. Sau lương điều hành và điều chỉnh có lý do, mỗi cổ đông được chia bao nhiêu?
3. Đã chi cho cổ đông/quản lý bao nhiêu; mỗi cổ đông còn bao nhiêu lợi nhuận chưa chi và đang có bao nhiêu tạm ứng?
4. User tự ghi chép ví cá nhân thế nào mà không lẫn với sổ quỹ doanh nghiệp?

Trang chính là `/reports/finance/profit-distribution` (`ProfitHubPage`). Cổ đông/quản lý được gắn tài khoản chỉ xem phần của mình; người có quyền quản trị thấy các tab Tổng quan, Chốt LN tháng và Cổ đông & tỷ lệ.

Từ 11/10/2026 (Q9) tab **Chốt LN tháng** và **Cổ đông & tỷ lệ** hiện theo quyền (chốt/mở chốt; `shareholder_profit.manage_shareholders`), **Lương của tôi** luôn hiện với quản lý điều hành; bỏ cơ chế nhấp 3 lần vào logo. Bản mobile không render tab chốt/cấu hình (thao tác quản trị dùng desktop) nhưng có tab **Lương** cho quản lý điều hành.

## 2. Bất biến hiện hành

- **Server tính nguồn:** client không gửi P&L, lương điều hành, tỷ lệ hay allocation cuối cùng. `profit_close_preview_v2` tự đọc nguồn accrual và cấu hình trong organization.
- **Tính cả tháng, ghi phần được chọn (từ 27/08/2026):** CLOSE/RECLOSE tính preview canonical trên MỌI toà thật của organization nhưng chỉ GHI các toà trong `p_building_ids`. Vì phạm vi tính không đổi, `source_hash` (CAS) và `building_source_hash` giữ nguyên công thức cũ — chốt lẻ không làm snapshot đã chốt trước đó hoá `is_stale`.
- **Tập ghi đóng theo `TOTAL_GROUP`:** với mỗi quy tắc lương điều hành `basis=TOTAL_GROUP` đang active, tập ghi phải chứa TẤT CẢ hoặc KHÔNG toà nào của quy tắc đó. Chốt nửa nhóm sẽ dồn sai khoản lương của cả nhóm vào phần toà đã chốt mà không có gì báo; server từ chối bằng `[TOTAL_GROUP_KHONG_DU]` kèm tên toà còn thiếu. Đây là bất biến THAY THẾ luật "chốt toàn tháng" cũ, không phải nới nó.
- **Điều chỉnh minh bạch:** `adjusted_profit = computed_profit + adjustment_amount`. Điều chỉnh khác 0 bắt buộc lý do 8–500 ký tự và lưu người/thời điểm.
- **Chống nguồn đổi:** preview trả `source_hash`; close/reclose chỉ ghi nếu hash vẫn khớp. Dữ liệu đổi giữa xem trước và xác nhận trả conflict, không chốt mù.
- **Idempotency:** mỗi write dùng idempotency key; replay cùng payload trả kết quả cũ, tái dùng key cho payload khác bị từ chối.
- **Revision bất biến:** close, reclose, reset và baseline đều ghi `profit_close_runs` + `profit_close_revisions` append-only.
- **Không chia cho người ngừng hoạt động:** cổ đông/quản lý `is_active=false` hoặc `deleted_at` khác null không nhận allocation mới. Mapping cross-organization hoặc cấu hình sống thiếu organization fail closed.

## 3. Mô hình dữ liệu

### 3.1. Cổ đông và tỷ lệ

- `shareholders`: danh bạ cổ đông, `organization_id`, `auth_user_id`, `name`, `is_active`, `deleted_at`.
- `building_shareholders`: tỷ lệ của cổ đông theo toà. Tổng tỷ lệ active không được vượt 100 khi preview/chốt.
- `auth_user_id` cho phép self-view nhưng không mở quyền đọc dữ liệu vận hành khác.

### 3.2. Snapshot tháng

`profit_monthly` có một dòng cho mỗi `(building_id, period_month)` và lưu:

- `computed_profit`: lợi nhuận canonical từ nguồn accrual.
- `adjustment_amount`, `adjustment_reason`, `adjustment_by`, `adjustment_at`.
- `adjusted_profit`: `computed_profit + adjustment_amount`.
- `management_salary`: lương điều hành bị trừ trước khi chia.
- `source_revenue`, `source_expense`, `source_net_profit`, `source_hash`, `source_captured_at`.
- `status`, `is_stale`, `stale_reason`, `revision_number`, `locked_at/by`.

`profit_allocations` chụp phần cổ đông; `profit_manager_allocations` chụp phần lương điều hành. Hai bảng này là nguồn số đã chốt, không đọc lại tỷ lệ/quy tắc live cho kỳ LOCKED.

### 3.3. Audit close

- `profit_close_runs`: một record append-only cho mỗi operation `BASELINE`, `CLOSE`, `RECLOSE`, `RESET` hoặc `UNLOCK`, gồm request hash, source snapshot và result snapshot.
- `profit_close_revisions`: revision theo từng toà/tháng, giữ previous/current snapshot cùng allocations. `profit_monthly_id` cố ý không là FK để reset snapshot hiện tại không xoá lịch sử.

### 3.4. Lương điều hành

- `profit_managers`: danh bạ quản lý điều hành.
- `profit_manager_salaries`: quy tắc `FIXED|PERCENT` × `PER_BUILDING|TOTAL_GROUP`.
- `profit_manager_salary_buildings`: tập toà áp dụng.
- Chỉ manager và rule đang active, chưa xoá, đúng organization mới tham gia preview/chốt.

### 3.5. Ví cá nhân

`personal_transactions` là sổ thu/chi own-only của từng user. Nó không đi vào `income_expenses`, sổ quỹ, KQKD, Profit Close hay approval engine.

## 4. Luồng Profit Close V2

```mermaid
flowchart LR
  P["profit_close_preview_v2"] --> H["source hash + preview theo toà"]
  H -->|"CLOSE lần đầu"| C["profit_close_v2"]
  H -->|"thay snapshot đã chốt"| R["profit_reclose_v2"]
  C --> S["profit_monthly + allocations"]
  R --> S
  S --> A["profit_close_runs + revisions"]
  S -->|"state hỗn hợp/legacy"| X["profit_reset_checked_v2"]
  X --> A
```

### 4.1. Preview

`profit_close_preview_v2(organization, month, building_ids?, adjustments?)`:

- xác thực organization và quyền;
- đọc tất cả toà thật đang hoạt động;
- đối chiếu hai nguồn accrual canonical;
- tính revenue, expense, net profit, điều chỉnh, lương điều hành và allocations;
- trả source hash toàn kỳ và hash theo toà;
- so snapshot hiện tại để đánh dấu `is_stale`/`stale_reason`.

UI chỉ gửi `adjustment_amount` có dấu và `adjustment_reason`; server tính phần còn lại.

### 4.2. Chốt lần đầu

`profit_close_v2` yêu cầu source hash preview (của TOÀN THÁNG) và idempotency key. Trong transaction, server khoá nguồn cần thiết, dựng lại preview trên toàn bộ toà thật, kiểm hash, rồi upsert `profit_monthly` + thay allocations CHỈ cho các toà trong `p_building_ids`, tăng revision và ghi audit.

`profit_close_runs.source_snapshot` luôn là tài liệu nguồn TOÀN THÁNG — `app_private.current_profit_building_source_hash_v1` dựng lại hash từ `run.source_snapshot->'pnl'` để canh độ tươi của phiếu chi cổ đông. `result_snapshot.buildings`/`totals` mới là phần đã ghi, kèm `scope_building_ids` và `written_building_ids`.

Lý do lần chốt đầu có thể dùng mặc định; điều chỉnh khác 0 vẫn phải có lý do riêng.

### 4.3. Chốt lại

`profit_reclose_v2` dùng khi các toà ĐƯỢC CHỌN đều đã LOCKED nhưng nguồn/cấu hình thay đổi. UI bắt buộc nhập lý do; server tạo revision mới và thay snapshot hiện tại sau khi source hash vẫn khớp. Vùng chọn lẫn toà đã chốt với toà chưa chốt là không hợp lệ — CLOSE và RECLOSE là hai RPC, mỗi cái đòi trạng thái đồng nhất trong tập ghi.

Không cần mở khoá/xoá allocation bằng nhiều DML client như flow cũ.

**Tháng đã chốt khoá phiếu thế nào** (từ 25/09/2026, migration
[20260925073251](../../supabase/migrations/20260925073251_khoa_thang_loi_nhuan_tuyet_doi.sql)):
- Trigger `a02_ie_profit_lock_*` / `a02_ie_items_profit_lock` chặn lập, sửa, xoá phiếu và hạng mục có
  **ngày phiếu** thuộc tháng đã chốt của toà, với **mọi người** (kể cả chủ công ty, super admin, job không
  đăng nhập) và mọi loại phiếu (kể cả ngoài KQKD). Ngoại lệ không đổi tiền, trigger tự kiểm delta: dời lịch
  phiếu lặp, gắn/nhả phiên bàn giao, đánh dấu đã kiểm, tắt lặp (`STOP_RECURRING`), gắn hợp đồng vào phiếu cọc
  giữ chỗ (`LINK_CONTRACT`).
- `app_private.assert_period_open_for_edit_v1` (cửa của mọi writer sửa/huỷ/đổi hình thức thu) chặn thêm
  **phiếu thu của hoá đơn thuộc tháng đã chốt** dù ngày phiếu ở tháng sau. Thu mới nợ cũ và duyệt khoản thu đó
  không đi qua cửa này nên vẫn làm được.
- Không chốt được khi toà còn phiếu **Chờ duyệt** có ngày trong tháng (trigger
  `a10_profit_month_lock_requires_no_pending` trên `profit_monthly`, phủ mọi đường đặt `locked_at`).
- Mở khoá: `profit_unlock_v2` kèm lý do 8–1000 ký tự (lưu `profit_close_runs` + `profit_close_revisions`).

**Khoá theo KỲ + phát sinh sau chốt** (rà 21/10 F06, chủ chốt 22/10/2026 "chặn hẳn", migration
[20261022172918](../../supabase/migrations/20261022172918_khoa_ky_thang_da_chot_ln.sql)):
- Lợi nhuận tính theo **kỳ** (`fa_accrual_allocations`: phiếu gắn hoá đơn ⇒ tháng hoá đơn; hạng mục có kỳ ⇒
  các tháng của kỳ; không kỳ ⇒ tháng ngày phiếu), nên ngoài ngày phiếu, trigger còn xét **tháng KQKD theo kỳ**:
  phiếu (bản cũ đang tính LN = đã duyệt; bản mới đã duyệt hoặc chờ duyệt) có phần KQKD rơi vào tháng đã chốt của
  toà ⇒ khoá **cả phiếu** như khoá theo ngày phiếu — lập, sửa, xoá, huỷ, **duyệt**, khôi phục đều bị chặn, với mọi
  người. Cùng các ngoại lệ không đổi tiền ở trên. Hạng mục: trigger AFTER `a02_ie_items_profit_period_lock` (thêm /
  sửa / xoá dòng có kỳ trong tháng đã chốt). Câu lỗi: `[PROFIT_LOCKED] Tháng MM/YYYY của toà X đã chốt lợi nhuận —
  không ghi được phiếu có kỳ trong tháng này. Muốn ghi: mở khoá tháng ở tab Chốt LN.` Form phiếu
  (`postLockFormBlock` trong `src/lib/profitPostLock.ts`) báo đúng câu này trước khi lưu và mờ nút Lưu.
- **Thu mới nợ cũ** vẫn đi: phiếu theo hoá đơn (tháng KQKD = tháng hoá đơn) không bị cửa kỳ chặn — thu tiền hoá
  đơn của tháng đã chốt (kèm tiền thối/hoàn trả gắn hoá đơn) và duyệt khoản đó vẫn làm được. Phiếu chờ duyệt có kỳ
  trong tháng đã chốt (dữ liệu trước khoá kỳ) vẫn huỷ/xoá được.
- **Chi / Thu phiếu đã duyệt vẫn đi** (chủ chốt 16/11/2026, migration
  [20261116090142](../../supabase/migrations/20261116090142_chi_phieu_da_duyet_qua_khoa_thang_ln.sql)): cửa chặn
  chốt chỉ đòi hết phiếu chờ duyệt, nên tháng có thể chốt khi còn phiếu **đã duyệt chưa chi**. Ghi sổ không đổi lợi
  nhuận tháng (`fa_accrual_allocations` không đọc cột ghi sổ / sổ quỹ), nên trigger miễn đúng hai bước của nút Chi
  / Thu và tự kiểm delta: (A) đóng dấu ghi sổ `UNPOSTED`/`REVERSED` → `POSTED` của phiếu đã duyệt, chỉ các cột dấu
  ghi sổ đổi, có token vòng đời V2 của chính phiếu, bút toán trỏ tới là bút toán thật chưa đảo đúng sổ quỹ; (B) scope
  `ANNOTATE` chỉ **thêm** ảnh chứng từ khi phiếu đã duyệt còn chờ ghi sổ. Duyệt, huỷ duyệt, hoàn tác ghi sổ, huỷ,
  sửa, gỡ ảnh, sửa ghi chú vẫn bị khoá. Token do mọi writer definer của vòng đời V2 cấp nên (A) mở cho mọi đường
  definer ghi sổ phiếu đã duyệt, không riêng nút Chi. Khoá **sổ quỹ** không đổi: sổ đã chốt & bàn giao qua **ngày
  phiếu** thì ghi sổ vẫn bị `[CASHBOOK_CLOSED]`.
- **Phát sinh sau chốt**: `public.profit_post_lock_vouchers_v1(p_from, p_to, p_building_ids)` (chỉ đọc, DEFINER,
  quyền `can_access_building`, anon ⇒ 42501) trả toà×tháng đã chốt và các phiếu đã duyệt đóng góp KQKD vào tháng
  đã chốt (theo `fa_accrual_allocations`) mà **tạo hoặc duyệt sau lúc chốt** — thu tiền hoá đơn tháng đã chốt, hoặc
  dữ liệu cũ trước khoá kỳ. Báo cáo LN (chế độ theo kỳ) **không cộng** chúng vào tháng đã chốt: bỏ khỏi danh sách
  thu/chi và tổng (dòng "Của iHome", bộ dò, phần chờ duyệt tính trên tổng mới), hiện chip "Phát sinh sau chốt —
  chưa cộng vào tháng đã chốt: N khoản · thu X · chi Y" kèm danh sách; thanh kiểm chứng trừ đúng phần này phía
  engine (không báo LỆCH giả) và chuyển "cần xem lại". Tab Chốt LN gắn nhãn "N khoản phát sinh sau chốt (chưa
  cộng)". Muốn cộng: mở khoá tháng ở tab Chốt LN rồi chốt lại.

### 4.4. Đặt lại tháng

Toà đã chốt xen toà chưa chốt KHÔNG còn là trạng thái hỏng — đó chính là thứ chốt-theo-từng-toà tạo ra. Chỉ khi tháng còn snapshot nằm trên toà ảo/đã xoá (`has_out_of_scope_snapshots`) hoặc không thể reclose an toàn thì UI mới dùng **Đặt lại**.

`profit_reset_checked_v2` bắt buộc:

- lý do 8–1000 ký tự;
- `expected_state_hash` của toàn bộ snapshot/allocation hiện tại;
- danh sách chính xác `expected_snapshot_ids`;
- idempotency key.

Tham số `p_target_building_ids` (thêm 27/08/2026) thu hẹp TÁC ĐỘNG về vài toà, nhưng CAS vẫn ở mức TOÀN KỲ — không đặt lại được trên trạng thái đã cũ dù chỉ nhắm một toà. `NULL` = đặt lại cả kỳ (hành vi cũ).

Nếu snapshot đổi trước lúc reset, server trả conflict. Reset bỏ snapshot hiện tại nhưng lịch sử revision vẫn giữ để kiểm toán.

## 5. Chi lợi nhuận, tạm ứng cổ đông và lương điều hành

Từ 18/11/2026 (migration [20261118041911](../../supabase/migrations/20261118041911_tam_ung_co_dong_va_chot_chi_loi_nhuan.sql)) đây là HAI nghiệp vụ tách nhau trên sổ tổng lợi nhuận cổ đông: **tạm ứng** là của cổ đông được cấp quyền tạm ứng, cộng dồn; **chi lợi nhuận** là chủ chốt theo tháng. Phiếu cũ không sửa.

### 5.1. Hai con số của mỗi cổ đông

Chủ đọc qua `shareholder_profit_positions_v1` (mọi cổ đông, kể cả cổ đông đã xoá còn số); cổ đông tự xem qua `shareholder_profit_my_position_v1` (kèm các lần chốt):

- **Lợi nhuận chưa chi** — phần được chia đã chốt (sau mốc "đã trả đủ") mà chủ chưa chốt chi. Có thể **âm** (vd một tháng đã chốt chi được mở chốt lại); lần chốt chi sau tự trừ lại.
- **Tạm ứng đang có** — mọi phiếu chi lợi nhuận **đã duyệt** của cổ đông lập sau mốc "đã trả đủ" mà chưa được khấu trừ ở một lần chốt — gồm phiếu Tạm Ứng mới VÀ phiếu chi lập bằng lệnh cũ trước 18/11/2026 (`shareholder_profit_ledger_payout_v1`); phiếu tiền của chính các lần chốt không tính. Luôn ≥ 0. Giảm khi chủ chốt chi (khấu trừ), khi phiếu bị huỷ, khi lương giữ lại để trừ, hoặc khi đặt mốc "đã trả đủ" (phiếu trước mốc không còn tính). Tạm ứng **chờ duyệt** hiện riêng ("chờ duyệt …"), chưa được khấu trừ khi chốt.
- Bất biến: lợi nhuận chưa chi − tạm ứng đang có − tạm ứng chờ duyệt = số dư ròng của sổ tổng. Lệch ⇒ máy chủ dừng (`PROFIT_LEDGER_POSITION_DRIFT`), giao diện không hiện số.
- Số đầu trang Tổng quan của chủ cộng đúng các dòng bảng "Sổ tổng theo cổ đông" đang hiện; chưa đọc được số thì hiện "—", không bao giờ hiện 0 thay số chưa biết.

### 5.2. Chi lợi nhuận = chốt đến hết một tháng, không nhập tay số tiền

Quyền `shareholder_profit.distribute`. Hộp "Chi lợi nhuận cổ đông" (nút Chi của từng cổ đông hoặc "Chi lợi nhuận"):

1. Chọn cổ đông và **"Chốt đến hết tháng N"** — mặc định là tháng đủ điều kiện mới nhất do máy chủ trả; chỉ chọn được tháng còn lợi nhuận chưa chi (tháng đã chốt lợi nhuận, sau mốc, không trước lần chốt chi gần nhất).
2. Máy chủ tính (`shareholder_profit_settlement_preview_v1`): **X** = lợi nhuận chưa chi đến hết N; **khấu trừ tạm ứng** K = min(X, tạm ứng đang có); **thực chi** = X − K. Ba dòng này khoá, không sửa được.
3. Thực chi > 0 ⇒ chọn sổ quỹ + ngày chi ⇒ một **phiếu chi chờ duyệt** (tiền chưa ra khỏi sổ). Thực chi = 0 ⇒ nút "Chốt, không ra tiền" (có bước xác nhận): không lập phiếu, có hiệu lực ngay.
4. Lệnh chốt `shareholder_profit_settle_v1` gửi kèm đúng hai số đang hiện (`p_expected_recognized`, `p_expected_cash`). Số vừa đổi ⇒ PT409 `PROFIT_LEDGER_SETTLE_CHANGED`, không ghi gì; hộp tải lại xem trước để chủ xem số mới rồi tự bấm lại (không tự gửi lại).

Hộp nhắc (không chặn) khi còn tạm ứng chờ duyệt (chưa được khấu trừ lần này), và khi cổ đông chưa có mốc "đã trả đủ" lẫn chưa chốt lần nào — lần chốt đầu gom toàn bộ phần được chia từ đầu, nên đặt mốc trước nếu tháng cũ đã trả ngoài app (có nút mở hộp đặt mốc, cả trên điện thoại). Các lần chốt còn hiệu lực liệt kê trong hộp: lần **không có phiếu tiền** huỷ bằng "Huỷ chốt" (`shareholder_profit_settlement_void_v1`, lý do 8–1000 ký tự); lần **có phiếu tiền** thì huỷ / từ chối chính phiếu chi đó — lần chốt tự hết hiệu lực, hai con số tự trở lại.

Web không còn gọi lệnh chi theo số tiền nhập tay (`shareholder_profit_ledger_payout_v1`) và xem trước cũ của nó cho cổ đông.

### 5.3. Tạm ứng của cổ đông

Người được cấp quyền `shareholder_profit.advance_own_cashbook`. Mọi khoản ứng là **tạm ứng**, cộng dồn; ứng vượt lợi nhuận chưa chi chỉ **cảnh báo**, không chặn; mọi phiếu **chờ chủ duyệt** (người duyệt khác người lập và người nhận).

- **Tự ứng** — nút "Chi tạm ứng cho tôi" ở màn tự xem, tab "Tạm ứng LN", và ở Tổng quan của chủ khi chính chủ là cổ đông của công ty đang xem và có quyền này. Chỉ chi từ sổ quỹ mình đang **giữ**; chưa giữ sổ nào ⇒ nhờ người đang giữ sổ lập phiếu Tạm Ứng hộ ở Thu chi.
- **Lập ở Thu chi** — phiếu CHI tạo mới, chọn hạng mục **"Tạm Ứng"** (chỉ có khi `shareholder_profit_advance_options_v1` báo lập được: sổ tổng chạy thật, người lập đang giữ sổ, có người nhận). Toà khoá về Kho Văn Phòng Chung; "người nhận" là dropdown những cổ đông có quyền tạm ứng (kể cả chính mình); sổ quỹ chỉ còn các sổ người lập đang giữ (máy chủ đã loại sổ ảo); một số tiền. Lưu bằng `shareholder_profit_advance_v1`, không đi lệnh tạo phiếu thường. Không có ở form lô, tạo nhanh, Báo chi nhanh.
- Người giữ sổ **lập hộ** không thấy số nào của cổ đông: xem trước, kết quả lập và câu lỗi không mang số; khi người đó tự huỷ phiếu chờ duyệt của mình, kết quả huỷ cũng không có số dư sau huỷ (máy chủ trả `balance_after` null cho người không có quyền chi lợi nhuận và không phải người nhận). Người lập (tự ứng hay lập hộ) tự huỷ được phiếu còn chờ duyệt; phiếu đã duyệt / đã chi thì chỉ người có quyền chi lợi nhuận huỷ.

### 5.4. Mốc "đã trả đủ"

`profit_ledger_set_marker_v1` đặt / đè / gỡ mốc "đã trả đủ đến hết tháng X": mọi khoản tới hết X không còn tính vào hai con số. Mốc **không lùi trước tháng đã chốt chi**: cổ đông có lần chốt còn hiệu lực đến hết tháng M thì mốc sớm hơn M bị từ chối (`PROFIT_LEDGER_MARKER_BEFORE_SETTLEMENT`); muốn đặt mốc sớm hơn thì huỷ lần chốt đó trước. Con số "tạm ứng bị xoá" của mốc cộng cả phần tạm ứng đã được khấu trừ ở các lần chốt.

### 5.5. Lương điều hành và hạch toán

- `manager_salary_payout_v1` lập phiếu lương điều hành (quyền `shareholder_profit.pay_manager`); số còn lại đọc từ sổ lương điều hành `profit_manager_ledger_v1`. Luồng này không đổi theo đợt tạm ứng / chốt chi.
- Phiếu chi lợi nhuận, tạm ứng và lương điều hành nằm trên toà ảo `Chung`, gắn `shareholder_id` hoặc `profit_manager_id`, và `business_result_accounting=false` để không trừ ngược KQKD đã dùng làm nguồn chia.

Các adapter frontend vẫn có fallback coexistence được phân loại cho tới T7 drain; trạng thái 15/15 writer ON nằm ở [authorization/README.md](../authorization/README.md).

## 6. Quyền

| Action | Ý nghĩa |
|---|---|
| `shareholder_profit.view` | Xem báo cáo/phần được chia trong phạm vi cho phép; cũng là quyền đọc `profit_total_group_peers_v2` (bản đồ toà nào phải chốt cùng toà nào) |
| `shareholder_profit.lock` | Preview, close và reclose toàn kỳ |
| `shareholder_profit.unlock` | Xem state và reset/unlock theo guard |
| `shareholder_profit.distribute` | Chốt chi lợi nhuận cổ đông theo tháng (hộp chốt, không nhập tay số tiền), huỷ lần chốt không có phiếu tiền, đặt mốc "đã trả đủ"; xem hai con số của mọi cổ đông |
| `shareholder_profit.advance_own_cashbook` | Được tạm ứng lợi nhuận: tự ứng từ sổ quỹ mình đang giữ, hoặc nhận phiếu Tạm Ứng do người giữ sổ lập hộ ở Thu chi |
| `shareholder_profit.pay_manager` | Chi lương điều hành (lương quản lý) từ lợi nhuận |
| `shareholder_profit.manage_shareholders` | Quản lý cổ đông, tỷ lệ và cấu hình liên quan |

RPC/RLS kiểm organization và scope; ẩn/hiện tab ở frontend không phải lớp bảo vệ cuối.

## 7. Trang và hook chính

- `ProfitLockTab.tsx`: chọn organization/tháng, **tick từng toà**, preview, điều chỉnh, close/reclose/unlock/reset theo đúng vùng chọn. Tick một toà thuộc nhóm `TOTAL_GROUP` thì cả nhóm được chọn theo (và bỏ tick cũng bỏ cả nhóm) — logic thuần ở `expandTotalGroupSelection` trong `src/lib/profitClose.ts`.
- `useProfitCloseOrganizations`, `useProfitCloseState`, `useProfitClosePreview`, `useCloseProfitPeriod`, `useResetProfitPeriod`: client của RPC V2.
- `ProfitOverviewTab.tsx` / `ProfitOverviewMobile.tsx`: Tổng quan của chủ — bảng / thẻ "Sổ tổng theo cổ đông" (được chia sau mốc, đã chi kèm chờ duyệt, qua lương, lợi nhuận chưa chi, tạm ứng đang có) với nút Sổ / Mốc / Chi; "Chi tạm ứng cho tôi" khi chủ đồng thời là cổ đông có quyền tạm ứng.
- `ShareConfigTab.tsx`: cổ đông, tỷ lệ và quản lý điều hành.
- `ShareholderSelfView.tsx`, `ShareholderAdvanceTab.tsx`, `ProfitManagerSelfView.tsx`: self-view (hai con số, các lần chốt, phiếu của mình) và tab "Tạm ứng LN".
- `ProfitDistributeDialog.tsx`: hộp chốt chi lợi nhuận theo tháng; `ProfitSelfAdvanceDialog.tsx`: tự tạm ứng; `ProfitLedgerMarkerDialog.tsx`: mốc "đã trả đủ"; `ShareholderAdvanceVoucherPanel.tsx` (form Thu chi): phiếu Tạm Ứng; `ManagerSalaryPayoutDialog.tsx`: lương điều hành.
- Số và chữ dùng chung ở `src/lib/profitLedger/positionView.ts` (hai con số, câu nhắc), bộ đọc RPC ở `positionReaders.ts`, hook ở `src/hooks/profit-ledger/`.

## 8. Kiểm tra khi thay đổi

1. Test preview và close/reclose với nguồn đổi giữa hai bước; phải conflict thay vì ghi.
2. Test idempotency replay và key reuse khác payload.
3. Test active/inactive/deleted shareholder/manager và cross-org mapping.
4. Test tháng hỗn hợp dùng reset guard với state hash/snapshot IDs.
5. Test chốt lẻ: chốt 2 toà rồi mở lại preview toàn tháng — 2 toà đó phải KHÔNG `is_stale`. Đây là bất biến dễ vỡ nhất khi ai đó "tối ưu" preview về đúng tập ghi.
6. Test guard nhóm: dựng một quy tắc `TOTAL_GROUP` phủ 3 toà rồi chốt 1 toà — phải nhận `[TOTAL_GROUP_KHONG_DU]`.
7. Chạy test liên quan, `npm run typecheck:baseline` và `node scripts/reconcile-money.mjs [YYYY-MM]`.
8. Nếu migration đụng view, chạy `node scripts/check-view-invoker.mjs`.

Xem hướng dẫn thao tác: [Chia lợi nhuận](../huong-dan-su-dung/03-quan-ly-van-hanh/chia-loi-nhuan/).

## 9. Toà vận hành cho chủ nhà — quyết toán tháng (chủ chốt 21/10/2026)

Toà do chủ nhà sở hữu, công ty vận hành và nhận % lợi nhuận tháng theo thoả thuận riêng từng toà — không thuê lại, không có tiền nhà. Toà loại này **không** quyết toán qua Profit Close V2 hay chia cổ đông ở trên.

- Màn `/reports/finance/quyet-toan-van-hanh` (chủ công ty / super admin, RPC chặn 42501) và link chỉ đọc `/qt/:token` cho chủ nhà (không đăng nhập, thu hồi được, không lộ id nội bộ).
- Công thức một nơi: `app_private.landlord_settlement_compute_v1` ([migration](../../supabase/migrations/20261021083438_quyet_toan_van_hanh_chu_nha.sql)). Phiếu đã duyệt; dòng lãi lỗ (đúng vị ngữ KQKD canonical: `business_result_accounting IS DISTINCT FROM false` và (`IS TRUE` hoặc `accounting_class = 'PNL'`)) chia tháng **theo kỳ** ghi trên hạng mục — chủ chốt 22/10 — bằng `app_private.landlord_kqkd_lines_v1`, bản chép đúng luật xếp tháng của `fa_accrual_allocations` (hoá đơn ⇒ tháng hoá đơn; kỳ nhiều tháng ⇒ chia đều; không kỳ ⇒ ngày phiếu) nhưng không xét quyền người gọi (link chủ nhà) và có cả phiếu chờ duyệt; test PGlite so từng đồng với định nghĩa sống của `fa_accrual_allocations`. Lợi nhuận quyết toán vì thế bằng đúng lợi nhuận toà trên Báo cáo LN (phần đã duyệt). Cọc / tiền khách trả thừa / dòng không tính / tiền thối là dòng tiền thật ⇒ theo **ngày phiếu**. Phiếu ở sổ quỹ thuộc danh sách sổ chủ nhà ⇒ chủ nhà giữ; mọi sổ khác ⇒ quản lý giữ.
- Phần quản lý = `round(LN × %)` khi LN > 0, ngược lại 0đ. Chủ nhà trả quản lý = phần quản lý + quản lý chi − quản lý thu + cọc/tiền khách trả thừa/tiền thối đang nằm ở sổ chủ nhà (âm ⇒ quản lý trả lại chủ nhà). Làm tròn **không** tính (là phần khách trả thiếu được bỏ qua). Cọc ở sổ quản lý chỉ hiển thị.
- % quản lý và sổ chủ nhà theo **phiên bản tháng** (`app_private.landlord_operation_terms`, tháng M dùng `valid_from` lớn nhất ≤ M). Sửa "từ tháng X" (mặc định ngay sau tháng chốt gần nhất): so với điều khoản đang áp ở X, **trường nào đổi thì ghi trường đó** cho X và mọi mốc sau X — đổi % không kéo theo sổ của mốc khác và ngược lại; tháng trước X giữ nguyên; X không được là tháng đã chốt. Không dời "áp dụng từ tháng" ra sau tháng đã chốt (55000). Sổ chủ nhà thêm mới phải là sổ quỹ thật, chưa xoá (sổ đang có mà sau bị xoá vẫn giữ được).
- Thanh lý tách theo `system_source` (`termination.revenue`, `forfeit_revenue`, `extra_receipt`, `refund`, `offset`, `rent_refund_*`); mọi dòng thuộc đúng một nhóm (tính KQKD / cọc / không tính) — nhóm "không tính" vẫn liệt kê kèm lý do.
- Chốt tháng: chỉ tháng đã qua, không còn phiếu chờ duyệt, không có phiếu đã duyệt mà bút toán sổ quỹ bị đảo hoặc chưa ghi sổ (UNPOSTED), không có phiếu dùng sổ chủ nhà của toà vận hành khác, không có phiếu của toà khác ghi vào sổ chủ nhà của toà này, tháng đầu tiên không còn phiếu chờ duyệt ghi ngày trước tháng áp dụng, số dư đầu kỳ đã được đánh dấu "đã đối chiếu với chủ nhà" (khi số dư hoặc cọc trước kỳ ở sổ chủ nhà khác 0). Dấu đối chiếu gắn với **cơ sở** lúc xác nhận (tháng áp dụng + cọc trước kỳ): dời tháng hay cọc trước kỳ đổi (phiếu nhập muộn, đổi sổ) thì hết hiệu lực; xác nhận mới chỉ được nhận khi cơ sở không đổi ngay trong lần lưu đó và đúng số cọc trước kỳ màn đã hiện (`p_opening_seen_pre_start`) — không ai "xác nhận" một con số chưa thấy. CAS theo `source_hash` (chỉ dòng KQKD và cọc ở sổ chủ nhà — duyệt cọc giữ chỗ ở sổ quản lý không làm tháng "đã đổi"), append-only. Chốt **không khoá phiếu**: phiếu đổi sau khi chốt ⇒ màn báo "đổi sau khi chốt"; mở chốt (lý do ≥ 8 ký tự) rồi chốt lại.
- Màn quản trị (không có trên link chủ nhà) kèm: khối **đối chiếu với Báo cáo LN** (`fa_accrual_allocations`) — cùng luật kỳ nên khớp từng đồng; lệch chỉ khi tháng đã chốt mà phiếu đổi sau đó, hoặc luật kỳ của `fa_accrual_allocations` đổi mà bản chép chưa đổi (lỗi kỹ thuật, màn báo đỏ); cảnh báo khoản chi cố định chưa có phiếu (theo Phí cố định theo toà, điện/nước mặc định, bỏ tiền nhà; hạng mục đã gắn khoá là nguồn đúng), phiếu ở toà khác/toà ảo có nhắc tên toà (bỏ dấu), phiếu toà khác ghi vào sổ chủ nhà, phiếu chờ duyệt trước tháng áp dụng, khoản lãi lỗ có **kỳ trước tháng áp dụng** mà phiếu lập sau (không tính, không chặn chốt). Dòng lãi lỗ mà hạng mục không còn tồn tại (KQKD bỏ qua) hiện ở "không tính" kèm lý do. Hộp cài đặt đánh dấu sổ "dùng chung với N toà khác" và không gợi ý sổ dùng chung.
- Link chủ nhà: không lộ id, tên sổ chỉ còn "Sổ chủ nhà" / "Sổ quản lý" / "Cấn trừ cọc (nội bộ)", tên phiếu có hạng mục hạn chế bị che; ghi chú chốt và ghi chú thanh toán chủ nhà xem được. Toà bị xoá mềm / chuyển toà ảo ⇒ link chết. Huỷ thanh toán / thu hồi link: id/token không có và không có quyền trả cùng lỗi 42501.
- Thanh toán quyết toán giữa hai bên ghi ở `app_private.landlord_settlement_payments` (không sinh phiếu thu/chi, huỷ phải có lý do). Còn lại = số dư đầu kỳ + Σ quyết toán tháng đã chốt − chủ nhà đã trả + quản lý đã trả; chưa chốt tháng nào thì màn ghi "Chưa chốt tháng nào" thay vì 0 đ.
- Báo cáo Lợi Nhuận giữ **tổng lợi nhuận** như cũ và thêm **một dòng "Lợi nhuận của iHome"** = tổng − phần chủ nhà của các toà vận hành trong phạm vi đang xem (chủ chốt 22/10: phần chủ nhà vẫn tính, không hiện thành dòng riêng). Phần chủ nhà lấy từ `public.landlord_ihome_profit_v1` theo toà × tháng: tháng đã chốt lấy số đã chốt, tháng mở là số tạm tính; chỉ toà người gọi xem được (`can_access_building`). Chốt LN tháng (Profit Close) **chưa đổi**: vẫn chốt lợi nhuận toàn toà.
