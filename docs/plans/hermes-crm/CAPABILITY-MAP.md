# Bản đồ năng lực CRM → Hermes (P0.06)

## Cập nhật đích quyền và trạng thái — 19/10/2026

**Checkpoint 19/10, 12:51 UTC+7:** core `8bcee906` ở draft [PR #222](https://github.com/zxGreenxz/whiteboard-ihomecrm/pull/222); cả sáu production migration official forward lane PASS lúc `2026-10-19T05:51:09.263Z`. Gate5 core 67/67 Node 24.18.0, TEST read-only 64/64, fast fixture 15/15 và binding 19/19 PASS. Production post-apply verifier 23/23 PASS; catalog 53 hàm (51 digest + 2 SQL standard), ACL 17, metadata 11. Read-only org có ACTIVE membership xác nhận ba cặp wrapper/core deepEqual, mỗi cặp 5 hàng; DEMO ban đầu rỗng. Chưa deploy VPS/phát hành app; fast production, UI, broker/provider, p95 và CI head cuối chưa kiểm. Các dòng inventory dưới đây giữ snapshot source/capability; trạng thái triển khai mới nhất ở [STATUS](STATUS.md).

**Quyền Hermes = quyền web của user − những quyền bị tắt trong cài đặt Hermes.** [Plan và audit §10](TINH-GON-KIEM-QUYEN.md) đang được hiện thực; sáu migration đã qua production lane nhưng runtime VPS/app chưa phát hành. Mode kế thừa giữ giới hạn có chủ đích; bỏ cấp lại/kiểm lặp, giữ registry readiness và quyền/RLS/nghiệp vụ CRM thật. Không áp đặt 100 ms/cấm cache/epoch mọi RPC từ ý kiến audit khác. Allowlist cũ chuyển sang exclusions có bằng chứng. PII xét từng field/output/search; Network Center giữ tạm RLS khách, không gỡ theo web RPC DEFINER. Khóa chưa hỗ trợ không được coi là user đã tắt.

Baseline source/runtime `81c49363`: 52 khóa đọc + 11 khóa thao tác khai báo; ba khóa Wave2 chưa có báo cáo giữ tắt. Wave2 có 70 báo cáo qua hai tool; số khóa, số tool và số báo cáo là ba đơn vị khác nhau. Theo bàn giao sáng 19/10, đợt 2 và #217 đã production; connection mới có 48 + 11 khóa, thấy 69 báo cáo, đã ghép Zalo nhưng chưa nghiệm thu đợt 2 qua Zalo. Đây là baseline vận hành, không phải số đo live mới.

Các nhãn “chưa gắn broker”, “chưa áp” và “chưa đo” trong các mục snapshot cũ phải đối chiếu [STATUS](STATUS.md#cập-nhật-1910); không dùng chúng để bật quyền hoặc kết luận chức năng hiện đang thiếu. Parity còn phải rà superadmin, sổ quỹ/owner, dữ liệu không gắn tòa và PII che thêm riêng của Hermes. Ba reader khách/hợp đồng/hóa đơn có candidate shared core + fast RPC; TEST read-only 64/64 và fixture 15/15 PASS. Sáu migration qua production lane, nhưng chưa deploy VPS/phát hành app hoặc đổi marker runtime. Không đổi marker production `mirrored` thành `rpc` chỉ bằng sửa tài liệu.

Snapshot 15/10/2026, nhánh gói E từ `0991db1a`; cập nhật 18/10/2026 (Gói Z) cho đợt 2 đọc đầy đủ — §2 cột Hermes/Disposition và §5.4. Đối chiếu [inventory](../../../tooling/hermes-crm-inventory.generated.json) schemaVersion 2 (67 tool, 32 action, 29 bề mặt UI) với source, migration và broker hiện có. Chỉ dựa trên repo: **chưa đo catalog/ACL TEST hay production**, chưa gọi PostgREST thật. Inventory là manifest Copilot, không phải cấu hình quyền; file này không cấp quyền hay bật capability nào.

## 1. Quy ước

**Công thức quyền dùng chung (mọi dòng "đã chuyển"/"chuyển đợt này"):** quyền CRM hiện tại của user (`get_authorization_context_v1` + `authorized_scope_v3(<khoá>)`, membership còn hiệu lực, không offboard) ∩ registry `app_private.hermes_capabilities` (mặc định TẮT) ∩ chính sách công ty Hermes ∩ Read/Action + scope đã lưu của kết nối. SQL là lớp quyết định cuối; broker chỉ lọc danh sách tool và kiểm lại kết quả. Actor/công ty lấy từ kết nối đã xác minh, model không tự khai.

**Disposition:** `Đã chuyển` (có tool Hermes) · `Chuyển đợt này` (gói E) · `Một phần` (tool hiện có phủ một phần, phần còn lại ghi rõ) · `Giữ UI/deep link` · `Hoãn` (kèm lý do) · `Bỏ có chủ đích`.

**Không mang sang Hermes (cơ chế Copilot, không phải nghiệp vụ):** cờ `copilot_feature_flags` qua `copilot_page_flag_allows_v1` (23 reader dính cờ, mặc định `disabled`); nonce `copilot_write_confirmations`; `copilot_action_gate_v1`; khoá idempotency/ledger `ai_write_audit`, `copilot_action_ledger`; kế hoạch L5 + PIN step-up, `pin_always`; `copilot_plan_role_allowed_v1`; marker `copilot_ie_writer_context_v1` của writer nháp; quyền chat `ai_copilot.view`. **Giữ nguyên (điều kiện nghiệp vụ thật):** khoá quyền và scope toà/sổ trong hàm canonical (`authorized_scope_v3`, `can_do_on_building`, `authorize_income_expense_on_building`, `can_v3`), quyền dùng sổ quỹ (chủ sổ/CUSTODIAN/OPERATOR), vòng đời/trạng thái, CAS phiên bản, khoá chống trùng canonical, bộ máy chi và thang duyệt.

Ký hiệu cổng reader Copilot: **H** = `copilot_org_scope_buildings_v1` (mảng toà theo `authorized_scope_v3`, thiếu quyền trả rỗng), **A** = kiểm grant và raise 42501, **cờ** = dính `copilot_feature_flags`.

## 2. Tool đọc (55)

| Tool Copilot | Quyền CRM | RPC/hàm nền (cổng) | Hermes | Disposition |
| --- | --- | --- | --- | --- |
| `phong_trong` | rooms.view | `copilot_available_rooms_v1` (H) | `crm_available_rooms` | Đã chuyển |
| `bao_cao_phong_trong` | reports_real_estate.vacant_rooms | `copilot_report_vacant_rooms_v1` (H) | `crm_available_rooms`, `crm_read_occupancy`; `crm_read_report` re_vacant_rooms | Chuyển đợt 2 (18/10, chưa áp TEST/prod) |
| `ty_le_lap_day` | reports_real_estate.occupancy | `occupancy_snapshot_v2` / `_upcoming_vacancy_v2` (H) | `crm_read_occupancy` (họ v3 từ 17/10: cùng snapshot web, không đếm `rooms.status`); `crm_read_occupancy_report` (snapshot/upcoming gọi thẳng hai RPC web) | Đã chuyển (17/10) |
| `tim_khach_hang` | customers.view | `copilot_customer_search_v1` (H, SĐT đầy đủ) | `crm_read_customers` (SĐT đầy đủ từ 16/10, họ v3) + `crm_read_customer_detail` | Đã chuyển |
| `tim_khach_hen` | leads.view | `copilot_lead_search_v1` (H+A) | `crm_read_leads` | Đã chuyển |
| `tim_hop_dong` | contracts.view | `copilot_contract_search_v1` (H) | `crm_read_contracts`; `crm_read_contract_search` (SQL theo danh sách Hợp đồng: số HĐ/phòng/tên-SĐT khách, bộ lọc ACTIVE/TERMINATED/EXPIRING/EXPIRED và nhãn hiển thị web; theo toà đã giao) | Đã chuyển (17/10 bỏ phụ thuộc copilot) |
| `chi_tiet_hop_dong` | contracts.view | `copilot_contract_detail_v1` (H) | `crm_read_contract_detail` (họ v3: điều khoản, cọc, người ở, dịch vụ) | Đã chuyển (16/10) |
| `tim_hoa_don` | invoices.view | `copilot_invoice_search_v1` (H) | `crm_read_invoices`; `crm_read_invoice_report` (search theo bộ lọc /invoices: ẩn huỷ, unpaid = chưa thu đồng nào; stats) | Đã chuyển (17/10 bỏ phụ thuộc copilot) |
| `cong_no_tong_quan` | invoices.view | `get_invoice_statistics_v2` (H) | `crm_read_receivables` | Chuyển đợt này (dạng danh sách còn nợ); thống kê gộp hoãn: chưa rà shape JSON |
| `bao_cao_lich_thu_tien` | reports_finance.payment_schedule | `copilot_report_payment_schedule_v1` (H, tên khách) | `crm_read_report` payment_schedule (tên khách khi có customers.view); `crm_read_receivables` | Chuyển đợt 2 (18/10, chưa áp TEST/prod) |
| `tim_phieu_thu_chi` | income_expenses.view | `copilot_income_expense_search_v1` (H + `can_view_restricted_ie`) | `crm_read_income_expenses` | Chuyển đợt này |
| `hop_cho_duyet` | income_expenses.view | `list_my_pending_approvals_v1` (H+A) | `crm_read_pending_approvals` (gọi thẳng RPC hộp /approvals, việc chờ CHÍNH người hỏi duyệt, Toàn tổ chức); "phiếu chờ duyệt" = `crm_read_income_expenses status=UNAPPROVED` | Đã chuyển (17/10) |
| `chi_so_cong_to` | meter_readings.view | `copilot_meter_readings_v1` (H+A) | `crm_read_meter_readings` | Chuyển đợt này |
| `coc_dang_giu` | deposits.view | `get_held_deposit_summary` (H) | `crm_read_deposits_held` | Chuyển đợt này |
| `doanh_thu_thang` | reports_finance.analysis | `fa_monthly_pnl` / `_accrual` (H) | `crm_read_building_profit` (cash); `crm_read_monthly_pnl` (theo tháng, mặc định accrual như Phân tích tài chính, kèm thu/chi chờ duyệt mà BC Doanh Thu Chi Phí cộng thêm) | Đã chuyển (17/10) |
| `cong_viec` | tasks.view | `copilot_tasks_v1` (H+A) | `crm_read_tasks` | Đã chuyển |
| `danh_sach_tai_san` | assets.view | `copilot_asset_directory_v1` (H+A, cờ) | `crm_read_assets` (không cờ) | Đã chuyển |
| `danh_sach_dich_vu` | services.view | `copilot_service_directory_v1` (H+A, cờ) | `crm_read_services` | Đã chuyển |
| `danh_sach_loai_cong_viec` | task_types.view | `copilot_job_type_directory_v1` (A, cờ) | `crm_task_input_options kind=jobTypes`; `crm_read_report` task_types (bỏ thưởng/tính lương) | Chuyển đợt 2 (18/10, chưa áp TEST/prod) |
| `danh_sach_toa_nha` | buildings.view | `copilot_building_directory_v1` (A+H, cờ) | `crm_read_report` buildings, building_detail, rooms, room_detail; nhãn toà trong `crm_*_input_options` | Chuyển đợt 2 (18/10, chưa áp TEST/prod) |
| `danh_sach_phong_sale` | sale_phong.view | `copilot_sale_listing_directory_v1` (H+A, cờ) | `crm_available_rooms`, `crm_room_pass_observe` | Một phần |
| `hoi_thoai_zalo` | chat_zalo.view | `copilot_zalo_conversations_v1` (H+A; SĐT, nội dung tin) | `crm_group_directory` (nhóm); `crm_read_zalo_conversations` (SQL theo trang Chat Zalo + điều kiện RLS `zalo_authorized_org_ids('view')`; trả lời riêng, Toàn tổ chức) | Đã chuyển danh sách (17/10 bỏ phụ thuộc copilot); nội dung đầy đủ tin nhắn chưa |
| `bao_cao_dat_coc` | reports_finance.deposits_report | `copilot_report_deposits_v1` (H, tên khách) | `crm_read_deposits_held`; `crm_read_report` held_deposits, reservation_vouchers, reservation_settlements, deposit_refunds (khoá deposits.view) | Một phần: khoá reports_finance.deposits_report giữ tắt (bảng legacy deposits chưa có báo cáo) |
| `bao_cao_gia_han` | reports_real_estate.renewals_transfers | `copilot_report_renewals_v1` (H) | `crm_read_report` re_renewals_transfers | Chuyển đợt 2 (18/10, chưa áp TEST/prod) |
| `bao_cao_hop_dong_moi` | reports_real_estate.new_leases | `copilot_report_new_leases_v1` (H) | `crm_read_report` re_new_leases | Chuyển đợt 2 (18/10, chưa áp TEST/prod) |
| `bao_cao_thanh_ly` | reports_real_estate.terminations | `copilot_report_terminations_v1` (H; hoàn cọc, tên khách) | `crm_read_report` re_terminations (mẫu số tỉ lệ theo toà — khác web); hoàn cọc: `crm_read_report` deposit_refunds | Chuyển đợt 2 (18/10, chưa áp TEST/prod) |
| `hop_dong_sap_het_han` | reports_real_estate.expiring | `copilot_expiring_contracts_v1` (H) | `crm_read_report` re_expiring; `crm_read_contracts` | Chuyển đợt 2 (18/10, chưa áp TEST/prod) |
| `bao_cao_thu_thua` | reports_finance.overpayment | `copilot_report_overpayment_v1` (H) | `crm_read_report` overpayment | Chuyển đợt 2 (18/10, chưa áp TEST/prod) |
| `bao_cao_ty_le_chi_phi` | reports_real_estate.expense_ratio | `copilot_report_expense_ratio_v1` (H) | `crm_read_report` re_expense_ratio | Chuyển đợt 2 (18/10, chưa áp TEST/prod) |
| `bao_cao_dong_tien` | reports_finance.cash_flow | `copilot_report_cash_flow_v1` (H+A, postings, sổ) | `crm_read_report` cash_flow (hàng toàn công ty buildingId=null chỉ khi Toàn tổ chức) | Chuyển đợt 2 (18/10, chưa áp TEST/prod) |
| `bao_cao_thu_chi_theo_ngay` | reports_finance.daily_cashbook | `copilot_report_daily_cashbook_v1` (như trên) | `crm_read_report` cashbook_daily; `crm_read_income_expenses` (danh sách) | Chuyển đợt 2 (18/10, chưa áp TEST/prod) |
| `so_quy` | cashbooks.view | `copilot_cashbook_settlement_v2` (scope sổ) | `crm_read_report` cashbooks, cashbook_closings (chỉ sổ nhìn thấy, không số tài khoản) | Chuyển đợt 2 (18/10, chưa áp TEST/prod) |
| `bao_cao_ban_giao` | reports_finance.handover_report | `copilot_report_handover_v1` (A, cờ, sổ) | — | Hoãn: khoá reports_finance.handover_report giữ tắt (chưa có báo cáo; phạm vi web theo staff_assignments phải viết lại) |
| `bao_cao_chu_ky_thu` | reports_finance.collection_cycle | `copilot_report_collection_cycle_v1` (A, cờ) | — | Hoãn: khoá reports_finance.collection_cycle giữ tắt (chưa có báo cáo; như trên) |
| `bao_cao_khuyen_mai` | reports_real_estate.promotions | `copilot_report_promotions_v1` (A, cờ) | `crm_read_report` re_promotions | Chuyển đợt 2 (18/10, chưa áp TEST/prod) |
| `bang_luong_ky` | salary.view | `copilot_salary_summary_v1` (cờ sensitive; lương cá nhân) | `crm_read_report` salary_month (salary.view, tháng đã chốt); `crm_read_report` my_salary (assistant.salary.self) | Chuyển đợt 2 (18/10, chưa áp TEST/prod) |
| `loi_nhuan_co_dong` | shareholder_profit.view | `copilot_shareholder_profit_v1` (cờ sensitive) | `crm_read_report` profit_shareholders, profit_my_share | Chuyển đợt 2 (18/10, chưa áp TEST/prod) |
| `trang_thai_mang` | network_center.view | `copilot_network_status_v1` (cờ sensitive) | `crm_read_report` network_fleet … network_config_diff (10 báo cáo; fleet toàn công ty ≤256 toà) | Chuyển đợt 2 (18/10, chưa áp TEST/prod) |
| `tim_xe` | vehicles.view | `copilot_vehicle_search_v1` (biển số, chủ xe) | `crm_read_report` vehicles (tên/SĐT khách khi có customers.view) | Chuyển đợt 2 (18/10, chưa áp TEST/prod) |
| `ton_kho_vat_tu` | materials.view | `copilot_material_stock_v1` (H+A) | `crm_read_report` materials, material_categories, material_purchases, material_usages, material_adjustments | Chuyển đợt 2 (18/10, chưa áp TEST/prod) |
| `danh_sach_bao_tri_tai_san` | assets.view | `copilot_asset_maintenance_directory_v1` (cờ) | `crm_read_assets` | Một phần |
| `danh_sach_cong_to` | meters.view | `copilot_meter_directory_v1` (cờ) | `crm_read_report` meters | Chuyển đợt 2 (18/10, chưa áp TEST/prod) |
| `danh_sach_dinh_muc_dich_vu` | service_quotas.view | `copilot_service_quota_directory_v1` (cờ) | `crm_read_report` service_quotas | Chuyển đợt 2 (18/10, chưa áp TEST/prod) |
| `danh_sach_hotline` | hotline.view | `copilot_hotline_directory_v1` (cờ, SĐT đầy đủ) | `crm_read_report` hotlines | Chuyển đợt 2 (18/10, chưa áp TEST/prod) |
| `danh_sach_kho_tai_san` | warehouses.view | `copilot_warehouse_directory_v1` (cờ) | `crm_read_report` warehouses | Chuyển đợt 2 (18/10, chưa áp TEST/prod) |
| `danh_sach_khu_vuc` | areas.view | `copilot_area_directory_v1` (cờ) | `crm_read_report` areas (khoá buildings.view); nhãn khu vực trong lựa chọn scope | Chuyển đợt 2 (18/10, chưa áp TEST/prod) |
| `danh_sach_loai_tai_san` | asset_types.view | `copilot_asset_type_directory_v1` (cờ) | — | Hoãn |
| `danh_sach_nha_cung_cap` | suppliers.view | `copilot_supplier_directory_v1` (cờ) | `crm_read_report` suppliers (chỉ id, tên) | Chuyển đợt 2 (18/10, chưa áp TEST/prod) |
| `danh_sach_tang` | categories.view | `copilot_floor_directory_v1` (cờ) | `crm_read_report` floors (khoá buildings.view như RLS) | Chuyển đợt 2 (18/10, chưa áp TEST/prod) |
| `danh_sach_thanh_vien_vai_tro` | users.view | `copilot_member_role_directory_v1` (cờ) | — | Hoãn: quản trị thành viên |
| `thong_bao_gan_day` | notifications.view | `copilot_notification_feed_v1` (cờ) | `crm_read_report` notifications (của chính người hỏi, công ty kết nối) | Chuyển đợt 2 (18/10, chưa áp TEST/prod) |
| `trang_thai_gach_no_tu_dong` | auto_debt.view | `copilot_auto_debt_status_v1` (cờ) | — | Hoãn |
| `ban_do_he_thong`, `huong_dan`, `liet_ke_chu_de` | — | tài liệu tĩnh trong bundle | — | Hoãn: cần nguồn tài liệu theo permission (§07 "Tài liệu"), không phải RPC CRM |

## 3. Tool ghi/điều phối (12)

| Tool Copilot | Action / quyền | Hermes | Disposition |
| --- | --- | --- | --- |
| `tao_phieu_thu_chi_nhap` | income_expense.create_draft / income_expenses.create | `crm_expense_create` (+ `_input_options`, `_status`) | Chuyển đợt này qua writer canonical `create_income_expense_v1`, **không** dùng `ie_compat_insert_v2` + marker Copilot |
| `doi_trang_thai_tin_phong_nho_sale` | room_pass.set_active / sale_phong.manage_pass_listings | `crm_room_pass_set_active` (+ observe/status) | Đã chuyển |
| `ghi_nho`, `quen` | — / ai_copilot.view | `crm_work_memory_*` | Đã chuyển (work memory opt-in; personal memory thuộc Hermes) |
| `mo_trang` | — | deep link route | Giữ UI/deep link (P8.04); không PageAgent/DOM |
| `lap_ke_hoach`, `thuc_thi_buoc` | plan L5, superadmin | — | Bỏ có chủ đích: engine kế hoạch/PIN Copilot; Hermes tự điều phối |
| `ghi_chu_phieu_thu_chi` | income_expense.annotate / income_expenses.edit | — | Hoãn: canonical `annotate_income_expense_v1` có idempotency + bảo vệ bằng chứng; ứng viên đợt sau |
| `ghi_chi_so_cong_to` | meter_reading.create / meter_readings.create | — | Hoãn: UI INSERT thẳng bảng (APPROVED ngay), `create_meter_reading_v1` ép APPROVED, không có khoá chống trùng; cần chủ chốt AI ghi chỉ số có tự duyệt không |
| `dat_han_giu_cho` | reservation.set_hold_terms / deposits.edit | — | Hoãn: tiền cọc giữ chỗ |
| `tao_phieu_giu_cho` | reservation_deposit.create / deposits.create | — | Bỏ đường cũ (`create_reservation_deposit_v1` luôn 55000); luồng mới `create_room_reservation_v1` hoãn |
| `dat_co_hoi_thoai_zalo` | zalo.set_conversation_flags / chat_zalo.view | — | Hoãn: Zalo cá nhân |

## 4. Action Copilot (32)

Cột "Canonical" là hàm nghiệp vụ mà UI/execute thật gọi (theo khảo sát migration; ACL các hàm chỉ có trong baseline `--no-acl` **chưa xác minh** trên production).

| Action | Canonical | Disposition và lý do |
| --- | --- | --- |
| income_expense.create_draft | `create_income_expense_v1` (UI); Copilot từng dùng `ie_compat_insert_v2` | Chuyển đợt này (§5.2) |
| room_pass.set_active | `set_room_pass_listing_active` | Đã chuyển (hermes_room_pass_action_v1) |
| zalo.broadcast | `zalo_broadcast` | Một phần: thay bằng gửi nhóm `crm_group_room_send` theo projection công khai; phát sóng tuỳ ý không mở |
| income_expense.duyet | UI `approve_income_expense_v2` (CAS + idempotency); Copilot dùng v1 ba bậc | Hoãn: không tự duyệt; nếu mở phải là lệnh rõ của người có quyền duyệt và theo đúng v2 |
| income_expense.duyet_vao_so, income_expense.vao_so | `approve_and_post_income_expense_v2`, `post_approved_income_expense_v2` | Hoãn: posting, CAS phiên bản, reconcile v1/v2 |
| income_expense.annotate | `annotate_income_expense_v1` | Hoãn (ứng viên không tiền) |
| income_expense.nop_ho_so | chỉ helper Copilot quanh `submit_financial_voucher` | Bỏ có chủ đích: không màn nào dùng |
| cashbook.chot_so | `confirm_cashbook_closing_v1` | Hoãn: khoá sổ, cần overlay sổ quỹ |
| invoice.duyet, invoice.duyet_hang_loat, invoice.xoa_mem | `approve_invoice_v1`, `bulk_approve_invoices_v1`, `soft_delete_invoice_v1` | Hoãn: công nợ; bản hàng loạt canonical im lặng bỏ phần tử sai, cần lớp fail-closed |
| meter_reading.create, .duyet, .xoa_hang_loat | `create_meter_reading_v1`, `approve_meter_reading_v1`, `bulk_delete_meter_readings_v1` | Hoãn (xem §3); xoá hàng loạt UI không dùng RPC |
| contract.gia_han | UI `renew_contract_with_notice_v1` (Copilot dùng `renew_contract`) | Hoãn: hợp đồng; khi mở phải dùng bản with_notice (CAS, báo dọn) |
| room.chuyen_phong | UI `transfer_room_with_notice_v1` | Hoãn: như trên |
| contract.chuyen_nhuong | `transfer_contract` | Hoãn: đổi giá/cọc |
| contract.duyet_thanh_ly | `approve_contract_termination_v1` | Hoãn: sinh phiếu hoàn, vòng đời cọc |
| termination.hoan_coc | `create_termination_refund_voucher_v1` | Bỏ có chủ đích (đã gỡ 23/09) |
| reservation_deposit.create | thay bằng `create_room_reservation_v1` | Bỏ đường cũ; luồng mới hoãn |
| reservation.set_hold_terms | `set_reservation_hold_terms_v1` | Hoãn |
| customer.xoa_mem | `soft_delete_customer` | Hoãn: phá huỷ, chỉ chủ bản ghi/superadmin |
| salary.chi_luong, salary.khoa_thang | `salary_payout_v1`, `lock_salary_month_v2` | Hoãn: miền lương |
| member.invite, member.set_status, member.update_authorization, role.upsert | `invite_organization_member_v1`, `set_membership_status_v1`, `update_member_authorization_v1`, `upsert_organization_role_v1` | Giữ UI: thay đổi quyền/thành viên do người thật thao tác |
| network.execute_action | `network_center_execute_action_v1` | Hoãn: tác động thiết bị, UNKNOWN_EFFECT cần đối soát |
| zalo.recall_message, zalo.set_conversation_flags | `zalo_recall_message`, `zalo_set_conversation_flags` | Hoãn |

## 4b. Bề mặt UI (29, inventory `retain_ui`)

Tất cả **Giữ UI**: Hermes không điều khiển DOM; trùng khoá quyền không chứng minh có tool. Phủ dữ liệu qua connector:

| Route (quyền) | Hermes phủ |
| --- | --- |
| /apartments (rooms.view), /sale-phong (sale_phong.view), /building-map, /buildings (buildings.view) | `crm_available_rooms`, `crm_read_occupancy`, `crm_room_pass_*`, lịch phòng |
| /customers, /leads, /contracts, /invoices, /tasks, /assets, /services | tám miền đọc v1; tasks.create |
| /income-expense (income_expenses.view), /chi-tieu (income_expenses.create) | `crm_read_income_expenses`, `crm_expense_*` (đợt này) |
| /meter-readings (meter_readings.view), /deposits (deposits.view) | `crm_read_meter_readings`, `crm_read_deposits_held` (đợt này) |
| /reports/real-estate (reports_real_estate.view) | `crm_read_occupancy`, `crm_read_building_profit` (reports_finance.analysis) |
| /chat-zalo (chat_zalo.view) | nhóm Zalo; hội thoại cá nhân hoãn |
| /finance/cashbooks, /reports/finance/overpayment, /finance/salary, /finance/personal-wallet, /bien-dong-so-du (superadmin), /thu-tien, /materials, /vehicles, /network-center, /notifications, /settings/general, /settings/templates | Chưa phủ — hoãn theo §2/§4 (sổ quỹ, lương, ví cá nhân, thu tiền là miền tiền/nhạy cảm; còn lại ưu tiên thấp) |

Năng lực Hermes không có trong inventory Copilot: `crm_task_create/_input_options/_status` (tasks.create), lịch phòng `crm_room_schedule_*`, nhóm `crm_group_directory/_room_preview/_room_send/_send_status`, `crm_auth_context`. Customer/lead create (`hermes_customer_create_action_v1`) có SQL + core JS nhưng **chưa gắn broker/server**.

## 5. Mở trong đợt này

### 5.1 Họ đọc v2 (`20261015120000_hermes_domain_reads_v2.sql`)

Cùng registry `DOMAIN_READS` với tám miền v1; mỗi miền khai họ SQL (`v1`/`v2`). Input họ v2 thêm `fromDate`/`toDate`; kết quả thêm `source` (cố định) và `fetchedAt` (giờ máy chủ DB, UTC). Mọi miền giao tập toà = scope CRM của đúng khoá ∩ overlay scope kết nối (không nhận scope sổ quỹ).

| Tool | Quyền CRM | Nguồn | Projection | Loại bỏ |
| --- | --- | --- | --- | --- |
| `crm_read_income_expenses` | income_expenses.view | `income_expenses` | id, code, type, name, buildingId, roomId, roomName, voucherDate, totalAmount, approvalStatus | phiếu có hạng mục hạn chế, phiếu lương/cổ đông/quản lý LN, đã xoá; người nộp/nhận, tài khoản, ghi chú, chứng từ, người tạo |
| `crm_read_receivables` | invoices.view | `invoices` (APPROVED/PARTIAL_PAID/OVERDUE, `remaining_amount>0`) | number, status, roomName, billingMonth, dueDate, total/paid/remainingAmount | DRAFT, chờ duyệt, đã thu đủ, huỷ; ghi chú |
| `crm_read_meter_readings` | meter_readings.view | `meter_readings` | code, meterType, settlementMonth, readingDate, previous/current/consumption, status | ảnh, ghi chú, người ghi; chỉ số không gắn toà |
| `crm_read_deposits_held` | deposits.view | `get_held_deposit_summary` (canonical) | theo toà: contractCount, expected, held, shortfallAll/Short, các đếm | mọi chi tiết khách/hợp đồng |
| `crm_read_building_profit` | reports_finance.analysis | `fa_monthly_pnl` (canonical, còn tự lọc `can_access_building`) | theo toà trong kỳ ≤ 366 ngày: revenue, expense, net, months | toà không có số liệu |

Khoá v2 chưa nằm trong `HERMES_CAPABILITIES` (capability contract) nên chưa cấp được cho kết nối cho tới khi người tích hợp thêm; thứ tự phát hành là apply SQL trước JS. Nếu JS lên trước, `crm_read_receivables` (dùng khoá v1 `invoices.view`) vẫn hiện nhưng trả `backend_unavailable` — đóng an toàn, không lộ dữ liệu. Số tiền là chuỗi thập phân từ DB; Hermes không tự cộng. `crm_read_building_profit` cộng các dòng tháng của hàm canonical trong SQL; `fa_monthly_pnl` tin tính nhất quán toà↔công ty của phiếu (không lọc `organization_id`).

### 5.2 Ghi phiếu chi nhanh (`20261015120100_hermes_expense_create_action_v1.sql`)

- Tool: `crm_expense_input_options` (toà/phòng/hạng mục/sổ quỹ dùng được, chỉ nhãn; sổ che dãy ≥5 chữ số), `crm_expense_create`, `crm_expense_status`. Action `income_expenses.create`; một phiếu CHI 1–20 dòng, số nguyên VND, ngày phiếu, tên, nơi mua (tuỳ chọn). Không nhận đính kèm, số tài khoản nhận, khách thuê, hợp đồng, ghi chú, trạng thái duyệt.
- Ghi qua `create_income_expense_v1` với JWT thật (khoá chống trùng `hermes-expense:<requestId>`): quyền tạo theo toà, hạng mục hạn chế, sổ quỹ, khoá sổ, cờ writer/canary và bộ máy chi quyết trạng thái sinh. Hạng mục kênh này loại thêm: hệ thống, hạn chế, cọc, nội bộ, lưu trữ, ẩn khỏi lập tay/Báo chi nhanh.
- **Thang duyệt:** Hermes không gọi hàm duyệt/vào sổ. Writer sinh phiếu ĐÃ DUYỆT trong hai trường hợp: (a) người lập có `income_expenses.approve` trên toà — đây là dùng quyền duyệt của user nên Hermes đòi thêm overlay Thao tác `income_expenses.approve` (mặc định tắt), thiếu thì từ chối trước khi ghi và hậu kiểm sau writer (rollback); (b) luật máy của công ty (dưới ngưỡng, cam kết chi) — giữ đúng như lập tay. Kết quả trả `approvalStatus` (UNAPPROVED = chờ duyệt). **Cần chủ chốt** nếu muốn mọi phiếu Hermes luôn chờ duyệt kể cả dưới ngưỡng: khi đó cần cờ "force pending" trong writer canonical, không làm trong đợt này.
- Biên nhận `hermes_expense_create_receipts` cùng transaction với phiếu: lặp requestId trả lại kết quả cũ, đổi nội dung trả PT409, `status` trả `not_found` khi chưa có hiệu lực. Lỗi nghiệp vụ của writer quy về 22023/42501/PT409 (lý do chi tiết không qua được broker — giới hạn).

### 5.3 Hook dùng chung (`20261015120200_hermes_finance_capabilities_hook.sql`)

Định nghĩa lại `public.hermes_org_policy_options_v5`, `public.hermes_connection_options_v5`, `public.hermes_connection_context_v5` (giữ chữ ký/ACL), bọc thêm `app_private.hermes_finance_extend_options_v1` cho 4 khoá đọc v2 và 2 khoá action. Người tích hợp gộp với hook song song khác thành một chuỗi.

### 5.4 Đợt 2 đọc đầy đủ (Gói 0 + A–D + Z — đã production 19/10/2026 theo bàn giao)

- **Mặt tool:** hai tool meta `crm_read_report_list` (mục lục theo quyền lúc gọi) và `crm_read_report` (chạy một báo cáo) thay cho ~70 tool riêng; sổ báo cáo gom ở `infra/hermes-broker/wave2-registry.mjs` từ `wave2-{a,b,c,d}-contract.mjs`. 70 báo cáo, đều `private=true`: A thu tiền/công nợ/cọc 9, B sổ quỹ/KQKD/lợi nhuận/ví/biến động số dư 19, C xe/kho/thông báo/lương/Network Center 20, D BĐS/tài sản/danh mục/toà-phòng 22.
- **Quyền:** cổng SQL `public.hermes_w2_read_v1` (INVOKER) → bước kiểm quyền DEFINER (CRM thật ∩ registry ∩ chính sách công ty ∩ Read kết nối ∩ overlay toà) → hàm đọc gói INVOKER dưới RLS người hỏi → bước kết thúc rào đầu ra (toà/sổ/công ty mọi hàng, phân trang, trần 2000 hàng). Ngoại lệ nền đã duyệt: [CODEBASE_STRUCTURE.md](../../CODEBASE_STRUCTURE.md#công-thức-dùng-chung).
- **Công tắc:** `20261018090000_hermes_w2_enable_v1` bật 32 khoá (khoá của ít nhất một báo cáo + khoá phụ `income_expenses.restricted_view`); giữ tắt `reports_finance.deposits_report`, `reports_finance.handover_report`, `reports_finance.collection_cycle` (chưa có báo cáo). Khoá đợt 1 dùng lại (`invoices.view`, `deposits.view`, `reports_finance.analysis`, `assets.view`, `services.view`, `rooms.view`) đã bật từ 16/10. Hợp đồng overlay hiện hành cần connection mới để nhận khóa mới; bàn giao sáng 19/10 ghi đã tạo và ghép lại. Đích TG2/TG4 sẽ kế thừa quyền web và giữ binding khi đổi quyền, chưa triển khai.
- **Thứ tự áp:** nền `20261018000000 → 000500 → 000600 → 000700`; A `010000 → 010100`; B `020050 → 020200 → 020250 → 020300`; C `030100 → 030200 → 030300 → 030400 → 030500 → 030600`; D `040000 → 040100 → 040200 → 040300`; Z sửa tích hợp `080000` (hàm dùng chung) `→ 080100 → 080200 → 080300` (hàm đọc A, B, D); công tắc `090000`.
- **Riêng tư / tin nhóm:** như đợt 1, rào là cấu trúc (kênh Zalo cá nhân chỉ DM với người đã ghép; mọi tool gửi nhóm chỉ nhận ID/tuỳ chọn có khuôn, thân tin do broker/SQL dựng từ dữ liệu phòng công khai), cộng `PRIVATE_HINT` trong mô tả tool. Không có rào runtime đọc cờ `private`; test `wave2-z.test.mjs` khoá rào cấu trúc. Chữ tự do Hermes ghi ra trang công khai (`crm_room_pass_upsert`: tên/SĐT/chính sách sale) luôn qua xác nhận hai bước do broker ép (`public-text-guard.mjs`).

## 6. Đề xuất tiếp theo (chưa làm)

1. Overlay scope sổ quỹ (CASHBOOK) cho kết nối, rồi `so_quy`/dòng tiền/bàn giao theo reconcile v2.
2. Báo cáo bất động sản không tiền (gia hạn, hợp đồng mới, sắp hết hạn) qua hàm canonical + projection bỏ tên khách.
3. Ghi chú phiếu (`annotate_income_expense_v1`) và vật tư/kho: không tiền, có idempotency sẵn.
4. Hợp đồng/cọc/thanh lý/duyệt phiếu: chỉ sau quyết định chủ + harness vai thật; dùng đúng bản UI (`*_with_notice_v1`, `approve_income_expense_v2`).

## 7. Chưa đo

ACL thật trên TEST/production của các hàm baseline-only; JWT/PostgREST positive cho họ v2 và action; writer canonical thật (bộ máy chi, canary, lock date, trigger posting) — test dùng cổng giả lập cùng chữ ký; hiệu năng `fa_monthly_pnl`/`can_access_building` trên dữ liệu thật; hiển thị nhãn khoá mới ở UI quyền (`src/hermes/**` chưa cập nhật).
