# Tối ưu tốc độ Hermes — Đợt 1

**Trạng thái:** ĐÃ THỰC HIỆN #1–#8 trên production 16/10/2026 00:19–01:10 (giờ VN); còn chờ nghiệm thu 3 câu mẫu của chủ và quyết định chặn model chạy loạn (mục 0). Lập 15–16/10/2026 sau khảo sát chỉ-đọc trên VPS Minh (log Hermes, 9router, connector, worker, mạng).
**Phạm vi:** sửa #1–#8 + khảo sát model GPT/Gemini → báo cáo. #9 (phiên chat) và #10 (model/mức suy nghĩ) quyết sau theo báo cáo.
**Gián đoạn dự kiến:** CRM ~10 s (bước 4), bot Zalo im ~1–2 phút (bước 5).

---

## 0. Kết quả thực hiện (16/10/2026)

| # | Đã làm | Kiểm |
|---|---|---|
| 1 | Cửa nội bộ `172.17.0.1:20128`/`:8740` ([host-network](../../../infra/hermes-runtime/host-network/README.md)); `allowedHosts` thêm `172.17.0.1:8740`; Hermes trỏ model/MCP vào đó | Từ netns Hermes: 9router 0,076 s, connector 0,010 s (Cloudflare 0,43 s); không khóa → 401; MCP đăng ký đủ tool |
| 2 | `tools.tool_search.enabled: "off"` | Log không còn `tool_search activated`; lượt hỏi CRM không còn `tool_search`/`tool_describe`. Sau khi kết nối mới mở 48 tool CRM, prompt cố định 14,6k → 25,6k token (86 schema), vẫn cache ~90% |
| 3 | `model.context_length: 272000` | Không còn `probe-down` |
| 4 | `stale_timeout_seconds: 90` ở `providers.custom` và `providers.ninerouter` | `get_provider_stale_timeout("custom", …)` = 90. **Không chặn được kiểu treo thật** — xem dưới |
| 5 | Định đặt `connect_timeout: 5` → Hermes mất CRM (`CancelledError`, init MCP 3–8 s); **trả về 30** và sửa runbook | Restart lần 2: `registered 10 tool(s)` |
| 6 | `agent.agent_cache.idle_ttl_secs: 14400`; `docker update --memory 900m --memory-swap 1800m` | Resolver đọc 14400; container 269/900 MiB sau restart |
| 7 | [PR #175](https://github.com/zxGreenxz/whiteboard-ihomecrm/pull/175) merged `162e64e6`, chép `adapter.py` (sha256 `cc1770e8…`) | CI PR xanh, review APPROVE; Zalo connected sau restart |
| 8 | `ihome-net-tuning.service`: MSS clamp 1452 + `tcp_mtu_probing=1` | SYN host + container mang `mss 1452`; đo 600 lần trước/sau đều 0 treo (lỗi chập chờn, cần theo dõi 24 giờ) |

Sao lưu cấu hình cũ ở VPS `/root/ihome-perf/backup-20261015-1719/`.

**Treo vì model chạy loạn (phát hiện sau khi áp):** 2 lượt 01:26 và 01:33 phải `/stop`. `stream_diag` cho thấy không phải im lặng: 35.562 chunk / 1,5 MB / 273 s và 27.172 chunk / 1,66 MB / 306 s, `finish_reason_seen=False`; 9router nhận request nhưng không bao giờ DONE. Model `cx/gpt-6-sol` sinh tham số tool-call vô tận (arguments chèn khoảng trắng; lần 2 ngay sau 3 lỗi `invalid_request` của `crm_task_input_options`). Vì chunk vẫn chảy, bộ phát hiện treo (đo im lặng) không cắt — mốc 90 hay 600 s như nhau; `RunawayStreamWatch` của Hermes v0.21.6 chỉ theo dõi content/reasoning, không theo dõi arguments. 9router bỏ qua `max_tokens`/`max_completion_tokens`/`max_output_tokens` với codex (đặt 40 vẫn ra ~800 token). Lỗi đã có trước đợt 1 (20:55 lượt 589 s, 22:27 `/stop`). Lựa chọn chờ chủ quyết: relay SSE ở cửa `20128` cắt khi arguments một tool-call vượt ngưỡng (khuyến nghị, PR riêng); hạ `gateway_timeout`; hoặc đổi model theo [khảo sát](MODEL-SURVEY.md). Connector đang được sửa để nhận `null` cho tham số tùy chọn (giảm tác nhân).

**Khảo sát model:** [MODEL-SURVEY.md](MODEL-SURVEY.md) — 284 request, dữ liệu tổng hợp. Đề xuất cho #10: `cx/gpt-6-sol(low)` (S2 tổng p50 3,39 s so với 4,01 s ở medium, chất lượng như cũ) hoặc thử `cx/gpt-6-luna` (nhanh nhất, 2,91 s); Gemini 3.8 flash-low chỉ làm dự phòng. Khảo sát không đo khả năng chống chạy loạn tham số.

---

## 1. Hiện trạng đo được (15/10, giờ VN)

| Loại câu hỏi | Thời gian trả lời | Số lượt gọi AI |
|---|---|---|
| Chào hỏi / câu ngoài CRM | 2,7–7,3 s | 1 |
| Hỏi CRM (phòng trống…) | 11,0–23,2 s | 2–4 |
| Gửi bản tin vào nhóm | 53,3 s và 68,2 s | 6 và 11 |
| Sự cố | 73,8 s (23:14), 30,1 s (23:19), không trả lời (22:27, phải `/stop`), 589 s (20:55, đã sửa ở PR #172) | — |

- Một lượt gọi AI qua 9router: p50 3,2 s, p95 6,2 s; chờ chữ đầu p50 2,3 s, p95 4,0 s. 9router không lỗi, không 429.
- Câu 23:14 "em hiểu về tâm lý học không": model chỉ mất 4,5 s; 63 s còn lại là 2 lần bắt tay TLS tới `ai.chillhome.io.vn` hết giờ 30 s + chờ thử lại.
- Prompt mỗi lượt: 14,6 nghìn token cố định → 33 nghìn token khi phiên có 113 tin (cache ~92%).
- Mạng: đường ra internet có PMTU 1492 nhưng máy khai 1500, `tcp_mtu_probing=0`, không MSS clamp; 4,2% lần mở TCP phải gửi lại SYN (từ lúc khởi động). Đo tay 8 lần tới Cloudflare: 1 lần treo 35 s, 1 lần 6,3 s; lần đo khác 0/100 — lỗi chập chờn.
- Ổn: RAM/CPU/swap, 9router, worker gửi Zalo (<1,5 s), connector nội bộ (2–4 ms), DNS, đồng hồ, cloudflared, Network Center, không cron gọi AI.

### Luồng hiện tại (đi vòng)

```text
Zalo ─► Worker ─► Hermes (Docker) ──► internet ──► Cloudflare ──► tunnel ──► 9router (cùng VPS)
                                 └──► internet ──► Cloudflare ──► tunnel ──► Connector (cùng VPS) ──► Supabase
```

### Luồng sau đợt 1 (đi thẳng)

```text
Zalo ─► Worker ─► Hermes (Docker) ══ 172.17.0.1:20128 ══► 9router ──► ChatGPT/Gemini
                                 ══ 172.17.0.1:8740  ══► Connector ──► Supabase
Web CRM (Vercel) ──► Cloudflare ──► Connector   (giữ nguyên)
```

Lý do đang đi vòng: Hermes chạy trong Docker, `127.0.0.1` trong container là chính container; 9router và connector cố ý chỉ nghe `127.0.0.1` của VPS. Lúc dựng chỉ có tên miền công khai là đường Hermes gọi tới được. Bản sửa P9 (PR #170) chỉ rút ngắn đoạn connector → Supabase, không đổi đoạn này.

---

## 2. Danh sách vấn đề

| # | Vấn đề | Bằng chứng | Ảnh hưởng | Trong đợt 1 |
|---|---|---|---|---|
| 1 | Gọi AI và CRM đi vòng Cloudflare dù cùng máy | `config.yaml`: `base_url https://ai.chillhome.io.vn/v1`, MCP `https://crm-hermes.chillhome.io.vn/mcp`; tunnel trỏ về `127.0.0.1:20128` / `:8740` | Treo 30–74 s; +0,3–0,7 s mỗi lượt gọi | Có |
| 2 | Hermes giấu công cụ CRM sau `tool_search` → `tool_describe` | `tools.tool_search.enabled: auto` (mặc định); log "tool_search activated: 22 kept, 14 deferred" | +1–2 lượt AI = 5,5–7 s mỗi câu CRM; ~35% lịch sử là kết quả tìm công cụ | Có |
| 3 | Dò "độ dài ngữ cảnh" thất bại, và đoán sai | Log "probe-down… Using hardcoded 1,050,000"; 9router `/v1/models` báo `cx/gpt-6-sol` = 272 000 | 0,3 s thường, 5 s lúc xấu; ngưỡng nén phiên sai | Có |
| 4 | Hermes coi model treo sau 10 phút (sàn riêng cho dòng gpt-6) | `agent/reasoning_timeouts.py`, `_cloud_stale_timeout` | 2 lần treo 8–10 phút ngày 15/10 | Có |
| 5 | MCP `connect_timeout: 30` (runbook ghi 5) | `config.yaml` | Lúc lỗi chờ lâu | Có |
| 6 | Hermes "nguội" sau 1 giờ | `agent.agent_cache.idle_ttl_secs: 3600`; lượt đầu sau nghỉ 1,8–4,8 s chờ dựng lại | +2–5 s tin đầu | Có |
| 7 | Plugin Zalo hỏi worker mỗi 1 s | `infra/hermes-zalo-native/adapter.py:133`; worker `/v1/receive` trả ngay, không long-poll | +0,5 s trung bình mỗi tin | Có |
| 8 | PMTU 1492, không MSS clamp, không dò MTU | `tracepath` pmtu 1492, `ping -M do -s 1472` lỗi, SynRetrans 4,2% | Nghi là nguyên nhân bắt tay TLS treo (chặng 9router→upstream, connector→Supabase vẫn ra internet) | Có |
| 9 | Phiên chat không tự làm mới (Hermes 0.21.6 bỏ tự reset) | `hermes_cli/session_reset_retirement.py` | Prompt tăng ~170 token/tin | Quyết sau |
| 10 | Mức suy nghĩ đặt chung theo nhà cung cấp | 9router `settings.providerThinking`: codex = medium, antigravity = high | ~3,2 s mỗi lượt AI | Khảo sát, quyết sau |
| 11 | Smart approval thêm 1 lượt AI cho lệnh bị gắn cờ | `approvals.mode: smart` | +2–4 s/lệnh | Giữ (an toàn) |
| 12 | Gửi nhóm cần 6–11 lượt AI | log 22:54, 22:36 | 50–68 s | #2 bớt 2 lượt; phần còn lại làm sau |
| 13 | Self-improvement review | `agent/background_review.py`: chạy nền sau khi trả lời, tin mới huỷ trong ≤2 s | Không chặn trả lời | Giữ theo quyết định chủ |

---

## 3. Các bước thực hiện

Thứ tự: 0 → (1 chạy song song) → 2 → 3 → 4 → 5 → 6 → 7 → 8. Mọi lệnh chạy trên VPS Minh bằng SSH khóa (xem vault); không in secret ra log.

### Bước 0 — Chuẩn bị (không gián đoạn)

1. Thư mục `/root/ihome-perf/backup-<YYYYmmdd-HHMM>/` (mode 700), chép giữ quyền:
   - `config.yaml` của profile Hermes owner;
   - `/etc/ihome-hermes/connector.json` (giữ owner/mode 600);
   - `docker inspect hermes-owner` → `inspect.json`;
   - `iptables-save`, `sysctl net.ipv4.tcp_mtu_probing`.
2. Đo nền bằng `/root/ihome-perf/tls-probe.sh`:
   - 4 đích: `ai.chillhome.io.vn/v1/models`, `crm-hermes.chillhome.io.vn/mcp`, `chatgpt.com`, Supabase REST.
   - 75 lần mỗi đích, chạy từ host và từ netns của worker/Hermes (`nsenter -t <pid ihome-zalo-worker> -n`).
   - Ghi `time_connect`, `time_appconnect`, `time_total`; đếm lần TLS > 3 s và lần lỗi.
   - Chụp `nstat` (`TcpExtTCPSynRetrans`, `TcpRetransSegs`, `TcpExtTCPTimeouts`).
3. Chạy script tách thời gian từng lượt trên `agent.log` (đã có ở phiên khảo sát) để lưu bảng nền.

### Bước 1 — #7 Sửa plugin Zalo (song song, theo quy trình repo)

- Worktree mới từ `origin/main`. Sửa vòng `_poll` trong `infra/hermes-zalo-native/adapter.py`:
  - vừa nhận tin → hỏi tiếp ngay (để rút hàng chờ);
  - rỗng → chờ 0,25 s (hằng số đặt tên rõ);
  - lỗi → giữ 5 s.
- Không sửa worker (đổi worker phải khởi động lại phiên Zalo). Kiểm trước: chi phí `/v1/receive` ở `worker/lib/hermes-native-bridge.js` (quét journal `inbound`) có giới hạn kích thước, 4 lần/giây qua loopback không đáng kể.
- Kiểm: runner theo `tooling/test-matrix.json` (nhóm `hermes-native-zalo-*`), `npm run gate:truoc-push -- --plan` rồi gate theo kế hoạch.
- `infra/hermes-zalo-native/**` thuộc nhóm rủi ro cao trong `risk-map`: draft PR, CI Linux `hermes-native-zalo-linux-upstream`, review một lượt trên diff cuối, merge.
- Deploy: chép `adapter.py` từ SHA đã merge vào `plugins/ihome-zalo-native/` của profile (owner 10003, mode 644), so sha256 với repo; áp cùng lần restart ở bước 5. Nếu PR chưa xong thì deploy sau (thêm 1 lần restart ~1 phút).

### Bước 2 — #8 Mạng VPS (không gián đoạn)

1. Xác nhận lại: `ping -M do -s 1464 1.1.1.1` đạt, `-s 1465` lỗi → PMTU 1492.
2. Unit `/etc/systemd/system/ihome-net-tuning.service` (oneshot, `RemainAfterExit=yes`, `After=network-online.target docker.service`):
   - `sysctl -w net.ipv4.tcp_mtu_probing=1`;
   - MSS clamp **chỉ hạ, không nâng**, áp cho cả host lẫn container đi ra `eth0.209`:

     ```sh
     iptables -t mangle -C POSTROUTING -o eth0.209 -p tcp --tcp-flags SYN,RST SYN \
       -m tcpmss --mss 1453:65535 -j TCPMSS --set-mss 1452 2>/dev/null \
     || iptables -t mangle -A POSTROUTING -o eth0.209 -p tcp --tcp-flags SYN,RST SYN \
       -m tcpmss --mss 1453:65535 -j TCPMSS --set-mss 1452
     ```

   - `ExecStop` xoá đúng luật đó và trả `tcp_mtu_probing=0`.
3. Kiểm:
   - `tcpdump -c 5 -i eth0.209 'tcp[tcpflags] & tcp-syn != 0' -vv` thấy `mss 1452`;
   - chạy lại `tls-probe.sh`, so với nền;
   - WireGuard/Tailscale (UDP) và Network Center không đổi hành vi.
4. Rollback: `systemctl disable --now ihome-net-tuning`.

### Bước 3 — #1 Cửa nội bộ (không gián đoạn, chỉ thêm đường)

Hai cặp unit dùng `systemd-socket-proxyd` (có sẵn), 9router/connector vẫn nghe `127.0.0.1`:

```ini
# /etc/systemd/system/ihome-docker-9router.socket
[Unit]
Description=Cua noi bo Docker -> 9router
BindsTo=sys-subsystem-net-devices-docker0.device
After=sys-subsystem-net-devices-docker0.device

[Socket]
ListenStream=172.17.0.1:20128
BindToDevice=docker0
FreeBind=true

[Install]
WantedBy=sys-subsystem-net-devices-docker0.device

# /etc/systemd/system/ihome-docker-9router.service
[Unit]
Requires=ihome-docker-9router.socket
After=ihome-docker-9router.socket 9router.service

[Service]
ExecStart=/lib/systemd/systemd-socket-proxyd --connections-max=64 127.0.0.1:20128
DynamicUser=yes
NoNewPrivileges=yes
PrivateTmp=yes
```

Cặp `ihome-docker-connector.socket/.service` giống hệt, cổng `8740`, `After=hermes-connector.service`.

- Chỉ nhận từ mạng Docker (`BindToDevice=docker0`); internet không thấy. Container khác trên `docker0` (Network Center) về lý thuyết gọi tới được, nhưng 9router đòi API key (đã thử: 401) và connector đòi token kết nối.
- Kiểm:
  - `ss -ltnp` thấy `172.17.0.1%docker0:20128` và `:8740`;
  - từ netns Hermes: `POST /v1/chat/completions` không khóa → 401; `POST /mcp` không token → lỗi Host (chưa thêm ở bước 4) hoặc 401;
  - stream SSE dài qua proxy không bị cắt (thử 1 câu dài bằng key trong process env).
- Rollback: `systemctl disable --now ihome-docker-{9router,connector}.socket ihome-docker-{9router,connector}.service`.

### Bước 4 — Connector nhận địa chỉ mới (CRM gián đoạn ~10 s)

1. Thêm `"172.17.0.1:8740"` vào `http.allowedHosts` của `/etc/ihome-hermes/connector.json` (ghi file tạm rồi `install` giữ owner/mode 600; kiểm JSON hợp lệ trước khi thay).
2. `systemctl restart hermes-connector` (unit `Restart=no`, theo dõi ngay).
3. Kiểm:
   - `systemctl is-active` + journal khởi động không lỗi cấu hình;
   - `curl -X POST -H 'Host: 172.17.0.1:8740' http://127.0.0.1:8740/mcp` → 401 (không phải lỗi Host);
   - `https://crm-hermes.chillhome.io.vn/mcp` vẫn 401; trang `/settings/hermes` trên web vẫn đọc được trạng thái (bộ đếm in-memory reset là bình thường).
4. Rollback: chép lại `connector.json` từ backup, restart.

### Bước 5 — Cấu hình Hermes #1–#6 + plugin #7 (bot im ~1–2 phút)

1. Đọc source Hermes trong container để chốt **đúng khóa và giá trị** trước khi sửa:
   - giá trị hợp lệ của `tools.tool_search.enabled` (tránh YAML hiểu `off` thành `false` nếu source không nhận);
   - `providers.<id>.stale_timeout_seconds` tra theo `ninerouter` hay `custom` (log hiện `provider=custom`);
   - `agent.agent_cache.idle_ttl_secs`, `model.context_length`, `mcp_servers.*.connect_timeout`.
2. Cấu hình đích (minh hoạ; giữ nguyên `key_env`, headers, `timeout`, plugin, `gateway`):

   ```yaml
   model:
     provider: ninerouter
     default: cx/gpt-6-sol
     context_length: 272000            # #3, đúng số 9router báo
   providers:
     ninerouter:
       base_url: http://172.17.0.1:20128/v1   # #1
       stale_timeout_seconds: 90               # #4, xác minh khóa/id
   tools:
     tool_search:
       enabled: "off"                  # #2, xác minh giá trị
   agent:
     agent_cache:
       idle_ttl_secs: 14400            # #6
   mcp_servers:
     ihomecrm:
       url: http://172.17.0.1:8740/mcp # #1
       connect_timeout: 5              # #5
   ```

   Ưu tiên `hermes --profile owner config set …` nếu CLI hỗ trợ; nếu sửa tay thì parse lại bằng Python trong venv của image trước khi restart.
3. RAM (#6): xem `MemorySwap` hiện tại rồi `docker update --memory 900m --memory-swap <giữ tỉ lệ cũ> hermes-owner` (không tạo lại container). VPS còn ~868 MB trống; container đang 547/700 MiB.
4. Chắc không có lượt dở: lượt `conversation turn` cuối đã có `response ready`, `pending_messages/` rỗng; báo chủ không nhắn bot.
5. Chép plugin #7 nếu đã merge. `docker restart hermes-owner`.
6. Kiểm log khởi động:
   - có "Turn machinery warmed", không "probe-down", không "tool_search activated";
   - MCP nối `172.17.0.1:8740`; mọi `OpenAI client created … base_url=http://172.17.0.1:20128/v1`;
   - stale timeout hiệu lực = 90 (gọi hàm resolver trong container hoặc log);
   - `hermes --profile owner mcp test ihomecrm` đạt;
   - worker thấy Hermes poll lại `/v1/receive`.
7. Rollback: chép `config.yaml` (và `adapter.py` nếu có đổi) từ backup, `docker update` về 700m, restart.

### Bước 6 — Nghiệm thu

- Chủ nhắn 3 câu: "xin chào", "còn phòng trống nào", một câu ngoài CRM. Tách thời gian từng lượt, lập bảng trước/sau.
- Đạt khi:

| Tiêu chí | Ngưỡng |
|---|---|
| Lượt `tool_search`/`tool_describe` | 0 |
| Chào hỏi / ngoài CRM | < 6 s |
| Hỏi CRM | < 15 s |
| Lượt nào cũng | < 120 s |
| `tls-probe.sh` | 0 lần treo |
| Log khởi động | không probe-down, MCP qua `172.17.0.1` |

- Theo dõi 24 giờ: số "API call failed", "Streaming failed", lần chạm stale timeout, lượt > 60 s và > 120 s; chạy lại `tls-probe.sh` hôm sau. Mốc so sánh: 3 lần lỗi kết nối trong 4 phút tối 15/10.

### Bước 7 — Khảo sát model GPT và Gemini → báo cáo

**Điều kiện:** chạy sau khi bước 6 đạt, vào giờ vắng, **tuần tự 1 request/lần**, nghỉ 2 s giữa các request; dừng ngay nếu `cx/*` trả 429 (dùng chung quota với Hermes thật). Dữ liệu thử là **phòng giả**, không dùng dữ liệu CRM thật. Khóa 9router chỉ nạp vào env của tiến trình đo.

**Cần chốt trước khi đo (đọc source 9router):**
- `settings.providerThinking` đặt **theo nhà cung cấp**: codex = medium, antigravity = high. Đổi trên dashboard = đổi luôn cho Hermes.
- Request gửi `reasoning_effort` hoặc model có hậu tố `-low/-medium/-high` (Gemini) có thắng cài đặt nhà cung cấp không? Nếu có → đo các mức mà không đụng dashboard. Nếu không → GPT chỉ đo mức hiện tại (medium); mức low chỉ thử trong một khung ngắn lúc vắng rồi trả lại ngay, hoặc ghi "chưa đo".

**Danh sách:**
- GPT (`cx/`): `gpt-6.1-sol`, `gpt-6-sol` (đang dùng), `gpt-6-astra`, `gpt-6-luna`, `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`, `gpt-5.5`, `gpt-daybreak-blue-latest`, `gpt-reserve`. Không đo bản `[1m]` (cùng model, ngữ cảnh dài) và bản `*-review`/`codex-auto-review` (chuyên review).
- Gemini (`ag/`): `gemini-3.8-flash`, `-low`, `-medium`, `-high`; `gemini-3.7-flash-low/medium/high`; `gemini-3.6-flash-low/medium/high`; `gemini-3.1-pro-low`, `gemini-3.1-pro-high`; `gemini-pro-agent`. Tham chiếu tuỳ chọn: `ag/gpt-oss-120b-medium`.

**Kịch bản:**

| Mã | Nội dung | Đo |
|---|---|---|
| S1 | 3 câu tiếng Việt ngắn | chờ chữ đầu, tổng thời gian |
| S2 | Prompt ~30 nghìn token giống Hermes (system + 25 schema công cụ + lịch sử giả), hỏi "còn phòng trống nào" | gọi đúng `crm_available_rooms`, đúng tham số, thời gian |
| S3 | Chuỗi gửi nhóm với kết quả giả: lấy mã → xem danh sách nhóm → xem trước → mẫu khác bản nháp thì hỏi lại | đúng thứ tự, không tự gửi khi chưa xác nhận, số lượt |
| S4 | 3 câu ngoài CRM (tâm lý, giải thích, tư vấn) | chất lượng tiếng Việt theo thang đúng/tự nhiên/ngắn gọn, chấm mù |

- **Vòng 1 (lọc ~25 model):** S1 × 3 + S2 × 1. Loại model lỗi, 429, gọi sai công cụ, hoặc p50 tổng > 2 lần mức hiện tại.
- **Vòng 2 (5–6 model tốt nhất):** S2 × 5, S3 × 3, S4 × 3; so các mức suy nghĩ nếu đo được.
- Ước tính ~220 request; prompt S2/S3 dùng chung tiền tố để cache.

**Báo cáo:** `docs/plans/hermes-crm/MODEL-SURVEY.md` — bảng p50/p95 (chờ chữ đầu, tổng), tỉ lệ gọi đúng công cụ, đúng thứ tự S3, lỗi/429, điểm chất lượng, ghi chú quota; đề xuất cho #10 (model + mức suy nghĩ) và #9 (chính sách phiên). Chỉ số liệu đo, không dữ liệu production.

### Bước 8 — Ghi lại

- `STATUS.md`: số đo trước/sau, thay đổi trên VPS, link PR #7.
- Runbook: `infra/hermes-zalo-native/README.md` (sidecar: base URL/MCP nội bộ, RAM 900m, khóa cấu hình mới), `infra/hermes-broker/CONNECTOR.md` (MCP cùng host qua cửa Docker, `allowedHosts`).
- Mẫu unit `ihome-docker-*.socket/.service`, `ihome-net-tuning.service` lưu vào repo để dựng lại được.
- Commit theo Contract (gate theo kế hoạch; PR khi risk-map yêu cầu).

---

## 4. Rủi ro và cách lùi

| Bước | Rủi ro | Cách lùi |
|---|---|---|
| 1 | Poll dày làm worker bận | Hằng số 0,25 s; đo CPU worker; trả về 1 s |
| 2 | Đổi mạng làm hỏng kết nối đang chạy | Luật chỉ chạm SYN đi ra `eth0.209`, chỉ hạ MSS; `systemctl disable --now` |
| 3 | `docker0` tạo lại làm cửa mất | `BindsTo` thiết bị `docker0` để socket tự lên/xuống theo; kiểm sau `systemctl restart docker` ở đợt bảo trì |
| 4 | Connector không lên sau restart | Backup `connector.json`; restart lại bản cũ; web CRM chỉ mất trạng thái in-memory |
| 5 | Khóa cấu hình sai tên → Hermes bỏ qua hoặc lỗi khởi động | Đọc source trước; parse YAML trước restart; backup + restart lại |
| 5 | Stale 90 s cắt nhầm lượt suy nghĩ dài | Lượt dài nhất 15/10 là 11 s; nếu thấy cắt nhầm thì nâng 150 s |
| 5 | Tắt `tool_search` làm prompt to khi mở thêm nhiều công cụ CRM | Hiện 14 schema ≈ 4,8 nghìn token (gần bằng manifest đang dùng); xem lại khi mở thêm miền |
| 7 | Khảo sát ăn quota của Hermes | Tuần tự, giờ vắng, dừng khi 429 |

## 5. Việc của chủ

- Chọn giờ chạy bước 2–5 và báo không nhắn bot lúc restart (bước 5).
- Nếu PR #7 chưa merge kịp: chọn deploy sau (thêm 1 lần restart) hay chờ để restart một lần.
- Nhắn 3 câu mẫu ở bước 6.
- Đọc báo cáo khảo sát rồi quyết #9, #10.

## 6. Ngoài phạm vi đợt 1

- #9 phiên chat, #10 model/mức suy nghĩ — sau báo cáo khảo sát.
- #11 giữ smart approval; #12 rút bước gửi nhóm cần thiết kế riêng (giữ bước xem trước); #13 giữ self-improvement.
- Đổi các credential đã hiện trong log phiên khảo sát (danh sách ghi riêng ngoài repo).
- Dọn đĩa VPS (87%, còn ~2,5 GB); tra `notifyPush http 400` sau mỗi tin đến ở worker; theo dõi RAM container Hermes.

## 7. Chưa xác minh

- #8 mới là giả thuyết: chưa bắt được gói tin đúng lúc treo; bước 2 + theo dõi 24 giờ sẽ trả lời.
- Tên khóa stale timeout (`providers.custom` hay `providers.ninerouter`) và giá trị hợp lệ của `tool_search.enabled` — chốt ở bước 5.1.
- Thứ tự ưu tiên giữa `providerThinking` và `reasoning_effort`/hậu tố model trong 9router — chốt trước bước 7.
- Khoảng 5,2 s trước lượt 23:13 được suy ra là probe hết giờ, chỉ dựa vào thời điểm log.
