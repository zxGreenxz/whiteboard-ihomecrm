# Bàn giao Hermes × iHomeCRM

Dành cho chủ công ty, quản trị CRM và người vận hành VPS. Cập nhật 18/10/2026. Trạng thái chi tiết, bằng chứng và lịch sử nằm ở [STATUS.md](STATUS.md); quyết định đã chốt ở [PLAN.md](PLAN.md).

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
- Từ 17/10 Hermes không gọi hàm `copilot_*` nào lúc chạy và mã `infra/hermes-*` không còn tham chiếu Copilot ngoài chú thích (#189, #193); gate `copilot-independence` chặn tham chiếu mới.
- Mọi việc Hermes làm trong CRM đi qua quyền CRM hiện tại của bạn **giao** với quyền Đọc/Thao tác bạn chọn cho kết nối. Hermes không có quyền riêng, không tự cấp thêm quyền.
- Nick bot phải dành riêng cho Hermes: bật bot làm mọi tin nhắn riêng tới nick đó thành riêng tư, không vào hộp chat chung.

## 2. Dùng hằng ngày

Nhắn riêng cho bot từ nick Zalo chính đã liên kết. Ví dụ:

| Muốn | Nhắn |
| --- | --- |
| Hỏi phòng trống / phòng đang sale | "Còn phòng trống nào ở 417LVT?" — danh sách đúng trang Sale Phòng/link chia sẻ |
| Gửi bản tin phòng vào nhóm | "Gửi bản tin phòng trống theo mẫu CRM vào nhóm Web nội bộ" — chỉ soạn thì nói "chỉ soạn, chưa gửi" |
| Gửi ảnh phòng trống cho nhóm sale | "Gửi ảnh phòng trống cho các nhóm sale ngay", "Hẹn gửi ảnh phòng trống 9h sáng mai", "Đổi giờ gửi ảnh phòng trống hằng ngày sang 8h" — kết nối phải có phạm vi Toàn tổ chức |
| Cập nhật tin khách nhờ pass | Dán nguyên tin "KHÁCH PASS PHÒNG…" và nhờ cập nhật lên Sale phòng |
| Giao việc / theo dõi / huỷ việc | "Tạo việc kiểm tra máy lạnh 405PVB giao cho &lt;tên nhân viên&gt;, hạn 17h mai, nhắc trước 1 tiếng"; "Huỷ việc vừa giao" |
| Ghi phiếu chi | "Ghi phiếu chi 350k sửa ống nước 158PVC hôm nay" |
| Thêm khách (Cư dân) / lead (Khách hẹn) | "Thêm cư dân Nguyễn Văn A 09xxxxxxxx" hoặc "Thêm khách hẹn Trần Thị B 09xxxxxxxx" — kết nối phải có phạm vi Toàn tổ chức |
| Tra khách, hợp đồng | "SĐT và CCCD của khách phòng 103 417LVT?", "Hợp đồng phòng 405PVB hết hạn khi nào?" |
| Tra thu chi, công nợ, chỉ số, cọc giữ, lãi lỗ, công suất, hộp duyệt | Hỏi bằng lời thường, nêu toà/tháng |

- Mới 16/10: tạo khách (Cư dân) / lead (Khách hẹn); giao việc → theo dõi/nhắc hạn → huỷ việc, và lập → chạy → thu hồi lịch bản tin nhóm — hai chuỗi này đã thử thật qua Zalo ngày 16/10 ([STATUS](STATUS.md#nghiệm-thu-cuối-1610)).
- Mới 16–17/10 (đã lên production, chưa có bằng chứng thử qua Zalo trong repo):
  - Hermes điều khiển tự động hoá "Gửi ảnh phòng trống" của CRM: gửi ngay, hẹn một lần, sửa lịch hằng ngày, huỷ lượt chưa chạy (5 tool `crm_zalo_broadcast_*`, #187). CRM là bộ lập lịch duy nhất; lịch bản tin chữ cũ chỉ còn xem/thu hồi, không tạo/sửa mới.
  - Đọc đầy đủ cho người hỏi (#190): SĐT/CCCD đầy đủ, hồ sơ khách, chi tiết hợp đồng, báo cáo khớp màn web — theo đúng quyền web của bạn và **chỉ trong tin nhắn riêng**. Bản tin nhóm, lịch và tự động hoá vẫn chỉ dùng dữ liệu công khai.
  - Báo cáo lấy cùng nguồn màn web: công suất `occupancy_snapshot_v2` / `occupancy_upcoming_vacancy_v2`, lãi lỗ `fa_monthly_pnl_accrual` (mặc định) / `fa_monthly_pnl`, hộp duyệt `list_my_pending_approvals_v1`; hoá đơn, hợp đồng, hội thoại Zalo dùng SQL riêng theo đúng bộ lọc web.
  - Công ty không còn link chia sẻ Sale phòng thì Hermes báo `no_sale_page` — không phải hết phòng (#185).
- Hermes tự gọi CRM khi cần; dữ liệu phòng, giá, chính sách luôn lấy mới từ CRM, không lấy từ trí nhớ.
- Khi mất phản hồi sau lúc gửi/ghi, Hermes báo "chưa rõ kết quả" và **không tự làm lại**; xem mục Đối soát ở phần 3.
- `/stop` cắt lượt đang treo; `/new` mở phiên mới (Hermes hỏi xác nhận, trả lời `/approve`). Phiên rất dài dễ chậm — mở phiên mới khi đổi chủ đề lớn.
- Tin "💾 Self-improvement review" là tính năng nền của Hermes (tự tạo kỹ năng), không phải lỗi.

Chưa ghi được qua Hermes (chủ hoãn 16/10): hợp đồng, cọc, hoá đơn, lương/cổ đông, tài sản/dịch vụ và các miền ghi khác ngoài danh sách trên. Hermes sẽ nói không có công cụ; làm trực tiếp trên CRM.

Chưa đọc được (đợt 2, chưa phát hành): lương, cổ đông, ví cá nhân, biến động số dư, sổ quỹ, tài sản/dịch vụ/vật tư, Network Center và các báo cáo khác của đợt 2 ([STATUS](STATUS.md#cập-nhật-1810)).

## 3. Quản trị trên CRM (`/settings/hermes`)

**Tạo kết nối:** chọn quyền Đọc, quyền Thao tác và phạm vi (toàn tổ chức, khu vực hoặc toà), xác nhận mật khẩu CRM. Token `hc_…` chỉ hiện một lần — đưa ngay vào Hermes (biến `MCP_IHOMECRM_API_KEY` của profile), không gửi qua chat.

**Đổi quyền = tạo kết nối mới:** kết nối chỉ thu hẹp được, không mở rộng. Muốn thêm quyền: tạo kết nối mới → ngắt liên kết Zalo cũ → liên kết Zalo với kết nối mới → thay token trong Hermes → thu hồi kết nối cũ. Một nick chính + một bot chỉ có một liên kết đang hoạt động. Đã làm 3 lần trên production; kết nối đang dùng (ghi 16/10) `…624ef30e` (17 quyền Đọc + 11 quyền Thao tác, toàn tổ chức).

**Sau khi đợt 2 phát hành:** 35 khoá đọc mới mặc định tắt, chỉ bật (Gói Z) khi web và connector mới đã lên production. Khi đó chủ tạo **một kết nối mới** có các khoá cần dùng và **liên kết lại Zalo một lần** theo đúng quy trình trên; kết nối cũ không tự có quyền mới.

**Liên kết Zalo:** mục "Điều khiển Hermes qua Zalo" → chọn kết nối và bot → tạo mã → từ nick chính nhắn mã cho bot → bấm xác nhận. UID Zalo là theo góc nhìn bot (cùng một người có UID khác nhau ở mỗi nick).

**Bot của công ty:** chỉ người có quyền quản trị phù hợp bật/tắt; tắt bot thu hồi mọi liên kết qua bot đó.

**Đối soát tin chưa rõ kết quả:** xem trực tiếp trên Zalo tin đã tới chưa rồi ghi nhận; ghi nhận không gửi lại.

**Trợ lý của tôi:** xem/sửa/quên ghi nhớ công việc CRM, danh sách việc Hermes đang theo dõi và nhắc hạn.

**Thu hồi khẩn:** bấm Thu hồi trên kết nối — Hermes mất quyền CRM ngay, phần trò chuyện cá nhân vẫn chạy.

## 4. Vận hành VPS Minh

Runbook chi tiết: [HOST_SERVICE.md](../../../infra/hermes-runtime/HOST_SERVICE.md) (release, giới hạn, backup/restore, xoay khoá, sự cố, đồng bộ giờ), [CONNECTOR.md](../../../infra/hermes-broker/CONNECTOR.md) (cài vào Hermes upstream), [kênh Zalo native](../../../infra/hermes-zalo-native/README.md) (token kênh, plugin, đối soát, lệnh tạo sidecar).

| Thành phần | Vị trí / cách xem |
| --- | --- |
| Connector | `systemctl status hermes-connector`; release ở `/opt/ihome-hermes/releases/<sha8>`, đang dùng = symlink `/opt/ihome-hermes/current`; cấu hình `/etc/ihome-hermes/connector.json` |
| Hermes | `docker logs hermes-owner`; log lượt chat `/var/lib/ihome-hermes-profiles/owner/.hermes/profiles/owner/logs/agent.log`; cấu hình `config.yaml` + `.env` cùng thư mục |
| Worker Zalo | container `ihome-zalo-worker` (chạy `--native`) |
| Đường vào | Hermes gọi connector `http://172.17.0.1:8740/mcp` và 9router `http://172.17.0.1:20128/v1` qua unit `ihome-docker-connector` (systemd-socket-proxyd) và `ihome-docker-9router` (`llm-stream-guard`, cắt tool arguments chạy loạn; [host-network](../../../infra/hermes-runtime/host-network/README.md)); web CRM gọi connector qua tunnel `crm-hermes.chillhome.io.vn` |

**Release connector (18/10):** đang chạy main `77a4327a` (merge #192; gồm #187 gửi ảnh phòng trống, #189 phạm vi toà, #190 đọc đầy đủ đợt 1, #191 lệch đồng hồ, #192 trần `tools/list`). Kết nối đủ quyền thấy 63 tool, `tools/list` ≈ 62 KB (61.883 B); trần riêng của `tools/list` là 192 KiB, mọi phản hồi khác vẫn 64 KiB. Chưa gồm #193 (chỉ gỡ mã host v1 chưa từng chạy; connector-only không đổi hành vi). Lùi bản: chọn release cũ còn trên VPS nhưng không cũ hơn `f762ff52` (#187) — bản trước #185/#187 đọc nguồn phòng cũ nên gửi nhóm trả `context_changed` và tạo lịch chữ bị SQL từ chối (đều dừng an toàn, không gửi sai).

Giữ nguyên khi thao tác (tối ưu tốc độ 16/10): `connector.json` phải còn `172.17.0.1:8740` trong `http.allowedHosts` (thiếu là 403); MCP `connect_timeout: 30`; container Hermes RAM `900m`/swap `1800m` — chỉ `docker restart`, nếu tạo lại phải truyền lại; unit `ihome-net-tuning` (MSS 1452, `tcp_mtu_probing=1`); NTP qua IPv4 (`/etc/systemd/timesyncd.conf.d/ihome-ipv4.conf`) — đồng hồ lệch làm mọi RPC lịch trả 42501. Connector đã có dung sai 5 s cho mốc giờ do DB sinh (#191), không thay được NTP.

**Cập nhật connector (quy trình chốt 18/10):**

1. Chọn commit đã merge vào main, CI main xanh.
2. **Migration trước, connector sau.** Bản gọi RPC mới thì áp migration production qua forward lane trước, rồi kiểm từng hàm mới trên production bằng `select to_regprocedure('<hàm>(<kiểu tham số>)') is not null` — phải trả `true`. Ví dụ từ #189 (commit `1a6fdc59`) connector gọi `hermes_scope_buildings_v1` ở mọi lượt xác thực (migration `20261017023242`): `select to_regprocedure('public.hermes_scope_buildings_v1(text,uuid)') is not null`. Thiếu hàm thì mọi lượt ra `backend_unavailable`.
3. Dựng gói release từ đúng commit đó (thư mục `infra/hermes-broker`, `infra/hermes-runtime`, `infra/hermes-zalo-router`, `src/lib/roomSaleFacts.ts`, `worker/lib/hermes-link.js`, `worker/package.json`, `vendor/xlsx-0.20.3.tgz`, `package.json`, `package-lock.json`, bỏ test) → giải nén vào `releases/<sha8>` → `npm ci --omit=dev --ignore-scripts` bằng Node 24 của `/opt/ihome-hermes/node` → thử import `host-service.mjs` bằng user 10004.
4. Đổi symlink `/opt/ihome-hermes/current` sang release mới → `systemctl restart hermes-connector` → kiểm `GET /` 404, `/mcp` không token 401 qua tunnel. **Giữ nguyên** `/etc/ihome-hermes/connector.json` (không chép đè từ file mẫu).
5. `docker restart hermes-owner` (chờ hết lượt đang trả lời) để Hermes đọc lại danh sách tool. **Không tạo lại sidecar.** Buộc phải tạo lại thì dùng đúng lệnh `docker run` ở [kênh Zalo native](../../../infra/hermes-zalo-native/README.md): phải có `--entrypoint hermes` và `--memory 900m --memory-swap 1800m`.

**Đọc đầy đủ đợt 1 (crm_read_customers / `_detail` / `_report`, crm_read_occupancy họ v3):** đã áp production 17/10, đủ bốn migration trong MỘT lượt lane, đúng thứ tự `20261016162104_hermes_full_read_v1` → `20261016172206_hermes_full_read_review_fixes_v1` → `20261017021554_hermes_full_read_web_parity_v1` → `20261017033630_hermes_full_read_owner_scope_v1`. Dựng môi trường khác thì làm y vậy (`npm run migrate:forward -- <file> --env <đích> --apply` từng file, không xen việc khác) và chỉ đổi symlink connector khi câu dưới (`npm run db:query -- --file <câu>`) trả `1 | t | t | t | crm.fa_monthly_pnl`; connector lên trước thì `crm_read_occupancy` và các báo cáo trả `backend_unavailable` hoặc `invalid_request`.

```sql
SELECT count(*) FILTER (WHERE p.proname='hermes_pnl_pending_v1') AS pnl_pending,
  bool_or(p.proname='hermes_domain_read_v3' AND p.prosrc LIKE '%current_visible_owner_ids%') AS v3_owner_scope,
  bool_or(p.proname='hermes_report_read_v2' AND p.prosrc LIKE '%v_pnl_buildings%') AS reports_fixed,
  bool_or(p.proname='hermes_room_pass_upsert_v2' AND p.prosrc LIKE '%v_owners%') AS room_lookup_owner,
  app_private.hermes_report_catalog_v1('monthly_pnl','by_month')->>'source' AS pnl_source
FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
WHERE n.nspname IN ('public','app_private')
  AND p.proname IN ('hermes_pnl_pending_v1','hermes_domain_read_v3','hermes_report_read_v2','hermes_room_pass_upsert_v2');
```

**Đợt 2 (chưa phát hành):** migration Gói 0 (`20261018000000`, `20261018000500`, `20261018000600`) và các gói A–D lên trước; kiểm `select to_regprocedure('public.hermes_w2_read_v1(jsonb,text,jsonb)') is not null` rồi mới đổi connector. 35 khoá còn tắt nên thứ tự không làm gãy kết nối hiện có (#195); Gói Z bật registry sau cùng, rồi chủ tạo kết nối mới + liên kết lại Zalo (phần 3).

**Lùi bản:** trỏ symlink `current` về release trước (giữ ít nhất một bản cũ) rồi restart connector. Migration CRM đã apply không lùi; muốn tắt năng lực thì tắt dòng registry `app_private.hermes_capabilities` bằng migration mới hoặc thu hồi kết nối.

**Đĩa:** VPS 19 GB, còn khoảng 2,4 GB (đo 16/10) — xoá release cũ không dùng (không xoá bản đang `current` và bản lùi gần nhất).

## 5. Phiên bản đang chạy (18/10/2026)

| Thành phần | Phiên bản |
| --- | --- |
| Hermes | `nousresearch/hermes-agent` v0.21.6, image `sha256:ffa4fbb4…`, plugin `ihome-zalo-native` từ PR #175 (ghi 16/10, không đổi trong các PR 17–18/10) |
| Connector | release main `77a4327a`, 63 tool khi kết nối đủ quyền |
| Model | 9router `cx/gpt-6-luna` (từ 16/10 05:57) |
| CRM | production `ptcrm.vercel.app`, nhánh `production` = `c384ab2d` (18/10). Màn Khách hàng gọi `customer_list_v1` (#196) mới có ở main/Preview, chưa promote |
| Schema production 16–18/10 | #185 (2 migration), #187 (5), #190 (4), #189 `20261017023242`, #196 `20261017115708`; mỗi lượt có commit biên nhận lane. Registry năng lực không thêm khoá; 35 khoá đợt 2 chưa lên production |

Phiên cập nhật tài liệu 18/10 không có quyền VPS/DB: release VPS ghi theo báo cáo vận hành; app và migration lấy từ nhánh `production` và các commit biên nhận trên main.

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

Chi tiết ở [STATUS.md](STATUS.md#cập-nhật-1810). Tóm tắt:

- Đọc đầy đủ đợt 2: Gói 0 (#195, draft) và gói A–D (nhánh `claude/hermes-w2a`…`claude/hermes-w2d`, WIP) → Gói Z bật registry → kết nối mới + liên kết lại Zalo.
- Hàm dùng chung web + Hermes: Hợp đồng (#197) và Hoá đơn (#201) chưa merge, chưa áp production; Hermes chuyển sang gọi `customer_list_v1` / `contract_list_v1` / hàm hoá đơn ở PR sau.
- Thử thật qua Zalo trên connector `77a4327a`: gửi ảnh phòng trống, đọc đầy đủ đợt 1, `crm_group_directory` sau #191.
- Các miền ghi CRM còn lại và cách cho Hermes "làm như một user" (chủ làm sau); user thứ hai/canary nhiều người; trần ngân sách/độ trễ chính thức; các bước tối ưu tốc độ còn lại theo [TOI-UU-TOC-DO-DOT1.md](TOI-UU-TOC-DO-DOT1.md).

## 8. Chuông báo Hermes ↔ web và hàm dùng chung

Chủ chốt 17/10/2026: sửa bộ lọc/công thức web mà Hermes đang chép thì CI đỏ cho tới khi Hermes theo trong cùng thay đổi. Bản đồ: [web-parity.json](../../../infra/hermes-broker/web-parity.json); gate `npm run gate:hermes-web-parity` (CI: `check-hermes-web-parity`, job quality-gates).

Khi gate đỏ:

1. Đọc dòng lỗi: mục `[id]`, vùng web hoặc nguồn SQL CRM đã đổi, và hàm/file Hermes đang chép (kèm migration chứa bản định nghĩa cuối).
2. Sửa Hermes cho khớp web bằng migration `hermes_*` mới (migration đã apply không sửa) và/hoặc `infra/hermes-broker/*-contract.mjs`.
3. Web chuyển RPC (vd. `_v3`): đổi lời gọi trong hàm Hermes, sửa `rpc`/`webCalls`/`calls` trong bản đồ.
4. Chạy `node scripts/check-hermes-web-parity.mjs --write` để ghi hash mới, nêu lý do trong commit. Đổi chỉ là trình bày, không ảnh hưởng Hermes: vẫn `--write`, ghi rõ "không ảnh hưởng Hermes".
5. Thêm chỗ chép mới (đợt 2): bọc mã web bằng `// hermes-parity:begin <vùng>` … `// hermes-parity:end <vùng>` (chỉ chú thích), thêm một mục (`web` + `hermes`, `sql` nếu chép thân hàm/RLS CRM), rồi `--write`.

**Hàm dùng chung (chủ chốt 17/10, mô hình INVOKER + RLS 18/10):** công thức dùng từ hai nơi trở lên hoặc dính tiền/quyền đặt trong một hàm SQL mà web và Hermes cùng gọi ([quy tắc](../../CODEBASE_STRUCTURE.md#công-thức-dùng-chung)). Hàm là `SECURITY INVOKER`, đọc bằng RLS của chính người gọi; `p_building_ids` chỉ thu hẹp; helper DEFINER chỉ dùng cho phần kiểm quyền. Không gọi hàm INVOKER từ thân hàm DEFINER của Hermes (bỏ qua RLS, bị chặn 42501): đợt 2 có lối vào INVOKER `public.hermes_w2_read_v1`. Web chuyển sang hàm chung thì mục bản đồ giữ `mirrored` (hash trỏ hàm mới) tới khi Hermes gọi cùng hàm, lúc đó đổi thành `rpc`.

| Màn | Hàm | Trạng thái 18/10 |
| --- | --- | --- |
| Khách hàng | `customer_list_v1` (#196) | Merged, đã áp production; web mới ở main/Preview; Hermes chưa chuyển |
| Hợp đồng | `contract_list_v1` + `contract_stats_v2` (#197) | Draft, chưa merge, chưa áp production |
| Hoá đơn | `invoice_list_v1` + `invoice_statistics_v3` (#201) | Draft, chưa merge, chưa áp production; sửa thống kê chủ công ty ra 0 |

## 9. Bài học 17–18/10

- **Mốc giờ DB so với giờ VPS phải có dung sai.** Đồng hồ DB chạy trước VPS vài chục ms làm `crm_group_directory` trả `backend_unavailable` khoảng một nửa số lần dù NTP của VPS tốt. Connector dùng `DB_CLOCK_SKEW_MS = 5000` ([clock-skew.mjs](../../../infra/hermes-broker/clock-skew.mjs)) cho cận trên mốc giờ do DB sinh, không nới chiều "đã hết hạn" (#191). Phép so mới với mốc giờ DB dùng lại hằng này.
- **PGlite: một instance mỗi file test.** Mỗi ca chạy trong `BEGIN … ROLLBACK`, đột biến chỉ `CREATE OR REPLACE` bên trong ca. Dựng nhiều instance mỗi file làm runner CI cạn RAM (job quality-gates bị tắt; full-read-report đo 13,6 GB → 0,68 GB sau khi sửa ở `9f5ec9b2`).
- **Migration trước, connector sau**, kiểm `to_regprocedure(...)` trên production trước khi đổi symlink (phần 4).
- **Sidecar Hermes chỉ `docker restart`**; tạo lại mà quên `--entrypoint hermes` hoặc RAM 900m là sai cấu hình.
