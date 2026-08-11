---
status: current
reviewed: 2026-08-11
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

Registry hiện phủ **2** capability. Toàn app có ~146 route —
phần còn lại vẫn khai tay ở từng nơi. Đây là trạng thái CÓ CHỦ Ý: registry bắt
đầu từ hai capability đã drift thật, mở rộng là việc riêng.

| Capability | Route | Quyền | Rủi ro | Tài liệu |
|---|---|---|---|---|
| Trung tâm mạng | `/network-center` | `network_center.view` | hạ tầng | docs/he-thong/22-network-center.md |
| OpenClaw Zalo | `/openclaw-zalo` | `openclaw_zalo.view` | an ninh | docs/he-thong/23-openclaw-zalo.md |

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
