# Supabase Edge Functions

> **Reviewed:** 2026-07-20. Legacy `ai-chat`, `ai-embeddings` và RAG `ai_*` đã bị xoá; không deploy theo hướng dẫn cũ.

## Functions hiện hành

| Function | Vai trò | Auth chính |
|---|---|---|
| `admin-create-user` | **Tạo** user mới qua Supabase Admin API; không phải endpoint update | JWT hợp lệ + caller là `super_admin` |
| `demo-reset` | Reset dữ liệu demo có cooldown/tripwire | POST + header `x-demo-secret` (không dùng admin JWT) |
| `llm-proxy` | Proxy model cho AI Copilot, quota/reservation/usage | JWT + entitlement + cấu hình provider |
| `quick-entry` | AI của trang Báo chi nhanh `/chi-tieu`: chép giọng (OpenRouter) + đọc chữ/ảnh bill (9router) | JWT + quyền ghi chi + công tắc `QUICK_ENTRY_MODE` |
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
node scripts/deploy-edge-fn.mjs network-center-worker --no-verify-jwt --revision <40-char-release-sha>
```

## Chạy local

```powershell
supabase functions serve <function-name> --env-file supabase/.env.local
```

`supabase/.env.local` là secret local, phải nằm trong `.gitignore`. Không ghi key/token thật vào README, command log hoặc fixture.

## Secrets

- Provider/API key, `CRON_SECRET`, service-role và cấu hình push thuộc môi trường deploy.
- `network-center-worker` không dùng một `NETWORK_WORKER_SECRET` dùng chung. Mỗi
  worker có secret CSPRNG riêng; Edge function chỉ hash header rồi để PostgreSQL
  xác thực digest trong registry, thời hạn, revoke và building assignment. Không
  dùng lại service-role key, mật khẩu MikroTik, secret 9Router hoặc Zalo; không
  ghi header/digest này vào log.
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

## Báo chi nhanh (`quick-entry`)

Hàm riêng của trang `/chi-tieu`, tách khỏi `llm-proxy` để không đụng mã và manifest phát hành của
Copilot. Hai đường, mỗi đường một nhà cung cấp:

| Đường | Nhà cung cấp | Chuỗi mô hình mặc định (lỗi thì thử mô hình kế) |
|---|---|---|
| `POST …/quick-entry/audio/transcriptions` — chép giọng nói | OpenRouter | `google/chirp-3` → `deepgram/nova-3` → `openai/whisper-1` |
| `POST …/quick-entry/chat/completions` — đọc chữ/ảnh bill ra JSON | 9router | `cx/gpt-6-luna(low)` → `cx/gpt-5.6-luna(low)` |

Chuỗi chép giọng theo xếp hạng tiếng Việt đo 01/10/2026 (16 câu × 2 giọng × sạch/ồn, chấm bằng bộ đọc
số tiền của trang): chirp-3 64/64 > nova-3 62 = whisper-1 62 > gemini-3.5-transcribe 60 >
whisper-large-v3 59. `gpt-4o-transcribe` bị loại: đúng hết khi sạch nhưng gặp tiếng ồn thì BỊA câu tiếng
khác dù `language=vi` và vẫn trả 200 (chuỗi không dự phòng được).

**Người dùng chọn mô hình** (ô "Mô hình AI" trên trang, để tự so sánh): mặc định của ô là "Mặc định (máy
chủ chọn)" — trang KHÔNG gửi `model`, chuỗi ở bảng trên (hoặc `QUICK_ENTRY_*_MODELS`) quyết định. Chỉ khi
người dùng tự chọn một mô hình thì body mới có `model`. Máy chủ CHỈ nhận id trong danh sách cho phép
(`STT_CHOICES` — 5 mô hình chép giọng tốt nhất; `READ_MODEL_CHOICES` × `READ_EFFORTS` — GPT-6.1 Sol,
GPT-6 Astra, GPT-6 Sol, GPT-6 Luna, GPT-5.6 Luna với mức tự động/minimal/low/medium/high/xhigh/max/ultra,
trừ `READ_UNSUPPORTED` = Astra + minimal), thử nó TRƯỚC rồi tới chuỗi mặc định; id lạ ⇒ chuỗi mặc định.
`QUICK_ENTRY_CHOICES=off` bỏ qua mọi lựa chọn của người dùng (một mô hình đang trả sai mà người dùng đã
lưu lựa chọn trên máy họ). Danh sách ô chọn ở `src/lib/quickEntry/models.ts` — test giữ khớp.

Thứ tự kiểm: phương thức/đường → cỡ body → công tắc + khoá → JWT (`/auth/v1/user`) → header
`x-organization-id` → `get_my_permissions_v2` dưới JWT người gọi (cần `income_expenses.create`
hoặc `personal_finance.create`) → chế độ `pilot` đòi `ai_copilot_entitlements.chat_enabled` →
kiểm đầu vào (≤1 ảnh, chữ ≤32.000 ký tự) → **giữ chỗ** một dòng `ai_usage_logs` trạng thái
`pending` (ghi không được ⇒ 503, không gọi) → trần lượt/ngày (đếm `task_id` khác nhau, feature
`quick_entry`, ĐÃ gồm dòng vừa giữ — gọi song song không cùng lọt; vượt hoặc đọc không được ⇒ xoá
dòng giữ chỗ, 429). Mỗi lần thử một mô hình ghi một dòng (lần đầu điền vào dòng giữ chỗ); âm thanh,
ảnh và bản chữ không được lưu hay ghi log. 401/402 từ nhà cung cấp là lỗi khoá/số dư ⇒ dừng, không
thử tiếp. Ngân sách thời gian cả lượt: chép giọng 35 s, đọc 50 s (chừa ≥10 s dưới thời gian client chờ
45 s / 60 s); một lần thử tối đa 25 s (chép giọng) / 35 s (đọc — mức suy nghĩ cao + ảnh bill có thể mất
15–20 s). `max_tokens` kẹp ở 4000: mức suy nghĩ cao tính cả token suy nghĩ vào trần này, xin ít là JSON
bị cụt.

**Cụm từ ưu tiên (chỉ `google/chirp-3`):** song song với bước giữ chỗ, hàm đọc bằng JWT CỦA NGƯỜI DÙNG
(RLS lọc, đúng `organization_id` đang chọn) mã + tên toà (`buildings`), tên thường gọi của toà
(`building_common_names`, kèm cụm ghép "số nhà + tên" như "102 Lê Văn Thọ"), hạng mục chi
(`income_expense_types`, bỏ `system_only`) và tên phòng ("phòng 301", "phòng MADRID 3"); bỏ trùng, tối
đa 900 cụm × 100 ký tự, gửi trong `provider.options["google-vertex"].config.adaptation` — dạng DUY NHẤT
OpenRouter chuyển tiếp cho Google (đo 02/10/2026: `adaptation` đặt thẳng trong options, khoá `google`,
snake_case và `prompt` đều bị bỏ im lặng; 1.000 cụm đạt, 1.001 cụm bị 400). Không gửi boost (10/20 ra y
hệt không boost). Tác dụng đo bằng giọng máy: "1392 cute" ⇒ "1392QT", "bắn form … 80 DS3" ⇒
"bắn foam … 80DS3", "417 LVT" ⇒ "417LVT". Đọc nguồn lỗi/quá 3 s ⇒ chép không gợi ý; Google trả 400 với bộ
cụm từ ⇒ thử lại chirp-3 một lần không kèm cụm từ rồi mới tới mô hình kế. Header `x-quick-entry-hints` = số
cụm đã gửi ở lần thử trả lời.

Lưu ý hạn mức: `reserve_ai_usage` của Copilot cộng token/USD theo ngày của **mọi** dòng
`ai_usage_logs` của người dùng, không lọc feature — dùng nhiều Báo chi nhanh (nhất là ảnh) có thể
làm người đó chạm trần Copilot trong ngày sớm hơn.

Secret (thiếu khoá của đường nào thì đường đó trả `quick_entry_disabled`, trang vẫn nhập tay được):

| Secret | Ý nghĩa |
|---|---|
| `QUICK_ENTRY_MODE` | `off` (mặc định) · `pilot` (chỉ người có Copilot) · `all` — công tắc tắt khẩn |
| `QUICK_ENTRY_OPENROUTER_KEY` | Khoá OpenRouter riêng cho chép giọng (đặt hạn mức chi trên openrouter.ai) |
| `QUICK_ENTRY_NINEROUTER_BASE_URL` / `QUICK_ENTRY_NINEROUTER_KEY` | 9router; vắng thì dùng `NINEROUTER_BASE_URL` / `NINEROUTER_API_KEY` của Copilot. Chỉ nhận `https://` |
| `QUICK_ENTRY_STT_MODELS` / `QUICK_ENTRY_READ_MODELS` | Tuỳ chọn: đổi chuỗi mô hình, phân tách bằng dấu phẩy, ≤5 |
| `QUICK_ENTRY_CHOICES` | Tuỳ chọn: `off` ⇒ bỏ qua mô hình người dùng tự chọn, mọi người dùng chuỗi trên |
| `QUICK_ENTRY_STT_HINTS` | Tuỳ chọn: `off` ⇒ không đọc/gửi cụm từ ưu tiên cho chirp-3 |
| `QUICK_ENTRY_DAILY_CALLS` | Tuỳ chọn: trần lượt/người/ngày (mặc định 150; một lần nói = 2 lượt) |

```powershell
npx --yes deno@2.9.4 test --config supabase/functions/quick-entry/deno.json `
  supabase/functions/quick-entry/index.test.ts --allow-env
```

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
