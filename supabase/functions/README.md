# Supabase Edge Functions

> **Reviewed:** 2026-07-20. Legacy `ai-chat`, `ai-embeddings` và RAG `ai_*` đã bị xoá; không deploy theo hướng dẫn cũ.

## Functions hiện hành

| Function | Vai trò | Auth chính |
|---|---|---|
| `admin-create-user` | **Tạo** user mới qua Supabase Admin API; không phải endpoint update | JWT hợp lệ + caller là `super_admin` |
| `demo-reset` | Reset dữ liệu demo có cooldown/tripwire | POST + header `x-demo-secret` (không dùng admin JWT) |
| `llm-proxy` | Proxy model cho AI Copilot, quota/reservation/usage | JWT + entitlement + cấu hình provider |
| `salary-v5-jobs` | Chạy job V5 (`nightly`, `digest`, `close_period`...) | cron secret, service role hoặc JWT admin |
| `send-push` | Gửi Web Push từ notification pipeline | JWT/service caller theo implementation |
| `network-center-worker` | API hẹp cho worker MikroTik/Aruba trên Vultr | `x-network-worker-secret`, không nhận JWT trình duyệt |

Mỗi function có thư mục riêng với `index.ts`. Nguồn sự thật là code function, migrations liên quan và [docs hiện hành](../../docs/README.md).

## Deploy

```powershell
supabase link --project-ref <project-ref>
supabase functions deploy <function-name>
```

Không deploy tất cả functions mù. Review diff, secrets, auth gateway và caller trước; deploy từng function trong phạm vi thay đổi.

Riêng `network-center-worker` dùng secret worker thay cho JWT của người dùng, vì
vậy phải deploy với gateway JWT tắt và giữ xác thực fail-closed bên trong
function:

```powershell
node scripts/deploy-edge-fn.mjs network-center-worker --no-verify-jwt
```

## Chạy local

```powershell
supabase functions serve <function-name> --env-file supabase/.env.local
```

`supabase/.env.local` là secret local, phải nằm trong `.gitignore`. Không ghi key/token thật vào README, command log hoặc fixture.

## Secrets

- Provider/API key, `CRON_SECRET`, service-role và cấu hình push thuộc môi trường deploy.
- `network-center-worker` cần `NETWORK_WORKER_SECRET` riêng, ngẫu nhiên tối thiểu
  32 ký tự. Không dùng lại service-role key, mật khẩu MikroTik, secret 9Router
  hoặc Zalo; không ghi header này vào log.
- Tên secret phải lấy từ code function tương ứng; không suy từ tài liệu AI/RAG cũ.
- Thay đổi secret cần có kế hoạch rotation và kiểm tra fail-closed khi thiếu/sai.

## Network Center worker API

API chỉ nhận `POST application/json` và chỉ có các route allowlist:
`heartbeat`, `connections`, `claim`, `renew`, `ingest`, `inventory`, `stage`,
`complete`, `incidents`, `snapshots`, và `maintenance`. Mọi route xác thực
`x-network-worker-secret` bằng digest SHA-256 độ dài cố định trước khi đọc body,
validate worker ID/UUID/timestamp/kích thước rồi mới gọi RPC service-role tương
ứng. Lỗi backend được làm sạch, không trả raw SQL message.

Inventory Aruba là display-only. Mỗi request discovery tối đa 256 Aruba nhưng
không có quota tổng theo tòa hay toàn hệ thống; worker gửi tiếp nhiều batch cho
đến hết. API trình duyệt đọc Aruba bằng cursor, tối đa 100 dòng mỗi page.

Chạy test từ root repo (máy không cần cài Deno global):

```powershell
npx --yes deno test --config supabase/functions/network-center-worker/deno.json `
  supabase/functions/network-center-worker/index.test.ts --allow-env
```

## AI Copilot (`llm-proxy`)

- Runtime hiện dùng schema Copilot mới, không dùng `ai_conversations`, `ai_messages`, `ai_memory_embeddings` hay `ai_usage_stats` legacy.
- Proxy kiểm provider/entitlement/quota server-side và ghi usage theo schema hiện hành.
- Model không nằm trong metadata giá có thể bị hạch toán cost 0; xem [AI Copilot current status](../../docs/ai-copilot/README.md) trước khi mở model/provider mới.
- Browser local/Ollama là nhánh riêng; không giả định mọi request đều qua Edge Function.

## Salary V5 (`salary-v5-jobs`)

- Transport gọi logic job DB; idempotency/heartbeat nằm ở `cron_runs`.
- Kênh chính là Vercel Cron qua `api/salary-v5-cron.js`; admin có thể chạy lại từ UI.
- Job không tự post tiền V5. Ghi tiền chỉ qua gate đối soát/lock tương ứng.
- Xem [V5 runbook](../../docs/bang-luong/V5-RUNBOOK.md).

## Security checklist

1. Xác thực caller ở gateway và trong function khi cần.
2. Không tin user ID/organization từ body nếu có thể derive từ JWT/database.
3. Service-role chỉ dùng server-side và giới hạn code path.
4. Validate method, content type, payload size và CORS theo endpoint.
5. Không log Authorization header, secret, PII hoặc raw provider payload nhạy cảm.
6. Test deny path, expired token, cross-org và retry/idempotency trước deploy.

## Kiểm tra sau thay đổi

- Chạy test caller/function liên quan.
- Kiểm typecheck baseline và build.
- Với schema migration, regenerate Supabase types sau deploy.
- Với function đụng tiền/quyền, test trên org DEMO và kiểm audit/console; không ghi dữ liệu vào org thật.
