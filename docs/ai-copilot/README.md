# AI Copilot — nền công cụ dùng chung

P0 Hermes mở lại kiểm offline cho registry, quyền, kế hoạch, xác nhận, bộ nhớ và dữ liệu hướng dẫn dùng chung.
Phạm vi test/gate hoạt động nằm trong `tooling/deferred-modules.json` và `tooling/test-matrix.json`.

Các phần Copilot UI/model, kiểm live và Zalo fleet còn hoãn theo [hồ sơ Zalo/Copilot](../deferred/zalo-copilot.md).
Khôi phục runner hoặc kiểm kê mã không xác nhận tính năng đang chạy, quyền thật hay kết quả production.

## Kiểm kê từ mã nguồn

Khối dưới được sinh bằng `node scripts/check-copilot-tool-inventory.mjs --write`; không sửa số đếm bằng tay.

<!-- COPILOT_TOOL_INVENTORY:START -->

<!-- KHỐI NÀY SINH TỰ ĐỘNG. Đừng sửa tay:
     node scripts/check-copilot-tool-inventory.mjs --write -->

**67 tool**: 55 đọc · 11 ghi · 1 điều hướng (chỉ mở trang / trả link).

| Tool | Loại | Quyền | Nguồn |
| --- | --- | --- | --- |
| `ban_do_he_thong` | read | — (lọc theo từng kết quả) | `src/copilot/tools/registry.ts` |
| `bang_luong_ky` | read | `salary.view` | `src/copilot/tools/nghiepVuTools.ts` |
| `bao_cao_ban_giao` | read | `reports_finance.handover_report` | `src/copilot/tools/nghiepVuTools.ts` |
| `bao_cao_chu_ky_thu` | read | `reports_finance.collection_cycle` | `src/copilot/tools/nghiepVuTools.ts` |
| `bao_cao_dat_coc` | read | `reports_finance.deposits_report` | `src/copilot/tools/nghiepVuTools.ts` |
| `bao_cao_dong_tien` | read | `reports_finance.cash_flow` | `src/copilot/tools/nghiepVuTools.ts` |
| `bao_cao_gia_han` | read | `reports_real_estate.renewals_transfers` | `src/copilot/tools/nghiepVuTools.ts` |
| `bao_cao_hop_dong_moi` | read | `reports_real_estate.new_leases` | `src/copilot/tools/nghiepVuTools.ts` |
| `bao_cao_khuyen_mai` | read | `reports_real_estate.promotions` | `src/copilot/tools/nghiepVuTools.ts` |
| `bao_cao_lich_thu_tien` | read | `reports_finance.payment_schedule` | `src/copilot/tools/nghiepVuTools.ts` |
| `bao_cao_phong_trong` | read | `reports_real_estate.vacant_rooms` | `src/copilot/tools/nghiepVuTools.ts` |
| `bao_cao_thanh_ly` | read | `reports_real_estate.terminations` | `src/copilot/tools/nghiepVuTools.ts` |
| `bao_cao_thu_chi_theo_ngay` | read | `reports_finance.daily_cashbook` | `src/copilot/tools/nghiepVuTools.ts` |
| `bao_cao_thu_thua` | read | `reports_finance.overpayment` | `src/copilot/tools/nghiepVuTools.ts` |
| `bao_cao_ty_le_chi_phi` | read | `reports_real_estate.expense_ratio` | `src/copilot/tools/nghiepVuTools.ts` |
| `chi_so_cong_to` | read | `meter_readings.view` | `src/copilot/tools/nghiepVuTools.ts` |
| `chi_tiet_hop_dong` | read | `contracts.view` | `src/copilot/tools/nghiepVuTools.ts` |
| `coc_dang_giu` | read | `deposits.view` | `src/copilot/tools/nghiepVuTools.ts` |
| `cong_no_tong_quan` | read | `invoices.view` | `src/copilot/tools/nghiepVuTools.ts` |
| `cong_viec` | read | `tasks.view` | `src/copilot/tools/nghiepVuTools.ts` |
| `danh_sach_bao_tri_tai_san` | read | `assets.view` | `src/copilot/tools/registry.ts` |
| `danh_sach_cong_to` | read | `meters.view` | `src/copilot/tools/registry.ts` |
| `danh_sach_dich_vu` | read | `services.view` | `src/copilot/tools/nghiepVuTools.ts` |
| `danh_sach_dinh_muc_dich_vu` | read | `service_quotas.view` | `src/copilot/tools/registry.ts` |
| `danh_sach_hotline` | read | `hotline.view` | `src/copilot/tools/registry.ts` |
| `danh_sach_kho_tai_san` | read | `warehouses.view` | `src/copilot/tools/registry.ts` |
| `danh_sach_khu_vuc` | read | `areas.view` | `src/copilot/tools/registry.ts` |
| `danh_sach_loai_cong_viec` | read | `task_types.view` | `src/copilot/tools/registry.ts` |
| `danh_sach_loai_tai_san` | read | `asset_types.view` | `src/copilot/tools/registry.ts` |
| `danh_sach_nha_cung_cap` | read | `suppliers.view` | `src/copilot/tools/registry.ts` |
| `danh_sach_phong_sale` | read | `sale_phong.view` | `src/copilot/tools/registry.ts` |
| `danh_sach_tai_san` | read | `assets.view` | `src/copilot/tools/nghiepVuTools.ts` |
| `danh_sach_tang` | read | `categories.view` | `src/copilot/tools/registry.ts` |
| `danh_sach_thanh_vien_vai_tro` | read | `users.view` | `src/copilot/tools/registry.ts` |
| `danh_sach_toa_nha` | read | `buildings.view` | `src/copilot/tools/registry.ts` |
| `dat_co_hoi_thoai_zalo` | write | `chat_zalo.view` | `src/copilot/tools/writeTools.ts` |
| `dat_han_giu_cho` | write | `deposits.edit` | `src/copilot/tools/writeTools.ts` |
| `doanh_thu_thang` | read | `reports_finance.analysis` | `src/copilot/tools/registry.ts` |
| `doi_trang_thai_tin_phong_nho_sale` | write | `sale_phong.manage_pass_listings` | `src/copilot/tools/writeTools.ts` |
| `ghi_chi_so_cong_to` | write | `meter_readings.create` | `src/copilot/tools/writeTools.ts` |
| `ghi_chu_phieu_thu_chi` | write | `income_expenses.edit` | `src/copilot/tools/writeTools.ts` |
| `ghi_nho` | write | `ai_copilot.view` | `src/copilot/tools/memoryTools.ts` |
| `hoi_thoai_zalo` | read | `chat_zalo.view` | `src/copilot/tools/nghiepVuTools.ts` |
| `hop_cho_duyet` | read | `income_expenses.view` | `src/copilot/tools/nghiepVuTools.ts` |
| `hop_dong_sap_het_han` | read | `reports_real_estate.expiring` | `src/copilot/tools/registry.ts` |
| `huong_dan` | read | — (lọc theo từng kết quả) | `src/copilot/tools/registry.ts` |
| `lap_ke_hoach` | write | `ai_copilot.view` | `src/copilot/tools/planTools.ts` |
| `liet_ke_chu_de` | read | — (lọc theo từng kết quả) | `src/copilot/tools/registry.ts` |
| `loi_nhuan_co_dong` | read | `shareholder_profit.view` | `src/copilot/tools/nghiepVuTools.ts` |
| `mo_trang` | navigate | — (lọc theo từng kết quả) | `src/copilot/tools/registry.ts` |
| `phong_trong` | read | `rooms.view` | `src/copilot/tools/registry.ts` |
| `quen` | write | `ai_copilot.view` | `src/copilot/tools/memoryTools.ts` |
| `so_quy` | read | `cashbooks.view` | `src/copilot/tools/nghiepVuTools.ts` |
| `tao_phieu_giu_cho` | write | `deposits.create` | `src/copilot/tools/writeTools.ts` |
| `tao_phieu_thu_chi_nhap` | write | `income_expenses.create` | `src/copilot/tools/writeTools.ts` |
| `thong_bao_gan_day` | read | `notifications.view` | `src/copilot/tools/registry.ts` |
| `thuc_thi_buoc` | write | `ai_copilot.view` | `src/copilot/tools/planTools.ts` |
| `tim_hoa_don` | read | `invoices.view` | `src/copilot/tools/registry.ts` |
| `tim_hop_dong` | read | `contracts.view` | `src/copilot/tools/nghiepVuTools.ts` |
| `tim_khach_hang` | read | `customers.view` | `src/copilot/tools/registry.ts` |
| `tim_khach_hen` | read | `leads.view` | `src/copilot/tools/nghiepVuTools.ts` |
| `tim_phieu_thu_chi` | read | `income_expenses.view` | `src/copilot/tools/nghiepVuTools.ts` |
| `tim_xe` | read | `vehicles.view` | `src/copilot/tools/nghiepVuTools.ts` |
| `ton_kho_vat_tu` | read | `materials.view` | `src/copilot/tools/nghiepVuTools.ts` |
| `trang_thai_gach_no_tu_dong` | read | `auto_debt.view` | `src/copilot/tools/registry.ts` |
| `trang_thai_mang` | read | `network_center.view` | `src/copilot/tools/nghiepVuTools.ts` |
| `ty_le_lap_day` | read | `reports_real_estate.occupancy` | `src/copilot/tools/nghiepVuTools.ts` |

<!-- COPILOT_TOOL_INVENTORY:END -->
