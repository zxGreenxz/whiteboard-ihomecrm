# Đợt refactor & tối ưu toàn site — 2026-07-10

> Tài liệu này để **một AI/kỹ sư khác review lại toàn bộ** các thay đổi đợt này.
> Mỗi phase = 1 commit độc lập, shippable, đã push thẳng `main` → Vercel production.
> Đọc theo thứ tự; mỗi file phase có mục **"Reviewer cần soi"** ở cuối.

## Bối cảnh

Xuất phát từ yêu cầu "rà soát toàn bộ web (code + database + logic liên hệ giữa
các page) rồi tối ưu/refactor, chia 10 phase, làm kỹ từng phase, verify xong mới
qua phase sau". Đã audit toàn diện bằng 3 agent khảo sát song song (pages/routes,
tầng data, database). Kết quả audit + quyết định nghiệp vụ của chủ hệ thống nằm ở
`../../docs/` và trong plan gốc.

**Định hướng chủ chốt (quyết định thứ tự ưu tiên):**
- Hệ thống ĐÃ có người ngoài dùng + định hướng bán SaaS đa-chủ-nhà → **cách ly
  tenant là ưu tiên #1** (nên bảo mật xuyên-tenant làm trước).
- Điểm đau thật của user: (1) **không tin số liệu, phải đối chiếu tay**, (2) chậm/
  loading, (3) page chồng chéo.
- Flow sống còn (test kỹ nhất, đụng thận trọng nhất): thu tiền tập trung, hoá đơn
  + điện nước, thu chi sổ quỹ + bàn giao, hợp đồng ký/gia hạn/thanh lý — **đặc biệt
  số tiền và số dư sổ quỹ**.
- Chốt sổ **mềm**: được sửa số quá khứ nhưng phải báo diff trước khi áp.
- Chia lợi nhuận (`monthly_building_profit` bỏ sót phiếu NV ~1,8 tỷ thu/1,3 tỷ chi):
  user **HOÃN** — không đụng đợt này (xem RISK-REGISTER).

## Nguyên tắc chung mọi phase (verify gate)

1. `npx tsc --noEmit -p tsconfig.app.json` — số lỗi ≤ baseline `ts-baseline.txt`
   (106, ratchet không tăng). Chạy nhanh: `npm run typecheck:baseline`.
2. `npx vitest run` các suite liên quan + suite mới.
3. Chờ Vercel deploy → Playwright trên production đi qua page của phase, check
   console/network không lỗi mới.
4. **Phase đụng tiền**: `node scripts/reconcile-money.mjs` — so SUM SQL thật vs
   tổng-1000-dòng-đầu, phải khớp.
5. DB changes: apply TRỰC TIẾP qua Management API (`scripts/apply-sql.mjs`, UTF-8),
   KHÔNG `supabase db push`. Mỗi migration có comment `-- ROLLBACK:`.

## Chỉ mục commit (theo thứ tự)

| Phase | Commit | Nội dung | Loại |
|-------|--------|----------|------|
| 1 | `5e9c3cf` | Vá 3 lỗ hổng xuyên-tenant + khoá DEFINER nội bộ | DB-only |
| 2 | `b4a496b` | Regen types.ts (hết 25 migration drift) + ratchet TS baseline | FE |
| 3 | `a050c24` | Diệt bug cap-1000 khi cộng tiền + máy đối chiếu | FE + tool |
| 4 | `be1ffc0` | Wrap 128 policy initplan + chốt view-invoker + dọn migration replay | DB + tool |
| 5 | `dacfd0c` | Gate dialog useQuery theo open + dọn console.log | FE |
| 6 | `6a0c122` | Gom formatCurrency/formatVND về lib/utils + thống nhất viewport | FE |

Xem chi tiết 1 commit: `git show <hash>`. Diff 1 file trong commit: `git show <hash> -- <path>`.

## Cách review nhanh

1. Đọc `RISK-REGISTER.md` trước — nó liệt kê điểm rủi ro cao + câu hỏi mở cần soi kỹ.
2. Với thay đổi DB (phase 1, 4): so định nghĩa hàm/policy **live** với migration đã
   commit — dùng `node scripts/query-sql.mjs <file.sql>` (đọc PAT từ CLAUDE.local.md).
3. Với thay đổi tiền (phase 3): chạy `node scripts/reconcile-money.mjs` và tự nghĩ
   thêm chỉ tiêu tiền khác để kiểm cap-1000.
4. Với formatter (phase 6): chạy `npx vitest run src/lib/__tests__/currencyFormat.test.ts`
   — snapshot cứng chứng minh output KHÔNG đổi.

## Trạng thái

- **Đã xong + shipped: Phase 1–6.**
- **Chưa làm: Phase 7–10** (dọn route + xoá page chết + xoá 2 BC công nợ; làm lại
  BC Lấp đầy; rút query khỏi component + mổ god-hook; mổ component monolith + dedup
  salary). Xem `../../` plan gốc + RISK-REGISTER §"Còn lại".

## Công cụ mới tạo đợt này (tái dùng về sau)

| Script | Công dụng |
|--------|-----------|
| `scripts/query-sql.mjs` | Chạy SELECT qua Management API, in FULL JSON (khác apply-sql cắt 500 ký tự) |
| `scripts/check-ts-baseline.mjs` | Ratchet lỗi TS (`npm run typecheck:baseline`) |
| `scripts/reconcile-money.mjs` | Đối chiếu SUM SQL vs tổng-1000-dòng-đầu (bắt bug cap-1000) |
| `scripts/check-view-invoker.mjs` | Quét view thiếu `security_invoker=true` (chống lộ tenant) |
| `src/lib/supabaseFetchAll.ts` | `fetchAllRows` — fetch phân trang chống cap-1000 khi cộng tiền |
