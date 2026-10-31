# Học có kiểm duyệt cho Hermes (đợt 2 kế hoạch trị tận gốc — chủ duyệt 31/10/2026)

**Trạng thái:** (1) job kiểm học tập, (2) kho đề xuất + trang duyệt, (4) timer: đã viết trong cùng PR (đã sửa theo review chéo
REQUEST CHANGES 31/10) — **chưa áp migration, chưa cài trên VPS**. (3) tin Zalo 21:00 + duyệt qua Zalo: **thiết kế + khung**
(mục 4), chưa nối connector, khoá chưa seed. Cài đặt/vận hành: [infra/hermes-learning-audit/README.md](../../../infra/hermes-learning-audit/README.md).

**Hành vi hiện tại (nói đúng với chủ):** bài học đã có hiệu lực từ lúc curator/trợ lý tự ghi; job chỉ phát hiện và đưa đi
duyệt. "Duyệt" ghi nhận bài học đúng; "Bỏ" **chỉ ghi nhận** — gỡ bài học khỏi trợ lý do điều phối viên làm tay (mục 6).

**Chờ chủ quyết (để khung linh hoạt, chưa chốt):**
- Duyệt **trước** hay **sau** khi bài học có hiệu lực (trước = cần hook chặn trong Hermes; hiện là sau).
- Ai được xem nội dung đề xuất; lưu nguyên văn hay chỉ tóm tắt; sau quyết định có xoá/che nội dung không. Hiện: lưu nội dung
  đã che bí mật + thông tin cá nhân hiển nhiên; bảng có khung **che một lần sau quyết định** (`redacted_at/redacted_by`, chưa có
  RPC); trigger **không** cấm xoá (chưa có RPC xoá) để chủ chọn chính sách lưu/xoá sau.

## 1. Vì sao

31/10 curator Hermes ("Self-improvement review") ghi tên tool đã nghỉ hưu `crm_task_create` vào skill local
`crm-task-management` của hồ sơ owner ⇒ bot báo "công cụ tạo việc CRM hiện không khả dụng" dù `crm_action_run task.create`
làm được. Nghiệm thu chạy trên hồ sơ TEST (skill chuẩn, phiên mới) nên không thấy. Chủ **giữ** tự học, chốt áp dụng "tuỳ loại":

- sở thích / cách nói chuyện / việc trợ lý ngoài CRM ⇒ tự áp dụng;
- bài học về cách **ghi** dữ liệu CRM ⇒ chỉ là đề xuất, phải được duyệt; duyệt ở **cả hai** nơi: Zalo mỗi tối (nhanh) và
  trang CRM (xem kỹ, tra lịch sử).

## 2. Luồng

```mermaid
flowchart LR
  C[Curator / trợ lý sửa skill, bộ nhớ] --> P[(Hồ sơ Hermes trên host)]
  P -->|20:40 VN, chỉ đọc, sandbox| A[learning_audit.py — làm sạch + che trước khi rời hồ sơ]
  A -->|private/ 0700: báo cáo đủ| R[(Chỉ user job kiểm)]
  A -->|outbox/ 0640: chỉ đề xuất| I[ingest.mjs — login riêng ∈ hermes_learning_ingest; 20:55 VN + sau kiểm]
  I --> T[(app_private.hermes_learning_proposals + hermes_learning_audit_runs)]
  T -->|users.edit, phân trang, lần kiểm cuối| W[Web: Cài đặt › Hermes › Bài học chờ duyệt]
  T -.->|21:00 VN — mục 4, chưa nối| Z[Tin Zalo của bot cho chủ]
  Z -.->|"duyệt 1,3" / "bỏ 2"| D[crm_action_run learning.decide]
  W --> X[Lõi quyết định một lần]
  D -.-> X
  X --> O[Điều phối viên: duyệt ⇒ đưa vào skill chuẩn; bỏ ⇒ curator rollback / gỡ mục bộ nhớ]
```

Chủ đích: đề xuất là **bản ghi quyết định**; job chỉ đọc nên không chặn trước hiệu lực của bài học (curator ghi ngay sau
phiên). Bài học sai vẫn được phát hiện trong ≤ 24 giờ, đi duyệt, rồi gỡ. Chặn trước cần hook trong Hermes — đợt khác.

## 3. Dữ liệu (migration `20261031041523_hermes_learning_proposals_v1`)

| Thành phần | Ghi chú |
|---|---|
| `app_private.hermes_learning_proposals` | công ty, người dùng, trợ lý (FK `hermes_assistants`), hồ sơ, `seq` theo công ty, loại (`skill_crm_write`/`memory_crm_write`), tiêu đề ≤ 200, nội dung ≤ 4000 (có chữ, không ký tự điều khiển), nguồn (jsonb ≤ 4096 B **dạng chữ**), lúc phát hiện, lúc nạp, khoá chống trùng `UNIQUE(công ty, dedupe_key)`, trạng thái pending/approved/rejected, người/lúc/ghi chú/kênh duyệt, `decision_request_id`, khung che `redacted_at/redacted_by`. RLS bật, không cấp bảng cho vai nào; trigger: danh tính bất biến, quyết định một lần, nội dung chỉ đổi được **một lần, khi che sau quyết định**; không chặn xoá (chờ chính sách) |
| `app_private.hermes_learning_audit_runs` | "lần kiểm cuối" theo (công ty, người dùng, hồ sơ): mốc job kiểm (giữ mốc lớn nhất) + lúc nhận; job nạp ghi mỗi lần chạy, kể cả không có đề xuất |
| `public.hermes_learning_review_v1(p)` | người giữ `users.edit` (qua `require_perm_v1`, thành viên đang hoạt động, chưa nghỉ việc): đang chờ 20/trang theo số (`pendingAfterSeq` → `nextPendingAfterSeq`), lịch sử 20 dòng/trang (nội dung rút còn 300 ký tự, không kèm nguồn), con trỏ `(decidedAt µs, id)`, `audits` ≤ 20. Trang luôn dưới 1 MiB (đo bằng 20 đề xuất dài tối đa) |
| `public.hermes_learning_decide_v1(p)` | ≤ 20 đề xuất/lần, `approve`/`reject`, ghi chú tuỳ chọn ≤ 500; cùng `requestId` của cùng người ⇒ trả lại kết quả cũ (`replayed`), khác nội dung ⇒ PT409; đã quyết định ⇒ PT409; ngoài công ty ⇒ 22023 |
| `app_private.hermes_learning_apply_v1(…, p_via)` | lõi dùng chung trang web (`crm_ui`) và thao tác connector (`hermes_connector`, mục 4) |
| `app_private.hermes_store_learning_ingest_v1(p)` | **chỉ** vai NOLOGIN riêng `hermes_learning_ingest` (không còn cấp cho `hermes_store_executor`); 0..25 đề xuất/lô + `auditGeneratedAt`; kiểm thành viên + trợ lý ACTIVE; trùng khoá bỏ qua, trả riêng `rejectedDuplicates` (trùng đề xuất đã bỏ) |

Xác thực của job nạp: login riêng `hermes_store_learning` (vận hành tạo ngoài repo) chỉ thuộc `hermes_learning_ingest`;
`store-transport.mjs` phạm vi `learning` kiểm vai trước lệnh đầu và chỉ gọi được hàm nạp (lý do ở README). Không `service_role`,
không khoá tĩnh mới, không dùng lại login kho bền của connector.

Dữ liệu rời hồ sơ: `learning_audit.py` làm sạch mọi chuỗi (surrogate lẻ, NUL, ký tự điều khiển), **che** bí mật (Bearer, JWT,
`sk-…`, header Authorization, khoá dạng `key=value`, PEM, token GitHub/Supabase/Slack/AWS/Google) và thông tin cá nhân hiển nhiên
(SĐT, CCCD/CMND, email, số tài khoản có nhãn) rồi mới cắt ngắn; nguồn ≤ 2 KiB; `detectedAt` trong [lúc chạy − 365 ngày, lúc
chạy]. Báo cáo đủ (cả câu "bó tay") chỉ ở `private/` 0700; job nạp đọc `outbox/` chỉ có đề xuất; "tự áp dụng" chỉ còn đếm (băm),
không chép nội dung bộ nhớ.

## 4. Tin Zalo 21:00 + duyệt qua Zalo (thiết kế — chưa làm)

### 4.1 Đường gửi: cron "live" của Hermes trên hồ sơ owner

| Phương án | Ưu | Nhược |
|---|---|---|
| **A. Cron Hermes** `deliver: zalo_personal:<uid của chủ>` (adapter `infra/hermes-zalo-native/adapter.py` cho phép live cron, cấm send chung) | đúng nick bot, đúng DM chủ, không thêm worker; chủ trả lời ngay trong DM | nội dung qua LLM (giảm bằng: prompt chỉ "gửi nguyên văn `result.message`"); `outcome_unknown` đóng băng kênh tới khi đối soát |
| B. Outbox DB + worker Zalo (kiểu `task_reminder_outbox`) | tất định | worker chưa có vòng claim cho outbox (grep `worker/` trống); giờ yên 21→7 chặn tin 21:00; đổi worker phải dựng lại sidecar `hermes-owner` |

**Chọn A** cho đợt 3; B khi outbox nhắc việc của worker đã chạy thật. Câu hỏi phải kiểm trước khi nối: cron Hermes có bỏ
gửi khi câu trả lời rỗng không; job cron chạy phiên riêng nên phiên DM chính hiểu "duyệt 1,3" nhờ skill chuẩn (4.5), không
nhờ ngữ cảnh cron.

### 4.2 Thao tác `learning.digest` (khung: `infra/hermes-broker/learning-digest.mjs` → `formatLearningDigest`)

- Không tham số. SQL lấy đề xuất `pending` của công ty mà `announced_at IS NULL` (cột mới, thêm ở migration đợt 3), đánh dấu
  đã báo, trả `{items:[{seq,kind,title,content}], pendingTotal}`; adapter dựng `message` tất định bằng `formatLearningDigest`
  (≤ 10 dòng, ≤ 1 800 ký tự, link `publicWebOrigin` + `/settings/hermes?tab=bai-hoc`); không có mục mới ⇒ `message: null`.
- Lớp `reversible`, `confirm='never'` (chỉ ghi sổ "đã báo", không đổi dữ liệu nghiệp vụ); lặp cùng `requestId` ⇒ replay.

### 4.3 Thao tác `learning.decide` (khung: `parseLearningReply` cho câu "duyệt 1,3" / "bỏ 2 vì …")

- Tham số `{numbers: int[1..20], decision: 'approve'|'reject', note?: string ≤ 500}`; số = `seq` của công ty (trùng số
  trên web, ổn định giữa các tối — trả lời tin cũ vẫn đúng mục).
- Lớp `reversible` + dòng chính sách `confirm='always'` (bắt buộc ghi tường minh — mặc định reversible là `never`): lượt 1
  xem trước "#1 … → DUYỆT", chủ "ok" ⇒ lượt 2 gửi đúng `resolved` + `basis` (băm trạng thái các đề xuất đã chọn; lệch ⇒
  `state_changed`). Bước SQL gọi `hermes_learning_apply_v1(c.user_id, c.organization_id, ids, decision, note, requestId,
  'hermes_connector')`. Không cần `consentText` (không phải `irreversible`).
- Câu mơ hồ (không số, trộn duyệt + bỏ, "duyệt hết") ⇒ `needs_input`, bot hỏi lại — không đoán.

### 4.4 Khoá, chính sách, cổng host

- Khoá mới `assistant.learning_review` (mode `action`) seed **TẮT** trong `app_private.hermes_capabilities`; mảng riêng
  `HERMES_LEARNING_ACTION_KEYS` trong `capability-contract.mjs` (không nối vào FOUNDATION — test khoá 14 khoá), nhãn ở
  `src/hermes/capabilityLabels.ts`; **promote web trước/cùng lúc áp migration seed** (web từ chối khoá lạ ⇒ trang Hermes
  báo "Chưa đọc được danh sách quyền").
- `app_private.hermes_action_policies`: `('learning.digest','assistant.learning_review','users.edit','reversible','never')`,
  `('learning.decide','assistant.learning_review','users.edit','reversible','always')` — chèn ở migration **bật** riêng,
  sau lượt kiểm cuối (như các trang khác).
- Trang `learning` vào `ACTION_PAGES` + `PAGE_LABELS` (+ `LISTED_PAGES`), nạp qua cờ host `actionPages: ["learning"]`
  (vắng ⇒ không có thao tác, như production hiện nay).

### 4.5 Skill chuẩn (nhánh "hướng dẫn chuẩn" — `infra/hermes-skills/ihome-crm-*`)

Đề xuất một mục trong skill chuẩn (chủ sở hữu bộ skill duyệt nội dung):

> Khi chủ trả lời tin "Bài học Hermes chờ duyệt" bằng "duyệt N[,M]" hoặc "bỏ N [vì …]": gọi `crm_action_run` với
> `learning.decide` (numbers = các số N, decision theo động từ, note = phần sau "vì"). Không đoán số; câu mơ hồ thì hỏi lại.
> Không tự sửa skill/bộ nhớ về cách ghi CRM — bài học loại này phải qua duyệt.

### 4.6 Tệp phải đổi khi nối (đợt 3)

| Phía | Tệp |
|---|---|
| SQL | migration mới: cột `announced_at`; vỏ INVOKER `public.hermes_learning_action_v1` (`BEGIN ATOMIC`, ghim băm ở `scripts/hermes-task-function-contract.mjs` + fixture/schema test) + bước DEFINER (guard → basis → apply → receipt); seed khoá TẮT |
| Connector | `learning-action-contract.mjs` (`defineAction` ×2), `action-catalog.mjs`/`action-contract.mjs` (trang `learning`), `server.mjs` (`ACTION_PAGE_CATALOGS`), `capability-contract.mjs` (+ `.d.mts`), `CONNECTOR.md` |
| Test | `action-catalog`, `action-contract` (ngân sách 3 tool ≤ 2 000 B), `action-tools-budget`, `action-runtime`, PGlite theo `action-foundation-sql.test.mjs`, `capabilityLabels.test.ts`; `action-activation-sql.test.mjs` + file lùi khi viết migration bật |
| Hồ sơ owner | job cron Hermes 21:00 VN (`deliver: zalo_personal:<uid chủ>`) — tạo bằng CLI Hermes trong container, điều phối viên làm |

### 4.7 Rủi ro

- Cron chạy lúc bot đang trả lời chủ ⇒ hai luồng cùng DM; giữ tin ngắn, không hỏi lại trong tin cron.
- Kênh `outcome_unknown` đóng băng tới khi đối soát (trang "Đối soát tin chưa rõ kết quả").
- Số `seq` lộ ra Zalo chỉ là số thứ tự, không phải id.

## 5. Thứ tự phát hành (đợt 2 — PR này)

1. Review chéo PR (tier authorization + migration): base/head + kết luận ghi vào PR.
2. Áp `20261031041523` qua lane trên TEST rồi production (dry-run → `--apply`, biên nhận); làm tươi provenance/surfaces.
   Migration tạo vai NOLOGIN `hermes_learning_ingest`.
3. Tạo login `hermes_store_learning` như mẫu `hermes_store_host` (`LOGIN INHERIT`, không đặc quyền, timeout ngắn), **chỉ**
   `GRANT hermes_learning_ingest TO hermes_store_learning`, qua đường admin đã duyệt, ngoài repo; mật khẩu chỉ ở VPS
   `/etc/ihome-hermes/learning-store-password`.
   `scripts/test-env/owners.mjs` đã khai sẵn login này (TEST dựng lại NOLOGIN).
4. Promote web (tab "Bài học chờ duyệt"); trước khi áp, trang báo "Máy chủ chưa có chức năng duyệt bài học".
5. Đổi release connector trên VPS sang bản có `infra/hermes-learning-audit/` (chỉ đổi symlink `current`; connector không gọi
   thao tác mới nên không cần restart vì lý do này).
6. Cài user + cấu hình + 5 unit theo README, chạy tay một lần, kiểm báo cáo + dòng `learning_ingest`, rồi bật 2 timer.

## 6. Sau quyết định (làm tay, chờ chủ chốt chính sách)

- **Duyệt**: điều phối viên đưa bài học vào bộ skill chuẩn `ihome-crm-*` rồi gỡ bản local.
- **Bỏ**: gỡ khỏi trợ lý — skill: `hermes curator rollback <ledgerId>`; bộ nhớ: xoá đúng mục. Nếu trợ lý học lại đúng bài học
  đã bỏ, SQL không đưa lại vào hàng chờ; job nạp báo riêng `rejectedDuplicates` + khoá trong journal.
- **Che nội dung** sau quyết định (khi chủ chọn chính sách): `UPDATE … SET title/content/source = …, redacted_at, redacted_by`
  một lần (trigger chỉ cho đúng chuyển này); RPC che/xoá chưa viết.
