# Tạo công việc bằng giọng nói qua 9Router — kế hoạch đề xuất

> **For agentic workers:** Khi được giao triển khai, dùng `superpowers:subagent-driven-development` hoặc `superpowers:executing-plans` theo từng hạng mục. Các bước có checkbox để theo dõi.

**Goal:** Người dùng nói tiếng Việt, kiểm tra và sửa bản nháp, rồi bấm Tạo để lưu đúng một công việc trong iHomeCRM.

**Architecture:** Ghi âm trong trình duyệt → Edge Function xác thực → STT qua 9Router → trích xuất dữ liệu qua `llm-proxy` → đối chiếu danh mục được phép truy cập → biểu mẫu kiểm tra → người dùng tạo công việc qua luồng nghiệp vụ hiện hữu.

**Tech Stack:** React/TypeScript, MediaRecorder, React Hook Form + Zod, TanStack Query, Supabase Edge/RLS, 9Router. Runtime và runner theo manifest dự án.

**Trạng thái:** Bản đề xuất ngày 26/09/2026 theo yêu cầu lên kế hoạch; chưa triển khai tính năng. Chưa kiểm tra endpoint/model STT trên VPS. Phạm vi mặc định là trang Công việc trên desktop/mobile; đưa vào chat Copilot là giai đoạn sau.

**Tiếp nối:** Theo yêu cầu thử trên điện thoại, đã dựng trang lab độc lập; xem [phạm vi và bằng chứng mới](2026-09-26-voice-task-mobile-lab.md). Kế hoạch dưới đây vẫn dành cho bước tích hợp CRM sau khi đánh giá lab.

## Ràng buộc chung

- Tuân thủ `docs/engineering/PROJECT_CONTRACT.md`; không ghi dữ liệu nghiệp vụ org THẬT để thử nghiệm.
- Mọi key 9Router nằm server-side. Không thêm key vào biến `VITE_*` hoặc gọi VPS trực tiếp từ trình duyệt.
- AI chỉ đề xuất bản nháp; nút Tạo của người dùng là bước phát sinh dữ liệu.
- Kiểm quyền tại server/RLS, gắn user/org từ phiên đã xác thực; không tin user ID, org hoặc UUID do model tự tạo.
- Không tự tạo loại công việc, nhân viên, tòa nhà hoặc phòng mới từ lời nói.
- Bản nháp là trạng thái giao diện, không thêm trạng thái `DRAFT` vào bảng `jobs`.
- Công việc được tạo vẫn dùng trạng thái `IN_PROGRESS`, `visible_to_customer=false`; model không được điều khiển các trường này.
- Các giới hạn và tiêu chí bên dưới là mục tiêu thiết kế, chưa phải kết quả đo.

## 1. Căn cứ từ mã nguồn

| Thành phần hiện có | Ý nghĩa với tính năng |
|---|---|
| `src/components/tasks/TaskCreateDialog.tsx` | Desktop/mobile dùng chung dialog, có preview cú pháp nhập nhanh và gọi `useCreateJob`. Đây là điểm tích hợp chính. |
| `src/lib/jobQuickInput.ts` | Parser theo token cố định; hạn mặc định cuối ngày mai. Không ép lời nói tự nhiên thành chuỗi rồi đưa ngược vào parser. |
| `src/hooks/useJobs.ts` | Tạo bằng insert bảng `jobs` trong session user; chưa thấy cơ chế chống lặp yêu cầu riêng. Mutation đầu vào hiện là `any`, cần thu hẹp kiểu khi nối luồng mới. |
| `src/types/jobs.ts` | Có `deadline`, `assignee_id`, `assignee_name`; mức ưu tiên `NORMAL`, `LOW`, `URGENT`. |
| `src/copilot/ChatPanel.tsx` | Có Web Speech API tiếng Việt để điền ô chat; chưa phải nhận dạng âm thanh qua 9Router. |
| `src/components/chat-zalo/composer/VoiceRecorder.tsx` | Có mẫu ghi âm, chọn codec, nghe lại và giải phóng micro; tham khảo logic, không kéo hành vi gửi Zalo sang công việc. |
| `src/copilot/llmClient.ts`, `supabase/functions/llm-proxy/index.ts` | Có proxy chat, JWT/org, model allowlist, quota và usage. Chưa có đường nhận audio để STT. |

Nguồn khảo sát: commit `e1a0d2ac0312bba94148e974af2fb132303865a6`, trùng `origin/main` khi bắt đầu soạn. Chỉ xác minh source; không suy ra trạng thái production.

Tài liệu chính thức của [9Router STT](https://github.com/decolua/9router/blob/master/skills/9router-stt/SKILL.md) mô tả `POST /v1/audio/transcriptions` và khám phá model qua `GET /v1/models/stt`. [Route upstream](https://github.com/decolua/9router/blob/master/src/app/api/v1/audio/transcriptions/route.js) cũng có handler này. Khả năng upstream không chứng minh VPS hiện tại đã bật provider STT hoặc có credential tương ứng. Cần kiểm riêng model chat và model nhận dạng âm thanh.

## 2. So sánh phương án

| Phương án | Ưu điểm | Đánh đổi |
|---|---|---|
| **Ghi âm → STT qua 9Router → AI trích xuất → duyệt bản nháp** | Kiểm soát provider, đo riêng nhận dạng và trích xuất, dễ sửa chữ nghe sai | Cần đường upload và quota STT; đề xuất chọn |
| Web Speech API → AI qua 9Router | Tận dụng mic Copilot hiện tại, ít backend hơn | Nhận dạng không đi qua 9Router; phụ thuộc khả năng trình duyệt |
| Gửi audio trực tiếp cho model đa phương thức | Có thể gom nhận dạng và trích xuất | Phụ thuộc model và adapter thực tế; khó tách lỗi nghe sai với lỗi hiểu sai |

Chọn phương án đầu; chỉ chốt model STT sau khi đo trên instance thực. Không tự chuyển sang Web Speech hoặc provider khác nếu STT lỗi.

## 3. Trải nghiệm bản đầu

1. Trong hộp Thêm công việc, chọn **Nói để tạo việc**.
2. Bấm micro, cấp quyền nếu cần, nói tối đa 60 giây. Giao diện có thời gian, Dừng và Hủy.
3. Dừng để nghe lại; chọn **Phân tích** mới gửi âm thanh. Có thể ghi lại.
4. Xem phần chữ đã nghe và bản nháp có từng trường sửa được.
5. Xử lý các trường thiếu hoặc còn nhiều khả năng khớp, rồi bấm **Tạo công việc**.
6. Hiển thị việc vừa tạo; giữ bản nháp nếu lỗi để người dùng không phải nói lại.

Ví dụ: “Tạo việc sửa vòi nước phòng 201 tòa 1392QT, giao anh Nam, trước 5 giờ chiều ngày mai, việc gấp.”

Bản nháp: tòa 1392QT; phòng 201 thuộc tòa đó; loại Sửa nếu danh mục có; nội dung Sửa vòi nước; ưu tiên Gấp; hạn 17:00 ngày mai theo giờ Việt Nam. Nếu nhiều người tên Nam, buộc chọn người; không lấy kết quả đầu tiên.

Mỗi bản ghi tạo tối đa một việc. Nếu có nhiều yêu cầu độc lập, yêu cầu chọn một việc hoặc ghi lại. Đợt đầu chưa có nhập hàng loạt, hội thoại bằng giọng nói liên tục, nhắc việc tự động hoặc tự hạch toán vật tư/chi phí. Phần vật tư/đính kèm thủ công hiện có vẫn là thao tác riêng của người dùng.

## 4. Hợp đồng bản nháp và quy tắc đối chiếu

AI trả cấu trúc có kiểm tra Zod, gồm: nội dung, tên/mã tòa được nhắc tới, tên/mã phòng, phạm vi phòng/toàn tòa, loại việc, tên người nhận, ưu tiên và cụm thời gian nguyên văn. Kèm các điểm chưa rõ và trích đoạn làm căn cứ. Không nhận SQL, tool ghi hoặc UUID làm kết quả đáng tin.

- **Danh mục:** Tra bằng hook/service dưới JWT người dùng và khóa rõ org đang chọn. Các hook hiện tại có chỗ dựa vào RLS mà chưa lọc selected org; không giả định toàn bộ kết quả đã đúng org, nhất là phiên admin. Resolver và lần ghi phải xác minh quan hệ org/tòa/phòng/loại/người nhận. Chỉ gửi tên/mã tối thiểu của các ứng viên cần thiết cho model; không gửi toàn bộ hồ sơ cư dân, số điện thoại hoặc tài khoản ngân hàng.
- **Tòa/phòng:** Đối chiếu mã/tên/alias trong tập được phép. Phòng phải thuộc tòa đã chọn. Không có phòng không đồng nghĩa toàn tòa; phạm vi toàn tòa phải được nói hoặc chọn rõ.
- **Tên trùng:** Chuẩn hóa tiếng Việt để tìm ứng viên, nhưng không dùng việc bỏ dấu để tự quyết định khi có nhiều ứng viên. Danh mục chưa tải xong hoặc tải lỗi phải chặn xác nhận.
- **Loại việc:** Hỗ trợ tên nhiều từ như “Vệ sinh”. Không thấy loại phù hợp thì yêu cầu chọn; không gọi `useCreateJobType` tự động.
- **Người nhận:** Không được nhắc thì đề xuất người đang tạo, có nhãn mặc định như form hiện tại. Tên được nhắc nhưng không khớp thì giữ chưa giải quyết; người dùng có thể chọn nhân viên hoặc chủ động nhập tên người ngoài theo khả năng hiện hữu `assignee_name`.
- **Ưu tiên:** Mặc định `NORMAL`; chỉ chuyển `URGENT`/`LOW` khi lời nói hoặc chỉnh sửa thể hiện rõ. Không phát minh giá trị mới như `HIGH`.
- **Ngày giờ:** Chụp thời điểm tham chiếu một lần khi bắt đầu phân tích; diễn giải bằng `Asia/Ho_Chi_Minh`, không theo timezone thiết bị. Ngày đã hiểu phải hiển thị đầy đủ trước Tạo. “Chiều mai”, ngày thiếu năm hoặc câu không rõ cần người dùng chọn giờ/ngày; không đoán ngầm.
- **Không nói hạn:** Đề xuất cuối ngày mai theo giờ Việt Nam, ghi nhãn mặc định. Không có giờ nhưng có ngày rõ thì đề xuất cuối ngày và hiển thị nhãn.
- **Nội dung đã sửa:** Sau khi người dùng sửa transcript phải phân tích lại hoặc giữ bản nháp đã sửa có chỉ báo; không gửi bản nháp cũ như thể đã cập nhật. Sửa một trường không được AI âm thầm ghi đè.

Đề xuất interface dùng chung khi triển khai:

```ts
type VoiceTaskMention = {
  description: string;
  buildingText: string | null;
  roomText: string | null;
  scope: 'room' | 'building' | 'unspecified';
  jobTypeText: string | null;
  assigneeText: string | null;
  priority: 'NORMAL' | 'LOW' | 'URGENT' | null;
  deadlineText: string | null;
  issues: string[];
};
type VoiceDraftContext = {
  organizationId: string;
  referenceTime: string;
  timeZone: 'Asia/Ho_Chi_Minh';
  generation: number;
};
```

Resolver là hàm thuần nhận mentions + context + danh mục được phép, trả từng giá trị đã khớp và ứng viên chưa giải quyết. Payload tạo việc chỉ được dựng sau khi đủ trường bắt buộc. Schema phải từ chối key lạ và chuỗi vượt giới hạn được định nghĩa tại một nơi.

## 5. Backend, giới hạn và lỗi

**Endpoint mới `task-transcribe`:** Nhận multipart file + request ID + org context. Kiểm JWT, org được chọn, quyền `tasks.create`, entitlement/cờ AI và provider allowlist trước khi gọi upstream. Kiểm lại điều kiện khi xử lý kết quả; request từ phiên/org cũ phải bị loại. Tầng ghi DB tiếp tục kiểm quyền tại thời điểm tạo.

**Giới hạn khởi đầu đề xuất:** 60 giây/bản, 10 MiB/request, tối đa 1 request STT đang chạy/người dùng; timeout tổng 45 giây. Codec chọn theo `MediaRecorder.isTypeSupported`, ưu tiên webm/opus hoặc mp4 phù hợp trình duyệt và provider đã thử. Không chỉ tin phần mở rộng, MIME hoặc duration do client gửi. Nếu chưa đo duration đáng tin thì quota trừ mức dự trữ 60 giây; chặn file vượt giới hạn tại server. Không thêm bộ chuyển mã WASM nặng vào trình duyệt ở đợt đầu.

**Quota:** Tái sử dụng chính sách user/org/entitlement của Copilot, nhưng STT có đơn vị giây và số yêu cầu riêng; không biến độ dài audio thành token chat. Đề xuất mặc định pilot 10 phút/người/ngày và 60 phút/org/ngày, có cấu hình. Reserve/finalize có request ID duy nhất, TTL cho request treo và kiểm đồng thời. Retry cùng ID không được gọi upstream/tính phí lại; nếu request đã xong nhưng mất nội dung trả về, thông báo cần phân tích lại bằng ID mới. Không lưu transcript dài hạn chỉ để hỗ trợ retry.

**Extraction:** Dùng `llmClient`/`llm-proxy` với model chat 9Router được cho phép và prompt/schema chuyên dụng. Chỉ cho model trả cấu trúc, không đưa domain write tools vào lượt này. Kiểm schema, enum, trường bắt buộc và cách ly org bằng code sau response. Nội dung audio/transcript là dữ liệu, không được thay đổi system instruction. Chặn kết quả cũ bằng generation + org snapshot + AbortController.

**Lỗi cần UX riêng:** Không có/quyền micro bị từ chối; audio trống/không đọc được; vượt thời lượng/dung lượng; không có provider STT; hết quota; upstream lỗi/timeout; JSON sai; tên trùng; đổi org; hết phiên; tạo việc mất phản hồi. Cho phép ghi lại, sửa chữ, chọn lại trường hoặc nhập thủ công tương ứng. Không tự tạo việc sau retry phân tích.

**Chống tạo trùng:** Khi xác nhận lần đầu, cấp một UUID công việc và cố định payload, user, org cho lần gửi đó. Truyền UUID qua typed create service tới khóa chính `jobs.id`; thử trên TEST rằng trigger/RLS cho phép và giữ nguyên ID. Nếu mất response, chỉ đọc lại đúng ID trong org ban đầu khi phiên còn cùng phạm vi; đổi org thì dừng luồng, không truy vấn bằng org mới. Nếu chưa xác định được thì giữ trạng thái chưa rõ, không phát UUID mới và không tạo lại mù. Các lần retry cùng payload dùng cùng ID. Chặn bấm đôi là lớp UI bổ sung. Nếu DB không hỗ trợ điều kiện này, hạng mục backend phải thêm RPC idempotent qua migration trước khi mở pilot.

**Quan hệ dữ liệu ở lần ghi:** Database phải bảo đảm tòa và loại việc thuộc org của job, phòng thuộc đúng tòa/org và người nhận thuộc phạm vi hợp lệ. Kiểm bằng JWT các payload cố tình trộn ID thuộc hai org. Nếu RLS/constraint hiện hữu chưa bảo đảm thì bắt buộc bổ sung qua migration trước pilot; kiểm ở client không thay lớp bảo vệ này.

**Vật tư thủ công khi mất phản hồi:** Theo dõi riêng trạng thái tạo job và lưu vật tư. Readback tìm thấy job chỉ chứng minh job đã tạo; vật tư có thể chưa ghi. Giữ dữ liệu người dùng đã chọn và thông báo rõ phần chưa hoàn tất/chưa xác định. Không tự thực hiện lại thao tác kho và không báo toàn bộ đã hoàn tất. Pilot bảo đảm tối đa một job; thao tác vật tư chưa rõ được xử lý bằng luồng nghiệp vụ có xác nhận hiện hữu.

**Dữ liệu và log:** Mặc định audio/transcript chỉ sống trong phiên xử lý, không ghi file vào R2 hay log ứng dụng; giải phóng Blob, object URL và micro khi đóng/hủy. Chỉ lưu nội dung công việc đã duyệt và metadata kỹ thuật tối thiểu như request ID, user/org, model, duration, latency, trạng thái. Kiểm cấu hình log/retention của 9Router và upstream trong bước preflight; không cam kết provider xóa dữ liệu khi chưa xác minh. Nếu sau này muốn lưu audio làm chứng từ, thiết kế riêng retention/quyền truy cập qua R2 hiện hữu.

## 6. Các hạng mục triển khai

### P0 — Kiểm chứng 9Router và khóa hợp đồng tích hợp

- [ ] Kiểm version, STT discovery, model/credential khả dụng từ backend; không in secret.
- [ ] Gửi mẫu tiếng Việt tổng hợp không có dữ liệu thật: mã tòa, số phòng, tên có dấu, câu ồn; kiểm ít nhất webm và mp4 từ thiết bị đích.
- [ ] Đo transcript, latency, lỗi/quota và chính sách logging; chọn model STT theo kết quả. Không lấy model chat hiện tại làm STT mặc định.
- [ ] Chốt cách kiểm duration, giới hạn và giá/chi phí thực tế. Nếu thiếu provider STT, ghi rõ cấu hình cần thêm rồi tiếp tục phần giao diện dùng mock.
- [ ] Ghi bằng chứng gọn vào `docs/engineering/voice-task-9router-capability.md` khi triển khai.

**Đầu ra:** Một model STT + request/response đã thử, mẫu audio tương thích, giới hạn thực tế; là điều kiện mở pilot.

### P1 — Bản nháp có cấu trúc, đối chiếu và kiểm ngày giờ

**Tạo:** `src/lib/tasks/voiceTaskSchema.ts`, `voiceTaskResolver.ts`, `voiceTaskClient.ts`; `src/lib/tasks/__tests__/voiceTaskResolver.test.ts`.

- [ ] Khai schema mentions, resolved draft, issues; định nghĩa giới hạn từng chuỗi và adapter sang payload create.
- [ ] Viết test tên trùng, loại nhiều từ, phòng sai tòa, ngày mai qua nửa đêm, timezone máy khác Việt Nam, dữ liệu không thuộc org; chạy test phải đỏ trước khi viết resolver.
- [ ] Viết resolver, client extraction giới hạn schema; chạy lại các ca trên và test parser nhập nhanh cũ.
- [ ] Kiểm prompt chỉ nhận dữ liệu cần thiết; model trả UUID/field lạ/instruction phải bị từ chối.

**Đầu ra:** Transcript giả lập tạo được bản nháp sửa được; chưa cần microphone hoặc STT sống.

### P2 — STT backend và kiểm soát tài nguyên

**Tạo:** `supabase/functions/task-transcribe/index.ts`, `transcription.ts`, `index.test.ts`, `deno.json`, lock theo chuẩn function hiện hữu. Cập nhật `supabase/config.toml`, `tooling/test-matrix.json` và surface Edge.

- [ ] Viết handler tests cho JWT thiếu/hết hạn, không có quyền, sai org, file rỗng/quá cỡ, duration không tin cậy, quota đồng thời, duplicate ID, timeout và cleanup reservation.
- [ ] Tách phần policy dùng chung cần thiết từ proxy theo phạm vi hẹp nếu tái sử dụng; giữ test hồi quy proxy. Không copy nguyên proxy sang function mới.
- [ ] Thêm quota STT theo giây/request. Cấp tên migration bằng `node scripts/tao-ten-migration.mjs task_voice_stt_usage`; xác minh RLS/ACL, unique request và reserve/finalize trên môi trường TEST.
- [ ] Bọc gọi 9Router bằng timeout/abort, giới hạn response, không retry ngầm; không trả stack/upstream secret về UI.
- [ ] Chạy Deno handler tests, JWT role thật, concurrency, kiểm đột biến các invariant quyền/org/quota; nối suite vào runner thật.

**Đầu ra:** STT trả transcript hoặc mã lỗi rõ, không tạo dữ liệu công việc; quota và org được đo bằng test.

### P3 — Ghi âm và màn hình kiểm tra chung desktop/mobile

**Tạo:** `src/hooks/useAudioRecorder.ts`, `src/hooks/useTaskVoiceDraft.ts`, `src/components/tasks/VoiceTaskInput.tsx`, `TaskDraftEditor.tsx`, `src/components/tasks/__tests__/VoiceTaskInput.test.tsx`.

**Sửa:** `src/components/tasks/TaskCreateDialog.tsx`; entry point trong `src/pages/TaskManagementPage.tsx` và `src/pages/TasksMobilePage.tsx` để gate quyền nhất quán. Desktop hiện chưa có gate nút Thêm tương ứng với mobile; backend vẫn là lớp quyết định.

- [ ] Làm recorder với start/stop/cancel, 60 giây, preview, MIME thực và cleanup cả trường hợp xin quyền xong sau khi dialog đã đóng.
- [ ] Dùng hook điều phối state: idle → recording → review audio → transcribing → extracting → reviewing → submitting → done/error.
- [ ] Hiển thị bản nháp bằng RHF/Zod, đánh dấu trường mặc định/chưa rõ; chỉ cho Tạo khi đã giải quyết đầy đủ và session/org còn đúng.
- [ ] Kiểm mất mạng, cancel giữa request, đổi org, đóng/mở dialog và response về sai thứ tự; giữ sửa tay, không áp kết quả cũ.
- [ ] Giữ đường nhập nhanh hiện tại và ảnh/vật tư thủ công hoạt động. Lazy-load phần voice nếu làm tăng tải trang.

**Đầu ra:** Một luồng desktop/mobile xuyên suốt với mock provider, giao diện lỗi và sửa bản nháp đầy đủ.

### P4 — Lưu công việc đúng một lần và kiểm phân quyền

**Sửa:** `src/hooks/useJobs.ts`; **tạo:** `src/lib/tasks/createVoiceTask.ts`, `src/lib/tasks/__tests__/createVoiceTask.test.ts`.

- [ ] Thu hẹp create input thành kiểu dựa trên generated Insert; trường do hệ thống sở hữu không lấy từ AI. Không sửa generated types bằng tay.
- [ ] Dùng UUID ổn định + frozen payload/user/org; đọc lại kết quả khi response mất. Test riêng job đã tạo nhưng vật tư chưa ghi/chưa rõ; giữ các lựa chọn và báo đúng phần chưa hoàn tất, không retry kho tự động.
- [ ] Thử bấm đôi, timeout sau DB commit, retry, đổi org, user bị thu quyền sau preview; xác minh đúng một job hoặc bị từ chối đúng lý do.
- [ ] Chạy JWT/RLS cho vai được tạo, vai chỉ đọc, user khác org, phòng ngoài phạm vi và payload trộn org của tòa/loại/phòng/người nhận. Bổ sung ràng buộc backend còn thiếu và review độc lập trước pilot.

**Đầu ra:** Click Tạo là điểm ghi duy nhất, mọi retry cùng lần xác nhận không nhân đôi công việc.

### P5 — Nghiệm thu và mở thử có kiểm soát

**Tạo:** `.e2e-fleet/specs/tasks-voice-create.spec.ts`; **cập nhật:** hướng dẫn nghiệp vụ và manifest nếu thêm vào corpus Copilot.

- [ ] Chạy unit đã nêu, Deno function, `npm run typecheck:baseline`, `npm run build`, `npm run gate:bundle`; kiểm surface/generated types nếu đổi schema.
- [ ] Chạy E2E headless trên TEST hoặc fixture DEMO có dọn: `npx playwright test specs/tasks-voice-create.spec.ts --reporter=list --trace=off` từ `.e2e-fleet/`; kiểm console errors và chứng cứ đúng commit.
- [ ] Kiểm mic thật trên Chrome/Edge desktop, Chrome Android và Safari iPhone; mic giả lập không thay bằng chứng codec/quyền trên thiết bị thật.
- [ ] Bộ đánh giá ít nhất 30 câu tiếng Việt gồm mã tòa/phòng, tên trùng, loại nhiều từ, hạn tương đối, tiếng ồn và câu có instruction lạ. Mục tiêu pilot ≥90% trường rõ nghĩa đúng trên bộ đã chốt; 100% ca mơ hồ phải yêu cầu xác nhận/chỉnh sửa.
- [ ] Mục tiêu độ trễ P95 dưới 15 giây sau khi gửi audio dài tối đa 20 giây; báo số đo thật và điều kiện mạng/model, điều chỉnh mục tiêu nếu đo không đạt.
- [ ] Bật feature flag theo org thử; có công tắc tắt voice mà người dùng vẫn tạo việc thủ công. Theo dõi tỷ lệ sửa draft, lỗi STT, giây audio và token extraction riêng.
- [ ] Review độc lập phần Edge/quyền/schema, draft PR khi có thay đổi quyền hoặc migration; chạy gate dự án và phát hành theo Contract §3–5. Không apply migration/deploy trong lượt lên kế hoạch này.

**Điều kiện đạt:** Preview không tạo job; Tạo lưu đúng trường, đúng org và tối đa một job; không rò key/audio trong log; không giữ micro sau đóng; fallback nhập tay dùng được; quota có bằng chứng concurrency; có kiểm thiết bị thật.

## 7. Thứ tự và ước lượng

P0 chạy trước phần tích hợp provider. P1 và phần recorder/UI dùng mock có thể làm song song; P2 cần hợp đồng P0; P3 nối P1+P2; P4 trước P5.

Ước lượng cho một người triển khai có review: P0 0,5–1 ngày; P1 1 ngày; P2 1–2 ngày; P3 1–1,5 ngày; P4 0,5–1 ngày; P5 1–1,5 ngày. Tổng khoảng **5–8 ngày làm việc** nếu STT đã có provider khả dụng. Đây là dự toán, chưa tính thời gian cấu hình nhà cung cấp mới hoặc xử lý lỗi hạ tầng ngoài phạm vi.

Giai đoạn sau có thể tái dùng service bản nháp trong Copilot, thêm file audio có sẵn, hoặc chia một bản ghi thành nhiều việc. Mỗi mở rộng cần thiết kế cơ chế xác nhận và nghiệm thu riêng.

## 8. Phần đã và chưa xác minh

- Đã đọc Contract, các source nêu trên, runner/risk manifest và tài liệu upstream 9Router; khảo sát độc lập module Tasks và Copilot.
- Chưa gọi VPS/credential STT, chưa kiểm danh mục provider thực tế, giá, chất lượng nhận dạng hay retention upstream.
- Chưa xác minh RLS/trigger jobs, idempotency hoặc quyền create bằng JWT trên database sống.
- Chưa viết code tính năng, chưa chạy unit/build/E2E hoặc ghi dữ liệu thử. Các lệnh và tiêu chí trên là công việc của lượt triển khai.
- Phạm vi trang Công việc là đề xuất mặc định; có thể chuyển vị trí sang Copilot mà giữ phần ghi âm/STT/resolver, nhưng cần thêm hợp đồng xác nhận tool trước khi cho chat tạo việc.
