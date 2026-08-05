# iHomeCRM

Hệ quản trị cho thuê nhà trọ / căn hộ đang vận hành thật: hợp đồng, hoá đơn, thu chi, sổ quỹ, công tơ,
lương thưởng, lợi nhuận cổ đông, cùng hai hệ hạ tầng riêng (Trung tâm mạng và kênh Zalo).

> **Repo riêng tư, một chủ sở hữu.** Dữ liệu là sổ sách tiền thật của công ty đang chạy — không phải
> môi trường thử nghiệm. Production: <https://ptcrm.vercel.app>

## Đọc gì trước

| Bạn là | Đọc |
|---|---|
| Agent (Claude Code / Codex) | **[docs/engineering/PROJECT_CONTRACT.md](docs/engineering/PROJECT_CONTRACT.md)** — luật bắt buộc, đọc trước khi chạm gì |
| Người mới | [docs/he-thong/README.md](docs/he-thong/README.md) — 23 domain nghiệp vụ |
| Muốn biết chương trình đang ở đâu | [tooling/program-status.json](tooling/program-status.json) |
| Cần số liệu database | [docs/generated/database-inventory.json](docs/generated/database-inventory.json) — sinh bằng máy, **đừng chép tay** |

## Kiến trúc

```text
Trình duyệt (React 18 + Vite + shadcn/ui)
        │  PostgREST RPC + Realtime
        ▼
Supabase — PostgreSQL 17.6 · Auth · Realtime · Edge Functions (Deno)
        │            ▲                    ▲
        │            │                    │
   Cloudflare R2   Worker Zalo      Worker Network Center
   (ảnh, egress $0)  (VPS)            (VPS, SSH → RouterOS)
```

Deploy: Vercel (frontend + `api/` serverless + 2 cron lương). Cloudflare Worker cho media gateway.

**Quy mô hiện tại** (ảnh chụp 2026-08-06): 316 bảng logic, 12 view, 1527 hàm (1057 SECURITY DEFINER),
640 file SQL migration, 418 file test, 43 Playwright spec.

## Bản đồ thư mục

```text
src/            frontend — pages/ components/ hooks/ lib/ copilot/ integrations/
api/            Vercel serverless (cron lương v5)
supabase/       migrations/ functions/ (14 Edge function) migrations-archive/
services/       openclaw-zalo-{bridge,cell,maintenance}, openclaw-egress-broker
infra/          network-center-worker, openclaw-media-gateway, openclaw-zalo-watchdog,
                cloudflare-worker, openclaw-zalo
worker/         worker Zalo thế hệ cũ (pm2, không deploy lên Vercel)
scripts/        gate, verifier, rollout, harness SQL
contracts/      JSON schema (OpenClaw) + golden vectors
docs/           engineering/ he-thong/ generated/ openclaw-zalo/ huong-dan-su-dung/
docs-site/      VitePress — tài liệu cho người dùng cuối
.e2e-fleet/     Playwright headless chạy song song
tooling/        risk-map, program-status (manifest máy đọc)
```

## Chạy tại máy

```bash
npm ci
npm run dev          # http://localhost:8080
```

Cần Node **≥20** cho app chính. Một số subsystem đòi Node khác — `services/openclaw-*` cần
**24.15–24.x**, `infra/network-center-worker` cần **≥20 <23**. Script `test:openclaw:services` tự chặn
nếu sai phiên bản. Nên dùng volta/fnm/nvm để đổi nhanh.

**Secret không nằm trong repo.** Biến `VITE_*` trong `.env` (publishable, nhúng vào bundle client);
credential thật đọc từ `CLAUDE.local.md` — file này **luôn** bị gitignore và không bao giờ được commit,
copy hay in ra log.

## Kiểm thử

```bash
npm run typecheck:baseline    # ratchet TS theo tập fingerprint (KHÔNG phải đếm số)
npx vitest run <path>         # unit / property test
npm run build

npm run gate:copilot-docs     # allowlist tài liệu Copilot đọc
npm run gate:agent-contract   # 3 file rule không lệch nhau
npm run gate:no-auto-apply    # không workflow nào tự apply migration
npm run types:check           # types.ts không lẫn partition runtime
npm run catalog:check         # catalog production khớp inventory đã commit
npm run gate:view-invoker     # sau MỌI migration đụng VIEW
npm run gate:stable-fn-locks  # sau MỌI migration tạo/sửa FUNCTION
npm run gate:reconcile-money  # mọi thay đổi đụng tiền

cd .e2e-fleet && FLEET_WORKERS=8 npx playwright test specs/<file>.spec.ts
```

E2E mặc định **chạy ẩn**; chỉ mở trình duyệt hiện hình khi được yêu cầu tường minh. Chỉ ghi dữ liệu vào
org DEMO — org thật chỉ đọc.

## Database và migration

Migration mới đặt trong `supabase/migrations/`, timestamp 14 chữ số duy nhất, **immutable sau khi
merge**.

> ⚠ **Lịch sử legacy KHÔNG replay được.** `supabase db push` và `supabase start` chết ở unique
> constraint của ledger; repo apply qua Management API. Đừng tin số file migration là bằng chứng đã
> deploy — xem [docs/DATABASE_SCHEMA.md](docs/DATABASE_SCHEMA.md).

Sau khi đổi schema: `npm run gen:types && npm run types:normalize`.

## Ba tổ chức trong cùng một database

| Org | Dùng để |
|---|---|
| THẬT | sổ sách thật — **chỉ đọc** khi test |
| DEMO | seed tay, có nút reset — nơi test được phép ghi |
| TEST | bản sao dữ liệu thật — thử tính năng mới |

Bảng mới có `organization_id` **phải** kèm policy `_hide_sandbox_admin`, nếu không dữ liệu org TEST sẽ
lọt vào màn hình chủ nhà và nhân đôi mọi con số. Chi tiết: Project Contract §2.

## Phát hành

```text
push main → Vercel preview → gate suite → xanh hết → promote nhánh `production`
                                        → đỏ bất kỳ → dừng, production giữ SHA cũ
```

Rollback là promote lại deployment trước. Ghi database production cần promotion token nhập tại chỗ,
không dùng PAT sẵn trong vault.

> Trạng thái: nhánh `production` đã tạo, nhưng Vercel **chưa** được đổi Production Branch — cho tới khi
> đổi, `push main` vẫn là phát hành. Kiểm bằng `npm run check:external-controls`.

## Bảo mật

- Mọi bảng public bật RLS; mọi view `security_invoker=true`; mọi hàm SECURITY DEFINER có `search_path`
  (kiểm bằng `npm run catalog:capture`).
- Hàm lấy khoá dòng phải khai `VOLATILE` — PostgREST chạy hàm `STABLE` trong transaction READ ONLY nên
  `SELECT … FOR SHARE` sẽ ném `25006`: gọi bằng SQL thì xanh, gọi từ trình duyệt thì hỏng.
- Không commit secret. Nghi ngờ lộ thì rotate ngay rồi mới điều tra.
