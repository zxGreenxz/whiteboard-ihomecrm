# Mạng cùng host cho Hermes sidecar

Áp dụng khi sidecar Hermes (chung network namespace với `ihome-zalo-worker` trên bridge Docker mặc định) chạy **cùng VPS** với 9router và connector CRM. Hai dịch vụ này chỉ nghe `127.0.0.1`; trong container, `127.0.0.1` là chính container, nên trước đây Hermes phải gọi tên miền công khai (Cloudflare tunnel) rồi vòng về đúng VPS. Đường vòng đó làm bắt tay TLS treo 30 s mỗi lần (đo 15/10/2026: một câu hỏi mất 73,8 s, model chỉ 4,5 s). Plan và số đo: [TOI-UU-TOC-DO-DOT1](../../../docs/plans/hermes-crm/TOI-UU-TOC-DO-DOT1.md).

Các file ở đây là bản cho VPS Minh; tên giao diện `docker0`, `eth0.209` và IP `172.17.0.1` là của host đó — đổi theo host khác. Khi cài hoặc kiểm, so sha256 file trên host với repo.

| File | Vai trò |
| --- | --- |
| `ihome-docker-9router.socket/.service` | `172.17.0.1:20128` → `127.0.0.1:20128` qua `llm-stream-guard` (socket activation) |
| `llm-stream-guard.mjs` | Relay HTTP Node 24, không phụ thuộc gói ngoài; chuyển nguyên request/response, cắt luồng tool call sinh `arguments` không dứt ([mục dưới](#llm-stream-guard-cửa-9router)) |
| `ihome-docker-connector.socket/.service` | `172.17.0.1:8740` → `127.0.0.1:8740` bằng `systemd-socket-proxyd` |
| `ihome-net-tuning.service` | MSS clamp 1452 cho SYN đi ra `eth0.209` (PMTU tuyến ra là 1492, chỉ hạ, không nâng) và `net.ipv4.tcp_mtu_probing=1`; `ExecStop` gỡ đúng luật và trả sysctl về 0 |
| `tls-probe.sh` | Đo bắt tay TLS lặp lại từ host và từ netns của worker/Hermes (`tls-probe.sh <nhãn> [số lần] [host netns]`), ghi vào `/root/ihome-perf/` |

## Cài

```sh
# guard chạy bằng DynamicUser: mọi thư mục cha của node phải cho người lạ đi qua (o+x)
systemd-run --wait --pipe -p DynamicUser=yes -p ProtectSystem=strict -p ProtectHome=yes /opt/ihome-hermes/node/bin/node -v
install -d -m 755 /opt/ihome-llm-guard
install -m 644 llm-stream-guard.mjs /opt/ihome-llm-guard/
install -m 644 ihome-docker-*.socket ihome-docker-*.service ihome-net-tuning.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now ihome-docker-9router.socket ihome-docker-connector.socket ihome-net-tuning.service
ss -ltnp | grep -E '172.17.0.1%docker0:(20128|8740)'
```

- Socket gắn `BindToDevice=docker0` và `BindsTo` thiết bị `docker0`: chỉ nhận kết nối đến từ bridge Docker, tự lên/xuống theo `docker0`. Internet không thấy cổng này. Container khác trên `docker0` về lý thuyết gọi tới được, nhưng 9router đòi API key và connector đòi token kết nối.
- Connector phải cho phép Host mới: thêm `"172.17.0.1:8740"` vào `http.allowedHosts` của `/etc/ihome-hermes/connector.json` rồi restart; thiếu thì `POST /mcp` trả 403 `forbidden`.
- Đường Cloudflare giữ nguyên cho web CRM trên Vercel và cho truy cập từ ngoài.

## llm-stream-guard (cửa 9router)

**Vì sao.** Model đôi khi thoái hoá và stream `arguments` của một tool call mãi không dứt (đo: 0,5–1,7 MB, 10–35 nghìn chunk SSE, 3–5 phút, không bao giờ có `finish_reason`). Hermes v0.21.6 không bắt được: bộ phát hiện stale chỉ bắn khi luồng im lặng, runaway watch chỉ xem content/reasoning chứ không xem `arguments`, còn 9router bỏ qua `max_tokens`/`max_completion_tokens`/`max_output_tokens` với backend này. Arguments bình thường chỉ ≈50–200 ký tự.

**Chuyển tiếp.** Guard chuyển nguyên method, path, query, header (gồm `Authorization`, `Host`) và body theo luồng, không đệm request hay response; chỉ header hop-by-hop (`Connection`, `Transfer-Encoding`…) do Node tự quản ở mỗi chặng. Riêng `POST /v1/chat/completions` bỏ `Accept-Encoding` để SSE không bị nén (chặng loopback không cần nén); nếu upstream vẫn nén, luồng đi qua không kiểm và ghi `llm_stream_guard_skip`. Client bỏ ngang thì request upstream bị huỷ; upstream trả lỗi thì status/header/body đi nguyên; upstream đứt giữa chừng thì client cũng thấy đứt; không kết nối được upstream thì trả 502 JSON (`type: upstream_unavailable`) và ghi `llm_stream_guard_upstream_error`.

**Quy tắc cắt.** Chỉ đọc response `text/event-stream` không nén của `POST /v1/chat/completions` (so đúng path; path khác như có `/` cuối thì đi qua không kiểm), tách SSE theo dòng `\n`/`\r\n` qua mọi biên TCP; mỗi dòng `data:` là một sự kiện (chunk OpenAI là JSON một dòng). Dòng không phải JSON, chú thích hay `[DONE]` đều đi qua, lỗi phân tích không bao giờ làm hỏng luồng; mọi trường hợp không đọc được đều để luồng đi qua chứ không cắt. Đếm cho từng tool call (theo `index`; `id` mới ở cùng index là call mới) tổng số ký tự `function.arguments`:

| `reason` | Điều kiện | Mặc định (env) | Đơn vị `limit` |
| --- | --- | --- | --- |
| `tool_args` | `arguments` của một tool call vượt giới hạn | `GUARD_ARGS_MAX=8192`; tool trong `GUARD_LARGE_TOOLS` dùng `GUARD_LARGE_ARGS_MAX=131072` | ký tự |
| `wall_clock` | Cả lượt stream quá thời gian, tính từ lúc guard nhận request; hẹn giờ đặt khi upstream trả header (treo trước header do stale timeout của Hermes lo) | `GUARD_MAX_STREAM_SECONDS=300` | ms |
| `events` | Quá số dòng `data:` | `GUARD_MAX_EVENTS=40000` | sự kiện |

`GUARD_LARGE_TOOLS` (phân tách bằng dấu phẩy, **thay hẳn** danh sách mặc định) mặc định là các tool hợp lệ gửi arguments lớn: `write_file, patch, skill_manage, execute_code, terminal, memory, delegate_task, mcp__ihomecrm__crm_room_pass_upsert` (SKILL.md ≈3 KB+, heredoc, tin đăng dán vào…). Tool hợp lệ khác mà arguments vượt 8 KB sẽ bị cắt mỗi lượt: thêm tên nó vào danh sách bằng `systemctl edit ihome-docker-9router.service` (`[Service]` → `Environment=GUARD_LARGE_TOOLS=…`) rồi restart. Giá trị env sai làm guard thoát ngay (mã 1, lý do ở journal), không chạy với giới hạn đoán; systemd khởi động lại mỗi 3 s, và nếu chạm giới hạn khởi động (`service-start-limit-hit`) thì socket cũng failed, cổng 20128 ngừng nghe. Sửa env xong: `systemctl daemon-reload && systemctl reset-failed ihome-docker-9router.service ihome-docker-9router.socket && systemctl restart ihome-docker-9router.socket ihome-docker-9router.service`.

**Khi cắt.** Guard không chuyển mảnh TCP chứa vi phạm, huỷ request upstream (9router thấy client rời đi, ngừng tiêu quota) và đóng socket client giữa body chunked. Hermes coi đó là stream drop và tự thử lại (`Stream drop on attempt 1/3 — retrying`); replay A/B cho thấy thoái hoá ở ~24% lượt gọi đầu nên lượt thử lại thường đạt. Mỗi lần cắt ghi đúng một dòng JSON ra stdout (journald), không bao giờ ghi arguments, nội dung, header hay khoá:

```json
{"event":"llm_stream_guard_cut","reason":"tool_args","tool":"skill_view","argsChars":8200,"limit":8192,"elapsedMs":2140,"events":96,"model":"gpt-6-luna"}
```

`tool`/`argsChars` của `wall_clock` và `events` là tool call dài nhất đã thấy; `model` lấy từ chunk đầu. Theo dõi: `journalctl -u ihome-docker-9router.service -g llm_stream_guard`. Dòng `llm_stream_guard_start` lúc khởi động ghi giới hạn đang hiệu lực; `llm_stream_guard_drop` khi vượt 64 kết nối đồng thời (như `--connections-max=64` cũ), `llm_stream_guard_server_error` khi accept lỗi (vd. EMFILE).

**Vận hành.** systemd giữ socket `172.17.0.1:20128` và trao fd 3 cho Node (`LISTEN_FDS`/`LISTEN_PID`); libuv tự bật `O_NONBLOCK` khi mở fd nên socket không cần `NonBlocking=true`. Restart service không nhả cổng: kết nối mới chờ trong backlog. SIGTERM: ngừng nhận kết nối, chờ luồng đang chạy tối đa 10 s rồi cắt phần còn lại (Hermes thử lại). Chạy tay để thử: `node llm-stream-guard.mjs --listen 127.0.0.1:20129`. Test: `node --test llm-stream-guard.test.mjs`.

**Cập nhật guard:** chép `llm-stream-guard.mjs` mới vào `/opt/ihome-llm-guard/` (`install -m 644`), `systemctl restart ihome-docker-9router.service`, kiểm dòng `llm_stream_guard_start` trong journal.

**Trả về proxy cũ (rollback).** Sửa `/etc/systemd/system/ihome-docker-9router.service`: `ExecStart=/lib/systemd/systemd-socket-proxyd --connections-max=64 127.0.0.1:20128`, bỏ dòng `Environment=GUARD_…`, rồi `systemctl daemon-reload && systemctl restart ihome-docker-9router.service`. Socket không đổi nên Hermes không cần sửa gì.

## Cấu hình Hermes đi kèm

Trong `config.yaml` của profile (Hermes v0.21.6):

```yaml
model:
  context_length: 272000          # đúng số 9router báo cho cx/gpt-6-sol; bỏ probe "probe-down" mỗi lượt
providers:
  ninerouter:
    base_url: http://172.17.0.1:20128/v1
    stale_timeout_seconds: 90
  custom:                         # lúc chạy agent.provider là "custom"; mục không có base_url nên không thành provider mới
    stale_timeout_seconds: 90     # thay sàn 600 s của dòng gpt-6
mcp_servers:
  ihomecrm:
    url: http://172.17.0.1:8740/mcp
    connect_timeout: 30           # init MCP qua connector mất 3–8 s; đặt 5 làm hỏng kết nối (CancelledError)
tools:
  tool_search:
    enabled: "auto"               # KHÔNG đặt "off": nạp sẵn mọi tool làm model sinh arguments thoái hoá nhiều hơn
agent:
  agent_cache:
    idle_ttl_secs: 14400          # giữ ấm 4 giờ
```

`tool_search.enabled` phải giữ `"auto"`. Replay A/B một request Hermes thật (16/10/2026): nạp sẵn cả 78 tool thì 6/25 lượt gọi đầu sinh tool arguments thoái hoá ≥4 KB; còn ~29 tool (như `tool_search` để lại) thì 0/15, trên cả gpt-6-sol medium/low và gpt-6-luna. Production đã trả về `"auto"`; cái giá là có thể thêm 1–2 lượt `tool_search`/`tool_describe` ở câu CRM (đo 15/10: 5,5–7 s mỗi câu).

Kiểm sau restart: log có `MCP: registered … tool(s)`, `Turn machinery warmed`, có thể có `tool_search activated: … kept, … deferred` (bình thường với `"auto"`), không có `probe-down`; `get_provider_stale_timeout("custom", "<model>")` trả 90.

## Gỡ

```sh
systemctl disable --now ihome-docker-9router.socket ihome-docker-connector.socket ihome-net-tuning.service
systemctl stop ihome-docker-9router.service ihome-docker-connector.service
```

Trả `base_url`/`url` của Hermes về tên miền công khai trước khi gỡ cửa nội bộ, rồi restart sidecar. `/opt/ihome-llm-guard/` xoá được sau khi gỡ.
