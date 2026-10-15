# Bản đồ năng lực CRM → Hermes (P0.06)

Snapshot 15/10/2026, nhánh gói E từ `0991db1a`. Đối chiếu [inventory](../../../tooling/hermes-crm-inventory.generated.json) schemaVersion 2 (67 tool, 32 action, 29 bề mặt UI) với source, migration và broker hiện có. Chỉ dựa trên repo: **chưa đo catalog/ACL TEST hay production**, chưa gọi PostgREST thật. Inventory là manifest Copilot, không phải cấu hình quyền; file này không cấp quyền hay bật capability nào.

## 1. Quy ước

**Công thức quyền dùng chung (mọi dòng "đã chuyển"/"chuyển đợt này"):** quyền CRM hiện tại của user (`get_authorization_context_v1` + `authorized_scope_v3(<khoá>)`, membership còn hiệu lực, không offboard) ∩ registry `app_private.hermes_capabilities` (mặc định TẮT) ∩ chính sách công ty Hermes ∩ Read/Action + scope đã lưu của kết nối. SQL là lớp quyết định cuối; broker chỉ lọc danh sách tool và kiểm lại kết quả. Actor/công ty lấy từ kết nối đã xác minh, model không tự khai.

**Disposition:** `Đã chuyển` (có tool Hermes) · `Chuyển đợt này` (gói E) · `Một phần` (tool hiện có phủ một phần, phần còn lại ghi rõ) · `Giữ UI/deep link` · `Hoãn` (kèm lý do) · `Bỏ có chủ đích`.

**Không mang sang Hermes (cơ chế Copilot, không phải nghiệp vụ):** cờ `copilot_feature_flags` qua `copilot_page_flag_allows_v1` (23 reader dính cờ, mặc định `disabled`); nonce `copilot_write_confirmations`; `copilot_action_gate_v1`; khoá idempotency/ledger `ai_write_audit`, `copilot_action_ledger`; kế hoạch L5 + PIN step-up, `pin_always`; `copilot_plan_role_allowed_v1`; marker `copilot_ie_writer_context_v1` của writer nháp; quyền chat `ai_copilot.view`. **Giữ nguyên (điều kiện nghiệp vụ thật):** khoá quyền và scope toà/sổ trong hàm canonical (`authorized_scope_v3`, `can_do_on_building`, `authorize_income_expense_on_building`, `can_v3`), quyền dùng sổ quỹ (chủ sổ/CUSTODIAN/OPERATOR), vòng đời/trạng thái, CAS phiên bản, khoá chống trùng canonical, bộ máy chi và thang duyệt.

Ký hiệu cổng reader Copilot: **H** = `copilot_org_scope_buildings_v1` (mảng toà theo `authorized_scope_v3`, thiếu quyền trả rỗng), **A** = kiểm grant và raise 42501, **cờ** = dính `copilot_feature_flags`.

## 2. Tool đọc (55)

| Tool Copilot | Quyền CRM | RPC/hàm nền (cổng) | Hermes | Disposition |
| --- | --- | --- | --- | --- |
| `phong_trong` | rooms.view | `copilot_available_rooms_v1` (H) | `crm_available_rooms` | Đã chuyển |
| `bao_cao_phong_trong` | reports_real_estate.vacant_rooms | `copilot_report_vacant_rooms_v1` (H) | `crm_available_rooms`, `crm_read_occupancy` | Một phần: thay bằng tool phòng; báo cáo riêng hoãn |
| `ty_le_lap_day` | reports_real_estate.occupancy | `occupancy_snapshot_v2` / `_upcoming_vacancy_v2` (H) | `crm_read_occupancy` | Một phần: snapshot hiện tại; dự báo trống hoãn |
| `tim_khach_hang` | customers.view | `copilot_customer_search_v1` (H, SĐT đầy đủ) | `crm_read_customers` (SĐT che) | Đã chuyển |
| `tim_khach_hen` | leads.view | `copilot_lead_search_v1` (H+A) | `crm_read_leads` | Đã chuyển |
| `tim_hop_dong` | contracts.view | `copilot_contract_search_v1` (H) | `crm_read_contracts` | Đã chuyển |
| `chi_tiet_hop_dong` | contracts.view | `copilot_contract_detail_v1` (H) | `crm_read_contracts` | Một phần: chi tiết tiền thuê/cọc/khách hoãn, cần projection riêng |
| `tim_hoa_don` | invoices.view | `copilot_invoice_search_v1` (H) | `crm_read_invoices` | Đã chuyển |
| `cong_no_tong_quan` | invoices.view | `get_invoice_statistics_v2` (H) | `crm_read_receivables` | Chuyển đợt này (dạng danh sách còn nợ); thống kê gộp hoãn: chưa rà shape JSON |
| `bao_cao_lich_thu_tien` | reports_finance.payment_schedule | `copilot_report_payment_schedule_v1` (H, tên khách) | `crm_read_receivables` (lọc hạn) | Một phần |
| `tim_phieu_thu_chi` | income_expenses.view | `copilot_income_expense_search_v1` (H + `can_view_restricted_ie`) | `crm_read_income_expenses` | Chuyển đợt này |
| `hop_cho_duyet` | income_expenses.view | `list_my_pending_approvals_v1` (H+A) | `crm_read_income_expenses status=UNAPPROVED` | Một phần: hộp duyệt riêng của người duyệt hoãn |
| `chi_so_cong_to` | meter_readings.view | `copilot_meter_readings_v1` (H+A) | `crm_read_meter_readings` | Chuyển đợt này |
| `coc_dang_giu` | deposits.view | `get_held_deposit_summary` (H) | `crm_read_deposits_held` | Chuyển đợt này |
| `doanh_thu_thang` | reports_finance.analysis | `fa_monthly_pnl` / `_accrual` (H) | `crm_read_building_profit` | Chuyển đợt này (cash basis theo ngày phiếu); accrual hoãn |
| `cong_viec` | tasks.view | `copilot_tasks_v1` (H+A) | `crm_read_tasks` | Đã chuyển |
| `danh_sach_tai_san` | assets.view | `copilot_asset_directory_v1` (H+A, cờ) | `crm_read_assets` (không cờ) | Đã chuyển |
| `danh_sach_dich_vu` | services.view | `copilot_service_directory_v1` (H+A, cờ) | `crm_read_services` | Đã chuyển |
| `danh_sach_loai_cong_viec` | task_types.view | `copilot_job_type_directory_v1` (A, cờ) | `crm_task_input_options kind=jobTypes` | Một phần: chỉ khi có Action tasks.create |
| `danh_sach_toa_nha` | buildings.view | `copilot_building_directory_v1` (A+H, cờ) | nhãn toà trong `crm_*_input_options`, `crm_read_occupancy` | Một phần |
| `danh_sach_phong_sale` | sale_phong.view | `copilot_sale_listing_directory_v1` (H+A, cờ) | `crm_available_rooms`, `crm_room_pass_observe` | Một phần |
| `hoi_thoai_zalo` | chat_zalo.view | `copilot_zalo_conversations_v1` (H+A; SĐT, nội dung tin) | `crm_group_directory` (nhóm) | Một phần; hội thoại cá nhân hoãn: nội dung riêng tư cần projection |
| `bao_cao_dat_coc` | reports_finance.deposits_report | `copilot_report_deposits_v1` (H, tên khách) | `crm_read_deposits_held` (tổng theo toà) | Một phần; chi tiết hoãn |
| `bao_cao_gia_han` | reports_real_estate.renewals_transfers | `copilot_report_renewals_v1` (H) | — | Hoãn: ứng viên đợt sau, cần bỏ tên khách khỏi projection |
| `bao_cao_hop_dong_moi` | reports_real_estate.new_leases | `copilot_report_new_leases_v1` (H) | — | Hoãn: như trên |
| `bao_cao_thanh_ly` | reports_real_estate.terminations | `copilot_report_terminations_v1` (H; hoàn cọc, tên khách) | — | Hoãn: tiền hoàn cọc cần đối chiếu nghiệp vụ |
| `hop_dong_sap_het_han` | reports_real_estate.expiring | `copilot_expiring_contracts_v1` (H) | `crm_read_contracts` (chưa lọc ngày) | Hoãn: thêm lọc endDate vào họ v2 |
| `bao_cao_thu_thua` | reports_finance.overpayment | `copilot_report_overpayment_v1` (H) | — | Hoãn |
| `bao_cao_ty_le_chi_phi` | reports_real_estate.expense_ratio | `copilot_report_expense_ratio_v1` (H) | — | Hoãn: hạng mục gộp/lưu trữ cần `ie_type_report_root_v1` |
| `bao_cao_dong_tien` | reports_finance.cash_flow | `copilot_report_cash_flow_v1` (H+A, postings, sổ) | — | Hoãn: số liệu posting/sổ phải khớp reconcile v2; overlay sổ quỹ chưa có |
| `bao_cao_thu_chi_theo_ngay` | reports_finance.daily_cashbook | `copilot_report_daily_cashbook_v1` (như trên) | `crm_read_income_expenses` (danh sách) | Một phần; tổng theo ngày hoãn cùng lý do |
| `so_quy` | cashbooks.view | `copilot_cashbook_settlement_v2` (scope sổ) | — | Hoãn: cần overlay scope CASHBOOK (options hiện loại `cashbook_id`) và số dư theo reconcile v2 |
| `bao_cao_ban_giao` | reports_finance.handover_report | `copilot_report_handover_v1` (A, cờ, sổ) | — | Hoãn: cờ + scope sổ |
| `bao_cao_chu_ky_thu` | reports_finance.collection_cycle | `copilot_report_collection_cycle_v1` (A, cờ) | — | Hoãn: cờ + scope sổ |
| `bao_cao_khuyen_mai` | reports_real_estate.promotions | `copilot_report_promotions_v1` (A, cờ) | — | Hoãn |
| `bang_luong_ky` | salary.view | `copilot_salary_summary_v1` (cờ sensitive; lương cá nhân) | — | Hoãn: miền nhạy cảm, cần harness vai thật |
| `loi_nhuan_co_dong` | shareholder_profit.view | `copilot_shareholder_profit_v1` (cờ sensitive) | — | Hoãn: như trên |
| `trang_thai_mang` | network_center.view | `copilot_network_status_v1` (cờ sensitive) | — | Hoãn |
| `tim_xe` | vehicles.view | `copilot_vehicle_search_v1` (biển số, chủ xe) | — | Hoãn: PII |
| `ton_kho_vat_tu` | materials.view | `copilot_material_stock_v1` (H+A) | — | Hoãn: ứng viên không tiền |
| `danh_sach_bao_tri_tai_san` | assets.view | `copilot_asset_maintenance_directory_v1` (cờ) | `crm_read_assets` | Một phần |
| `danh_sach_cong_to` | meters.view | `copilot_meter_directory_v1` (cờ) | — | Hoãn |
| `danh_sach_dinh_muc_dich_vu` | service_quotas.view | `copilot_service_quota_directory_v1` (cờ) | — | Hoãn |
| `danh_sach_hotline` | hotline.view | `copilot_hotline_directory_v1` (cờ, SĐT đầy đủ) | — | Hoãn |
| `danh_sach_kho_tai_san` | warehouses.view | `copilot_warehouse_directory_v1` (cờ) | — | Hoãn |
| `danh_sach_khu_vuc` | areas.view | `copilot_area_directory_v1` (cờ) | nhãn khu vực trong lựa chọn scope | Một phần |
| `danh_sach_loai_tai_san` | asset_types.view | `copilot_asset_type_directory_v1` (cờ) | — | Hoãn |
| `danh_sach_nha_cung_cap` | suppliers.view | `copilot_supplier_directory_v1` (cờ) | — | Hoãn |
| `danh_sach_tang` | categories.view | `copilot_floor_directory_v1` (cờ) | — | Hoãn |
| `danh_sach_thanh_vien_vai_tro` | users.view | `copilot_member_role_directory_v1` (cờ) | — | Hoãn: quản trị thành viên |
| `thong_bao_gan_day` | notifications.view | `copilot_notification_feed_v1` (cờ) | — | Hoãn |
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

## 6. Đề xuất tiếp theo (chưa làm)

1. Overlay scope sổ quỹ (CASHBOOK) cho kết nối, rồi `so_quy`/dòng tiền/bàn giao theo reconcile v2.
2. Báo cáo bất động sản không tiền (gia hạn, hợp đồng mới, sắp hết hạn) qua hàm canonical + projection bỏ tên khách.
3. Ghi chú phiếu (`annotate_income_expense_v1`) và vật tư/kho: không tiền, có idempotency sẵn.
4. Hợp đồng/cọc/thanh lý/duyệt phiếu: chỉ sau quyết định chủ + harness vai thật; dùng đúng bản UI (`*_with_notice_v1`, `approve_income_expense_v2`).

## 7. Chưa đo

ACL thật trên TEST/production của các hàm baseline-only; JWT/PostgREST positive cho họ v2 và action; writer canonical thật (bộ máy chi, canary, lock date, trigger posting) — test dùng cổng giả lập cùng chữ ký; hiệu năng `fa_monthly_pnl`/`can_access_building` trên dữ liệu thật; hiển thị nhãn khoá mới ở UI quyền (`src/hermes/**` chưa cập nhật).
