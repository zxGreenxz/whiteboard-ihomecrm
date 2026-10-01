# Báo chi nhanh — kết quả thử nghiệm mô hình (Bước 0)

> Plan gốc: [2026-10-01-bao-chi-nhanh.md](2026-10-01-bao-chi-nhanh.md). File này ghi SỐ ĐO, cập nhật dần theo
> từng phần của Bước 0. Không chứa ảnh, ghi âm hay dữ liệu cá nhân.

## 0a — dò khả năng (01/10/2026, dữ liệu GIẢ)

Gọi thẳng `https://ai.chillhome.io.vn/v1` (9Router) và OpenRouter từ máy dev; không qua llm-proxy, không ghi
production. Ảnh thử là hoá đơn bán lẻ dựng bằng HTML rồi chụp JPEG (52,7 KB): hai món 90.000 + 15.000, giảm giá
7.000, **tổng thanh toán 98.000đ**.

| Phép thử | Kết quả |
|---|---|
| Mô hình `cx/` trên 9Router | `cx/gpt-6.1-sol`, `cx/gpt-6-astra`(+`[1m]`), `cx/gpt-6-sol`(+`[1m]`), `cx/gpt-6-luna`(+`[1m]`), `cx/gpt-5.6-luna`(+`[1m]`, `-review`) |
| Hậu tố effort trong id (`cx/gpt-6-luna(low)`, `(medium)`) | Nhận |
| Chữ "mua 2 bóng đèn 120k ở 102LVT" → `{"amount_vnd"}` | Đúng 120000 ở `luna`, `luna(low)`, `luna(medium)`; có và không có `response_format: json_object` đều ra JSON |
| Độ trễ chữ | `luna(low)` 2,9 s · `luna(medium)` 2,8 s · `luna` (không hậu tố, lượt đầu) 9,4 s |
| Ảnh hoá đơn → tổng/cửa hàng/ngày/món | `luna(low)` 3,5 s · `luna(medium)` 3,6 s · `sol(low)` 4,1 s — **cả ba đọc đúng tổng THỰC TRẢ 98.000** (sau giảm giá), đúng cửa hàng, ngày 2026-09-29 và hai món |
| `finish_reason` / `usage` | `stop`, có `usage` ở mọi lượt (non-stream) |
| 9Router `/v1/models/stt` | 200, danh sách **rỗng** — vẫn không có mô hình nhận giọng |
| OpenRouter mô hình nhận giọng | 24 mô hình, gồm `openai/gpt-4o-mini-transcribe`, `openai/gpt-4o-transcribe`, `openai/gpt-transcribe`, `google/chirp-3`, `google/gemini-3.5-transcribe`, `deepgram/nova-3`, `openai/whisper-large-v3(-turbo)` |
| Gọi `/audio/transcriptions` (WAV im lặng 1 s) | **402**: "requires at least $0.50 in balance for audio" |
| Tài khoản OpenRouter (`/api/v1/key`, `/credits`) | Khoá hạn mức 5 USD nhưng `total_credits` = 0, `is_free_tier` = true ⇒ chỉ gọi được mô hình `:free` |

Giá nhận giọng (OpenRouter, một câu 10 giây): `gpt-4o-mini-transcribe` ~0,0005 USD · `deepgram/nova-3` ~0,0007 USD ·
`google/chirp-3` ~0,0027 USD.

### Hệ quả cho thiết kế

- Chuỗi chữ + ảnh: `9router:cx/gpt-6-luna(low)` đứng đầu là hợp lý (nhanh nhất, đọc đúng ảnh); kế tiếp
  `cx/gpt-6-luna(medium)` → `cx/gpt-6-sol(low)`. Chốt sau 0b trên bill thật.
- Giữ `response_format: json_object` (mô hình nhận) nhưng không phụ thuộc vào nó — luna vẫn ra JSON khi bỏ.
- Ảnh 1600 px JPEG 0,75 của hoá đơn ngắn chỉ ~50 KB ⇒ ngân sách 360 KB dư nhiều; ảnh chụp camera thật cần đo ở 0b.
- **Nhận giọng chưa chạy được** tới khi tài khoản OpenRouter có số dư ≥ 0,50 USD (đề xuất nạp 5 USD ≈ 10.000 câu).
  Mắt xích OpenRouter dự phòng cho ảnh cũng cần số dư này.

## 0b — bill thật (chưa làm)

Chờ 15–20 ảnh bill 5 nhóm: điện nước, ăn uống, thu chi khác, vật tư (có viết tay), đơn Shopee — kèm số tiền đúng.

## 0c — giọng thật tiếng Việt (chưa làm)

Chờ nạp OpenRouter + ~40 câu ghi âm (giọng Bắc/Trung/Nam, trong phòng và ngoài đường).
