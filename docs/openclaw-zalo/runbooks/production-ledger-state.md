# Trạng thái ledger migration trên production — cần đọc trước Task 29

Cập nhật: 2026-08-03. Project: `tryymsxyyckgbrmmvozx`.

## Tóm tắt một câu

12 migration OpenClaw **đã apply** và schema production **khớp file đã review ở mọi
chiều thực chất**, nhưng `supabase_migrations.schema_migrations` **không ghi bytes
đã thực thi** cho 12 dòng đó — nên gate `--schema-drift` sẽ báo 13 phát hiện, và
tất cả đều là chuyện sổ sách chứ không phải drift thật.

## Vì sao ledger thiếu

12 file được apply trong phiên 2026-08-03 bằng script trực tiếp qua session pooler,
không qua Supabase CLI. Script ghi `(version, name)` và bỏ trống `statements`. Cả
360 dòng migration khác trong ledger đều có `statements`; chỉ 12 dòng OpenClaw
thiếu.

Sau đó một số file còn được **sửa tại chỗ** và phần chênh lệch được áp bằng tay:

| Delta | Nội dung |
| --- | --- |
| 1 | `app_private.openclaw_unknown_authority_v1` + `public.openclaw_get_unknown_authority_v1` + dựng lại `openclaw_resolve_unknown_v1` |
| 2 | `openclaw_get_bootstrap_v1` thêm `isActiveOwner` |
| 3 | `openclaw_conversations_recent_idx` (CREATE INDEX CONCURRENTLY) |
| 4 | `app_private.openclaw_actor_id_v1` + dựng lại 35 hàm bỏ `auth.uid()` |
| 5 | `openclaw_get_unknown_authority_v1` chuyển STABLE -> VOLATILE |

## Gate nói gì (đo 2026-08-03)

```
13 phát hiện drift:
  - Remote migration identity mismatch at <12 file>. (ledger records no statements…)
  - Remote aggregate migration manifest mismatch.
```

**Không có phát hiện nào khác.** Các chiều sau đều CHẠY và ĐỀU QUA:

- `unsafeViews` — rỗng (không view nào thiếu `security_invoker`)
- owner / `search_path` / grant của hàm — khớp hoàn toàn với file đã review
- cột mặc định kích hoạt — đúng, đều `false`, `NOT NULL`
- `enabledRowCount` — 0 (chưa cờ nào bật)

Trước bản sửa 2026-08-03, gate `throw` ngay ở dòng đầu nên **không ai nhìn thấy
bốn kết quả trên**. Nay nó gom hết rồi báo một lần.

## KHÔNG được làm gì

**Không back-fill cột `statements`.** Ghi bytes file hiện tại vào đó sẽ khẳng định
"đây là thứ đã chạy", trong khi file đã bị sửa sau khi apply — tức ghi một điều
không đúng vào chính bản ghi mà kiểm toán dựa vào. Bản thân gate cũng ghi rõ:

> Do not down-migrate or rewrite migration history. Ship only a separately
> reviewed forward corrective migration.

## Việc phải làm trước khi go-live (Task 29)

1. Người review đọc tài liệu này và xác nhận 13 phát hiện là **trạng thái đã biết**,
   không phải drift mới.
2. Nếu muốn ledger sạch: apply lại 12 file lên một database **mới** qua Supabase CLI
   (`supabase db push`) để CLI tự ghi `statements`, rồi đối chiếu schema với
   production. Đây là việc của Task 29, không phải sửa vá trên production đang chạy.
3. `scripts/apply-openclaw-reviewed-migrations.mjs` mà plan (dòng 3274) yêu cầu
   **chưa tồn tại**. Khi viết, nó phải ghi `statements`, nếu không dòng ledger mới
   cũng sẽ thiếu y hệt.
