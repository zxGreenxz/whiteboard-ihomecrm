# Nền chung cho thao tác ghi của Hermes — Đợt 1 (THIẾT KẾ ĐÃ DUYỆT, đang hiện thực)

Ngày 21/10/2026 (giờ Việt Nam). Mốc 1 (thiết kế) đã được phiên chính duyệt; chủ đã trả lời đủ 27 câu của plan gộp (21/10, 18:31–18:36). Các quyết định D1–D9 đã chốt ở mục 15; chỗ nào khác bản thiết kế đầu thì đã sửa ngay trong mục tương ứng. Hiện thực đi theo các mốc ở mục 13. Chưa có migration nào được áp, chưa đổi production.

Đợt 1 dựng phần dùng chung cho mọi thao tác ghi mới của Hermes. Ba trang Thu chi, Hoá đơn, Hợp đồng dùng nó trước; mảng Công việc dùng sau. Đợt 1 không làm thao tác cụ thể nào của từng trang (ghi phiếu chi, thu tiền, gia hạn…).

Nguồn:
- Đề xuất nền 3-0 ở [DOT-3-THAO-TAC-GHI.md](DOT-3-THAO-TAC-GHI.md) mục 4.
- Plan gộp "Plan thao tác Hermes" gửi chủ ngày 21/10, mục 4–8.
- Ba plan chi tiết Thu chi, Hoá đơn, Hợp đồng và bản khảo sát Công việc, cùng ngày 21/10.

Plan gộp, ba plan chi tiết và bản khảo sát nằm ở máy làm việc, không nằm trong repo. Câu 1, 2, 3, 5 chủ chọn đúng mặc định đề xuất; câu 4 chủ đồng ý tắt 3 tool phiếu chi cũ. Riêng D7 (luật khớp tên) phiên chính đổi: giải tên cho thao tác ghi đặt trong hàm SQL dùng chung (mục 7).

## 0. Kết luận

1. **Ba tool ghi dùng chung tốn 1 830 B trong `tools/list`.** Đó là `crm_action_list`, `crm_action_run` và `crm_action_status`, đo bằng `advertisedTool` thật trên bản nháp định nghĩa. Thêm thao tác mới không tốn thêm byte, vì danh mục thao tác và khuôn tham số nằm trong *kết quả* của `crm_action_list`.
2. **Danh sách công cụ hiện chỉ còn 168 B.** Đo trên `origin/main` `27e0f9d10`: 65 tool, 63 832 B, trần test 64 000 B.
   - Vì vậy Đợt 1 phát hành ba tool ở trạng thái **ẩn**: chúng chỉ hiện khi kết nối giữ khoá của ít nhất một thao tác đã đăng ký và đang bật. Đợt 1 không đăng ký thao tác thật nào, nên production giữ nguyên 63 832 B.
   - Thao tác thật đầu tiên chỉ hiện được khi rút đủ byte. Chủ đã đồng ý tắt ba tool phiếu chi cũ (−3 152 B, câu 4); phiên chính làm ở draft PR #254 (khoá registry `income_expenses.create` = TẮT). Sau đó tổng còn khoảng 62 510 B.
3. **Rào xác nhận của tin pass phòng tách thành module chung `confirm-guard.mjs`.**
   - Token vẫn dùng một lần, sống 10 phút, gắn kết nối + thao tác + nội dung.
   - Phần mở rộng cho thao tác ghi: token gắn thêm `requestId` do connector cấp ở lượt xem trước, gắn dấu trạng thái `basis` mà máy chủ đọc lúc xem trước, và gắn bản đầu vào đã giải tên. Lượt 2 gửi xuống SQL đúng bản đã giải, không giải tên lần hai.
   - Máy chủ tính lại `basis` trong transaction ghi. Lệch thì từ chối với lý do `state_changed`, và bot xem trước lại.
   - `crm_room_pass_upsert` chuyển sang module chung mà không đổi hành vi; test cũ phải xanh nguyên.
4. **Lý do lỗi là một danh sách đóng, có câu tiếng Việt tĩnh.**
   - Danh sách có 20 mã dùng chung. Mỗi trang thêm mã riêng vào cùng danh sách.
   - SQL ánh xạ lỗi của hàm ghi web sang mã. Connector chỉ chuyển cho mô hình các mã và câu trong danh sách. Mã lạ thành `crm_refused`, không chuyển nguyên văn lỗi SQL.
   - **Thiếu hoặc mơ hồ đầu vào không phải lỗi.** Tên không giải được, thiếu tham số, tham số sai, thao tác lạ trả về *kết quả thường* `outcome: "needs_input"` kèm `detail` và ứng viên. Lý do: ca thử Công việc trên TEST (21/10) cho thấy sau 3 lời gọi bị từ chối liên tiếp, Hermes tạm khoá cả MCP server khoảng 59 giây và bot bỏ cuộc. Chỉ lỗi thật (quyền, nghiệp vụ, hệ thống) mới là lỗi.
   - Có thêm 2 mã lỗi broker: `action_rejected`, `action_outcome_unknown`. Cả 2 mã và mọi mã lý do phải vào sổ kiểm toán `host-ownership.mjs` cùng commit. Test `audit-codes.test.mjs` đã khoá `ERROR_STATUS ⊆ AUDIT_CODES`; Đợt 1 khoá thêm tập mã lý do.
5. **Chính sách câu 2, 3, 5 có chỗ bật/tắt, nhưng có hai giới hạn thật.**
   - **Câu 2.** Thao tác tiền hoặc không lùi được luôn xem trước. Đây là sàn trong mã; cấu hình chỉ siết thêm được, không nới được. Các thao tác khác theo bảng chính sách trong DB.
   - **Câu 3.** Connector **không biết** loại chat: `_meta` bị bỏ, không có header nào mang loại chat. Rào hiện có nằm ở kênh: adapter Zalo chỉ nhận DM của người đã ghép. Mục 8.2 nêu phương án và giới hạn.
   - **Câu 5.** Khoá đang tắt trong registry **không hiện** ở màn tạo kết nối. Kết nối kiểu `inherit_crm` thì tự nhận khoá khi khoá được bật. Phiên chính đã đọc production: cả 6 kết nối ACTIVE đều `inherit_crm`, nên không cần tạo lại kết nối; mỗi lần bật khoá là kết nối nhận ngay (mục 8.3).
6. **Ước công Đợt 1: 4–6 ngày kỹ sư**, chia 6 mốc. Mỗi mốc là một commit có test xanh. Hai mốc đầu chỉ đụng connector, không cần migration.

## 1. Phạm vi

| Trong Đợt 1 | Ngoài Đợt 1 |
| --- | --- |
| Rào xác nhận hai lượt dùng chung; chuyển `crm_room_pass_upsert` sang, không đổi hành vi | Thao tác cụ thể của từng trang (ghi/sửa/huỷ phiếu, thu tiền, gia hạn, báo trả…) |
| Ba tool ghi chung, danh mục thao tác, kiểm tham số + gợi ý tĩnh, dựng sẵn khuôn chuyển sang phương án B | Tắt 3 tool phiếu chi cũ (chờ chủ, câu 4) |
| Danh sách đóng mã lý do + câu tĩnh; ánh xạ SQL; sổ kiểm toán | Vá lỗ phiếu hoàn cọc thứ hai (chủ đang xem) |
| Giải tên cho thao tác ghi (khung; trang cắm vào sau) | SOUL bản 5 và skill (phiên chính) |
| Chính sách câu 2/3/5 bật tắt được; đăng ký khoá ghi dự kiến ở trạng thái TẮT | Áp migration, deploy connector, chạm VPS (phiên chính) |
| SQL nền: sổ biên nhận chung, hàm kiểm ngữ cảnh, tra trạng thái, ánh xạ lý do, capabilities | Báo cáo đọc mới của từng trang |
| Ca thử offline + PGlite; danh sách ca bot thật để phiên chính chạy trên TEST | Chạy bot thật (phiên chính, connector TEST cổng 8741) |

## 2. Kiểm kê mã hiện có

Tất cả đường dẫn dưới đây tính từ `infra/hermes-broker/`, trừ khi ghi khác.

| Thành phần | Ở đâu | Đợt 1 dùng lại thế nào | Khoảng trống |
| --- | --- | --- | --- |
| Rào chữ công khai | `public-text-guard.mjs`; broker gọi tại `broker.mjs` nhánh `crm_room_pass_*` | Tách phần token (cấp, dùng một lần, TTL, giới hạn 1 024 token chờ, tách `confirmToken` trước validator) thành `confirm-guard.mjs` | Token chỉ gắn `roomId` + 3 trường chữ. Không có `requestId`, không có dấu trạng thái, không có bản xem trước do máy chủ dựng |
| Cấp requestId | `request-id-contract.mjs`, tool `crm_new_request_id` (531 B) | Connector tự cấp ở lượt xem trước; tool ghi mới không bắt buộc `requestId`, nên `startsCrmRequest` không kéo thêm `crm_new_request_id` | Tool ghi cũ vẫn cần `crm_new_request_id` cho tới khi chuyển hết |
| Khuôn ghi prepare/finalize | `bound-user-operation.mjs`; ví dụ `expense-action-adapter.mjs`, `task-adapter.mjs` | Thêm một service cùng khuôn cho thao tác: biên nhận có nhãn, lời gọi RPC JWT người dùng là lệnh `await` cuối | Mỗi họ tool có adapter, biên nhận và tool `*_status` riêng |
| Mã lỗi broker | `broker.mjs` `ERROR_STATUS`, `MUTATION_UNKNOWN`, `REQUEST_RECEIPT_UNKNOWN` | Thêm 2 mã (mục 6.3) | Lỗi nghiệp vụ SQL chỉ còn 4 mã trơn |
| Ánh xạ lỗi PostgREST | `bound-user-rpc.mjs`: 401 → `unauthorized`, 42501 → `forbidden`, PT409 → `context_changed`, 22023 → `invalid_request`, PT413 → `result_too_large`, còn lại → `backend_unavailable` | Giữ nguyên cho tool cũ. RPC thao tác mới trả lý do trong JSON 200 nên không đi qua nhánh này | Mất câu lý do (sự cố R2 của khảo sát Công việc) |
| Chuyển `detail` cho mô hình | `mcp-http.mjs`: chỉ `read_name_unresolved.detail` và gợi ý tĩnh `READ_MISUSE_HINT_TEXTS` | Thêm nhánh cho `action_rejected` (`reason` + `detail` trong danh sách đóng). Thiếu/mơ hồ đầu vào đi bằng kết quả `needs_input`, không qua nhánh lỗi | — |
| Sổ kiểm toán host | `infra/hermes-runtime/host-ownership.mjs` `CODES`; test `infra/hermes-runtime/audit-codes.test.mjs` | Thêm 2 mã + tập `AUDIT_REASONS` + trường `reason` tuỳ chọn; mở rộng test | Thiếu mã là nguyên nhân sự cố 21/10: mọi lỗi tên hiện thành "CRM tạm lỗi" |
| Giải tên đọc | `read-name-resolution.mjs`: toà bỏ dấu, bỏ tiền tố "toà", khớp bằng rồi chứa; phòng gọi `hermes_room_directory_v1` | Dùng lại `foldName`, `matchBuildings`, cache danh bạ toà 5 phút | Mã toà không tách bí danh theo dấu phẩy như web (`splitAliases`). Không có tên thường gọi (`building_common_names`). Phòng khớp chứa |
| Tên thường gọi | Bảng `building_common_names` (migration `20261002050652`); web đọc ở `src/lib/quickEntry/spokenBuilding.ts`, `resolve.ts` | Danh bạ toà v2 trả thêm `commonNames` | `hermes_building_directory_v1` không trả trường này |
| Tool meta đọc | `wave2-registry.mjs`: `crm_read_report_list` + `crm_read_report`, mục lục theo quyền, trần riêng 1 600 B | Mẫu cho `crm_action_list` + `crm_action_run`: mục lục trong kết quả, sổ khai báo kiểm khi nạp | — |
| Đo byte | `tool-argument-shape.test.mjs` (trần 64 000 B), `full-grant-broker.fixture.mjs` | Thêm phép đo có họ thao tác; thêm điều kiện loại trừ họ phiếu chi cũ | Chỉ còn 168 B |
| Registry | `app_private.hermes_capabilities(capability, mode, enabled)`; capabilities RPC từng họ, ví dụ `hermes_expense_capabilities_v1`; hook options `hermes_*_extend_options_v1` | Seed khoá TẮT; một capabilities RPC chung cho mọi khoá thao tác | Khoá tắt không hiện ở màn tạo kết nối (mục 8.3) |
| Biên nhận ghi | `app_private.hermes_expense_create_receipts`, `hermes_task_create_receipts`…, khoá chính `(organization_id, user_id, request_id)` | Mẫu cho `app_private.hermes_action_receipts`, một bảng cho mọi thao tác mới | Mỗi họ một bảng |
| Kênh Zalo | `infra/hermes-zalo-native/adapter.py` (`chat_type="dm"`, chỉ nhận `senderUid == paired_uid`); `worker/lib/hermes-native-bridge.js`; `bridge.test.mjs` | Căn cứ cho câu 3 | Connector không thấy loại chat |

## 3. Vòng đời một lệnh ghi

```text
Người dùng ── "Gia hạn 302 toà 44TL thêm 6 tháng" ──► Hermes
Hermes ── crm_action_run {action:"contract.renew", params:{buildingName:"44TL", roomName:"302", months:6}} ──► connector
connector:
  1. admission, quyền, audit như mọi tool (broker invoke)
  2. tra danh mục: thao tác có đăng ký? (không ⇒ KẾT QUẢ needs_input: unknown_action) kết nối giữ khoá? (không ⇒ lỗi action_rejected: action_disabled)
  3. kiểm params theo khuôn của thao tác (sai/thiếu ⇒ KẾT QUẢ needs_input: invalid_params + gợi ý tĩnh)
  4. chính sách kênh (mục 8.2)
  5. gọi RPC xem trước của trang (INVOKER, STABLE) bằng JWT người dùng; trong đó SQL giải tên ở chế độ ghi, trong phạm
     vi toà của KHOÁ GHI (mục 7; 0/≥2 ⇒ KẾT QUẢ needs_input: name_unresolved + ứng viên)
  6. cùng RPC đó dựng preview có tên, basis, warnings, hoặc trả lý do từ chối sớm (lỗi action_rejected)
  7. quyết định xác nhận = sàn theo lớp thao tác ∨ chính sách DB ∨ máy chủ đòi (mục 8.1)
     ├─ không cần ⇒ cấp requestId, đi thẳng bước 10 trong cùng lượt gọi
     └─ cần ⇒ cấp requestId; lưu {binding, đầu vào đã giải, basis, requestId} trong bộ nhớ, sau confirmToken
  ◄── {outcome:"confirmation_required", applied:false, action, requestId, preview, warnings, confirmToken, expiresAt, huongDan}
Hermes nhắc lại bản xem trước, hỏi "Đồng ý?"; người dùng "ok"
Hermes ── crm_action_run {cùng action, cùng params, requestId, confirmToken} ──► connector
  8. tách confirmToken trước validator; thiếu requestId ⇒ confirmation_invalid
  9. đổi token lấy bản đã lưu (dùng một lần). Sai, hết hạn, đã dùng, hoặc (kết nối, action, params, requestId) khác ⇒ confirmation_invalid
 10. gọi RPC ghi của trang với {binding, requestId, action, đầu vào đã giải, expectedBasis}:
       SQL kiểm ngữ cảnh, mở biên nhận (trùng requestId cùng đầu vào ⇒ phát lại kết quả cũ; khác đầu vào ⇒ request_conflict),
       khoá hàng, tính lại basis (lệch ⇒ state_changed, KHÔNG chốt biên nhận), gọi ĐÚNG hàm ghi web,
       bắt lỗi hàm ghi ⇒ mã lý do, chốt biên nhận + audit trong cùng transaction
  ◄── {outcome:"applied", requestId, action, result:{…tên…}, link}  hoặc  lỗi action_rejected {reason, detail}
Mất phản hồi sau khi gửi bước 10 ⇒ lỗi action_outcome_unknown + requestId ⇒ Hermes gọi crm_action_status {requestId}
```

### 3.1 Quy tắc

- **Lượt 1 không ghi.** Với thao tác cần xác nhận, lượt 1 chỉ đọc. Token chỉ chứng minh bản xem trước đã được cấp; connector không biết người dùng đã đồng ý chưa. Rủi ro này và cách đo nằm ở mục 14.
- **Token dùng một lần, sống 10 phút** (`CONFIRM_TTL_MS`).
  - Đồng hồ lùi thì coi như token hết hạn.
  - Trình ra là token mất, dù khớp hay không.
  - Tối đa 1 024 token chờ cho mỗi bề mặt; đầy thì bỏ token cũ nhất.
  - Khởi động lại broker làm mất token chờ, nên người dùng phải xem trước lại. Việc này không mở đường ghi thẳng.
- **Khoá token gồm** sha256 của JSON chuẩn hoá `[connectionId, action, params chuẩn hoá, requestId]`. Bản ghi chờ giữ thêm đầu vào đã giải và `basis`. Mô hình không gửi lại hai thứ này, nên không giả được.
- **requestId.**
  - Lượt 1 không có `requestId` thì connector cấp một UUID v4 mới.
  - Có `requestId` (mô hình thử lại) thì giữ nguyên.
  - Nếu biên nhận của mã đó đã chốt, connector phát lại kết quả cũ thay vì xem trước. Việc này chặn ghi trùng khi mô hình lẫn lộn.
  - Lượt 2 bắt buộc có `requestId`, và mã phải trùng với mã đã gắn trong token.
- **Hai loại từ chối.**
  - *Từ chối cuối*: lỗi của hàm ghi web, ví dụ tháng đã chốt. Lý do được chốt vào biên nhận, và gọi lại cùng `requestId` phát lại y nguyên.
  - *Từ chối trước khi ghi*: `state_changed`, `request_conflict`, token sai. Không có tác dụng nào xảy ra, nên biên nhận không bị chốt và có thể xem trước lại.
- **Thao tác ghi thẳng** (không cần xác nhận) ghi ngay ở lượt 1.
  - `requestId` vẫn do connector cấp và trả về trong kết quả hoặc trong lỗi `action_outcome_unknown`.
  - Mô hình tự gọi lại thì sinh mã mới. Rủi ro trùng giống tool ghi hiện nay; chỉ chấp nhận cho thao tác không tiền và lùi được.
- **Kết quả có tên.** Kết quả không trả UUID, trừ khi UUID nằm trong `link` tới trang web. Tiền là chuỗi số nguyên VND, như các tool đọc.

## 4. Ba tool ghi chung (phương án A)

Đo bằng `advertisedTool` thật. Script `do-byte-nen-chung.mjs` nằm ở scratchpad của phiên, không nằm trong repo. Câu đầu của mô tả ≤ 60 ký tự và có từ khoá ASCII, vì `tool_search` của Hermes xếp hạng BM25 trên token ASCII và danh sách chỉ hiện khoảng 60 ký tự đầu.

| Tool | Câu đầu mô tả (ký tự) | Tham số | Byte |
| --- | --- | --- | --- |
| `crm_action_list` | `List CRM write actions: expense, invoice, contract, task.` (57) | `page`: null / `expense` / `invoice` / `contract` / `task` | 498 |
| `crm_action_run` | `Run CRM write action (expense, invoice, contract, task).` (56) | `action`* (mẫu `^[a-z][a-z0-9_]{1,31}\.[a-z][a-z0-9_]{1,31}$`), `params` (object), `requestId` (uuid), `confirmToken` | 928 |
| `crm_action_status` | `CRM write action status by requestId.` (37) | `requestId`* (uuid) | 404 |
| **Cộng** | | | **1 830** (thêm vào `tools/list` ≈ 1 833 B kể cả dấu phẩy) |

Phần còn lại của mô tả `crm_action_run` (đã tính trong 928 B):
- `action` và `params` dùng đúng tên trong `crm_action_list`.
- Toà và phòng gửi bằng tên; tiền là số nguyên VND.
- `confirmation_required` nghĩa là CHƯA ghi. Bot đọc bản xem trước cho người dùng; chỉ khi họ đồng ý rõ mới gọi lại y nguyên, kèm `requestId` và `confirmToken`.
- `action_rejected`: báo đúng `detail` cho người dùng, không tự thử lại.
- `action_outcome_unknown`: gọi `crm_action_status` cùng `requestId`, không gọi lại.

Annotations:
- `crm_action_run`: `destructiveHint: true`, `idempotentHint: true`.
- `crm_action_list` và `crm_action_status`: `readOnlyHint: true`.

### 4.1 Kết quả

- **`crm_action_list`** trả:
  - `items[]` gồm `action`, `page`, `title` tiếng Việt, `confirm` (`always` / `never`), `params` (tên, kiểu, bắt buộc, giới hạn, ví dụ) và `nameParams`.
  - Danh sách chỉ có thao tác mà kết nối giữ khoá và khoá đang bật.
  - `organizationId` và `fetchedAt`.
- **`crm_action_run`** trả một trong ba khuôn kết quả thường, hoặc một lỗi:
  - cần thêm thông tin: `{outcome:'needs_input', applied:false, action, reason, detail, candidates?, huongDan}`. `reason` là một trong 7 mã dạng `needs_input` (mục 6.1). Đây **không** phải lỗi MCP (`isError: false`), để không dính rào "3 lời gọi bị từ chối" của Hermes;
  - xác nhận: `{outcome:'confirmation_required', applied:false, action, requestId, preview, warnings[], confirmToken, expiresAt, huongDan}`;
  - đã ghi: `{outcome:'applied', applied:true, action, requestId, result, link}`;
  - lỗi thật: `action_rejected` (quyền, nghiệp vụ), `action_outcome_unknown`, `confirmation_invalid` (mục 6).
- **`crm_action_status`** trả `{requestId, outcome: applied | rejected | not_found | unknown, action, result | reason+detail}`.
  - `not_found` nghĩa là chưa có biên nhận: chưa ghi, có thể chỉ mới xem trước.
  - `unknown` nghĩa là biên nhận đã mở nhưng chưa chốt.

### 4.2 Lỗi và mã broker

Mục 6.3 liệt kê mã broker mới. Lỗi khung dùng lại mã sẵn có: `tool_not_available` khi kết nối không có khoá thao tác nào, `forbidden`, `rate_limited`, `timeout`, `backend_unavailable`.

### 4.3 Chuyển sang phương án B mà không viết lại

- Danh mục thao tác là nguồn duy nhất. Mỗi mục có `page`.
- Phương án B *sinh* một tool cho mỗi trang từ cùng danh mục: `crm_<page>_action` với `operation` enum. `crm_action_status` dùng chung.
- Lõi chạy (`runAction(actionId, params, ctx)`), rào xác nhận, giải tên, lý do và SQL giữ nguyên. Chỉ đổi lớp mặt tool và bảng định tuyến tên tool → thao tác.
- Đo bản nháp B cho 3 trang + `crm_action_status` được 2 728 B, so với 1 830 B của A. Hermes tự kiểm được enum `operation`, nhưng vẫn không kiểm được `params`.
- Chọn A hay B là một hằng số trong `action-contract.mjs`. Test byte đo cả hai.

## 5. Danh mục thao tác

Mỗi trang khai thao tác của mình trong một file contract riêng, theo khuôn `wave2-*-contract.mjs`. Sổ chung kiểm khi nạp: mã trùng, khoá không có trong `capability-contract.mjs`, lý do ngoài danh sách đóng, khuôn tham số sai ⇒ lỗi nạp, không chạy.

```text
defineAction({
  id: 'contract.renew',            // <page>.<verb>, khớp mẫu của tool
  page: 'contract',
  key: 'contracts.renew',           // khoá Action Hermes (registry + capability-contract)
  class: 'money' | 'irreversible' | 'reversible',   // quyết sàn xác nhận (mục 8.1)
  params: { buildingName: name('building'), roomName: name('room'), months: int(1, 60), reason: text(8, 1000, optional) },
  preview: 'hermes_contract_preview_v1', apply: 'hermes_contract_apply_v1',   // RPC của trang
  reasons: ['room_has_no_active_contract', …],      // lý do riêng trang, phải có trong danh sách đóng
})
```

- **Kiểm tham số ở connector.** Hermes không tự kiểm được `params` tự do, nên connector kiểm theo khuôn trên:
  - khoá lạ;
  - thiếu trường bắt buộc;
  - sai kiểu hoặc khoảng giá trị;
  - chuỗi có ký tự điều khiển.
- **Gợi ý tĩnh khi sai.** Sai hoặc thiếu thì trả *kết quả* `needs_input` với lý do `invalid_params` và `detail` dựng từ khuôn, ví dụ "`months`: số nguyên 1–60". Câu gợi ý chỉ chứa tên tham số và mô tả kiểu lấy từ khuôn, không chứa giá trị mô hình gửi.
- **Kiểu tham số dự phòng cho ảnh.** Khuôn có sẵn kiểu `attachments`: mảng tham chiếu tới ảnh đã tải lên (không phải ảnh thô). Câu 11 chủ chọn làm đường nhận ảnh bill qua Zalo ở đợt Thu chi và dùng chung cho Công việc; Đợt 1 chỉ chừa kiểu, chưa làm luồng ảnh. Thao tác nào khai `attachments` mà chưa có luồng ảnh thì sổ danh mục từ chối khi nạp.
- **Chuẩn hoá trước khi kiểm.** Tên tham số kiểu snake_case và số tiền dạng chuỗi số (`"3500000"`) được chuẩn hoá trước khi kiểm, giống `normalizeToolArguments`. Đọc kiểu "3tr5" là việc của mô hình.
- **Danh mục production của Đợt 1 rỗng.** Test và TEST dùng danh mục thử `probe.*` (mục 12.4).

## 6. Lý do lỗi đọc được

### 6.1 Danh sách đóng dùng chung

Lý do nằm trong `infra/hermes-broker/action-reasons.mjs`. Mỗi mã có một câu tĩnh, một chỉ dẫn thử lại (`retry`) và một **dạng**:
- dạng `needs_input` (7 mã: `unknown_action`, `invalid_params`, `name_unresolved`, `reason_required`, `amount_out_of_range`, `date_out_of_range`, `not_found`): trả về như *kết quả thường* `outcome:'needs_input'`, không phải lỗi MCP. Đây đều là chỗ người dùng phải nói thêm hoặc sửa lại (thiếu lý do, số tiền hay ngày sai, không tìm thấy trong phạm vi), nên không được dính rào "3 lời gọi bị từ chối" của Hermes;
- dạng `rejected` (13 mã còn lại): lỗi `action_rejected` kèm `reason` + `detail`.

Câu chữ chốt nằm trong `action-reasons.mjs`; bảng dưới là tóm tắt.

| Mã | Câu cho người dùng (tĩnh) | `retry` | Nguồn |
| --- | --- | --- | --- |
| `unknown_action` | Không có thao tác này; xem `crm_action_list`. | sửa lệnh | connector |
| `invalid_params` | Tham số sai: {gợi ý từ khuôn}. | sửa lệnh | connector |
| `name_unresolved` | Chưa xác định được toà/phòng/người; hỏi lại người dùng. `detail` nêu ứng viên trong phạm vi quyền. | hỏi lại | hàm giải tên SQL (mục 7) |
| `action_disabled` | Thao tác này chưa được bật cho kết nối. | không | registry tắt / kết nối thiếu khoá |
| `not_allowed` | Anh/chị không có quyền làm thao tác này ở toà này. | không | 42501, phạm vi toà |
| `private_chat_only` | Lệnh ghi chỉ nhận trong chat riêng. | không | chính sách kênh (mục 8.2) |
| `state_changed` | Dữ liệu vừa đổi sau bản xem trước; cần xem trước lại. | xem trước lại | basis lệch, PT409, 40001 (gộp ba mã "dữ liệu vừa đổi" của Thu chi) |
| `request_conflict` | Mã yêu cầu này đã dùng cho lệnh khác; xem trước lại. | xem trước lại | biên nhận khác đầu vào |
| `period_locked` | Kỳ này đã chốt (lợi nhuận, sổ quỹ hoặc bàn giao); không ghi được. | không | `[PROFIT_LOCKED]`, `[CASHBOOK_CLOSED]`, `[HANDOVER_LOCKED]`, `[PERIOD_CLOSED]` |
| `cashbook_not_held` | Anh/chị không giữ sổ quỹ này. | không | không có quyền dùng sổ / không giữ sổ |
| `not_pending` | Phiếu đã vào sổ hoặc không còn chờ duyệt. | không | `Phiếu đã ghi sổ`, `Chỉ sửa được phiếu Chờ duyệt`, `Phiếu đã huỷ` |
| `reason_required` | Cần ghi lý do (ít nhất 8 ký tự). | sửa lệnh | 22023 lý do, trigger lý do gia hạn |
| `amount_out_of_range` | Số tiền vượt giới hạn cho phép. | sửa lệnh | `Tổng tiền phiếu vượt giới hạn`, kiểm khuôn |
| `date_out_of_range` | Ngày không hợp lệ (ngoài khoảng cho phép hoặc ở tương lai). | sửa lệnh | ngoài 2000–2100, ngày tương lai |
| `quota_exceeded` | Vượt hạn mức của CRM; thử lại sau. | sau | hạn mức tạo việc 30/giờ, 10/giờ/cặp… |
| `strict_mode` | Công ty đang bật chế độ chặt; thao tác này làm trên web. | không | `[STRICT_MODE]` |
| `web_only` | Trường hợp này phải làm trên web. | không | wrapper từ chối có chủ ý; kèm `link` |
| `not_found` | Không tìm thấy đối tượng trong phạm vi được xem. | sửa lệnh | wrapper |
| `duplicate_request` | Lệnh này đã được ghi trước đó. | không | 23505 khoá idempotency |
| `crm_refused` | CRM từ chối, chưa phân loại được lý do; kiểm trên web. | không | mọi lỗi lạ |

Mỗi trang thêm mã riêng vào cùng file khi làm trang đó, ví dụ:
- Thu chi: `system_voucher`, `evidence_required`.
- Hoá đơn: `invoice_not_collectible`, `nothing_to_collect`, `overpay_needs_choice`, `reverse_not_latest`, `reverse_not_own`.
- Hợp đồng: `room_has_no_active_contract`, `already_returned`, `renew_end_not_after_current`, `room_not_lockable`, `room_already_locked`, `cannot_remove_last_representative`, `customer_ambiguous`.
- Công việc: `loop_blocked`, `cancel_blocked`, `follow_exists`, `assignee_cannot_see_building`.

Đợt 1 chỉ khai 20 mã chung. Mã của trang vào cùng commit với thao tác của trang; test ở mục 12 bắt thiếu.

### 6.2 Ánh xạ từ SQL

- **Hàm ánh xạ dùng chung trong DB.** `app_private.hermes_action_reason_v1(p_sqlstate text, p_message text) RETURNS text` (IMMUTABLE) ánh xạ theo SQLSTATE và tiền tố thông điệp, theo quy tắc "công thức dùng chung đặt trong database".
- **Bắt lỗi ở wrapper ghi của trang.** Wrapper bắt lỗi của hàm ghi web bằng `EXCEPTION WHEN OTHERS` quanh lời gọi, lấy mã từ hàm trên, rồi chốt `{outcome:'rejected', reason}` vào biên nhận. Lỗi không mang theo thông điệp gốc ra ngoài.
- **SQLSTATE và câu thô chỉ nằm trong biên nhận.** Biên nhận (`app_private`, không ai đọc được ngoài DEFINER) giữ thêm `sqlstate` và 200 ký tự đầu của thông điệp, để phân loại các ca `crm_refused` về sau.
- **Connector chỉ nhận mã trong danh sách.** Connector kiểm `reason ∈ ACTION_REASONS`; ngoài danh sách thì đổi thành `crm_refused`. Mô hình không bao giờ nhận nguyên văn lỗi SQL, vì lỗi có thể chứa ID hoặc dữ liệu.
- **Lỗi thoát khỏi wrapper.** Lỗi PostgREST thoát ra ngoài wrapper (wrapper chưa có, hết giờ…) vẫn theo `bound-user-rpc.mjs`. Riêng RPC thao tác mới đổi thêm như sau:
  - PT409 → `state_changed`;
  - 42501 → `not_allowed`;
  - PGRST202 → `action_disabled` (hàm chưa áp: connector chạy trước migration).

### 6.3 Đường tới mô hình và sổ kiểm toán

- **Mã broker mới** (thêm vào `ERROR_STATUS`):

  | Mã | HTTP | Ghi chú |
  | --- | --- | --- |
  | `action_rejected` | 400 | kèm `reason` (dạng `rejected`) và `detail` = câu tĩnh của `reason` |
  | `action_outcome_unknown` | 503 | vào `MUTATION_UNKNOWN` và `REQUEST_RECEIPT_UNKNOWN`, kèm `requestId` |

  Bản thiết kế đầu có thêm `action_input_unresolved` (lỗi 400). Đã bỏ: tên không giải được nay là kết quả `needs_input` (mục 4.1).
- **`mcp-http.mjs`** chỉ chuyển `reason` và `detail` khi:
  - `reason ∈ ACTION_REASONS` và có dạng `rejected`;
  - và `detail` đúng là câu tĩnh của mã đó.
- **`host-ownership.mjs`.**
  - `CODES` thêm 2 mã trên.
  - Thêm tập `AUDIT_REASONS`.
  - Sự kiện audit nhận trường tuỳ chọn `reason`, hợp lệ khi và chỉ khi `code === 'action_rejected'` và `reason ∈ AUDIT_REASONS`.
  - Broker ghi `reason` vào audit, để đếm được lý do từ chối mà không phải đọc DB.
- **Test khoá.** `audit-codes.test.mjs` đã khoá `ERROR_STATUS ⊆ AUDIT_CODES` theo cả hai chiều. Đợt 1 thêm:
  - `ACTION_REASONS == AUDIT_REASONS`, cả hai chiều;
  - sổ audit thật nhận một dòng `action_rejected` cho mỗi mã lý do;
  - sổ audit từ chối mã lý do lạ.

  Thêm mã lý do mà quên `host-ownership.mjs` thì test đỏ ngay trong commit đó. Đây là đúng lớp sự cố 21/10.

## 7. Giải tên cho thao tác ghi

**Đã chốt (D7): luật khớp tên cho thao tác ghi nằm trong hàm SQL dùng chung**, theo quy tắc chủ chốt 17/10: công thức dùng ở ≥ 2 nơi (web + Hermes) hoặc dính tiền/quyền thì đặt trong database. Ghi tiền vào sai toà là sai tiền, nên luật này coi là dính tiền. Bản thiết kế đầu định chép luật sang connector; phương án đó đã bỏ.

- **Hàm.** `public.hermes_write_name_resolve_v1(p_organization_id uuid, p_building_ids uuid[], p_names jsonb) RETURNS jsonb`.
  - `SECURITY INVOKER`, `STABLE`, `SET search_path = ''` (mọi tên đều ghi đủ schema).
  - Từ chối (42501) khi `current_user <> 'authenticated'` hoặc `auth.uid()` rỗng.
  - Đọc dưới RLS của chính người gọi: `buildings`, `rooms`, `building_common_names` (đọc = ai xem được toà). Không có hàm DEFINER nào chép policy.
- **Ai gọi.** RPC xem trước của từng trang gọi hàm này trong cùng transaction, cùng JWT người dùng. Connector chỉ chuyển đối số và dựng `needs_input` từ kết quả; connector không tự khớp tên.
- **Kết quả.** `{status: 'resolved', building: {id, name}, room: {id, name} | null}` hoặc `{status: 'unresolved', field, wanted, candidates: [{name, buildingName}] (≤ 8), more: boolean}`.

| | Đọc (hiện có, ở connector) | Ghi (Đợt 1, trong SQL) |
| --- | --- | --- |
| Phạm vi | toà của khoá Đọc | toà của **khoá Ghi** của thao tác (`scopesByPermission[key]`, connector truyền vào `p_building_ids`) ∩ RLS |
| Toà | bỏ dấu, bỏ tiền tố "toà"; tên hoặc mã khớp bằng rồi chứa | như đọc, **cộng thêm**: (a) mã tách bí danh theo dấu phẩy như web `splitAliases` (`src/lib/textMatch.ts`); (b) tên thường gọi `building_common_names`; (c) so dạng gọn (chỉ chữ + số) cho mã. Khớp chứa chỉ nhận khi đúng **một** toà |
| Phòng | `hermes_room_directory_v1`: khớp bằng, không có thì chứa; tối đa 5 phòng trùng tên đi chung | **chỉ khớp bằng** tên hoặc mã sau khi bỏ dấu và bỏ tiền tố "phòng / ph / p" như `roomKey` của web. "20" không khớp "201". Không nêu toà ⇒ chỉ nhận khi đúng một phòng trong cả phạm vi |
| 0 khớp | lỗi `read_name_unresolved` | kết quả `needs_input`, `detail`: "Không thấy toà/phòng '…' trong phạm vi quyền của anh/chị." Câu nói rõ *trong phạm vi quyền*, không nói "không có": ca thử Công việc cho thấy một tài khoản chủ không thấy hồ sơ nhân viên do RLS `profiles` |
| ≥ 2 khớp | liệt kê | kết quả `needs_input`, `detail` liệt kê tối đa 8 ứng viên **trong phạm vi khoá ghi**, ví dụ "Phòng '201' có ở toà A, B, C, … — nêu toà." Không đoán |

- **Bỏ dấu trong SQL.** Hàm tự bỏ dấu bằng `translate` (bảng chữ có dấu tiếng Việt → không dấu, đ → d) rồi `lower`. Không phụ thuộc extension `unaccent`, vì chưa xác minh extension này có trên mọi môi trường (TEST, PGlite, Restore Drill).
- **Bộ vector dùng chung.** Bộ vector đặt ở `infra/hermes-broker/name-match-vectors.json`. Test PGlite của hàm SQL và test web (`src/lib/__tests__/jobQuickInput.test.ts`, test của `src/lib/quickEntry`) cùng đọc file này, nên luật của SQL không lệch luật web. Các ca:
  - "le van tho" khớp toà có dấu;
  - "Toà 44TL" và "toa 44tl";
  - bí danh số trong mã;
  - "15" khớp mã 15KV chứ không chứa trong "158PVC";
  - "P.302", "phòng 302";
  - "201" có ở nhiều toà.
- **Phần JS còn trùng.** Nếu buộc phải giữ một đoạn JS cùng luật (ví dụ để dựng `detail` hoặc test), đoạn đó đánh dấu `// hermes-parity:begin` … `// hermes-parity:end`.
- **Việc về sau (ngoài Đợt 1).** Web chuyển sang gọi cùng hàm SQL thay cho luật khớp đang chạy ở trình duyệt.
- **Câu đọc bằng lời** ("một lẻ hai…") của Báo chi nhanh *không* đưa vào. Kênh Zalo là chữ gõ, còn câu đọc bằng lời chỉ có ở trang nhập bằng giọng nói.
- **Phần riêng từng trang.** Mỗi trang cắm phần giải riêng vào hàm xem trước của trang: Hợp đồng tìm khách theo SĐT, Thu chi tìm mã phiếu, Hoá đơn tìm kỳ và hoá đơn, Công việc tìm người nhận. Đầu ra luôn là ID nằm trong phạm vi, kèm tên để dựng bản xem trước. Giải người phải nói rõ "không thấy trong phạm vi quyền của anh/chị".

## 8. Chính sách bật/tắt

### 8.1 Câu 2: thao tác nào phải xem trước

| Lớp (khai trong danh mục, qua review) | Sàn trong mã | Chính sách DB |
| --- | --- | --- |
| `money`: có tiền, gồm cả chi, thu, duyệt + chi | **luôn xác nhận** | chỉ siết được |
| `irreversible`: không lùi được, ví dụ ghi nhận trả phòng, huỷ phiếu đã vào sổ | **luôn xác nhận** | chỉ siết được |
| `reversible`: không tiền, lùi được, ví dụ khoá tạm phòng, ghi chú | không | `confirm`: `always` / `never`, mặc định `never` theo câu 2 |

- **Bảng chính sách.** Đặt ở `app_private.hermes_action_policies(action text PRIMARY KEY, confirm text CHECK (confirm IN ('always','never')), private_only boolean NOT NULL DEFAULT true, updated_at)`.
  - Bảng được seed bằng migration và đổi bằng migration riêng, qua lane.
  - Connector đọc bảng qua `hermes_action_capabilities_v1`.
  - Thiếu dòng hoặc giá trị lạ thì coi là `always` + `private_only`: đóng an toàn.
- **Máy chủ đòi xác nhận.** RPC xem trước có thể đòi xác nhận cho từng lần gọi (`confirm: 'required'`), ví dụ khi số tiền vượt ngưỡng hoặc có cảnh báo trùng kỳ. Connector lấy giá trị chặt hơn trong ba nguồn.
- **Sàn nằm trong mã, không nằm trong cấu hình.** Đây là hàng rào, không phải tuỳ chọn. Một dòng cấu hình sai không được biến lệnh chi tiền thành ghi thẳng. Muốn nới sàn phải đổi mã và qua review. Quyết định D2 ở mục 15.

### 8.2 Câu 3: chỉ nhận lệnh ghi trong chat riêng

**Hiện trạng đã tra:**
- `mcp-http.mjs` chấp nhận `_meta` ở `tools/call` nhưng bỏ đi, không chuyển cho broker.
- Hermes chỉ gửi `Authorization: Bearer hc_…`. Không có header nào mang loại chat, phiên hay profile.
- Adapter Zalo đặt cứng `chat_type="dm"`. Adapter chỉ nhận tin của đúng người đã ghép (`infra/hermes-zalo-native/adapter.py`). Worker chỉ đẩy tin có `threadId === pairedUid` (`worker/lib/hermes-native-bridge.js`).
- `infra/hermes-zalo-native/bridge.test.mjs` khẳng định tin nhóm, lịch sử, tin chuyển tiếp và echo không trở thành lệnh.
- Các tool `crm_group_*` là tool *gửi vào* nhóm, được gọi từ DM. Chúng không phải tin *từ* nhóm.

**Kết luận:** connector không biết loại chat. Hiện tại tin nhóm không tới được Hermes, nên "chỉ nhận lệnh ghi trong chat riêng" đang đúng, nhờ kênh chứ không nhờ connector.

| Phương án | Làm gì | Giới hạn |
| --- | --- | --- |
| **K1 (đề xuất, làm trong Đợt 1)** | Giữ rào kênh. Thêm test cấp profile: profile mang token CRM có khoá ghi chỉ bật nền tảng `zalo_personal` (`infra/hermes-zalo-native/profile-provisioning.mjs` chỉ ghi `platforms.zalo_personal`). Cờ `private_only` lưu sẵn trong bảng chính sách | Chỉ đúng khi profile không bật thêm nền tảng có nhóm, như Telegram, Discord hay `api_server`. Không phải rào ở connector |
| K2 (khi có kênh thứ hai) | Ghi loại kênh vào cột `app_private.hermes_connections.channel_binding`. Cột đã có sẵn, đang để "reserved" và chưa ai dùng. Control plane ghi lúc liên kết kênh. Connector đọc cột này qua capabilities RPC. Khi `private_only = true` mà loại kênh không phải DM, connector từ chối với `private_chat_only` | Chứng minh *kết nối* được cấp cho kênh DM, không chứng minh *từng tin* là DM. Đủ khi adapter chỉ nhận DM. Cần đường control plane ghi cột và một lần backfill cho 5 kết nối hiện có |
| K3 | Đọc loại chat trong `_meta` | Chưa xác minh Hermes upstream có điền `_meta` theo chat. Dù có điền thì đó là dữ liệu do client tự khai |
| K4 | Kết nối riêng chỉ có quyền Đọc cho mọi profile hoặc nền tảng có nhóm | Đúng khi nền tảng đó dùng token riêng |

Đề xuất: làm K1 ngay. K2 làm khi thêm kênh thứ hai, và phải xong trước khi kênh đó nhận token có khoá ghi. Nếu chọn K2 sớm hơn, phải backfill `channel_binding` cho 5 kết nối hiện có, nếu không mọi thao tác mới sẽ bị chặn. Quyết định D3.

### 8.3 Câu 5: đăng ký sẵn khoá ghi ở trạng thái TẮT

**Đã tra (đọc mã, chưa thử):**
- Bảng `app_private.hermes_capabilities(capability, mode, enabled DEFAULT false)`. Seed khoá TẮT theo mẫu `20261015120100`: `INSERT … ON CONFLICT DO NOTHING`. Bật bằng migration riêng, theo mẫu `20261015172059`.
- Màn tạo kết nối lấy danh sách khoá từ `hermes_connection_options_v7`. Các hook `hermes_*_extend_options_v1` chỉ thêm khoá đang `enabled`, nên **khoá TẮT không hiện**. SQL kiểm lại khi lưu (`hermes_validate_limits_v1`).
- Web và connector từ chối khoá không có trong `infra/hermes-broker/capability-contract.mjs`. Khoá mới phải vào hợp đồng này, và web phải build lại (bài học 19/10).
- Kết nối kiểu `inherit_crm` (`20261019034754`) có quyền = mọi khoá registry đang bật trừ `excluded_*`. Trigger chiếu lại mỗi khi registry đổi. Vì vậy **bật một khoá thì mọi kết nối `inherit_crm` nhận ngay khoá đó**; quyền CRM thật và trần chính sách công ty vẫn giao vào. Kết nối `legacy_allowlist` thì phải tạo lại.

**Cách làm đề xuất:**
1. Một migration seed TẮT mọi khoá ghi dự kiến của ba trang. Cùng promote đó thêm khoá vào `capability-contract.mjs` và nhãn ở `src/hermes/capabilityLabels.ts`. Các khoá:
   - Thu chi: `income_expenses.edit`, `income_expenses.cancel`, khoá duyệt riêng của Hermes `income_expenses.approve_vouchers` (tên tạm).
   - Hoá đơn: `meter_readings.create`, `invoices.edit`, `invoices.cancel`, `invoices.approve`. **Không** seed `thu_tien.collect`: chủ chọn không thu tiền mặt qua bot (câu 13) và không hoàn tác lần thu qua bot (câu 14), nên cũng không có thao tác hoàn tác lần thu.
   - Hợp đồng: `contracts.terminate`, `contracts.renew`, `contracts.edit`, `sale_phong.lock_room`, `contracts.create`, `contracts.transfer`.
   - Thêm khoá thử `assistant.action_probe`, chỉ bật trên TEST.
   - Tên chốt cuối cùng do plan từng trang quyết. Khoá nào trùng tên khoá CRM thì ánh xạ thẳng; khoá riêng của Hermes thì ánh xạ trong SQL.
2. Hàm `hermes_action_capabilities_v1` và hook options chung cho các khoá này, theo khuôn `hermes_expense_capabilities_v1` và `hermes_finance_extend_options_v1`.
3. **Điều kiện để chủ chỉ tạo kết nối một lần:** kết nối của chủ phải là `inherit_crm`. Phiên chính đã đọc production (chỉ đọc, 21/10): cả 6 kết nối ACTIVE đều `inherit_crm`, `scope_mode = unrestricted`, `excluded_read` và `excluded_action` rỗng; `hermes_org_policies` có 0 dòng (trần công ty trung tính); registry đang tắt 3 khoá `reports_finance.*`. Vậy không cần tạo lại kết nối: mỗi lần bật khoá bằng migration là kết nối nhận khoá.
4. **Mặt trái:** bật khoá là mọi kết nối `inherit_crm` của người có quyền CRM tương ứng nhận ngay, và hiện không có trần công ty nào chặn. Cả 6 kết nối hiện đều của chủ.
   - **Bắt buộc trước khi cấp Hermes cho hai Quản Lý Tòa** (câu 7: sau 1 tuần canary): hoặc làm O2, hoặc tạo kết nối của họ với khoá tiền nằm trong danh sách loại trừ. Không làm một trong hai thì kết nối của quản lý nhận mọi khoá tiền đang bật.

| Phương án | Nội dung | Công |
| --- | --- | --- |
| **O1 (đã chốt)** | Như trên. Dựa vào `inherit_crm`, trần chính sách công ty và sàn xác nhận cho thao tác tiền | trong Đợt 1 |
| O2 | Thêm cột `hermes_capabilities.opt_in`. Kết nối `inherit_crm` chỉ nhận khoá `opt_in` khi khoá nằm trong danh sách chọn lúc tạo. Màn tạo kết nối hiện cả khoá đang tắt với nhãn "chưa bật" | +1–1,5 ngày; đổi trigger quyền, màn web và hàm kiểm lúc lưu |

Đã chốt D5 = O1. Còn chưa xác minh: `hermes_validate_limits_v1` có nhận khoá đang tắt trong danh sách loại trừ không (cần cho cách thứ hai ở điểm 4).

## 9. SQL nền (migration dự kiến, chưa viết)

Tên migration lấy qua `scripts/tao-ten-migration.mjs` ở Mốc 6. Việc kiểm làm bằng PGlite và test offline. Phiên chính áp qua lane.

| # | Đối tượng | Kiểu | Việc |
| --- | --- | --- | --- |
| M1.1 | `app_private.hermes_action_receipts(organization_id, user_id, request_id, connection_id, action, input jsonb, basis text, state, result jsonb, sqlstate, message_head, created_at, finished_at)`, khoá chính `(organization_id, user_id, request_id)` | bảng; RLS bật, REVOKE mọi vai | một sổ biên nhận cho mọi thao tác mới |
| M1.2 | `app_private.hermes_action_context_v1(p_binding jsonb, p_action text)` | DEFINER | Kiểm binding: epoch, policy version, membership, authorization version, session revision. Đây là phần kiểm `hermes_expense_action_v1` đang làm inline; tách thành hàm chung. Kiểm thêm: registry bật, trần công ty, khoá của kết nối, quyền CRM thật. Trả `{organizationId, userId, connectionId, buildingIds, policy}` |
| M1.3 | `app_private.hermes_action_receipt_begin_v1` / `_finish_v1` | DEFINER | Mở biên nhận (`FOR UPDATE`). Trùng `requestId` + trùng đầu vào ⇒ phát lại; khác đầu vào ⇒ `request_conflict`; kết nối khác ⇒ PT409. Chốt kết quả, ghi audit `HERMES_ACTION_*` trong cùng transaction |
| M1.4 | `public.hermes_action_status_v1(p_binding, p_request_id)` | DEFINER, STABLE | Đọc biên nhận của chính người dùng và kết nối |
| M1.5 | `app_private.hermes_action_reason_v1(p_sqlstate, p_message)` | IMMUTABLE | Ánh xạ mục 6.2; chỉ trả mã trong danh sách đóng |
| M1.6 | `app_private.hermes_action_policies` + seed | bảng | Mục 8.1; thiếu dòng = đóng an toàn |
| M1.7 | `public.hermes_action_capabilities_v1(p_organization_id)` | DEFINER, STABLE | Với mỗi khoá thao tác: `allowed`, `companyEnabled`, `buildingIds`, theo khuôn `hermes_expense_capabilities_v1`; kèm chính sách từng thao tác |
| M1.8 | `public.hermes_write_name_resolve_v1(org, toà[], names jsonb)` | INVOKER, STABLE, `search_path=''` | Giải tên toà/phòng chế độ ghi (mục 7), từ chối khi `current_user <> 'authenticated'` |
| M2 | Seed registry TẮT (mục 8.3) + hook options chung | migration riêng | Không có tác dụng cho tới khi bật |

**Khuôn cho trang cắm vào sau** (không làm trong Đợt 1):
- `public.hermes_<page>_preview_v1`: INVOKER, STABLE, dựng `preview` + `basis` dưới RLS của người dùng.
- `public.hermes_<page>_apply_v1`: thân INVOKER. Hàm gọi M1.2/M1.3 (DEFINER) để kiểm và giữ sổ. Nó tính lại `basis` bằng cùng hàm đọc của preview (cùng transaction, sau `FOR UPDATE`), rồi gọi đúng hàm ghi web.
- Hàm ghi web tự kiểm `auth.uid()`. Không có hàm DEFINER nào chép policy.

## 10. Ngân sách byte `tools/list`

Đo bằng `node --test --test-name-pattern="every grantable key lists every family" infra/hermes-broker/tool-argument-shape.test.mjs` trên `origin/main` `27e0f9d10`, và bằng `advertisedTool` cho bản nháp.

| Trạng thái | Byte | So với trần 64 000 B |
| --- | --- | --- |
| Hiện tại: 65 tool | 63 832 | còn 168 |
| Sau Đợt 1 trên production (danh mục rỗng, ba tool ẩn) | 63 832 | còn 168 (không đổi) |
| Nếu hiện ba tool mà không rút chỗ khác | ≈ 65 665 | **vượt 1 665** |
| Hiện ba tool + tắt 3 tool phiếu chi cũ (`crm_expense_input_options` 700, `crm_expense_create` 1 742, `crm_expense_status` 710) | ≈ 62 510 | còn ≈ 1 490 |
| Hiện ba tool + bỏ `crm_task_input_options` (1 075) + `crm_expense_input_options` (700), giữ hai tool phiếu chi kia | ≈ 63 890 | còn ≈ 110 (quá sát) |
| Về sau: bỏ `crm_new_request_id` (531) khi mọi tool ghi cũ đã chuyển sang connector cấp requestId; gộp các `*_status` cũ vào `crm_action_status` | thêm ≈ −531 và hơn | |

**Hệ quả cho lộ trình:** thao tác thật đầu tiên chỉ hiện được khi họ phiếu chi cũ đã tắt (câu 4 của chủ), hoặc khi rút được ≥ 1 665 B ở chỗ khác. Nếu trang đầu tiên là Hợp đồng (việc của chủ) mà câu 4 chưa có trả lời, phải chọn nguồn rút khác. Quyết định D4.

**Test byte của Đợt 1:**
1. Production (danh mục rỗng) giữ đúng tập tool hiện nay và ≤ 64 000 B.
2. Danh mục thử: họ thao tác hiện khi và chỉ khi có thao tác đăng ký và được cấp. Họ thao tác và họ phiếu chi cũ **không bao giờ cùng hiện**, giống nguyên tắc "không quảng bá cả hai họ" của plan Thu chi. Tổng đủ quyền khi có họ thao tác ≤ 64 000 B.
3. Ba tool ≤ 2 000 B (trần riêng, như trần 1 600 B của hai tool meta đọc). Câu đầu mô tả ≤ 60 ký tự và có từ khoá ASCII.

## 11. Thứ tự phát hành

Thứ tự theo bài học R2a/B5c: connector chịu được cả bản cũ lẫn bản mới, rồi mới áp migration, rồi bật khoá, rồi cập nhật SOUL.

1. **Connector bản N, chịu được thiếu SQL.**
   - Nội dung: `confirm-guard`; tin pass phòng chuyển sang module chung, không đổi hành vi; khung thao tác với danh mục rỗng; 2 mã broker + lý do trong `host-ownership.mjs`.
   - Broker và `host-ownership.mjs` nằm cùng gói phát hành, đổi cùng lúc khi đổi symlink.
   - Khi `hermes_action_capabilities_v1` chưa có (PGRST202): họ thao tác ẩn.
   - Production không đổi một byte `tools/list`.
2. **Migration M1** (SQL nền), áp lên TEST rồi production qua `migrate:forward`. Vì có hàm public mới nên chạy `gen:types`.
3. **Migration M2** (seed khoá TẮT + hook options) **cùng một lần promote web** có khoá trong `capability-contract.mjs` và nhãn. Chủ tạo lại kết nối một lần nếu đang là `legacy_allowlist` (mục 8.3).
4. **Trên TEST:** bật `assistant.action_probe` bằng script TEST (không phải migration bật trên production), rồi chạy bộ ca bot (mục 12.5).
5. **Từng trang về sau:** SQL của trang → connector khai thao tác → migration bật khoá → SOUL bản 5 nêu luật hai lượt → canary có chủ duyệt.

## 12. Kế hoạch test

### 12.1 Offline (`node:test`)

- **`confirm-guard.test.mjs`**:
  - token chỉ dùng một lần;
  - TTL 10 phút, biên đúng 10 phút, đồng hồ lùi;
  - lệch từng phần khoá (kết nối, action, params, requestId) thì từ chối;
  - đầy 1 024 token thì bỏ token cũ nhất;
  - định dạng `cf_` + 43 ký tự;
  - tách `confirmToken` trước validator: accessor, khoá không enumerable, null hoặc chuỗi rỗng;
  - khởi động lại broker thì mất token chờ.
- **Thí điểm tin pass phòng:**
  - `public-text-guard.test.mjs` (5 test), `room-pass-upsert.test.mjs` (9), `room-pass-upsert-composition.test.mjs` (3) phải xanh **mà không sửa một dòng test**;
  - câu `huongDan` giữ nguyên từng chữ.
- **`action-contract.test.mjs`**:
  - sổ danh mục từ chối mã trùng, khoá lạ, lý do lạ, khuôn sai;
  - kiểm tham số trả đúng gợi ý tĩnh;
  - `crm_action_list` chỉ liệt kê thao tác được cấp;
  - định tuyến A và B ra cùng thao tác.
- **`action-broker.test.mjs`** với danh mục thử, kiểm cả luồng:
  - thao tác `money` luôn xác nhận dù chính sách ghi `never`;
  - thao tác `reversible` ghi thẳng khi chính sách là `never`, xác nhận khi là `always`;
  - chính sách thiếu thì đóng an toàn;
  - requestId được cấp và trả về;
  - lượt 2 đổi params hoặc requestId thì `confirmation_invalid`;
  - phát lại theo requestId;
  - mất phản hồi sau khi gửi thì `action_outcome_unknown` + requestId;
  - từ chối có `reason` không bị đổi thành mã bất định (cờ `uncertain` tắt khi đã nhận phản hồi đủ khuôn);
  - `private_only` theo K1/K2.
- **`action-reasons.test.mjs`**:
  - mỗi mã có câu tĩnh;
  - `mcp-http` chỉ chuyển mã và câu trong danh sách;
  - `detail` gán bậy không tới mô hình.
- **`infra/hermes-runtime/audit-codes.test.mjs` mở rộng** như mục 6.3.
- **`needs_input` không phải lỗi**: thao tác lạ, tham số sai/thiếu, tên không giải được trả `isError: false`; ba lần liên tiếp như vậy không sinh lỗi MCP nào (rào "3 lời gọi bị từ chối" của Hermes không bị chạm).
- **`tool-argument-shape.test.mjs`** thêm 3 phép đo ở mục 10.
- **`tool-plan-cases.mjs`** thêm ca khung:
  - thao tác lạ ⇒ gọi `crm_action_list`;
  - mất phản hồi ⇒ `crm_action_status`;
  - `confirmation_required` ⇒ không tự gọi lượt 2.

### 12.2 PGlite (SQL nền)

- Biên nhận:
  - mở / phát lại / `request_conflict` / kết nối khác;
  - từ chối trước khi ghi không chốt biên nhận;
  - từ chối cuối được chốt và phát lại.
- `hermes_action_reason_v1`: bảng câu lỗi thật của hàm ghi web, chép từ ba plan chi tiết, mỗi câu ra đúng một mã; câu lạ ra `crm_refused`.
- `hermes_action_capabilities_v1`:
  - registry tắt, trần công ty, kết nối thiếu khoá đều ra `allowed=false`;
  - chính sách thiếu dòng thì đóng an toàn.
- `hermes_action_context_v1`: lệch epoch, session hay membership ⇒ PT409 hoặc 42501.
- `hermes_building_directory_v2`: tên thường gọi của toà ngoài danh sách không xuất hiện.

### 12.3 Kiểm đột biến

Theo Contract §8 cho quyền và tiền: gỡ từng rào thì phải có test đỏ. Các rào cần thử:
- dùng một lần;
- TTL;
- khoá token;
- sàn xác nhận;
- chính sách thiếu thì đóng an toàn;
- danh sách lý do ở `mcp-http`;
- `AUDIT_REASONS`;
- kiểm binding trong `hermes_action_context_v1`;
- biên nhận khác đầu vào.

Ghi băm file trước và sau mỗi lần thử, và khôi phục theo quy trình ở CODEBASE_STRUCTURE.

### 12.4 Danh mục thử

Danh mục thử gồm `probe.note` (lớp `reversible`) và `probe.confirm` (lớp `money` giả), dưới khoá `assistant.action_probe`.
- RPC thử chỉ ghi biên nhận và audit, không đụng bảng nghiệp vụ nào.
- Offline dùng writer giả.
- Trên TEST bật bằng script TEST để chạy bot thật. Production seed TẮT và không bao giờ bật.
- Đề xuất này cần phiên chính chốt (D6). Nếu không làm, ca bot thật phải chờ thao tác thật đầu tiên của trang.

### 12.5 Ca bot thật trên TEST (phiên chính chạy, connector TEST cổng 8741)

| Mã | Câu / tình huống | Đạt khi |
| --- | --- | --- |
| N1 | "ghi chú thử: kiểm nền chung" (`probe.note`) | 1 lượt, ghi thẳng, kết quả có `requestId`; biên nhận `applied` |
| N2 | "xác nhận thử 1.000đ" (`probe.confirm`), người dùng "đồng ý" | lượt 1 không có biên nhận; lượt 2 kèm token + requestId; biên nhận `applied`; thời gian tới bản xem trước khoảng 15 s |
| N3 | Như N2, người dùng "thôi" | không có lượt 2; không có biên nhận |
| N4 | Như N2, người dùng đổi nội dung sau khi xem ("à 2.000đ") | bot xem trước lại, token mới; không ghi bản cũ |
| N5 | Đồng ý sau hơn 10 phút | `confirmation_invalid` ⇒ bot xem trước lại, không ghi bằng token cũ |
| N6 | Đổi `basis` trên TEST giữa hai lượt (script đổi dòng thử) | `state_changed` ⇒ bot xem trước lại |
| N7 | Tên thao tác sai hoặc tham số sai | bot gọi `crm_action_list` hoặc sửa theo gợi ý; ≤ 1 lượt thừa |
| N8 | Tên toà không dấu, mã có tiền tố "toà", "201" thiếu toà | khớp đúng; "201" thì bot hỏi lại toà, không đoán |
| N9 | Kết nối thiếu khoá thử | tool ẩn hoặc `action_disabled`; bot nói không có quyền |
| N10 | Bot có tự gọi lượt 2 ngay trong cùng lượt trả lời không | đo khoảng cách từ xem trước tới xác nhận; 0 lần tự xác nhận khi người dùng chưa trả lời |

Mỗi ca chạy 3 lần. Chấm theo `app_private.hermes_action_receipts` và audit trên TEST, không chấm theo lời bot. Connection TEST loại trừ khoá `income_expenses.create` để `tools/list` không vượt trần khi có họ thao tác.

## 13. Các mốc hiện thực

Mỗi mốc là một commit có test xanh.

| Mốc | Nội dung | Migration | Công |
| --- | --- | --- | --- |
| 2 | `confirm-guard.mjs`; `public-text-guard.mjs` thành lớp chính sách trên module chung, giữ nguyên export và câu chữ; test thí điểm xanh nguyên | không | 0,5 |
| 3 | `action-reasons.mjs`, 2 mã broker, `mcp-http`, `host-ownership.mjs` (`AUDIT_REASONS`, trường `reason`), test kiểm toán | không | 0,5–1 |
| 4 | Sổ danh mục, ba tool (ẩn khi danh mục rỗng), định tuyến broker, kiểm tham số, danh mục thử, test byte, khuôn B | không | 1–1,5 |
| 5 | Hàm SQL `hermes_write_name_resolve_v1` (file migration, không áp) + bộ vector chung dùng cho PGlite và test web | có (file, không áp) | 1 |
| 6 | M1 + M2 (tên qua `tao-ten-migration`), PGlite, kiểm đột biến, adapter gọi RPC thật, chịu được thiếu hàm | có (file, không áp) | 1,5–2 |
| 7 | Nối chính sách 8.1/8.2; cập nhật `CONNECTOR.md`; review một lượt diff cuối theo Contract | không | 0,5 |

Worktree dùng junction `node_modules` trỏ tới checkout chính (nối ở Mốc 2); nhớ gỡ junction trước khi dọn worktree.

## 14. Rủi ro

| Rủi ro | Mức | Giảm |
| --- | --- | --- |
| Mô hình tự gọi lượt 2 ngay mà không chờ người dùng đồng ý. Token chỉ chứng minh bản xem trước đã được cấp | Cao, ở thao tác tiền | Mô tả tool + SOUL; ca N10 đo khoảng cách. Nếu thấy tự xác nhận: thêm khoảng chờ tối thiểu giữa xem trước và xác nhận (ví dụ ≥ 5 s, cấu hình được). Khoảng chờ chỉ là heuristic, không phải bằng chứng đồng ý |
| Vượt trần byte khi hiện họ thao tác | Chắc chắn nếu không rút chỗ | Ẩn cho tới khi rút đủ byte; test loại trừ họ phiếu chi cũ; D4 |
| Bật khoá ⇒ mọi kết nối `inherit_crm` nhận ngay | Vừa, tăng khi có kết nối của quản lý | Sàn xác nhận; trần chính sách công ty; O2 nếu cần chọn từng kết nối |
| Câu lỗi của hàm ghi web đổi ⇒ lý do rơi về `crm_refused` | Thấp, an toàn | Bảng câu thật trong test PGlite; tầng 2 trên TEST theo plan từng trang |
| Khớp chứa tên toà sai | Thấp | Chỉ nhận khi đúng một toà; bản xem trước nêu tên toà để người dùng bắt lỗi |
| Khởi động lại connector làm mất token chờ | Thấp | Người dùng xem trước lại; không mở đường ghi |
| Mô hình nhét `params` ra cấp ngoài, hoặc gửi chuỗi JSON | Vừa | Hermes chặn khoá lạ ở cấp ngoài (`additionalProperties: false`); `normalizeToolArguments` có thể đọc `params` dạng chuỗi JSON (đo ở N7) |
| Phát hành sai thứ tự làm đỏ cả họ | Vừa | Mục 11; connector chịu được thiếu hàm (PGRST202 ⇒ ẩn) |
| Kênh thứ hai dùng chung token có khoá ghi | Thấp hiện nay | K1 test cấp profile; K2 trước khi thêm kênh |
| Chia sẻ phiên song song (index, worktree) | Thấp | Chỉ stage file cụ thể; không `git stash`; commit WIP |

## 15. Quyết định đã chốt (phiên chính, 21/10)

| # | Quyết định | Đã chốt |
| --- | --- | --- |
| D1 | Câu 1: phương án A (ba tool chung) hay B (mỗi trang một tool) | **A** (chủ: dùng chung, đo trên TEST, kém thì tách); khuôn B dựng sẵn, đổi bằng một hằng số |
| D2 | Câu 2: sàn xác nhận cho `money`/`irreversible` nằm trong mã, cấu hình chỉ siết | **Có** |
| D3 | Câu 3: K1 ngay, K2 khi có kênh thứ hai | **K1** |
| D4 | Nguồn rút byte cho thao tác thật đầu tiên | **Tắt 3 tool phiếu chi cũ** (chủ đồng ý câu 4; draft PR #254 của phiên chính, đã áp TEST) |
| D5 | Câu 5: O1 (dựa vào `inherit_crm`) hay O2 (cờ `opt_in`) | **O1** (6/6 kết nối ACTIVE là `inherit_crm`); O2 hoặc loại trừ khoá tiền là điều kiện trước khi cấp Hermes cho Quản Lý Tòa |
| D6 | Danh mục thử `probe.*` + khoá `assistant.action_probe` (seed TẮT trên production, bật trên TEST) | **Có** |
| D7 | Luật khớp tên: chép sang connector + bộ vector chung với web, hay đưa vào hàm SQL | **ĐỔI: hàm SQL dùng chung** (INVOKER + RLS, `search_path=''`), vì sai toà khi ghi tiền là sai tiền; bộ vector dùng chung với test web; web chuyển sang hàm SQL là việc sau |
| D8 | Lỗi lạ: chỉ `crm_refused`, không chuyển nguyên văn lỗi SQL | **Có**. Câu thô chỉ lưu trong biên nhận để phân loại sau |
| D9 | Trường `reason` trong sự kiện audit host | **Có** |

Thêm từ ca thử Công việc trên TEST (bot thật, 21/10 18:24–18:47): thiếu/mơ hồ đầu vào trả kết quả `needs_input`, không phải lỗi (mục 4.1, 6.1).

## 16. Việc phiên chính phải làm

1. ~~Duyệt thiết kế: D1–D9~~ (đã xong 21/10).
2. Đọc production, chỉ đọc:
   - `permission_mode`, `excluded_action` của 5 kết nối;
   - công ty có hàng `hermes_org_policies` không;
   - `hermes_validate_limits_v1` có nhận khoá đang tắt trong danh sách loại trừ không.
3. Sau Mốc 6:
   - áp M1, M2 lên TEST rồi production qua lane;
   - chạy `gen:types`;
   - promote web cùng lúc với M2.
4. Phát hành connector bản N trước M1, theo thứ tự ở mục 11.
5. Bật `assistant.action_probe` trên TEST; chạy ca N1–N10, mỗi ca 3 lần; đồng bộ lại TEST nếu cần.
6. Xin chủ trả lời câu 4 (tắt 3 tool phiếu chi cũ) trước khi hiện thao tác thật đầu tiên.
7. SOUL bản 5: luật hai lượt, chỉ chat riêng, đọc `detail` khi bị từ chối.

## 17. Chưa xác minh

- Hermes upstream có điền `_meta` hay thông tin loại chat vào lời gọi MCP không. Chưa đọc source upstream.
- Màn tạo kết nối ẩn khoá tắt, và `inherit_crm` tự nhận khoá khi bật: kết luận từ đọc mã SQL và web, chưa thử trên TEST.
- Kiểu kết nối (`permission_mode`) của 5 kết nối production.
- Byte của ba tool là bản nháp mô tả. Con số chốt đo lại ở Mốc 4 bằng test thật.
- Giới hạn thật của client Hermes với `tools/list`. Trần 64 000 B là do test tự đặt; tài liệu trong repo nói hai cách khác nhau.
- `hermes_action_context_v1` tách được phần kiểm binding đang inline trong `hermes_expense_action_v1` mà không đổi hành vi hàm cũ. Hàm cũ giữ nguyên; chỉ hàm mới dùng bản tách.
- Snapshot băm thân hàm (`20261019034254_hermes_metadata_read_snapshot_v1.sql`) có phải cập nhật khi thêm capabilities RPC mới không.
