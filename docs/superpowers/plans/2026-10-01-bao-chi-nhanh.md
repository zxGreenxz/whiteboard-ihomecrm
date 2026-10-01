# Plan: Trang "Báo chi nhanh" (`/chi-tieu`) — ghi chi bằng tin nhắn, giọng nói, ảnh bill

> Soạn 01/10/2026 · Mã đọc từ `origin/main` (= production `f2712d59`) · Thư mục chính đang chậm ~96 commit ⇒ thi công
> trên **worktree mới từ `origin/main`**, không động vào thư mục chính.

> **Đã đổi khi thi công (chủ chốt 01/10/2026) — phần dưới về máy chủ là thiết kế ban đầu, không còn đúng:**
> - Máy chủ là hàm edge **riêng** `supabase/functions/quick-entry`, không phải nhánh `quick_entry` trong `llm-proxy`;
>   không migration, không đổi `reserve_ai_usage`. Công tắc/chuỗi mô hình/trần lượt là secret `QUICK_ENTRY_*`
>   (xem `supabase/functions/README.md`), không phải cột `ai_copilot_settings` + thẻ quản trị.
> - **Giọng nói chỉ qua OpenRouter** (`gpt-4o-transcribe` đầu chuỗi); bỏ hẳn nhận giọng của trình duyệt
>   (`useSpeechInput` đã xoá). **Đọc chữ/ảnh chỉ qua 9router** (`cx/gpt-6-luna(low)` → `cx/gpt-5.6-luna(low)`).
> - Trang mở bằng đường dẫn, chưa có capability/menu/ô màn hình chính. Mô tả hiện hành: `docs/he-thong/08` mục 5.13.

## 1. Bối cảnh

Chủ muốn một trang giống rollyapp.ai: gõ "bún bò 50k", nói, hoặc chụp bill là ghi xong khoản chi, AI tự phân loại.
Hiện nay ghi một khoản chi công ty phải qua form phiếu chi nhiều ô (toà, sổ quỹ, hạng mục + kỳ áp dụng…); "Tạo phiếu
nhanh" chỉ có trên trang Thu chi điện thoại, cú pháp cứng theo vị trí, không giọng nói/ảnh; "Ví thu chi cá nhân" chỉ là
bảng + 2 biểu đồ; cổng AI chỉ mở cho người được cấp Copilot. Kết quả mong muốn: **một trang nhập nhanh**, mỗi khoản thành
**phiếu chi công ty** (đi đúng bộ máy chi đang áp dụng) hoặc **khoản chi cá nhân**, luôn qua **một thẻ xác nhận**.

## 2. Quyết định đã chốt (01/10/2026)

1. **Cả hai đích**: mỗi khoản chọn Công ty hoặc Cá nhân; Công ty làm trước, Cá nhân dùng chung bộ nhập.
2. **AI cho mọi người** có `income_expenses.create` hoặc `personal_finance.create` — không cần Copilot (sau giai đoạn thử).
3. **Duyệt**: phiếu công ty đi `create_income_expense_v1` + bộ máy chi y như phiếu lập tay; không thêm luật riêng.
4. **Phạm vi gọn**: chỉ nhập. Xem lại/báo cáo ở trang sẵn có (Thu chi, Ví cá nhân, Phân tích tài chính).
5. Tên trang **"Báo chi nhanh"**, đường dẫn **`/chi-tieu`**; ô màn hình chính điện thoại + mục menu Tài chính; giao diện chat.
6. Mỗi khoản một **thẻ nháp sửa được**; bấm **"Lưu"** mới ghi. Không tự lưu.
7. Máy đọc chữ trước (50k, 1tr2, 1 triệu 2, mã toà, số phòng, "hôm qua"); AI lo hạng mục/chỗ mơ hồ và **mọi ảnh**;
   AI hỏng vẫn nhập tay được.
8. **Giọng nói tiếng Việt** (chủ yêu cầu phương án tối ưu, 01/10): chạm mic → **ghi âm ngay trong trang** (≤30 giây) →
   máy chủ chuyển thành chữ bằng **mô hình nhận giọng mạnh tiếng Việt qua OpenRouter** (dùng lại khoá đã có),
   `language=vi` + gợi ý từ vựng (tên toà, hạng mục, "triệu/nghìn/củ/lít") → hiện chữ (sửa được) → bộ đọc máy + AI như
   chữ gõ. Có **chuỗi dự phòng riêng cho giọng nói**, dự kiến `openai/gpt-4o-mini-transcribe` →
   `openai/gpt-4o-transcribe` → Google (Chirp/Gemini transcribe); bước 0 đo trên giọng thật 3 miền rồi mới chốt thứ tự.
   Dự phòng cuối: nhận giọng của trình duyệt (khi máy chủ lỗi, trình duyệt hỗ trợ) và mic bàn phím điện thoại.
   **Không lưu file ghi âm.** Không dựng lại trang thử giọng nói đã cất kho (chỉ chép có chọn lọc bài học ghi âm iPhone).
9. Ảnh bill: AI đọc tổng/cửa hàng/ngày/từng món/kỳ/mã khách hàng. Ảnh khoản **công ty** lưu làm chứng từ phiếu.
   Ảnh khoản **cá nhân**: AI đọc nhưng **không lưu** (kho chứng từ đọc chung trong công ty; lưu riêng để đợt sau).
10. Một bill = một phiếu, nhiều dòng theo hạng mục; một tin nhiều khoản → nhiều dòng; khác **toà hoặc phòng** → tách phiếu.
11. Sổ quỹ tự chọn sổ mình đang giữ (CUSTODIAN) theo toà, nhớ lần trước.
12. Không làm đợt 1: Zalo/Telegram, đa tiền tệ, ví chung, khoản định kỳ, tạm ứng/hoàn ứng, khoản THU, đọc AI file PDF
    (hoá đơn điện tử PDF ⇒ chụp màn hình), bảng "học thói quen" từ khoá→hạng mục.
13. Phát hành: TEST → **giai đoạn thử cho chủ + 1 quản lý, giới hạn bằng quyền Copilot** → mở cho mọi người.
14. **Mô hình AI: ưu tiên `cx/gpt-6-luna`; lỗi thì tự chuyển** sang mô hình kế trong chuỗi có thứ tự
    (cx khác trên 9Router → OpenRouter cuối). Nếu bước thử cho thấy luna đọc sai nhiều ⇒ đổi thứ tự chuỗi.
15. Mô hình `cx/` thêm vào hệ thống **hiện luôn trong danh sách chọn của Copilot**.
16. Bộ bill thử phủ 5 nhóm: **điện nước, ăn uống, thu chi khác, mua vật tư, đơn Shopee** (ảnh chụp màn hình).

## 3. Trang hoạt động thế nào

```
Ô nhập (chữ | mic: ghi âm → llm-proxy /audio/transcriptions → chữ sửa được | ảnh)
  → bộ đọc máy (src/lib/quickEntry)  ──đủ chắc──┐
  → AI qua llm-proxy, feature quick_entry ─────┤ (ảnh: luôn qua AI)
                                               ▼
                         Thẻ nháp (sửa được) ── Lưu ──┬─ Công ty: useCreateIncomeExpense → create_income_expense_v1
                                                      │           (bộ máy chi quyết Đã duyệt / Chờ duyệt)
                                                      └─ Cá nhân: useCreatePersonalTransaction → personal_transactions
```

Luật hợp nhất (để AI không làm sai tiền):
- Số tiền **gõ rõ ràng** do máy đọc thắng AI; ô người dùng đã sửa không bao giờ bị ghi đè.
- AI chỉ trả **chuỗi nhắc** (tên toà, phòng, mã khách hàng) và **chỉ số hạng mục `cN`** trong danh sách gửi đi; ID thật do
  bộ dò cục bộ tra ⇒ AI không bịa được toà/hạng mục.
- "2 bóng đèn 120k" = **tổng 120k** (số lượng 1, mô tả "2 ×"); chỉ "mỗi cái 60k" mới nhân.
- Bill: tổng dòng phải bằng tổng thanh toán; lệch (ship, giảm giá Shopee…) ⇒ gộp **1 dòng = số thực trả** + cờ "kiểm lại".
- **Bill điện nước**: AI đọc **mã khách hàng** + **kỳ** ⇒ tra `building_fee_accounts.provider_code` /
  `building_utility_accounts.provider_code` ra toà + hạng mục (`income_expense_types.fee_category`); kỳ ghi vào
  `start_date/end_date` của dòng (bộ máy chi tính trần điện nước theo kỳ của dòng).
- Thẻ công ty gọi `useVoucherSlotWarning` (`get_voucher_slot_warning_v1`) ⇒ hiện "kỳ này toà X đã có phiếu điện PC…"
  để không trả trùng với trang Thanh toán. Chỉ cảnh báo, không chặn.
- Chống trùng: mỗi thẻ một khoá `qe-<draftId>` cố định; kết quả lưu **không rõ** (rớt mạng) ⇒ **khoá thẻ**, chỉ cho
  "Thử lại y nguyên" (cùng khoá, cùng URL ảnh đã tải) hoặc "Kiểm tra ở Thu chi".
- Trạng thái sau lưu hiển thị đúng phiếu máy chủ trả về (`createdVoucherFeedback`): mã PC…, Đã duyệt / Chờ duyệt.

## 4. Cổng AI phía máy chủ (`quick_entry`)

**Đã kiểm trên `origin/main`:** `reserve_ai_usage` chỉ nhận `chat|ui_control` và đòi quyền Copilot
(`20260903034632_copilot_daily_token_cap_v1.sql:104,139-152`); proxy gán mọi header khác thành `chat`
(`supabase/functions/llm-proxy/index.ts:772`), không thử lại (`:5`), trần 512 KiB/4 ảnh (`:254-256`), đường non-stream
ghi 0 token khi upstream thiếu `usage` (`:1159`). Cột `ai_usage_logs.feature` là text tự do — không ràng buộc chặn.

**Cài đặt mới** trên `ai_copilot_settings`:
- `quick_entry_mode` `off | pilot | all` (mặc định `off`) — công tắc khẩn + cổng thử.
- `quick_entry_models text[]` — **một chuỗi có thứ tự** cho cả chữ và ảnh (≤5, không trùng, dạng `provider:model`);
  mô hình không nhận ảnh sẽ báo lỗi và tự nhảy mô hình kế. Gieo sẵn theo kết quả bước 0, dự kiến:
  `9router:cx/gpt-6-luna(<effort>)` → `9router:cx/gpt-6-sol(<effort>)` → `9router:cx/gpt-5.6-luna(<effort>)` →
  `openrouter:<mô hình nhận ảnh>`.
- `quick_entry_stt_models text[]` — **chuỗi riêng cho giọng nói** (mô hình nhận giọng khác mô hình chat), dự kiến
  `openrouter:openai/gpt-4o-mini-transcribe` → `openrouter:openai/gpt-4o-transcribe` → `openrouter:<Google
  Chirp/Gemini transcribe>`; id chính xác và thứ tự chốt ở bước 0.
- `quick_entry_daily_calls_user int` (mặc định 150 lượt/người/ngày — một lần nói tốn 2 lượt: nghe + đọc).

**Hàm quyền mới** `app_private.quick_entry_allowed_v1(p_user, p_org) → boolean` — chép khuôn
`app_private.has_any_scope_v3` (`20260725100000:57-140`) nhưng nhận `p_user`, chỉ 2 khoá `income_expenses.create`,
`personal_finance.create`; giữ đủ 3 vế (emergency deny, DENY toàn org, ≥1 ALLOW đúng loại phạm vi); không khoá dòng nên
STABLE an toàn; REVOKE khỏi PUBLIC/anon/authenticated/service_role. **Không dùng** `authorize_tenant_action_v3`:
thiếu toà nó từ chối quản lý theo toà (`20260725210000:11-13`) và khoá dòng org dưới khoá ngày toàn cục của AI.

**`reserve_ai_usage`** (giữ nguyên chữ ký 7 tham số + kiểu trả về; CREATE OR REPLACE từ thân `20260903034632`):
- `quick_entry` được nhận; bắt buộc task id dạng `qe:<uuid>` (proxy tự sinh).
- mode `off` ⇒ `quick_entry_disabled`; mô hình ngoài chuỗi ⇒ `quick_entry_model_mismatch`.
- mode `pilot` ⇒ phải có dòng `ai_copilot_entitlements` bật chat (hoặc super admin); `all` ⇒ bỏ đòi Copilot.
- Quyền = super admin hoặc `quick_entry_allowed_v1` ⇒ ngược lại `not_permitted` (kiểm trước khoá toàn cục).
- Hạn mức tính theo **lượt người dùng** (đếm `task_id` khác nhau), không theo số lần thử mô hình: rate/phút, trần
  ngày ⇒ `quick_entry_daily_cap`; ≤5 lần thử/task ⇒ `quick_entry_attempts_exhausted`. Trần USD/token giữ nguyên
  (token đếm mọi lần thử — đúng tiêu hao thật).

**llm-proxy** (một file `index.ts`; nhánh `chat/ui_control` giữ nguyên từng byte, có test khẳng định):
- Nhánh `xuLyQuickEntry()`: ép `stream:false`, ≤4 message, **≤1 ảnh**, bỏ `tools/tool_choice/temperature/top_p`,
  kẹp `max_tokens` (số chốt ở bước 0); **bỏ qua `body.model`**, lấy chuỗi từ cài đặt.
- Ảnh vẫn trong trần 512 KiB nhờ thang nén phía máy (1600→1400→1280 px, JPEG 0.75→0.6, ≤~380 KB). Chỉ nâng trần
  riêng cho `quick_entry` nếu bước 0 chứng minh cần.
- **Chuỗi dự phòng**: mỗi lần thử = 1 reservation (ledger đúng từng mô hình) + 1 finalize (có `finally` lưới an toàn).
  Chuyển mô hình kế khi: lỗi kết nối/timeout, 408/409/425/429/5xx/52x, 401/403 upstream (vd "invalidated oauth
  token"), 404 hoặc 400 nói model/ảnh/response_format không hỗ trợ, 200 mà rỗng/không phải JSON. Dừng ngay khi lỗi
  thuộc người dùng (quyền, rate, hạn mức, org). Bỏ qua (không reserve) mô hình của provider tắt/thiếu khoá — đúng
  trường hợp TEST không có 9Router. Hết chuỗi ⇒ 502 `quick_entry_all_failed`.
- Trả header `x-quick-entry-model/-index/-attempts` + `Access-Control-Expose-Headers`; nhận header
  `x-quick-entry-skip` (thêm vào CORS) để client thử lại mô hình kế **một lần** khi JSON trả về không qua zod.
- Thiếu `usage` ⇒ ước token như đường stream (`:1003-1050`), không ghi 0.
- Client gửi `model: "quick_entry:auto"` ⇒ proxy cũ (nếu phải lùi) trả lỗi thay vì lặng lẽ chạy như chat.
- **Đường giọng nói mới** `POST …/llm-proxy/audio/transcriptions` (chỉ feature `quick_entry`): nhận JSON
  `{format: webm|mp4|m4a|ogg|wav, data: base64}`, ≤30 giây, ≤~400 KB thô (vừa trần 512 KiB); chuyển tới OpenRouter
  `POST /api/v1/audio/transcriptions` với `language: "vi"`, mô hình lấy từ `quick_entry_stt_models`, gợi ý từ vựng
  (tên toà + hạng mục của org, gửi kèm request nếu nhà cung cấp nhận — bước 0 kiểm), xin nhà cung cấp **không giữ dữ
  liệu** (`provider.data_collection: "deny"` nếu OpenRouter hỗ trợ cho audio). Cùng luật dự phòng/hạn mức/ledger như
  trên; chi phí lấy `usage.cost` OpenRouter trả về. **Không lưu, không ghi log nội dung âm thanh hay bản chữ.**
  Kiểm lại ở bước 0: 9Router có mô hình nhận giọng chưa (trước đây danh sách rỗng) — có thì thêm vào chuỗi.

**Danh sách mô hình** (`ai_providers.models`, trigger `validate_ai_provider_pricing_v1`): migration riêng **chỉ thêm**
id còn thiếu cho dòng 9router (`self_hosted`, giá 0, đúng hậu tố effort) và cho dòng openrouter (mô hình nhận giọng +
1 mô hình nhận ảnh dự phòng, `metered` đúng giá), giữ `default_model`, **no-op khi không có dòng tương ứng**
(Restore Drill chạy trên DB rỗng); đồng bộ `tooling/copilot-provider-catalog.json`; sửa
`scripts/__tests__/copilot-vps-gemini-migration.test.mjs` chỉ so tập `ag/`. Các mô hình này hiện luôn trong Copilot.

**Trang quản trị AI**: thẻ `src/copilot/admin/QuickEntrySettingsCard.tsx` trong `SettingsTab`
(`AiCopilotAdminPage.tsx`) — chọn mode, sắp xếp chuỗi (thêm/bớt/lên/xuống, chỉ mô hình đang bật), trần ngày.
Đây cũng là **công tắc tắt khẩn trong vài giây**.

## 5. Các bước thi công

Worktree mới từ `origin/main` (junction `node_modules`; gỡ junction trước khi xoá worktree). Commit
`feat(chi-tieu): …`, stage đúng file, trailer theo CLAUDE.md. PR tiền/quyền/migration ⇒ draft PR + review chéo.
PR-1 chép plan này vào `docs/superpowers/plans/2026-10-01-bao-chi-nhanh.md` để có bản lưu trong repo.

### Bước 0 — Thử nghiệm (không ghi production)
- **0a dò khả năng**: script cục bộ đọc khoá 9Router/OpenRouter từ vault (không in ra), gọi thẳng
  `https://ai.chillhome.io.vn/v1`: hậu tố effort `(low|medium)` có nhận không, ảnh data URL, `response_format`,
  `usage` có trả không, tỷ lệ `finish_reason=length` ở 1024/2048 token, hình dạng lỗi (model sai, 429, oauth hỏng).
- **0b đo độ chính xác** với prompt/schema của Bước 1: 15–20 bill phủ 5 nhóm (điện nước, ăn uống, thu chi khác, vật tư
  viết tay, Shopee) + ~60 câu gõ/nói. Nguồn ảnh: **chủ gửi**; muốn dùng ảnh chứng từ có sẵn trên production thì lúc đó
  **xin phép một câu** (lệnh đọc production đang bị chặn). So `cx/gpt-6-luna(low|medium)` với `cx/gpt-6-sol`,
  `cx/gpt-6.1-sol`, `cx/gpt-5.6-luna` và 1–2 mô hình OpenRouter; ảnh 1024/1280/1600 px.
- **Ngưỡng đạt** (đề xuất): tổng bill in ≥95% đúng tuyệt đối, viết tay ≥80%, JSON hợp lệ ≥98%, p95 ≤6 s (chữ) /
  ≤15 s (ảnh). Luna trượt ⇒ đổi thứ tự chuỗi.
- **0c đo nhận giọng tiếng Việt**: ~40 câu ghi âm thật bằng chính trang thử (anh + 2 nhân viên, giọng **Bắc/Trung/Nam**,
  trong phòng và ngoài đường), mỗi câu có số tiền (nói chữ: "một trăm hai mươi nghìn", "một củ hai", "năm chục", "ba
  lít"), tên toà, số phòng. So: `openai/gpt-4o-mini-transcribe`, `openai/gpt-4o-transcribe`, Google Chirp 3 / Gemini
  transcribe, Whisper large-v3 (mốc rẻ), nhận giọng trình duyệt (Chrome Android); tuỳ chọn FPT.AI (chuyên tiếng Việt, dùng
  thử 60 phút miễn phí/năm, ~540–700đ/phút) nếu anh muốn mở tài khoản. Định dạng thật từ iPhone (mp4/aac) và Android
  (webm/opus) phải được nhận thẳng. **Thước đo chính: số tiền đúng tuyệt đối sau bộ đọc ≥95%**, tên toà/phòng đúng,
  tỷ lệ sai từ, p95 ≤3 giây cho câu 10 giây, chi phí/câu (ước ~15đ với gpt-4o-mini-transcribe).
- Các câu nói thu được giữ làm bộ mẫu cho test bộ đọc (chỉ giữ bản chữ đã gỡ thông tin cá nhân, không giữ âm thanh).
- Kết quả: `docs/superpowers/plans/2026-10-xx-bao-chi-nhanh-thu-nghiem.md` (thứ tự chuỗi, cỡ ảnh, `max_tokens`, khoá
  body bị bỏ, mẫu lỗi kích hoạt dự phòng). Không đưa ảnh/dữ liệu cá nhân vào git.

### Bước 1 — Thư viện thuần `src/lib/quickEntry/` (PR-1, chưa nối vào app)
- `amount.ts`: "50k", "50 nghìn/ngàn", "1tr2" (=1,2tr), "1tr25", "1tr200", "1 triệu 2", "1,2tr", "1.200.000",
  "1 200 000", "120000đ/vnd", "2 triệu rưỡi", "trăm rưỡi"; số trần <1000 = nghìn (khớp `parseQuickAmount`), ≥1000 = đồng
  (cảnh báo nếu <10.000); không bao giờ ăn số phòng ("p301", "P.301", "phòng 301").
  **Số nói bằng chữ** (bản chữ từ giọng nói): "một trăm hai mươi nghìn", "hai mươi mốt/tư/lăm", "mười lăm", "linh/lẻ",
  "năm chục (nghìn)", "một củ hai" (=1,2 triệu), "ba lít/xị" (=300 nghìn), "rưỡi", "tỷ"; ghép được kiểu lai
  "1 triệu hai trăm".
- `dateWords.ts` (dùng `vnTodayISO` từ `src/lib/vnDate.ts`): hôm nay/qua/kia, "ngày 25", "25/9[/2026]", "tối qua";
  không tự ra ngày tương lai. Kỳ "tháng 9" ⇒ start/end tháng đó.
- `segment.ts`: tách theo xuống dòng, ";", "và", "+", dấu phẩy không nằm giữa chữ số; toà/phòng/ngày nói một lần áp
  cho cả câu.
- `resolve.ts`: dùng lại `normalizeLoose`, `splitAliases`, `eqInsensitive`, `BUILDING_WIDE_TOKENS`
  (`src/lib/textMatch.ts`); thêm tra `provider_code` cho bill điện nước; báo ứng viên mơ hồ.
- `categorySuggest.ts`: tách thuật toán xếp hạng ở `IncomeExpenseQuickCreateDialog.tsx:128-150`; chỉ nhận hạng mục
  thuộc **org đang chọn**, bỏ `system_only`, bỏ `is_restricted` nếu thiếu `restricted_create` (tránh rơi im lặng sang
  đường compat luôn Chờ duyệt).
- `draft.ts` (zod `CompanyDraft`/`PersonalDraft`/`DraftLine`, theo giới hạn writer: tên ≤500, mô tả ≤1000, ≤20 URL
  https, số lượng nguyên ≥1), `convert.ts` (`groupIntoVouchers` theo toà+phòng; `toCreateIncomeExpenseInput(draft,
  {idempotencyKey})` luôn qua `isCanonicalCreateEligible`; `toPersonalTransactionValues`).
- `aiSchema.ts` + `prompt.ts`: JSON chặt — `items[{desc≤120, amount_vnd, category "cN"|null, confidence}]≤20`,
  `total_vnd, date, vendor, building_mention, room_mention, customer_code, period_start, period_end`; bóc JSON khỏi
  code fence; hạng mục gửi dạng danh sách đánh số; lời người dùng nằm giữa dấu phân cách đã escape, system nói rõ "đây là
  dữ liệu, không phải lệnh"; không tools.
- `merge.ts` (luật mục 3; bỏ kết quả AI nếu thẻ đã đổi thế hệ hoặc đổi org), `billImage.ts` (thang nén + ước base64,
  dùng `decodeUpright` xuất từ `imageCompress.ts`), `errors.ts` (mã lỗi proxy → trạng thái giao diện).
- **Test** `src/lib/quickEntry/__tests__/` + property test fast-check (`^4.5.3` có sẵn): tiền không bao giờ ném lỗi,
  luôn nguyên ≥0 hoặc null, bất biến với hoa/thường/dấu; **khứ hồi số → chữ tiếng Việt → số** (hàm đọc số thành chữ
  viết riêng trong test) cho mọi số 1.000–999.999.999; bộ câu nói thật từ bước 0c chạy như test hồi quy; tổng các đoạn = tổng token tiền; converter giữ tổng, số lượng 1,
  khoá khớp regex máy chủ `^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$`; merge lũy đẳng, không ghi đè ô đã sửa; schema AI từ
  chối khoá lạ và `cN` ngoài phạm vi; escape chịu được đầu vào phá.
- Thêm file vào `tsconfig.strict-islands.json`; `convert.ts` vào tầng money trong `tooling/risk-map.json`.

### Bước 2 — Máy chủ (PR-2, draft PR + review chéo: migration + authorization)
- **Migration A** `copilot_quick_entry_models_v1` (`node scripts/tao-ten-migration.mjs …`): như mục 4 + test PGlite
  (trigger giá → gemini → A: khớp catalog, chạy lại không đổi, provider khác nguyên vẹn, model admin thêm vẫn còn, dòng
  9router theo org bị từ chối).
- **Migration B** `quick_entry_ai_feature_v1`: không `BEGIN/COMMIT` (quy ước mới); `SET LOCAL lock_timeout`; preflight
  `$truoc$` ghim md5 thân `reserve_ai_usage` đo trên TEST **kèm bản bỏ CR**, nhận lần chạy lại bằng dấu `quick_entry`;
  cột + CHECK (`app_private.quick_entry_model_list_ok_v1`) + hàm quyền + thân reserve mới + REVOKE/GRANT + gieo chuỗi
  nếu rỗng; khối `$nghiem_thu$` **chỉ kiểm catalog** (chạy được trên DB rỗng). Test tĩnh
  `src/lib/__tests__/quickEntryReserveMigration.test.ts` dùng `liveDefinitionOf()`.
- **Diễn tập khôi phục cục bộ** (PG17 sẵn trên máy, không Docker): `dien-tap-khoi-phuc-baseline.mjs` +
  `dien-tap-forward-lane.mjs --moc origin/main` ⇒ hai migration chạy sạch.
- **Bộ kiểm SQL trên TEST** `scripts/tests/test-quick-entry-reserve.sql` (áp bằng `npm run test-env:thu-sql -- <file>
  --ghi`, mọi ca trong ROLLBACK): mode off; quản lý chỉ có quyền theo toà, không Copilot ⇒ được; chỉ có
  `personal_finance.create` ⇒ được; thành viên không quyền ⇒ `not_permitted`; emergency deny / DENY toàn org ⇒ chặn; org
  khác ⇒ `organization_forbidden`; pilot có/không entitlement; mô hình ngoài chuỗi; trần ngày + lần thử anh em không
  bị đếm; 5 lần thử/task; chat/ui_control không đổi; gọi bằng authenticated ⇒ bị từ chối; **đối chiếu**
  `quick_entry_allowed_v1` với `get_my_permissions_v2` cho mọi thành viên DEMO + org thật ⇒ 0 lệch.
- **Proxy** + test Deno (`supabase/functions/llm-proxy/index.test.ts`, `adminGia` mở rộng theo tên bảng): ánh xạ
  feature; >1 ảnh ⇒ 400 trước reserve; model lấy từ cài đặt; 503 rồi thành công ⇒ 2 reservation cùng task
  (`upstream_error` + `ok`), header index 1; 401 oauth ⇒ chuyển, 400 thường ⇒ dừng; hết hạn mức ⇒ dừng; provider
  thiếu khoá ⇒ bỏ qua không reserve; skip header bị chặn biên; ngân sách thời gian tổng; huỷ ⇒ dừng; thiếu usage ⇒ ước;
  mỗi reservation finalize đúng 1 lần; CORS; chat không bao giờ đọc `ai_copilot_settings`. **Đường giọng nói**:
  sai định dạng/quá 30 giây/quá cỡ ⇒ 400 trước reserve; mô hình lấy từ `quick_entry_stt_models`; lỗi mô hình đầu ⇒
  chuyển mô hình kế; `language: "vi"` luôn gửi; chi phí lấy từ `usage.cost`; không log nội dung.
- Thẻ quản trị `QuickEntrySettingsCard.tsx` + test; `src/copilot/copilotConfig.ts` cho feature `'quick_entry'`.
- **Đột biến** (`scripts/dot-bien.mjs`, nhớ 3 bẫy đã biết): bỏ kiểm quyền ⇒ bộ kiểm SQL + test tĩnh phải đỏ; bỏ "dừng
  khi hết hạn mức" ⇒ Deno đỏ; skip header không chặn biên ⇒ Deno đỏ.
- Gate: `provenance:generate` (sau khi stage), `gate:migration-provenance`, `check-forward-migration-idempotent`,
  `gate:stable-fn-locks`, `gate:definer-body-authz`, `gate:migration-test-liveness`, `gate:copilot-provider-policy`,
  `deno check` + test, `gate:truoc-push`, chuỗi số đếm tài liệu (inventory → docs-views → doc-counts --fix).

### Bước 3 — Sửa chung phía app (PR-3a, tầng money)
1. `src/hooks/income-expenses/types.ts:188`: `CreateIncomeExpenseInput` thêm `idempotency_key?`; `mutations.ts:95`
   dùng `input.idempotency_key ?? \`ie-create-${uuid}\``; xuất `isCanonicalCreateEligible`. Test truyền khoá, vắng ⇒
   ngẫu nhiên như cũ, 23505 không phải tín hiệu fallback; đột biến; chạy tay `gate:reconcile-money` (CI không chạy được).
2. **Vá lỗi ví cá nhân**: `useCreatePersonalTransaction` (`src/hooks/usePersonalTransactions.ts`) dùng
   `FinancialWorkflowGuard` với khoá cố định `'create'` và **không có `reconcile`** ⇒ một lần lưu không rõ kết quả
   chặn mọi khoản cá nhân sau đó trên máy đó. Thêm `reconcile`: tìm dòng của chính mình tạo sau `pending.startedAt`
   cùng loại/tiền/ngày/danh mục/mô tả ⇒ nhả khoá. Test + đột biến.
3. `IncomeExpenseType` thêm `system_only?`; xuất `decodeUpright` từ `src/lib/imageCompress.ts` (không đổi hành vi);
   chuyển danh mục cá nhân `CATEGORIES` (`PersonalTxnDialog.tsx:22`) sang `src/lib/personalCategories.ts`.

### Bước 4 — Trang (PR-3b)
- **Hooks** `src/hooks/quick-entry/`:
  - `useQuickEntryRefs`: org (`useOrganization`), quyền (`useMyPermissions` + `canUse`), toà/phòng
    (`useIncomeExpenseFormBuildings`, `useIncomeExpenseFormRooms`), hạng mục (`useIncomeExpenseTypes('expense')` lọc
    như Bước 1), sổ quỹ (giao `useCustodianCashbooksV2` với `useAccounts` theo org, bỏ sổ ảo — khuôn
    `SettlementLifecycleModal.tsx:195-219`; ưu tiên `quick_default_building_id`, rồi sổ dùng lần trước), danh mục cá
    nhân, tình trạng AI (mode + entitlement khi pilot).
  - `useVoiceRecorder` (đường chính): MediaRecorder, thứ tự định dạng `audio/webm;codecs=opus` → `audio/mp4` →
    `audio/webm` → `audio/ogg;codecs=opus` (iPhone cũ ra mp4/aac, Safari 18.4+ và Android ra webm/opus); khử vọng + lọc
    ồn; **chạm để nói, chạm lần nữa để gửi**, tự dừng ở 30 giây, nút huỷ, đồng hồ đếm; chỉ chạy HTTPS; thông báo dễ hiểu
    khi bị từ chối quyền mic; giải phóng mic khi rời trang. Chép có chọn lọc từ `useVoiceTaskLabRecorder.ts` (tag
    `archive/voice-task-lab-20260930`) và `src/components/chat-zalo/composer/VoiceRecorder.tsx`.
  - `useTranscribe`: gửi âm thanh base64 tới `/audio/transcriptions`, huỷ sau 45 giây, trả bản chữ ⇒ hiện thành bong
    bóng của người dùng (chạm để sửa) rồi chạy bộ đọc như chữ gõ. Âm thanh bỏ khỏi bộ nhớ ngay sau khi gửi.
  - `useSpeechInput` (dự phòng): Web Speech API vi-VN, chỉ dùng khi đường máy chủ tắt/lỗi và trình duyệt hỗ trợ; nếu
    cả hai không được (vd app màn hình chính iPhone) ⇒ gợi ý mic bàn phím.
  - `useQuickEntryAi`: dựng prompt, POST non-stream qua wrapper của `copilotConfig.ts`, huỷ sau 60 s, zod, thử lại 1
    lần với skip header, bỏ kết quả cũ (thế hệ/org).
  - `useQuickEntrySave`: Công ty — tải ảnh **một lần** bằng `uploadFileDetailed('income-expense-attachments',
    \`${uid}/…\`)` (giữ URL trên thẻ) rồi `useCreateIncomeExpense` với khoá `qe-<draftId>`; Cá nhân —
    `useCreatePersonalTransaction`. Trạng thái: đang lưu / đã lưu (mã + trạng thái) / **không rõ (khoá thẻ)** /
    23505 "có thể đã lưu" / bị từ chối.
- **Thành phần** `src/components/quick-entry/`: `QuickEntryComposer` (ô chữ tự giãn, mic, camera/thư viện
  `accept="image/*" capture="environment"`, dán ảnh trên máy tính qua `useClipboardImagePaste`), `QuickEntryFeed`,
  `DraftCard` + `CompanyDraftFields` (`CurrencyInput` lớn có nhãn "AI đọc", dòng, sheet chọn hạng mục, toà kể cả toà
  "Chung" + phòng/"Cả toà", sổ quỹ, `DateInput` + chip Hôm nay/Hôm qua, ảnh "lưu làm chứng từ", cảnh báo trùng kỳ) /
  `PersonalDraftFields` (danh mục cá nhân, ảnh "chỉ để AI đọc, không lưu"), `ModeToggle` (nhớ theo người dùng;
  `?che-do=ca-nhan|cong-ty`; nhắc toà/phòng ⇒ gợi ý Công ty; chỉ có một quyền ⇒ cố định), `SavedReceipt`.
- **Trang** `src/pages/quick-entry/QuickEntryPage.tsx`: tự rẽ theo quyền; điện thoại (`usePhoneViewport`) dùng khung
  `.cm-stage/.cm-app` của `src/styles/mobileApp.css` + `visualViewport`/safe-area để ô nhập không bị bàn phím che; máy
  tính là cột giữa trong `MainLayout`. Thẻ nháp (chỉ chữ) lưu localStorage theo người+org 48 giờ (iPhone hay tải lại
  trang sau khi mở camera), bọc try/catch, xoá khi đăng xuất. Lazy qua `src/app/lazyPages.ts`.
- **Nối dây**: route `<ProtectedRoute><QuickEntryPage/></ProtectedRoute>` trong nhóm route tài chính; registry
  `src/app/capabilities/registry.ts` capability `chi-tieu` — `release.enabled:false` tới lúc mở rộng, `permission`
  `income_expenses.create` + `guardMienTruVi` (một chuỗi nháy kép, khuôn mục `salary` ~281-305) vì trang phục vụ hai
  nhóm quyền, `systemDoc` 08, `userDoc` mới, `risk:"financial"`, `e2e.spec`; thêm `/chi-tieu` vào
  `COPILOT_PAGE_EXEMPTIONS` + tăng số route 112→113 ở `scripts/check-copilot-page-contracts.mjs`; `Sidebar.tsx`
  `navFieldsFor('chi-tieu')`; `src/pages/home/launcherTiles.ts` `launcherFieldsFor('chi-tieu')`; `Breadcrumbs.tsx`;
  nút "Nhập nhanh" trên `PersonalWalletPage.tsx` → `/chi-tieu?che-do=ca-nhan` (cùng cờ phát hành); file mới vào
  strict islands; đường dẫn chạm tiền vào `risk-map.json`.
- **Test jsdom** (luôn mock `@/integrations/supabase/client` — worktree `.env` trỏ production): `MediaRecorder` giả
  (chọn đúng định dạng, dừng ở 30 giây, huỷ, từ chối quyền), `SpeechRecognition` giả;
  proxy giả cho từng lớp lỗi + thử lại; lưu với kết quả không rõ / 23505 / thành công; kiểm hợp lệ thẻ; đổi chế độ.
- Gate: `gate:route-guards`, `gate:route-permission-drift`, `gate:capability-surfaces`, `gate:capability-docs`,
  `check-copilot-page-contracts`, `gate:bundle`, `typecheck:e2e`, `gate:truoc-push`.

### Bước 5 — Tài liệu
- `docs/he-thong/08-thu-chi-so-quy.md` mục mới "`/chi-tieu` — Báo chi nhanh" (đích ghi, khoá chống trùng + khoá thẻ,
  đường compat và cách hiện trạng thái, ảnh công ty lưu / ảnh cá nhân không lưu, rẽ quyền, cảnh báo trùng kỳ).
- `docs/he-thong/21-ai-copilot.md`: feature `quick_entry` (cả đường chat/ảnh lẫn đường giọng nói
  `/audio/transcriptions`), hai chuỗi dự phòng (ngoại lệ có phạm vi của luật "Copilot không tự
  đổi mô hình"), cổng/hạn mức, sổ tay vận hành (tắt mode, đổi thứ tự chuỗi, SQL xem tỷ lệ dự phòng), thứ tự phát hành.
- Cập nhật `reviewed` trong `docs/he-thong/manifest.json`; hướng dẫn người dùng
  `docs/huong-dan-su-dung/03-quan-ly-van-hanh/bao-chi-nhanh/index.md` (ghi rõ chuyện giọng nói/ảnh đi đâu) + mục trong
  `docs-site/.vitepress/sidebar.mts`; `docs:check`, `gate:copilot-docs`.

### Bước 6 — E2E và môi trường TEST
- Spec `.e2e-fleet/specs/bao-chi-nhanh-mobile.spec.ts` (Chromium khung Pixel 7, `login('quanly')`, chỉ ghi org DEMO,
  proxy giả ở trình duyệt bằng `page.route`): gõ → thẻ → Lưu (kiểm phản hồi `create_income_expense_v1` + biên nhận);
  chế độ cá nhân; **ghi âm bằng mic giả của Chromium** (`--use-fake-device-for-media-stream
  --use-fake-ui-for-media-stream --use-file-for-fake-audio-capture=<câu mẫu .wav>`) → đường `/audio/transcriptions` giả
  → bong bóng chữ → thẻ; nhận giọng trình duyệt giả bằng `addInitScript` cho nhánh dự phòng; AI tắt (403) vẫn nhập tay; zod hỏng ⇒ thử lại có
  skip header; ảnh qua `setInputFiles` rồi tải lên. Dọn: huỷ phiếu, xoá khoản cá nhân + file vừa tải. Bắt lỗi console.
- WebKit khung iPhone 13: chỉ bố cục/tràn + nhập tay (Safari không WebP; `page.route` không chặn được upload Storage).
- Trên TEST: chạy spec với `FLEET_BASE_URL` = web test-env (`FLEET_WORKERS=1`); khói sống qua proxy TEST với mắt xích
  OpenRouter (`npm run test-env:edge -- llm-proxy`; TEST không có khoá 9Router ⇒ kiểm luôn nhánh "bỏ qua provider
  thiếu khoá") bằng tài khoản `testquanly`, `testchu`.

### Bước 7 — Phát hành và đường lùi
1. Gộp PR-1. PR-2 kiểm trên TEST.
2. Production theo thứ tự bắt buộc: **deploy proxy** (`scripts/deploy-llm-proxy-manifest.mjs` +
   `node scripts/deploy-llm-proxy.mjs --release-sha <sha>`; an toàn vì chat không đổi, `quick_entry` trả lỗi khi chưa có
   cột) → `migrate:forward` A → `migrate:forward` B (mode vẫn `off`) → `gen:types` + `types:normalize` +
   `types:check` → **promote web** (`npm run promote:production -- --sha <40 ký tự>`; kiểm Vercel READY + bundle).
   **Lệnh `migrate:forward` cần chủ ra lệnh thẳng** (harness chặn nếu không).
3. Trang quản trị AI: kiểm chuỗi migration đã gieo, bật mode `pilot`; cấp Copilot cho tài khoản chủ công ty `nguyentam` + 1 quản lý. Thử 3–7
   ngày, theo dõi `ai_usage_logs` (feature `quick_entry`: tỷ lệ dự phòng, độ trễ), trạng thái phiếu tạo ra (khoá `qe-%`
   trong `canonical_write_operations`).
4. Mở rộng: mode `all` + bản web `release.enabled:true` + đăng hướng dẫn.
5. **Lùi**: tắt mode ở trang quản trị (vài giây — nhập tay vẫn chạy) → ẩn trang (`release.enabled:false`) → deploy lại
   proxy SHA cũ → migration tiến phục hồi thân `reserve_ai_usage` của `20260903034632` (phục hồi hàm trước khi bỏ cột).

## 6. Dùng lại, không viết mới

| Cần | Có sẵn |
|---|---|
| Ghi phiếu chi đúng bộ máy | `useCreateIncomeExpense` (`src/hooks/income-expenses/mutations.ts`) → `create_income_expense_v1` |
| Ghi khoản cá nhân | `useCreatePersonalTransaction` (`src/hooks/usePersonalTransactions.ts`) |
| Đọc số tiền "k", dò toà/phòng | `parseQuickAmount` (`src/lib/incomeExpenseQuickInput.ts`), `src/lib/textMatch.ts` |
| Xếp hạng hạng mục, chọn sổ mặc định | `IncomeExpenseQuickCreateDialog.tsx:128-150, 166-175` |
| Toà/phòng/sổ được phép | `useIncomeExpenseFormScope.ts`, `useCustodianCashbooksV2`, `useAccounts` |
| Cảnh báo trùng kỳ | `useVoucherSlotWarning` (`get_voucher_slot_warning_v1`) |
| Nén ảnh iPhone, tải ảnh | `compressImage`/`decodeUpright` (`src/lib/imageCompress.ts`), `uploadFileDetailed` (`src/lib/storage.ts`) |
| Thông báo kết quả phiếu | `createdVoucherFeedback`, `voucherFailureMessage` (`src/lib/voucherFeedback.ts`) |
| Gọi AI có hạn mức, sổ dùng | `llm-proxy` + `reserve/finalize_ai_usage`; wrapper `src/copilot/copilotConfig.ts` |
| Ô tiền, ô ngày, dán ảnh | `CurrencyInput`, `DateInput`, `useClipboardImagePaste` |
| Khung điện thoại | `usePhoneViewport`, `src/styles/mobileApp.css` |
| Mã khách hàng điện nước theo toà | `building_fee_accounts.provider_code`, `building_utility_accounts.provider_code` |
| Ghi âm trên iPhone/Android | Bài học `useVoiceTaskLabRecorder.ts` (tag lưu trữ), `chat-zalo/composer/VoiceRecorder.tsx` |
| Khoá AI nhận giọng | `OPENROUTER_API_KEY` đã có trong secrets Supabase (không cần tài khoản mới) |

## 7. Kiểm chứng end-to-end

- `npx vitest run src/lib/quickEntry src/hooks/quick-entry src/components/quick-entry` + các test sửa chung — xanh.
- Deno: `supabase/functions/llm-proxy/index.test.ts` xanh, `deno check` sạch.
- PGlite migration A; test tĩnh migration B; diễn tập khôi phục cục bộ sạch; bộ kiểm SQL trên TEST đủ ca, đối chiếu quyền
  0 lệch.
- Đột biến: mọi ca "ĐẠT" (không ca "MÙ").
- E2E Chromium + WebKit trên TEST xanh, 0 lỗi console; khói sống qua proxy TEST trả `x-quick-entry-model`.
- Thử tay trên điện thoại thật (Android Chrome + iPhone Safari **và** iPhone dạng app màn hình chính): gõ, nói (giọng
  3 miền, có tiếng ồn), chụp 5 nhóm bill; lưu công ty (thấy PC… đúng
  trạng thái duyệt bộ máy chi quyết) và cá nhân (thấy trong Ví cá nhân).
- `gate:truoc-push` xanh trước mỗi lần push; CI 3/3 xanh trước promote.

## 8. Rủi ro và cách chặn

| Rủi ro | Cách chặn |
|---|---|
| AI đọc sai số tiền | Số gõ do máy đọc thắng; nhãn "AI đọc" + ảnh cạnh ô tiền; cảnh báo tổng≠dòng, số lớn; ngưỡng đạt bước 0; luôn bấm Lưu |
| Phiếu trùng | Khoá cố định mỗi thẻ; khoá thẻ khi kết quả không rõ; gửi lại y nguyên; cảnh báo trùng kỳ |
| Rơi sang đường compat (luôn Chờ duyệt, bỏ qua bộ máy) | Lọc hạng mục theo org, bỏ `system_only`/hạn chế; sổ CUSTODIAN trước; hiện đúng trạng thái trả về |
| 9Router chết / oauth hỏng | Chuỗi dự phòng có OpenRouter cuối; đổi thứ tự ở trang quản trị; log dự phòng; nhập tay không bao giờ bị chặn |
| Nhận giọng tiếng Việt sai số tiền/tên toà | Mô hình mạnh tiếng Việt qua máy chủ + `language=vi` + gợi ý từ vựng; bộ đọc số nói bằng chữ; bản chữ hiện ra sửa được trước khi thành thẻ; đo giọng 3 miền ở bước 0 |
| iPhone app màn hình chính không có nhận giọng của trình duyệt | Đường chính là ghi âm + máy chủ (chạy được cả ở app màn hình chính); dự phòng mic bàn phím |
| Riêng tư giọng nói | Âm thanh chỉ đi qua proxy tới nhà cung cấp, xin không giữ dữ liệu, không lưu/không log ở mình; ghi rõ trong hướng dẫn |
| Chi phí nhận giọng | ~15đ/câu 10 giây; trần lượt/ngày; theo dõi hạn mức khoá OpenRouter ($5) và nạp thêm khi cần |
| Riêng tư ảnh cá nhân | Không lưu, không ghi log nội dung; báo rõ trên thẻ |
| Lạm dụng chi phí AI | mode/pilot; trần lượt/ngày; ≤5 lần thử/lượt; task id do máy chủ cấp; 1 ảnh; kẹp token; không tools |
| Chèn lệnh qua lời người dùng/ảnh | Không tools; chỉ JSON + zod chặt; ID chỉ từ bộ dò cục bộ; hạng mục theo chỉ số; người dùng xác nhận |
| Khoá toàn cục của AI dài hơn | Kiểm quyền trước khoá; đo p95 reserve trên TEST |
| Trả trùng bill điện nước với trang Thanh toán | Cảnh báo trùng kỳ + trần điện nước của bộ máy chi đẩy phiếu vượt về Chờ duyệt |

## 9. Cần chủ làm · chưa xác minh

- **Gửi 15–20 ảnh bill** theo 5 nhóm (kèm số tiền đúng); hoặc lúc thi công cho phép đọc ảnh chứng từ có sẵn.
- **Ghi ~40 câu nói** bằng trang thử ở bước 0 (anh + 2 nhân viên khác vùng miền, có câu ngoài đường); tuỳ chọn mở tài
  khoản dùng thử FPT.AI nếu muốn so thêm hàng chuyên tiếng Việt.
- **Ra lệnh thẳng** khi tới bước `migrate:forward` production; cấp Copilot cho 1 quản lý thử.
- Chưa xác minh (để bước 0 trả lời): mô hình `cx/` nhận ảnh thật qua API (biểu tượng con mắt mới là suy đoán), có nhận hậu
  tố effort, có trả `usage`; id/giá chính xác các mô hình nhận giọng trên OpenRouter, việc nhận thẳng webm/mp4 và gợi ý từ
  vựng qua OpenRouter; độ chính xác tiếng Việt trên giọng thật của công ty (số liệu ~4% sai từ là trên bộ đo chuẩn
  FLEURS, không phải giọng thật); đọc trên production bị chặn nên chưa có số đo lượng phiếu chi/ảnh hằng tháng.
- Ghi nhận ngoài phạm vi: Copilot `src/copilot/anh.ts` cho ảnh tới 1,5 MB nhưng proxy chặn 512 KiB ⇒ ảnh >~380 KB đã bị
  413 — sửa riêng sau (có thể dùng lại `billImage.ts`).
