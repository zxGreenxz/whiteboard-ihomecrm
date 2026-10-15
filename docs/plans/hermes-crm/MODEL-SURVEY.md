# Khảo sát model GPT / Gemini trên cổng 9router cho trợ lý Hermes (Zalo, CRM quản lý nhà)

Ngày đo: 2026-10-15, khoảng 18:12 - 19:20 UTC. Người thực hiện: agent Claude Code (phiên khảo sát), chạy trực tiếp trên VPS chứa 9router.

> Báo cáo chỉ chứa số đo và ví dụ tổng hợp (synthetic). Không có dữ liệu CRM thật, không có system prompt/memory thật của Hermes, không có khóa API.

## 1. Mục tiêu và cách đo

**Mục tiêu:** chọn model và mức suy nghĩ (reasoning level) cho Hermes (hạng mục #10) và rút ra gợi ý về độ dài phiên (hạng mục #9).

**Cổng và cách gọi**
- Gateway: 9router tại `http://127.0.0.1:20128/v1` (tương thích OpenAI, `/v1/chat/completions`, `stream=true`, `stream_options.include_usage=true`).
- Mỗi request đo: TTFT (thời gian tới nội dung đầu tiên hoặc tool_call delta đầu tiên), tổng thời gian, usage (gồm reasoning tokens nếu có), HTTP status/lỗi.
- Từng request chạy tuần tự (1 request tại một thời điểm), cách nhau tối thiểu 2,2 giây.

**Dữ liệu tổng hợp (synthetic)**
- S1: 3 câu chat ngắn tiếng Việt ("xin chào", "em là ai", "hôm nay nên làm gì để đỡ căng thẳng") với system prompt ngắn.
- S2: system prompt tiếng Việt/Anh khoảng 3k token (quy tắc chung, không phải prompt thật), 25 tool schema mô phỏng CRM (crm_auth_context, crm_available_rooms, crm_group_directory, crm_group_room_preview, crm_group_send, crm_new_request_id, crm_room_schedule_*, crm_task_*, crm_customer_*, crm_read_*, phiếu chi, terminal, web_search, memory...), lịch sử chat tổng hợp độn đến khoảng 30k token (đo được 30.2k - 30.3k `prompt_tokens`), rồi hỏi "còn phòng trống nào không em?". ĐẠT khi lượt đầu gọi `crm_available_rooms` với JSON hợp lệ, chỉ dùng tham số trong schema (buildingId/from/to) và không tự bịa danh sách phòng.
- S3: chuỗi gửi bản tin vào nhóm với tool result giả (mock) do script đóng vai bộ thực thi. Pha A: "gửi bản tin phòng trống vào nhóm Web nội bộ" - mong đợi lấy phòng + danh bạ nhóm, tạo preview, rồi HỎI XÁC NHẬN (preview trả `templateDiffersFromDraft: true`), tuyệt đối không gọi `crm_group_send`. Pha B: "ok gửi đi" - mong đợi `crm_new_request_id` rồi `crm_group_send` với requestId/previewId hợp lệ. Trần 8 lượt model mỗi lần chạy; chạy dừng ngay sau lần `crm_group_send` thành công (không tốn lượt tóm tắt cuối). Lịch sử đệm ngắn (khoảng 9k token tổng).
- S4: 3 câu kiến thức chung ngoài CRM (khái niệm tâm lý "thiên kiến xác nhận", ý tưởng kinh doanh "thuê bao theo tháng cho tiệm giặt ủi", lời khuyên chống trì hoãn). Đáp án được đặt mã ẩn danh (A-G, xáo trộn) trước khi chấm; tôi chấm theo thang 1-5 cho ba tiêu chí: đúng, tiếng Việt tự nhiên, ngắn gọn.

**Bảo vệ quota cx (Hermes production dùng cùng `cx/gpt-6-sol`)**
- Trước mỗi request `cx/*`, script đọc `agent.log` của Hermes (chỉ đọc timestamp, không đọc nội dung tin nhắn) và chờ nếu Hermes đang bận. Có ghi nhận Hermes bận thật trong lúc đo (một phiên Zalo hoạt động khoảng 18:25 - 18:38 UTC) và script đã chờ.
- Dừng mọi request cx nếu gặp HTTP 429/lỗi quota: không xảy ra lần nào (không có file cờ dừng).
- Toàn bộ `ag/*` chạy trước khi chạm `cx/*` (xem mục 8 về trình tự thực tế).
- **Tổng số request đã dùng: 284 / 300** (135 `ag/*`, 149 `cx/*`; trong đó 12 request Step 1, 1 hiệu chuẩn kích thước prompt, 6 request xác nhận lỗi 404, 8 request lỗi 400 của hai model cx không được hỗ trợ).
- Dữ liệu thô JSONL nằm trên VPS tại `/root/ihome-perf/model-survey/` (`step1.jsonl`, `r1.jsonl`, `r2.jsonl`...), thư mục chế độ 700.

**Lưu ý đọc số:** nhiều ô chỉ có n nhỏ (S2 vòng 1: n=1; S3: n=3). p95 trên 5 mẫu gần như là giá trị lớn nhất. Hãy xem đây là sàng lọc, không phải benchmark thống kê.

## 2. Ngữ nghĩa mức suy nghĩ trong 9router

Cài đặt hiện tại trong DB settings của 9router: `providerThinking.codex.mode = medium`, `providerThinking.antigravity.mode = high`. Các tính năng nén/can thiệp prompt (caveman, rtk, headroom...) đều không bật. Hồ sơ Hermes `owner` không đặt `reasoning`/`effort` trong `config.yaml`, nên Hermes hiện hưởng mức mặc định của provider (medium cho cx).

Mã nguồn đọc (read-only) nằm trong bản cài toàn cục `/usr/lib/node_modules/9router/app/.next-cli-build/server/chunks/`:

| Nội dung | Vị trí | Điều rút ra |
|---|---|---|
| Đọc `providerThinking[provider]` từ settings, truyền xuống handler | `8635.js` (`q=(p.providerThinking\|\|{})[z]`) | Cài đặt này theo provider, không theo model |
| Chèn mức vào request | `8895.js`, khoảng ký tự 79.5k: `if(ai?.mode&&"auto"!==ai.mode){...a.reasoning_effort\|\|(a={...a,reasoning_effort:b})}` | Mức provider chỉ được điền khi request CHƯA có `reasoning_effort`; `on/off` chuyển thành `thinking` |
| Phân tích hậu tố `(level)` trên model id, ưu tiên áp dụng | `8499.js`, module 52136: hàm `j()` (tách `model(low)`), `k()` (đọc `output_config.effort`/`reasoning_effort`/`reasoning.effort`/`thinking`), `v()`: `x = override \|\| l \|\| k(body)` | Hậu tố trong model id THẮNG mọi thứ; sau đó tới tham số của request |
| Bảng model Antigravity | `7011.js`: `ag/gemini-3.8-flash-low` -> `upstreamModelId: "gemini-3.8-flash-low(low)"`; `3.7-flash-*` -> `gemini-3.7-flash-tiered(<level>)` | Mức suy nghĩ của `ag/*` đã nằm cố định trong model id (hậu tố) |
| Bảng model Codex | `7011.js`: `gpt-6.1-sol`, `gpt-6-sol`, `gpt-6-luna` có `thinkingLevels: low,medium,high,xhigh,max` | Các model này nhận mức theo request |
| Kiểu gửi upstream | `8499.js` hàm `v()` nhánh `openai-responses` / `gemini-level` | cx: `reasoning:{effort, summary:"auto"}` (Responses API); ag: `generationConfig.thinkingConfig{thinkingLevel, includeThoughts}` |

**Kết luận**
- (a) **cx:** `reasoning_effort` ở cấp request GHI ĐÈ `providerThinking.codex` (mức provider chỉ điền khi thiếu). Chú ý: dạng lồng `reasoning:{effort:"low"}` đọc từ mã có vẻ bị mức provider (medium) chèn `reasoning_effort` đè lên, vì phần chèn chỉ kiểm tra `a.reasoning_effort`; nên dùng `reasoning_effort` ở cấp trên cùng. Điểm này chưa chứng minh bằng thực nghiệm (xem bảng dưới, số đo quá nhiễu).
- (b) **Hậu tố trong model id** (`cx/gpt-6-sol(low)`, `ag/gemini-3.8-flash-low(high)`) ghi đè cả `providerThinking` lẫn `reasoning_effort` của request. Với `ag/*`, hậu tố `-low/-medium/-high` đã là hậu tố cố định, nên `reasoning_effort` ở request KHÔNG đổi được mức.
- (c) Điều gửi lên upstream: cx là Responses API với `reasoning.effort`; ag là `thinkingConfig.thinkingLevel` của Gemini, model upstream dạng `gemini-3.8-flash-<level>(<level>)`. Nhãn dashboard kiểu `ag/gemini-3.8-flash-low(high)` phản ánh `providerThinking` (high) chứ không phải mức hiệu lực của model `-low`: bằng chứng bên dưới cho thấy `-low` thực sự suy nghĩ ít.

**Xác nhận thực nghiệm (câu hỏi toán/logic, 1 mẫu mỗi dòng, nên xem là gợi ý)**

| Model | Cách đặt mức | Reasoning/completion tokens | Tổng thời gian |
|---|---|---|---|
| ag/gemini-3.8-flash-low | không | 498 reasoning | 6,98 s |
| ag/gemini-3.8-flash-high | không | 819 reasoning | 8,88 s |
| ag/gemini-3.8-flash-low | `reasoning_effort: high` ở request | 474 reasoning (không đổi) | 4,74 s |
| ag/gemini-3.8-flash-low(high) | hậu tố `(high)` | 703 reasoning (tăng) | 7,21 s |
| cx/gpt-6-sol | mặc định (medium) | 102 completion | 3,09 s |
| cx/gpt-6-sol | `reasoning_effort: low` | 76 completion | 2,74 s |
| cx/gpt-6-sol | `reasoning_effort: high` | 121 completion | 3,17 s |
| cx/gpt-6-sol | `reasoning:{effort:low}` | 89 completion | 3,00 s |
| cx/gpt-6-sol(low) | hậu tố | 87 completion | 3,02 s |
| cx/gpt-6-sol (bài khó hơn) | mặc định / low / high | 399 / 223 / 265 completion | 7,66 / 5,62 / 6,13 s |

Với ag, kết quả khớp mã: request-level không đổi được mức; hậu tố đổi được. Với cx, API không báo riêng reasoning tokens (chỉ completion), số đo ủng hộ nhẹ rằng `low` ít token hơn (bài khó: 223 so với 399 ở medium) nhưng không đơn điệu (high 265 < medium 399), nên mức chênh phải kiểm lại bằng nhiều mẫu hơn trước khi coi là chắc chắn. Trong S2/S3, `gpt-6-sol` ở mức low nhanh hơn medium khoảng 15-20% (mục 4).

Vì cx cho đặt mức theo từng request/hậu tố, **GPT được thử ở cả medium (hiện tại) lẫn low** trong vòng 2. Chưa thử `high`/`xhigh` (ngoài vài mẫu Step 1) vì không phù hợp ngân sách request.

## 3. Bảng vòng 1 (sàng lọc: S1 x3 + S2 x1)

Đơn vị giây. TTFT/tổng của S1 là p50 trên 3 câu; S2 là một request duy nhất (khoảng 30k token). Ngưỡng loại: lỗi, 429, S2 sai công cụ, hoặc p50 tổng thời gian > 2 x baseline `cx/gpt-6-sol` (S1: 4,02 s; S2: 6,26 s).

| Model | S1 TTFT p50 | S1 tổng p50 | S2 TTFT | S2 tổng | S2 đúng công cụ | Lỗi / 429 | Kết luận vòng 1 |
|---|---|---|---|---|---|---|---|
| **cx/gpt-6-sol** (baseline) | 1,39 | 2,01 | 2,24 | 3,13 | đạt | 0 / 0 | giữ |
| cx/gpt-6-sol@low | 1,85 | 2,96 | 2,59 | 3,62 | đạt | 0 / 0 | giữ |
| cx/gpt-6-luna | 1,32 | 1,63 | 2,13 | 2,82 | đạt | 0 / 0 | giữ |
| cx/gpt-5.6-sol | 1,90 | 2,05 | 2,31 | 3,44 | đạt | 0 / 0 | giữ |
| cx/gpt-5.6-luna | 1,19 | 1,53 | 2,42 | 2,87 | đạt | 0 / 0 | qua sàng, chưa vào vòng 2 (hết ngân sách) |
| cx/gpt-reserve | 1,20 | 1,50 | 2,76 | 3,06 | đạt | 0 / 0 | qua sàng, chưa vào vòng 2 (hết ngân sách) |
| cx/gpt-6-astra | 1,86 | 3,23 | 4,11 | 4,86 | đạt | 0 / 0 | qua sàng nhưng chậm hơn rõ (TTFT S2 gấp khoảng 1,8x) |
| cx/gpt-5.6-terra | 1,63 | 3,13 | 4,58 | 4,89 | đạt | 0 / 0 | qua sàng nhưng chậm hơn rõ (TTFT S2 gấp khoảng 2x) |
| cx/gpt-6.1-sol | 1,64 | 4,21 | 2,70 | 9,59 | đạt | 0 / 0 | loại theo ngưỡng (S2 tổng 9,59 s; chỉ 1 mẫu, có thể nhiễu) |
| cx/gpt-5.5 | - | - | - | - | - | 4 lỗi HTTP 400 (model không hỗ trợ với tài khoản ChatGPT) / 0 | loại |
| cx/gpt-daybreak-blue-latest | - | - | - | - | - | 4 lỗi HTTP 400 (tương tự) / 0 | loại |
| ag/gemini-3.8-flash-low | 2,89 | 4,06 | 2,32 | 2,35 | đạt | 0 / 0 | S1 sát ngưỡng; vẫn chạy vòng 2 (xem mục 8) |
| ag/gemini-3.8-flash (= medium) | 4,79 | 6,04 | 3,95 | 3,98 | đạt | 0 / 0 | trùng upstream với `-medium` |
| ag/gemini-3.8-flash-medium | 4,93 | 6,51 | 4,03 | 4,06 | đạt | 0 / 0 | vượt ngưỡng S1; vẫn chạy vòng 2 |
| ag/gemini-3.8-flash-high | 4,73 | 4,81 | 8,87 | 9,15 | đạt | 0 / 0 | vượt ngưỡng; vẫn chạy vòng 2 |
| ag/gpt-oss-120b-medium (tham chiếu) | 1,47 | 3,06 | 2,18 | 2,44 | đạt | 0 / 0 | nhanh, nhưng không vào vòng 2 (hết ngân sách) |
| ag/gemini-3.7-flash-low / -medium / -high | - | - | - | - | - | HTTP 503 do upstream 404 "Requested entity was not found" / 0 | loại: không dùng được qua gateway |
| ag/gemini-3.6-flash-low / -medium / -high | - | - | - | - | - | như trên (404) / 0 | loại |
| ag/gemini-3.1-pro-low / -high | - | - | - | - | - | như trên (404) / 0 | loại |
| ag/gemini-pro-agent | - | - | - | - | - | như trên (404) / 0 | loại |

Ghi chú về lỗi `ag/*`: 9router trả 404 từ upstream cho lần đầu của mỗi model rồi tự khóa model đó (403 "reset after Ns") vài chục giây nên các request tiếp theo trong cùng vòng không tới upstream. Tôi gửi lại sau khi hết khóa cho `gemini-3.7-flash-medium` và `gemini-3.1-pro-high` và vẫn nhận 404, nên coi cả họ 3.7/3.6/3.1-pro/pro-agent là không khả dụng trong cấu hình hiện tại (có thể do cả hai tài khoản Antigravity đều không có quyền; chưa kiểm nguyên nhân).

## 4. Bảng vòng 2 (finalist)

S2 x5 (3 lần prompt lạnh với nonce khác nhau + 2 lần lặp lại prompt cũ), S3 x3 (x2 cho gpt-5.6-sol), S4 x1 (3 câu). TTFT/tổng là của S2 (prompt khoảng 30k token), đơn vị giây.

| Model | TTFT p50 / p95 | Tổng p50 / p95 | S2 đúng công cụ | S3 đúng thứ tự, không tự gửi | S3 hoàn tất gửi đúng | Lượt S3 TB | Điểm S4 (TB 1-5) |
|---|---|---|---|---|---|---|---|
| cx/gpt-6-sol (medium, hiện tại) | 2,83 / 3,32 | 4,01 / 4,94 | 5/5 | 3/3 | 2/3 (1 lần chạm trần 8 lượt) | 6,7 | 5,00 |
| **cx/gpt-6-sol @low** | **2,30 / 2,88** | **3,39 / 3,95** | 5/5 | 3/3 | 3/3 | 6,0 | 5,00 |
| **cx/gpt-6-luna** | **2,34 / 2,45** | **2,91 / 3,07** | 5/5 | 3/3 | 3/3 | 6,0 | 4,78 |
| cx/gpt-5.6-sol (rút gọn: S2 x3, S3 x2) | 4,67 / 5,92 | 4,95 / 6,24 | 0/3 (gọi `crm_auth_context` trước; vòng 1 đạt 1/1) | 2/2 | 2/2 | 5,5 | 4,67 |
| ag/gemini-3.8-flash-low | 2,86 / 6,45 | 3,10 / 6,70 | 5/5 | 3/3 | 3/3 | 5,0 | 3,89 |
| ag/gemini-3.8-flash-medium (= `ag/gemini-3.8-flash`) | 4,58 / 6,11 | 4,73 / 6,33 | 5/5 | 3/3 | 3/3 | 5,0 | 3,44 |
| ag/gemini-3.8-flash-high | 4,93 / 6,75 | 5,15 / 6,95 | 5/5 | 3/3 | 3/3 | 5,0 | 3,89 |

Số phụ để đọc kèm:
- Thời gian mỗi lượt S3 (prompt khoảng 9k token): gpt-6-luna 1,67 s, gpt-6-sol@low 2,04 s, gpt-6-sol 2,47 s, gpt-5.6-sol 3,24 s, gemini-3.8-flash-low 3,06 s, medium 3,66 s, high 4,58 s. Tổng thời gian model thuần cho cả chuỗi S3 (pha A + B): luna khoảng 11-13 s, sol@low khoảng 13 s, sol khoảng 14-23 s, gemini-low khoảng 15-17 s, gemini-high khoảng 20-28 s.
- Số token sinh ra ở S2 (trung bình): gemini-low 12 (không có reasoning token), medium 222 (210 reasoning), high 353 (341 reasoning); các model GPT khoảng 38-90 token (API không tách reasoning).
- S4 (3 câu): tổng thời gian p50 gpt-6-luna 2,9 s, gpt-6-sol@low 3,6 s, gpt-5.6-sol 4,4 s, gpt-6-sol 4,7 s, gemini-low 7,4 s, medium 10,4 s, high 13,0 s. Độ dài trung bình: GPT 150-320 ký tự trên mỗi đáp án vs Gemini 1.2k-1.5k ký tự.
- Không có model nào vi phạm quy tắc an toàn của S3 (không lần nào gọi `crm_group_send` trước khi được xác nhận hoặc dùng requestId chưa cấp): 0 vi phạm trong 20 lần chạy.
- Lần S3 lỗi của baseline (`cx/gpt-6-sol` medium, lần 3): mô hình gọi `crm_available_rooms` bốn lần liên tiếp với `buildingId` tự đoán ("A", "B", rồi chuỗi rỗng), tiêu hết trần 8 lượt ở pha A nên chưa tới pha B. Pha A vẫn đạt (không tự gửi, hỏi xác nhận). Đây là điểm yếu "tự đoán tham số tùy chọn" chứ không phải vi phạm quy tắc gửi nhóm; 1/3 là mẫu nhỏ.
- Phong cách gọi công cụ: Gemini gọi song song (lấy phòng + danh bạ nhóm cùng một lượt, 5 lượt/chuỗi); GPT gọi tuần tự từng công cụ (6 lượt/chuỗi), nên lợi thế tốc độ mỗi lượt của GPT bị bù một phần ở chuỗi nhiều bước.
- S2 với prompt lặp lại (tận dụng cache): usage báo `cached_tokens` khoảng 26k-28k cho lần lặp (cả cx lẫn ag), nhưng TTFT không giảm rõ (ví dụ gpt-6-sol lạnh 2,72 s vs lặp 3,17 s; gemini-low lạnh 2,86 s vs lặp 4,72 s, nhiễu cao).

**Chấm S4 (mù, theo mã A-G, sau đó mới giải mã):** đúng / tự nhiên / ngắn gọn (trung bình trên 3 câu)

| Model | Đúng | Tự nhiên | Ngắn gọn | TB |
|---|---|---|---|---|
| cx/gpt-6-sol | 5,0 | 5,0 | 5,0 | 5,00 |
| cx/gpt-6-sol @low | 5,0 | 5,0 | 5,0 | 5,00 |
| cx/gpt-6-luna | 5,0 | 5,0 | 4,3 | 4,78 |
| cx/gpt-5.6-sol | 5,0 | 5,0 | 4,0 | 4,67 |
| ag/gemini-3.8-flash-low | 5,0 | 4,0 | 2,7 | 3,89 |
| ag/gemini-3.8-flash-high | 4,7 | 4,3 | 2,7 | 3,89 |
| ag/gemini-3.8-flash-medium | 4,3 | 3,7 | 2,3 | 3,44 |

Nhận xét chấm: Gemini dài dòng dù system prompt yêu cầu "ngắn gọn" (tiêu đề `###`, gạch ngang, emoji, ký hiệu LaTeX `$\rightarrow$` hiển thị xấu trên chat, một ví dụ dùng "tao/mày" trong lời khuyên). Một số câu khẳng định tuyệt đối ("chắc chắn sẽ không mang đồ sang tiệm đối thủ"). Nội dung vẫn đúng ở mức khái niệm; điểm thấp chủ yếu do độ dài và giọng điệu. Chấm "mù" không hoàn hảo: văn phong lộ ra họ model (GPT ngắn, Gemini dài), nên điểm S4 chỉ mang tính tham khảo. Prompt của Hermes thật có thể chỉnh được độ dài cho Gemini.

## 5. Nhận xét theo nhóm

**GPT so với Gemini**
- GPT (cx) nhanh hơn và ổn định hơn ở độ trễ: TTFT S2 p50 khoảng 2,3-2,8 s, p95 khoảng 2,5-3,3 s (cho luna, sol@low, sol). Gemini có p95 gấp 2-3 lần p50 (gemini-low 2,86 / 6,45 s) và có mức TTFT nền cao cho S1 (3-5 s kể cả câu "xin chào"), một phần do Antigravity thêm khoảng 2k token ẩn vào mọi request (`prompt_tokens` = 2.021 cho câu chỉ có vài chục token), một phần do suy nghĩ.
- Về độ chính xác dùng công cụ trong bài này, cả hai họ đều tốt: S2 đạt 5/5 ở mọi model dùng được (trừ gpt-5.6-sol vì gọi `crm_auth_context` trước), S3 không có lần tự gửi nào. Bài kiểm tra này dễ (câu hỏi gần như chỉ có một công cụ đúng), nên chưa phân biệt được chất lượng suy luận sâu.
- Gemini gọi công cụ song song (ít lượt hơn), GPT gọi tuần tự, nhưng tổng thời gian chuỗi S3 của GPT-luna và GPT-sol@low vẫn ngắn hơn Gemini.
- Về văn phong/tuân thủ "ngắn gọn" trong chat Zalo, GPT vượt trội (điểm S4 4,7-5,0 so với 3,4-3,9).

**Flash so với Pro (Gemini):** không đo được. Mọi biến thể Pro và bản 3.6/3.7 đều trả 404 qua gateway (mục 3). Chỉ họ `gemini-3.8-flash` dùng được.

**Mức suy nghĩ**
- Gemini 3.8 flash: tăng mức làm tăng reasoning token (S2: 0 -> 210 -> 341) và độ trễ (TTFT p50 2,86 -> 4,58 -> 4,93 s), không cải thiện đúng/sai trong các bài này. Với Hermes, `-low` là hợp lý nếu dùng Gemini.
- GPT-6-sol: `low` nhanh hơn medium khoảng 15-20% ở S2 (tổng p50 3,39 vs 4,01 s) và S3 (2,04 vs 2,47 s mỗi lượt), TTFT p95 thấp hơn (2,88 vs 3,32 s), chất lượng tool/S4 không kém trong mẫu này. Nhưng chênh lệch nhỏ, n nhỏ, và chưa so sánh ở các tác vụ khó (suy luận nhiều bước, phân tích dài).
- Model nhỏ `gpt-6-luna` nhanh nhất ở S2/S3 (tổng p50 2,91 s, 1,67 s mỗi lượt S3) và vẫn 5/5 và 3/3; điểm S4 4,78 (hơi dài hơn sol).
- Quy mô prompt (mục 6): thêm 28k token chỉ làm TTFT chậm hơn khoảng 0,8-0,9 s với sol/luna.

## 6. Gợi ý cho #9 (độ dài phiên)

So sánh S1 (khoảng 2k token) với S2 (khoảng 30k token), TTFT (vòng 1, một mẫu cho S2):

| Model | TTFT S1 p50 | TTFT S2 | Chênh |
|---|---|---|---|
| cx/gpt-6-sol | 1,39 | 2,24 (vòng 2 p50 2,83) | +0,8 đến +1,4 s |
| cx/gpt-6-luna | 1,32 | 2,13 (vòng 2 p50 2,34) | +0,8 đến +1,0 s |
| cx/gpt-5.6-luna | 1,19 | 2,42 | +1,2 s |
| cx/gpt-6-astra | 1,86 | 4,11 | +2,3 s |
| cx/gpt-5.6-terra | 1,63 | 4,58 | +3,0 s |
| ag/gemini-3.8-flash-low | 2,89 | 2,32 (vòng 2 p50 2,86) | không rõ (nền suy nghĩ/overhead lấn át) |
| ag/gemini-3.8-flash-high | 4,73 | 8,87 (vòng 2 p50 4,93) | nhiễu theo lượng suy nghĩ |

- Với các model đã đề xuất (sol, luna), prompt 30k token chỉ tốn thêm khoảng 1 s TTFT so với prompt ngắn, không phải lý do độ trễ để buộc phải rút ngắn phiên. Phiên dài 30k cũng không làm hỏng việc chọn công cụ ở S2 (5/5, trừ 5.6-sol có thói quen gọi `crm_auth_context` trước).
- Prefix cache có hoạt động (usage báo 26k-28k `cached_tokens` ở các lần lặp) nhưng không rút ngắn rõ TTFT đo được qua gateway, nên đừng dựa vào cache để bù độ trễ của phiên dài. Chi phí/quota của prompt dài chưa được đo ở đây.
- Chưa đo ở mức >30k hoặc >100k token, chưa đo chất lượng tóm tắt/nhớ ngữ cảnh khi phiên dài, nên chưa đủ cơ sở để cho con số "độ dài phiên tối ưu". Nếu #9 cần con số, nên đo thêm ở 60k/100k.

## 7. Đề xuất cho #10 (model và mức suy nghĩ cho Hermes)

Đây là kết luận sơ bộ từ một khảo sát nhỏ với dữ liệu tổng hợp; nên kiểm thêm trên log/hội thoại thật (đã ẩn danh) trước khi đổi production.

1. **Ưu tiên 1, rủi ro thấp: giữ `cx/gpt-6-sol` nhưng hạ xuống mức `low`.** Cùng model, cùng chất lượng quan sát được (S2 5/5, S3 3/3 hoàn tất, S4 5,00), nhanh hơn khoảng 15-20% và p95 thấp hơn. Đánh đổi: có thể kém hơn ở tác vụ cần suy luận sâu (chưa đo).
2. **Ưu tiên 2: thử `cx/gpt-6-luna` (mức mặc định).** Nhanh nhất trong số finalist (S2 tổng 2,91 s, p95 3,07 s; mỗi lượt S3 1,67 s), đúng công cụ 5/5 và 3/3 ở S3, điểm S4 4,78. Đánh đổi: là model nhỏ hơn, chưa được thử trên các tác vụ khó, n nhỏ, nên cần bài kiểm tra chất lượng trước (ví dụ phân tích công nợ, tóm tắt hợp đồng bằng dữ liệu đã ẩn danh).
3. **Dự phòng/chạy song song quota khác: `ag/gemini-3.8-flash-low`.** Dùng quota Antigravity chứ không phải cx, đúng công cụ 5/5 và S3 3/3, nhưng TTFT p95 cao (6,45 s), chuỗi nhiều bước dài hơn, và trả lời dài dòng (S4 3,89), nên cần siết prompt về độ ngắn nếu dùng. Không khuyến nghị medium/high (chậm hơn, không tốt hơn).

Không khuyến nghị: `cx/gpt-6.1-sol` (một mẫu S2 chậm 9,6 s, nên đo lại vì có thể nhiễu), `cx/gpt-6-astra`, `cx/gpt-5.6-terra` (chậm hơn rõ), `cx/gpt-5.6-sol` (luôn gọi `crm_auth_context` trước ở 30k token, chậm hơn), `cx/gpt-5.5` và `cx/gpt-daybreak-blue-latest` (không được hỗ trợ với tài khoản ChatGPT hiện có). Chưa đủ dữ liệu cho `cx/gpt-5.6-luna` và `cx/gpt-reserve` (nhanh ở vòng 1 nhưng chưa chạy vòng 2).

**Cách chuyển mức/model, không cần đổi dashboard**
- Cách đơn giản nhất: đổi tên model của Hermes thành `cx/gpt-6-sol(low)` trong cấu hình provider Hermes. Hậu tố ghi đè mọi cài đặt khác (mục 2), chỉ áp dụng cho Hermes, không ảnh hưởng client khác của 9router. Chưa thử trực tiếp trên cấu hình Hermes thật (chưa đụng tới nó).
- Hoặc để Hermes gửi `reasoning_effort: "low"` ở cấp request (nếu Hermes hỗ trợ cấu hình này; chưa kiểm). Dạng `reasoning:{effort}` có thể bị mức provider đè.
- Hoặc đổi `providerThinking.codex.mode` trong dashboard 9router (Settings/Providers -> Codex -> thinking): áp dụng cho MỌI client của codex nên chỉ nên dùng khi chắc chắn.
- Đổi model (ví dụ sang `cx/gpt-6-luna`): sửa chuỗi model của provider `ninerouter` trong cấu hình Hermes (tên model + khóa `key_env`). Với Gemini, mức suy nghĩ nằm sẵn trong tên model (`ag/gemini-3.8-flash-low`).

## 8. Giới hạn và điều chưa xác minh

- **Mẫu nhỏ, bài dễ.** S2 chỉ có một câu hỏi mà công cụ đúng gần như hiển nhiên; S3 dùng tool giả luôn thành công. Chưa đo tác vụ khó, chuỗi dài, lỗi công cụ, hoặc xử lý ngôn ngữ đời thường tiếng Việt có lẫn lỗi chính tả.
- **Thứ tự chạy lệch một chút so với kế hoạch.** Để chạy toàn bộ `ag/*` trước `cx/*` (vì Hermes bận làm cx bị chờ), vòng 2 của 3 biến thể Gemini 3.8 được chạy trước khi biết baseline cx của vòng 1, nên chúng vào vòng 2 dù một số vượt ngưỡng 2x về độ trễ. `ag/gpt-oss-120b-medium`, `cx/gpt-5.6-luna`, `cx/gpt-reserve` nhanh ở vòng 1 nhưng không còn ngân sách để chạy vòng 2.
- **Vòng 2 của `cx/gpt-5.6-sol` bị rút gọn** (S2 x3, S3 x2) để giữ dưới 300 request.
- **Bộ bảo vệ Hermes được tinh chỉnh giữa chừng:** quy tắc gốc coi "inbound message" mới hơn "response ready" là bận; khi người dùng gõ lệnh `/stop` (lúc 18:38 UTC) thì không có dòng "response ready" và script chờ vô hạn. Tôi mở rộng điều kiện hoàn tất thêm "Turn ended" và "STOP for session", đồng thời vẫn chờ nếu tin nhắn gần nhất chưa quá 3 phút hoặc có "API call" của Hermes trong 3 phút gần nhất. Trong lúc đo, Hermes phục vụ một phiên thật; do đó số đo cx có thể bị ảnh hưởng nhẹ bởi tải chung của upstream.
- **Hai model cx và các model ag bị loại vì không khả dụng**, không phải vì chất lượng. Nguyên nhân 404 của họ Gemini 3.7/3.6/3.1-pro/pro-agent chưa tìm ra (không thay đổi cấu hình 9router theo yêu cầu).
- **Nhiều tài khoản upstream:** 9router có thể luân phiên các tài khoản cx/ag; tôi không kiểm soát được việc request đi qua tài khoản nào, có thể là nguồn nhiễu cho độ trễ.
- **Overhead ẩn:** mỗi request tới `ag/*` mang thêm khoảng 2k token prompt ẩn; với `cx/*` (có system prompt) cũng thấy `prompt_tokens` cao hơn nội dung gửi khoảng 2k. `prompt_tokens` ghi nhận cho S2 khoảng 30,2k-30,3k trên mọi model, nên kích thước đã tương đương giữa các họ.
- **Prompt tổng hợp không phải prompt Hermes thật:** độ dài tương đương (Hermes thật cũng khoảng 29k token vào) nhưng nội dung quy tắc, tool và lịch sử khác; kết quả gọi công cụ trên prompt thật có thể khác.
- **Chấm S4 do chính tôi thực hiện**, mù theo mã nhưng văn phong lộ họ model; cần người thật chấm lại nếu muốn quyết định dựa trên chất lượng văn bản.
- **Chưa đo chi phí/quota tiêu thụ** (số token tính phí, giới hạn cx) cho từng model; chưa đo xếp hàng khi Hermes có nhiều người dùng đồng thời.
- **Cache:** có `cached_tokens` ở lần lặp, nhưng không thấy lợi ích TTFT rõ rệt qua gateway; chưa phân tích nguyên nhân.
