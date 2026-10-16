# Bàn giao Hermes × iHomeCRM

Dành cho chủ công ty, quản trị CRM và người vận hành VPS. Trạng thái chi tiết, bằng chứng và lịch sử nằm ở [STATUS.md](STATUS.md); quyết định đã chốt ở [PLAN.md](PLAN.md).

## 1. Hermes đang chạy thế nào

```text
Nick Zalo chính của bạn ──nhắn riêng──► Bot Zalo của công ty (nick phụ "Ihome")
        ▲                                        │ worker Zalo trên VPS Minh
        │ trả lời                                 ▼
        └──────────────── Hermes (Docker "hermes-owner", model qua 9router)
                                                 │ MCP, token kết nối riêng
                                                 ▼
                         Connector CRM (systemd "hermes-connector") ──► Supabase CRM
```

- Hermes là trợ lý cá nhân của từng người (bản upstream `nousresearch/hermes-agent`), không phải Copilot cũ. Nó vẫn trò chuyện bình thường khi CRM tắt; phần CRM chỉ mở khi có kết nối hợp lệ.
- Mọi việc Hermes làm trong CRM đi qua quyền CRM hiện tại của bạn **giao** với quyền Đọc/Thao tác bạn chọn cho kết nối. Hermes không có quyền riêng, không tự cấp thêm quyền.
- Nick bot phải dành riêng cho Hermes: bật bot làm mọi tin nhắn riêng tới nick đó thành riêng tư, không vào hộp chat chung.

## 2. Dùng hằng ngày

Nhắn riêng cho bot từ nick Zalo chính đã liên kết. Ví dụ:

| Muốn | Nhắn |
| --- | --- |
| Hỏi phòng trống | "Còn phòng trống nào ở 417LVT?" |
| Gửi bản tin phòng vào nhóm | "Gửi bản tin phòng trống theo mẫu CRM vào nhóm Web nội bộ" — chỉ soạn thì nói "chỉ soạn, chưa gửi" |
| Cập nhật tin khách nhờ pass | Dán nguyên tin "KHÁCH PASS PHÒNG…" và nhờ cập nhật lên Sale phòng |
| Giao việc / theo dõi / huỷ việc | "Tạo việc kiểm tra máy lạnh 405PVB giao cho &lt;tên nhân viên&gt;, hạn 17h mai, nhắc trước 1 tiếng"; "Huỷ việc vừa giao" |
| Ghi phiếu chi | "Ghi phiếu chi 350k sửa ống nước 158PVC hôm nay" |
| Thêm khách (Cư dân) / lead (Khách hẹn) | "Thêm cư dân Nguyễn Văn A 09xxxxxxxx" hoặc "Thêm khách hẹn Trần Thị B 09xxxxxxxx" — kết nối phải có phạm vi Toàn tổ chức |
| Tra thu chi, công nợ, chỉ số, cọc giữ, lãi lỗ | Hỏi bằng lời thường, nêu toà/tháng |
| Lịch gửi định kỳ | "Mỗi sáng 8h gửi bản tin phòng trống vào nhóm …" |

- Mới thêm 16/10: tạo khách (Cư dân) / lead (Khách hẹn); giao việc → theo dõi/nhắc hạn → huỷ việc, và lập → chạy → thu hồi lịch bản tin nhóm — hai chuỗi này đã thử thật qua Zalo ngày 16/10 ([STATUS](STATUS.md#nghiệm-thu-cuối-1610)).
- Hermes tự gọi CRM khi cần; dữ liệu phòng, giá, chính sách luôn lấy mới từ CRM, không lấy từ trí nhớ.
- Khi mất phản hồi sau lúc gửi/ghi, Hermes báo "chưa rõ kết quả" và **không tự làm lại**; xem mục Đối soát ở phần 3.
- `/stop` cắt lượt đang treo; `/new` mở phiên mới (Hermes hỏi xác nhận, trả lời `/approve`). Phiên rất dài dễ chậm — mở phiên mới khi đổi chủ đề lớn.
- Tin "💾 Self-improvement review" là tính năng nền của Hermes (tự tạo kỹ năng), không phải lỗi.

Chưa ghi được qua Hermes (chủ hoãn 16/10): hợp đồng, cọc, hoá đơn, lương/cổ đông, tài sản/dịch vụ và các miền ghi khác ngoài danh sách trên. Hermes sẽ nói không có công cụ; làm trực tiếp trên CRM.

## 3. Quản trị trên CRM (`/settings/hermes`)

**Tạo kết nối:** chọn quyền Đọc, quyền Thao tác và phạm vi (toàn tổ chức, khu vực hoặc toà), xác nhận mật khẩu CRM. Token `hc_…` chỉ hiện một lần — đưa ngay vào Hermes (biến `MCP_IHOMECRM_API_KEY` của profile), không gửi qua chat.

**Đổi quyền = tạo kết nối mới:** kết nối chỉ thu hẹp được, không mở rộng. Muốn thêm quyền: tạo kết nối mới → ngắt liên kết Zalo cũ → liên kết Zalo với kết nối mới → thay token trong Hermes → thu hồi kết nối cũ. Một nick chính + một bot chỉ có một liên kết đang hoạt động. Đã làm 3 lần trên production; kết nối đang dùng `…624ef30e` (17 quyền Đọc + 11 quyền Thao tác, toàn tổ chức).

**Liên kết Zalo:** mục "Điều khiển Hermes qua Zalo" → chọn kết nối và bot → tạo mã → từ nick chính nhắn mã cho bot → bấm xác nhận. UID Zalo là theo góc nhìn bot (cùng một người có UID khác nhau ở mỗi nick).

**Bot của công ty:** chỉ người có quyền quản trị phù hợp bật/tắt; tắt bot thu hồi mọi liên kết qua bot đó.

**Đối soát tin chưa rõ kết quả:** xem trực tiếp trên Zalo tin đã tới chưa rồi ghi nhận; ghi nhận không gửi lại.

**Trợ lý của tôi:** xem/sửa/quên ghi nhớ công việc CRM, danh sách việc Hermes đang theo dõi và nhắc hạn.

**Thu hồi khẩn:** bấm Thu hồi trên kết nối — Hermes mất quyền CRM ngay, phần trò chuyện cá nhân vẫn chạy.

## 4. Vận hành VPS Minh

Runbook chi tiết: [HOST_SERVICE.md](../../../infra/hermes-runtime/HOST_SERVICE.md) (release, giới hạn, backup/restore, xoay khoá, sự cố, đồng bộ giờ), [CONNECTOR.md](../../../infra/hermes-broker/CONNECTOR.md) (cài vào Hermes upstream), [kênh Zalo native](../../../infra/hermes-zalo-native/README.md) (token kênh, plugin, đối soát).

| Thành phần | Vị trí / cách xem |
| --- | --- |
| Connector | `systemctl status hermes-connector`; release ở `/opt/ihome-hermes/releases/<sha8>`, đang dùng = symlink `/opt/ihome-hermes/current`; cấu hình `/etc/ihome-hermes/connector.json` |
| Hermes | `docker logs hermes-owner`; log lượt chat `/var/lib/ihome-hermes-profiles/owner/.hermes/profiles/owner/logs/agent.log`; cấu hình `config.yaml` + `.env` cùng thư mục |
| Worker Zalo | container `ihome-zalo-worker` (chạy `--native`) |
| Đường vào | Hermes gọi connector `http://172.17.0.1:8740/mcp` và 9router `http://172.17.0.1:20128/v1` qua unit `ihome-docker-connector` (systemd-socket-proxyd) và `ihome-docker-9router` (`llm-stream-guard`, cắt tool arguments chạy loạn; [host-network](../../../infra/hermes-runtime/host-network/README.md)); web CRM gọi connector qua tunnel `crm-hermes.chillhome.io.vn` |

**Release connector (16/10):** đang chạy `9cffe300`; bản lùi giữ trên VPS `8b3304c8`.

Giữ nguyên khi thao tác (tối ưu tốc độ 16/10): `connector.json` phải còn `172.17.0.1:8740` trong `http.allowedHosts` (thiếu là 403); MCP `connect_timeout: 30`; container Hermes RAM `900m`/swap `1800m` — chỉ `docker restart`, nếu tạo lại phải truyền lại; unit `ihome-net-tuning` (MSS 1452, `tcp_mtu_probing=1`); NTP qua IPv4 (`/etc/systemd/timesyncd.conf.d/ihome-ipv4.conf`) — đồng hồ lệch làm mọi RPC lịch trả 42501.

**Cập nhật connector:** đóng gói từ commit đã merge và CI main xanh (thư mục `infra/hermes-broker`, `infra/hermes-runtime`, `infra/hermes-zalo-router`, `src/lib/roomSaleFacts.ts`, `worker/lib/hermes-link.js`, `worker/package.json`, `vendor/xlsx-0.20.3.tgz`, `package.json`, `package-lock.json`, bỏ test) → giải nén vào `releases/<sha8>` → `npm ci --omit=dev --ignore-scripts` bằng Node 24 của `/opt/ihome-hermes/node` → thử import `host-service.mjs` bằng user 10004 → đổi symlink → restart connector → kiểm `GET /` 404, `/mcp` không token 401 qua tunnel. Có tool mới thì `docker restart hermes-owner` (chờ hết lượt đang trả lời) để Hermes đọc lại danh sách tool.

**Lùi bản:** trỏ symlink `current` về release trước (giữ ít nhất một bản cũ) rồi restart connector. Migration CRM đã apply không lùi; muốn tắt năng lực thì tắt dòng registry `app_private.hermes_capabilities` bằng migration mới hoặc thu hồi kết nối.

**Đĩa:** VPS 19 GB, còn khoảng 2,4 GB — xoá release cũ không dùng (không xoá bản đang `current` và bản lùi gần nhất).

## 5. Phiên bản đang chạy (16/10/2026)

| Thành phần | Phiên bản |
| --- | --- |
| Hermes | `nousresearch/hermes-agent` v0.21.6, image `sha256:ffa4fbb4…`, plugin `ihome-zalo-native` từ PR #175 |
| Connector | release `9cffe300` (lùi được về `8b3304c8`) |
| Model | 9router `cx/gpt-6-luna` (từ 16/10 05:57) |
| CRM | production `ptcrm.vercel.app` (app `455920b1`; #179–#181 chỉ đổi connector), registry năng lực Hermes 28/28 bật |

## 6. Lưu ý về model

- Đang dùng `cx/gpt-6-luna`, đổi 16/10 05:57 theo yêu cầu chủ. Cấu hình chỉ đổi `model.default` và `model.context_length: 272000`; bản cũ giữ ở file `.bak` cạnh `config.yaml`.
- Thử thật trong Hermes với cùng câu lập lịch (16/10):

| Model | Kết quả |
| --- | --- |
| `gpt-6-sol` (medium), `gpt-6.1-sol`, `gpt-6-astra` (medium) | Treo ngay lần gọi model đầu: 9router không trả DONE, phải `/stop` |
| `cx/gpt-6-luna` | Hỏi phòng 21 s, lập lịch 78 s, thu hồi lịch 50 s |
| `gpt-6-sol(low)` | Hỏi phòng 28 s, lập lịch 113 s, thu hồi lịch 35 s |

- Ngoài Hermes (bộ thử 52 tool CRM, prompt gọn) cả 4 cấu hình đều gọi tool đúng, không có ID giả hay lặp. Treo chỉ xuất hiện khi chạy đủ bộ tool + prompt của Hermes với sol/astra mức medium.
- Connector đã chịu lỗi tham số: #176 (null/UUID toàn 0), #179 (`kind=buildings`, mô tả tool), #180 (bỏ trường vô nghĩa theo chế độ), #181 (chuẩn hoá mốc giờ có múi giờ ở `expiresAt`/`deadline`).
- **Đổi model:** sửa `model.default` và `model.context_length` trong `config.yaml` của profile owner, rồi `docker restart hermes-owner` (chờ hết lượt đang trả lời). Mức suy nghĩ đặt bằng hậu tố `(low)` sau tên model, ví dụ `gpt-6-sol(low)`; kiểm dòng `THINK:` trong `journalctl -u 9router`.
- Chặn SSE hay siết guardrail thêm: chủ quyết theo khảo sát [TOI-UU-TOC-DO-DOT1.md](TOI-UU-TOC-DO-DOT1.md).
- Khi bot im quá 60 s: nhắn `/stop`, rồi `/new` + `/approve`.

## 7. Phần còn hoãn hoặc chờ chủ

Xem bảng nghiệm thu cuối trong [STATUS.md](STATUS.md#nghiệm-thu-cuối-1610). Tóm tắt: các miền ghi CRM còn lại và cách cho Hermes "làm như một user" (chủ làm sau); user thứ hai/canary nhiều người; trần ngân sách/độ trễ chính thức; các bước tối ưu tốc độ còn lại theo [TOI-UU-TOC-DO-DOT1.md](TOI-UU-TOC-DO-DOT1.md).
