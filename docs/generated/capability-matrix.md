---
status: current
reviewed: 2026-08-21
source_paths:
  - src/app/capabilities/registry.ts
  - contracts/surfaces/edge-function-surface.json
  - contracts/surfaces/realtime-surface.json
copilot_ingest: false
risk: normal
---

> **SINH TỰ ĐỘNG — đừng sửa tay.** `node scripts/generate-docs-views.mjs`
> Sửa ở đây tạo nguồn sự thật thứ hai, và nó sẽ trôi khỏi manifest trong vài ngày.

# Ma trận bề mặt sản phẩm

## Capability khai trong registry

Registry hiện phủ **27** capability. Toàn app có ~146 route —
phần còn lại vẫn khai tay ở từng nơi. Đây là trạng thái CÓ CHỦ Ý: registry bắt
đầu từ hai capability đã drift thật, mở rộng là việc riêng.

| Capability | Route | Quyền | Rủi ro | Tài liệu |
|---|---|---|---|---|
| Trung tâm mạng | `/network-center` | `network_center.view` | hạ tầng | docs/he-thong/22-network-center.md |
| OpenClaw Zalo | `/openclaw-zalo` | `openclaw_zalo.view` | an ninh | docs/he-thong/23-openclaw-zalo.md |
| Hoá đơn | `/invoices` | `invoices.view` | tiền | docs/he-thong/07-hoa-don-thanh-toan.md |
| Thu chi | `/income-expense` | `income_expenses.view` | tiền | docs/he-thong/08-thu-chi-so-quy.md |
| Sổ quỹ | `/finance/cashbooks` | `cashbooks.view` | tiền | docs/he-thong/08-thu-chi-so-quy.md |
| Bảng lương | `/finance/salary` | `salary.view` | tiền | docs/he-thong/17-luong-thuong.md |
| Toà nhà | `/buildings` | `buildings.view` | thường | docs/he-thong/02-co-cau-toa-nha-phong-dich-vu.md |
| Dịch vụ | `/services` | `services.view` | thường | docs/he-thong/02-co-cau-toa-nha-phong-dich-vu.md |
| Tài sản | `/assets` | `assets.view` | thường | docs/he-thong/10-tai-san.md |
| Khách hẹn | `/leads` | `leads.view` | thường | docs/he-thong/03-khach-hang-lead-ho-so.md |
| Đặt cọc | `/deposits` | `deposits.view` | tiền | docs/he-thong/04-coc-giu-cho.md |
| Hợp đồng | `/contracts` | `contracts.view` | tiền | docs/he-thong/05-hop-dong.md |
| Khách hàng | `/customers` | `customers.view` | thường | docs/he-thong/03-khach-hang-lead-ho-so.md |
| Phương tiện | `/vehicles` | `vehicles.view` | thường | docs/he-thong/03-khach-hang-lead-ho-so.md |
| Ghi chỉ số | `/meter-readings` | `meter_readings.view` | thường | docs/he-thong/06-cong-to-chi-so.md |
| Công việc | `/tasks` | `tasks.view` | thường | docs/he-thong/11-cong-viec-su-co.md |
| Chat Zalo | `/chat-zalo` | `chat_zalo.view` | thường | docs/he-thong/18-zalo-chat.md |
| Thông báo | `/notifications` | `notifications.view` | thường | docs/he-thong/13-bao-cao-dashboard-thong-bao.md |
| Mẫu biểu | `/settings/templates` | `templates.view` | thường | docs/he-thong/14-cai-dat-danh-muc-tai-lieu.md |
| Căn hộ | `/apartments` | `rooms.view` | thường | docs/he-thong/02-co-cau-toa-nha-phong-dich-vu.md |
| Kho vật tư | `/materials` | `materials.view` | thường | docs/he-thong/09-kho-vat-tu.md |
| Thu tiền | `/thu-tien` | `thu_tien.view` | tiền | docs/he-thong/15-kenh-cong-khai-sale-thu-tien.md |
| Sale Phòng | `/sale-phong` | `sale_phong.view` | thường | docs/he-thong/15-kenh-cong-khai-sale-thu-tien.md |
| Báo cáo bất động sản | `/reports/real-estate` | `reports_real_estate.view` | thường | docs/he-thong/13-bao-cao-dashboard-thong-bao.md |
| Cài đặt chung | `/settings/general` | `settings.view` | thường | docs/he-thong/14-cai-dat-danh-muc-tai-lieu.md |
| Sơ đồ toà nhà | `/building-map` | `buildings.view` | thường | docs/he-thong/02-co-cau-toa-nha-phong-dich-vu.md |
| Tiền thừa | `/reports/finance/overpayment` | `reports_finance.overpayment` | tiền | docs/he-thong/13-bao-cao-dashboard-thong-bao.md |

## Edge Function

| Chỉ số | Giá trị |
|---|---|
| Thư mục mã nguồn | 13 |
| ĐANG CHẠY trên server | 11 |
| Có mã mà **chưa deploy** | 2 — network-watchdog, openclaw-watchdog |
| `verify_jwt = false` (ai cũng gọi được) | 5 — demo-reset, network-center-worker, openclaw-runtime, openclaw-runtime-token, salary-v5-jobs |

Thư mục trong repo **không** có nghĩa là hàm đang chạy: deploy là thao tác riêng,
không gắn với `git push`.

## Realtime

| Chỉ số | Giá trị |
|---|---|
| Bảng được publish | 30 |
| Hub nghiệp vụ lắng nghe | 13 |
| **Hub nghe mà KHÔNG publish** (subscribe câm) | **0** |
| `REPLICA IDENTITY = DEFAULT` | 30/30 |

`DEFAULT` nghĩa là payload `UPDATE`/`DELETE` chỉ mang **khoá chính**. Code đọc cột
khác từ payload đó nhận `undefined` — không lỗi, chỉ là một nhánh đi sai đường.
