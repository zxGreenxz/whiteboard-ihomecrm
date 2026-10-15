# Mạng cùng host cho Hermes sidecar

Áp dụng khi sidecar Hermes (chung network namespace với `ihome-zalo-worker` trên bridge Docker mặc định) chạy **cùng VPS** với 9router và connector CRM. Hai dịch vụ này chỉ nghe `127.0.0.1`; trong container, `127.0.0.1` là chính container, nên trước đây Hermes phải gọi tên miền công khai (Cloudflare tunnel) rồi vòng về đúng VPS. Đường vòng đó làm bắt tay TLS treo 30 s mỗi lần (đo 15/10/2026: một câu hỏi mất 73,8 s, model chỉ 4,5 s). Plan và số đo: [TOI-UU-TOC-DO-DOT1](../../../docs/plans/hermes-crm/TOI-UU-TOC-DO-DOT1.md).

Các file ở đây là bản đang chạy trên VPS Minh (cùng sha256 lúc commit); tên giao diện `docker0`, `eth0.209` và IP `172.17.0.1` là của host đó — đổi theo host khác.

| File | Vai trò |
| --- | --- |
| `ihome-docker-9router.socket/.service` | `172.17.0.1:20128` → `127.0.0.1:20128` bằng `systemd-socket-proxyd` |
| `ihome-docker-connector.socket/.service` | `172.17.0.1:8740` → `127.0.0.1:8740` |
| `ihome-net-tuning.service` | MSS clamp 1452 cho SYN đi ra `eth0.209` (PMTU tuyến ra là 1492, chỉ hạ, không nâng) và `net.ipv4.tcp_mtu_probing=1`; `ExecStop` gỡ đúng luật và trả sysctl về 0 |
| `tls-probe.sh` | Đo bắt tay TLS lặp lại từ host và từ netns của worker/Hermes (`tls-probe.sh <nhãn> [số lần] [host netns]`), ghi vào `/root/ihome-perf/` |

## Cài

```sh
install -m 644 ihome-docker-*.socket ihome-docker-*.service ihome-net-tuning.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now ihome-docker-9router.socket ihome-docker-connector.socket ihome-net-tuning.service
ss -ltnp | grep -E '172.17.0.1%docker0:(20128|8740)'
```

- Socket gắn `BindToDevice=docker0` và `BindsTo` thiết bị `docker0`: chỉ nhận kết nối đến từ bridge Docker, tự lên/xuống theo `docker0`. Internet không thấy cổng này. Container khác trên `docker0` về lý thuyết gọi tới được, nhưng 9router đòi API key và connector đòi token kết nối.
- Connector phải cho phép Host mới: thêm `"172.17.0.1:8740"` vào `http.allowedHosts` của `/etc/ihome-hermes/connector.json` rồi restart; thiếu thì `POST /mcp` trả 403 `forbidden`.
- Đường Cloudflare giữ nguyên cho web CRM trên Vercel và cho truy cập từ ngoài.

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
    enabled: "off"                # nạp sẵn công cụ CRM, bỏ 1–2 lượt tool_search/tool_describe mỗi câu
agent:
  agent_cache:
    idle_ttl_secs: 14400          # giữ ấm 4 giờ
```

Kiểm sau restart: log có `MCP: registered … tool(s)`, `Turn machinery warmed`, không có `probe-down` hay `tool_search activated`; `get_provider_stale_timeout("custom", "<model>")` trả 90.

## Gỡ

```sh
systemctl disable --now ihome-docker-9router.socket ihome-docker-connector.socket ihome-net-tuning.service
systemctl stop ihome-docker-9router.service ihome-docker-connector.service
```

Trả `base_url`/`url` của Hermes về tên miền công khai trước khi gỡ cửa nội bộ, rồi restart sidecar.
