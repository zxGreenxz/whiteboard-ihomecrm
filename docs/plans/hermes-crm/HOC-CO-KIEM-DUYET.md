# Học có kiểm duyệt cho Hermes (đợt 2 kế hoạch trị tận gốc — chủ duyệt 31/10/2026)

**Trạng thái:** (1) job kiểm học tập, (2) kho đề xuất + trang duyệt, (4) timer: đã viết trong cùng PR (đã sửa theo review chéo
REQUEST CHANGES 31/10) — **migration `20261031041523` + `20261101064441` đã áp TEST và production 01/11 qua lane; trên production vai `hermes_store_learning` đã bật login, hai timer trên VPS (kiểm 20:40, nạp 20:55 giờ VN) đang chạy — đọc lại 10/11/2026, lượt 09/11 đều `success`; trên TEST vai này còn NOLOGIN** (runbook C→G trong PR #371). (3) tin Zalo 21:00 + duyệt qua Zalo: **đã phát hành production 10/11/2026** (mục 4) — migration
`20261105025453` áp 05/11, migration bật `20261105030528` áp 10/11 qua lane, connector production khai `actionPages: ["contract", "learning"]`,
job cron `ihome-learning-digest-2100` tạo 10/11 (4.6). Lượt 21:00 đầu (10/11) bị cron chặn trước khi chạy (`blocked_config`): không
tin nào tới Zalo, không đề xuất nào bị đánh dấu; nguyên nhân và bản sửa plugin ở 4.6.1. Bản sửa đã cài lên
hồ sơ owner trên VPS lúc 00:37 ngày 11/11 (giờ VN). Lượt 21:00 ngày 11/11 là lượt đầu chứng minh được tin tới Zalo; khi viết
dòng này lượt đó chưa tới.
Cài đặt/vận hành: [infra/hermes-learning-audit/README.md](../../../infra/hermes-learning-audit/README.md).

**Chủ đã chốt (31/10, ~18:30):**
1. **Duyệt SAU.** Bài học có hiệu lực ngay từ lúc curator/trợ lý tự ghi; job kiểm 20:40 mỗi tối gom và đưa lên hàng duyệt. Không
   cách ly định kỳ (vd. mỗi 15 phút), không chặn trong lõi Hermes. "Duyệt" ghi nhận bài học đúng; "Bỏ" **chỉ ghi nhận** — gỡ bài
   học khỏi trợ lý do điều phối viên làm tay (mục 6). Trang duyệt nói đúng điều này.
2. **Hiện toàn bộ nguyên văn, không che thông tin khách** (SĐT, CCCD, email, STK…): công ty nhỏ, nhân viên nội bộ dùng chung;
   quyền xem/duyệt giữ là người có `users.edit`. **Vẫn che bí mật kỹ thuật** (mật khẩu, token/JWT/Bearer, khoá API `sk-…`/`sbp_…`,
   khối PEM…) vì đó là an ninh hệ thống, không phải riêng tư — chủ có thể yêu cầu bỏ sau. **Không che sau quyết định**: đề xuất
   đã quyết định giữ nguyên làm lịch sử (bất biến, không xoá — bỏ khung `redacted_at/redacted_by` của bản trước). Báo cáo đủ
   trên host vẫn 0600 (có trích đoạn hội thoại).

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
  P -->|20:40 VN, chỉ đọc, sandbox| A[learning_audit.py — làm sạch + che bí mật kỹ thuật trước khi rời hồ sơ]
  A -->|private/ 0700: báo cáo đủ| R[(Chỉ user job kiểm)]
  A -->|outbox/ 0640: chỉ đề xuất| I[ingest.mjs — login riêng ∈ hermes_learning_ingest; 20:55 VN + sau kiểm]
  I --> T[(app_private.hermes_learning_proposals + hermes_learning_audit_runs)]
  T -->|users.edit, phân trang, lần kiểm cuối| W[Web: Cài đặt › Hermes › Bài học chờ duyệt]
  T -->|21:00 VN — cron Hermes gọi learning.digest, mục 4| Z[Tin Zalo của bot cho chủ]
  Z -->|"duyệt 1,3" / "bỏ 2"| D[crm_action_run learning.decide — luôn xem trước]
  W --> X[Lõi quyết định một lần]
  D --> X
  X --> O[Điều phối viên: duyệt ⇒ đưa vào skill chuẩn; bỏ ⇒ curator rollback / gỡ mục bộ nhớ]
```

Chủ đích: đề xuất là **bản ghi quyết định**; job chỉ đọc nên không chặn trước hiệu lực của bài học (curator ghi ngay sau
phiên). Bài học sai vẫn được phát hiện trong ≤ 24 giờ, đi duyệt, rồi gỡ. Chặn trước cần hook trong Hermes — đợt khác.

## 3. Dữ liệu (migration `20261031041523_hermes_learning_proposals_v1`)

| Thành phần | Ghi chú |
|---|---|
| `app_private.hermes_learning_proposals` | công ty, người dùng, trợ lý (FK `hermes_assistants`), hồ sơ, `seq` theo công ty, loại (`skill_crm_write`/`memory_crm_write`/`audit_warning`: cảnh báo của job kiểm), tiêu đề ≤ 200, nội dung ≤ 4000 (có chữ, không ký tự điều khiển), nguồn (jsonb ≤ 4096 B **dạng chữ**), lúc phát hiện, lúc nạp, khoá chống trùng `UNIQUE(công ty, dedupe_key)`, trạng thái pending/approved/rejected, người/lúc/ghi chú/kênh duyệt, `decision_request_id`. RLS bật, không cấp bảng cho vai nào; trigger: quyết định một lần rồi **bất biến làm lịch sử** — không sửa nội dung, không quyết định lại, không xoá (chủ chốt 31/10: không che sau quyết định) |
| `app_private.hermes_learning_audit_runs` | "lần kiểm cuối" theo (công ty, người dùng, hồ sơ): mốc job kiểm (giữ mốc lớn nhất) + lúc nhận; job nạp ghi mỗi lần chạy, kể cả không có đề xuất |
| `public.hermes_learning_review_v1(p)` | người giữ `users.edit` (qua `require_perm_v1`, thành viên đang hoạt động, chưa nghỉ việc): đang chờ 20/trang theo số (`pendingAfterSeq` → `nextPendingAfterSeq`), lịch sử 20 dòng/trang (đủ nội dung và nguồn, để xem lại và lấy mã gỡ), con trỏ `(decidedAt µs, id)`, `audits` ≤ 20. Trang luôn dưới 1 MiB (đo bằng 20 đề xuất dài tối đa) |
| `public.hermes_learning_decide_v1(p)` | ≤ 20 đề xuất/lần, `approve`/`reject`, ghi chú tuỳ chọn ≤ 500; cùng `requestId` của cùng người ⇒ trả lại kết quả cũ (`replayed`), khác nội dung ⇒ PT409; đã quyết định ⇒ PT409; ngoài công ty ⇒ 22023 |
| `app_private.hermes_learning_apply_v1(…, p_via)` | lõi dùng chung trang web (`crm_ui`) và thao tác connector (`hermes_connector`, mục 4) |
| Đợt 3 (`20261105025453`, **đã áp production 05/11/2026**) | cột `announced_at` (mốc "đã báo" của tin 21:00, đặt một lần khi còn chờ — guard bất biến dựng lại cho đúng bước này); `public.hermes_learning_action_v1` (vỏ INVOKER) → `app_private.hermes_learning_action_step_v1` (DEFINER) cho `learning.digest` / `learning.decide`; khoá `assistant.learning_review` seed TẮT (mục 4) |
| `app_private.hermes_store_learning_ingest_v1(p)` | **chỉ** vai NOLOGIN riêng `hermes_learning_ingest` (không còn cấp cho `hermes_store_executor`); 0..25 đề xuất/lô + `auditGeneratedAt`; kiểm thành viên + trợ lý ACTIVE; trùng khoá bỏ qua, trả riêng `rejectedDuplicates` (trùng đề xuất đã bỏ) |

Xác thực của job nạp: login riêng `hermes_store_learning` (migration `20261101064441` tạo NOLOGIN, `scripts/hermes-learning-login.mjs` bật bằng verifier) chỉ thuộc `hermes_learning_ingest`;
`store-transport.mjs` phạm vi `learning` kiểm vai trước lệnh đầu và chỉ gọi được hàm nạp (lý do ở README). Không `service_role`,
không khoá tĩnh mới, không dùng lại login kho bền của connector.

Dữ liệu rời hồ sơ: `learning_audit.py` làm sạch mọi chuỗi (surrogate lẻ, NUL, ký tự điều khiển), **che bí mật kỹ thuật** (Bearer,
JWT, `sk-…`, header Authorization, khoá dạng `key=value`, PEM, token GitHub/Supabase/Slack/AWS/Google) rồi mới cắt ngắn; thông tin
khách (SĐT, CCCD/CMND, email, STK) giữ nguyên văn theo quyết định của chủ; nguồn ≤ 2 KiB; `detectedAt` trong [lúc chạy − 365 ngày, lúc
chạy]. Báo cáo đủ (cả câu "bó tay") chỉ ở `private/` 0700; job nạp đọc `outbox/` chỉ có đề xuất; "tự áp dụng" chỉ còn đếm (băm),
không chép nội dung bộ nhớ.

## 4. Tin Zalo 21:00 + duyệt qua Zalo (đợt 3 — đã phát hành production 10/11/2026)

**Trạng thái (10/11/2026):** PR đợt 3 (nhánh `claude/hermes-learning-zalo-2100`): migration `20261105025453_hermes_learning_action_v1`
(**đã áp**; production 05/11), trang connector `learning` (chỉ nạp khi host bật `actionPages: ["learning"]`), nhãn khoá web, skill chuẩn
`ihome-crm-bai-hoc`. Migration **bật** `20261105030528_hermes_learning_actions_activation_v1` (**đã áp production 10/11 qua lane**; + file lùi
`docs/plans/hermes-crm/revert/hermes_learning_actions_activation_revert_v1.sql`, khuôn `action-activation-sql.test.mjs`) ở PR thứ hai, nhánh
`claude/hermes-learning-zalo-2100-bat` dựng trên nhánh đợt 3. Job cron 21:00: điều phối viên đã tạo 10/11 theo 4.6 (job
`ihome-learning-digest-2100`, lịch `0 21 * * *` theo múi giờ hồ sơ) — PR không tạo job. Canary chỉ đọc sau áp: `crm_action_list` của owner
liệt kê `learning.digest` và `learning.decide` trong `items`.

### 4.1 Đường gửi: cron "live" của Hermes trên hồ sơ owner

| Phương án | Ưu | Nhược |
|---|---|---|
| **A. Cron Hermes** `deliver: zalo_personal:<uid của chủ>` (adapter `infra/hermes-zalo-native/adapter.py` cho phép live cron, cấm send chung) | đúng nick bot, đúng DM chủ, không thêm worker; chủ trả lời ngay trong DM | nội dung qua LLM (giảm bằng: connector dựng sẵn `message`, prompt chỉ "gửi nguyên văn"); `outcome_unknown` đóng băng kênh tới khi đối soát |
| B. Outbox DB + worker Zalo (kiểu `task_reminder_outbox`) | tất định | worker chưa có vòng claim cho outbox (grep `worker/` trống); giờ yên 21→7 chặn tin 21:00; đổi worker phải dựng lại sidecar `hermes-owner` |

**Chọn A**; B khi outbox nhắc việc của worker đã chạy thật. Phải kiểm trên VPS trước khi tạo job (4.6): cron Hermes bản đang chạy có bỏ gửi
khi câu trả lời là `[SILENT]` không. Job cron chạy phiên riêng nên phiên DM chính hiểu "duyệt 1,3" nhờ skill chuẩn (4.5), không nhờ ngữ
cảnh cron.

### 4.2 Thao tác `learning.digest`

- Không tham số. Bước SQL lấy tối đa **10** đề xuất `pending` của CẢ công ty mà `announced_at IS NULL` (theo số), đặt `announced_at` (cột
  mới; guard bất biến cho đúng bước này: một lần, khi còn chờ — quyết định sau đó giữ nguyên mốc), trả `{announcedAt, pendingTotal,
  items:[{seq,kind,title,content ≤ 300 ký tự}]}`. Trần 10 = đúng số dòng tin tối liệt kê (`LEARNING_DIGEST_MAX_ITEMS` của
  `learning-digest.mjs`; test ghép giữ hai số bằng nhau): mục đã đánh dấu không bao giờ hiện lại ở tin sau, nên mục nào được đánh dấu
  cũng phải có số trong tin (review #391: trần 20 đánh dấu 20 mà tin chỉ liệt kê được 6). Phần vượt trần **sang tối sau** (vẫn tính
  trong `pendingTotal`). Đề xuất đã quyết định trên web trước khi được báo không bao giờ được chọn (guard cấm đánh dấu nó).
- Connector (`learning-action-contract.mjs` `presentLearningDigest`, nối qua `createActionRuntime({ presenters })` chỉ khi trang được
  nạp) trả cho mô hình `{message, newCount, numbers, pendingTotal}`: `message` = `formatLearningDigest` (mỗi đề xuất một dòng, đủ mọi
  số, ≤ 1 800 ký tự: dài thì rút trích nội dung 140 → 100 → 60 ký tự rồi bỏ trích, vẫn dài ⇒ chỉ còn danh sách số trần; không bao giờ
  bỏ dòng; dòng "Còn N đề xuất khác đang chờ duyệt"; link `publicWebOrigin` + `/settings/hermes?tab=bai-hoc`; ngày theo `announcedAt`
  của SQL nên phát lại / `crm_action_status` cho đúng tin cũ); không có mục mới ⇒ `message: null`. Nội dung đề xuất không tới mô hình.
  Origin mà tin tối không nhận ⇒ connector không khởi động.
- Lớp `reversible`, chính sách `never` (dòng ở migration bật): ghi thẳng ở lượt `auto`; siết thành `always` ⇒ xem trước, không đánh dấu.
  Cùng requestId ⇒ phát lại (sổ biên nhận chung).
- **Chỉ job cron gọi.** Gọi trong chat (bot tự gọi, hay kết nối của người giữ `users.edit` khác) đánh dấu các mục ⇒ tin tối hôm đó
  thiếu chúng (vẫn ở web và trong dòng "Còn N đề xuất khác đang chờ duyệt"). Giảm bằng tiêu đề thao tác + skill chuẩn; không có rào
  SQL phân biệt cron với chat (cùng kết nối).

### 4.3 Thao tác `learning.decide`

- Tham số `{numbers: int[1..20] (mỗi số 1–9 999 999), decision: 'approve'|'reject', note?: string ≤ 500}`; số = `seq` của công ty (trùng
  số trên web, ổn định giữa các tối — trả lời tin cũ vẫn đúng mục). Số trùng ("duyệt 1-3, 2") connector khử trước khi gửi (`param.list`
  `unique`, giữ thứ tự lần đầu; token xác nhận gắn danh sách đã khử); SQL vẫn tự từ chối số trùng (22023) khi bị gọi thẳng. `parseLearningReply` là bộ đọc tham chiếu cho câu "duyệt 1,3" /
  "bỏ 2 vì …" (skill chuẩn mô tả cùng luật cho mô hình).
- SQL **luôn xem trước** — sàn trong SQL, kể cả khi dòng chính sách bị đổi thành `never` (quyết định một lần, bất biến): `preview`
  {`decision` DUYỆT/BỎ, `items` [{`number`, `kind`, `title` ≤ 120}], `note`, `effect`}; số đã duyệt / đã bỏ / không có ⇒ `warnings`;
  không số nào còn chờ ⇒ `needs_input` `learning_not_pending` (mã mới, `action-reasons.mjs`). Không cần `consentText` (không phải
  `irreversible`).
- Lượt 2: phát lại theo requestId kiểm TRƯỚC (chính lượt đã ghi làm đổi trạng thái mà basis băm); basis = md5(thao tác, quyết định, ghi
  chú, id + số các đề xuất còn chờ đã xem) và bản đã giải `{proposalIds, numbers}` phải khớp trạng thái hiện tại, lệch ⇒ `state_changed`
  (không biên nhận). Ghi: `hermes_learning_apply_v1(c.user_id, c.organization_id, ids, decision, note, requestId, 'hermes_connector')` —
  trang web thấy `via`.
- Cổng người: guard chung (khoá `assistant.learning_review` bật, có trên kết nối và trần công ty, quyền CRM `users.edit` trên ảnh chụp)
  rồi `hermes_learning_admin_v1` như trang web (thành viên đang hoạt động, chưa nghỉ việc, `require_perm_v1 users.edit` sau khoá công
  ty), rồi khoá công ty của kho đề xuất (cùng khoá với nạp / đọc / quyết định web).
- Câu mơ hồ (không số, trộn duyệt + bỏ, "duyệt hết") ⇒ bot hỏi lại theo skill, không đoán.

### 4.4 Khoá, chính sách, cổng host

- Khoá `assistant.learning_review` (mode `action`, phạm vi công ty) seed **TẮT** ở migration đợt 3; mảng riêng
  `HERMES_LEARNING_ACTION_KEYS` trong `capability-contract.mjs` (+ `.d.mts`; không nối vào FOUNDATION — test khoá 14 khoá), nhãn ở
  `src/hermes/capabilityLabels.ts`. **Promote web TRƯỚC/CÙNG lúc áp migration seed** (web từ chối khoá lạ ⇒ trang Hermes báo "Chưa đọc
  được danh sách quyền"; các RPC options chỉ liệt kê khoá đang bật nên chậm nhất là trước migration bật).
- `app_private.hermes_action_policies`: `('learning.digest','assistant.learning_review','users.edit','reversible','never')`,
  `('learning.decide','assistant.learning_review','users.edit','reversible','always')` — chèn ở migration **bật** (PR thứ hai) cùng lúc
  bật khoá; file lùi `docs/plans/hermes-crm/revert/hermes_learning_actions_activation_revert_v1.sql` (tắt khoá, xoá hai dòng; rào
  `legacy_allowlist`). Tới khi áp file bật: guard chung từ chối mọi lời gọi (thiếu dòng chính sách ⇒ 42501).
- Trang `learning`: `ACTION_PAGES`, `LISTED_PAGES` (crm_action_list nhận `page: "learning"` — nhưng **không** vào enum `page` của tools/list:
  ba tool đang 1 999 / 2 000 B và host không bật trang thì tools/list phải giữ nguyên từng byte), `PAGE_LABELS` (khuôn B),
  `ACTION_PAGE_CATALOGS.learning`. Host bật bằng `actionPages: ["contract", "learning"]` (+ `publicWebOrigin` để có link tuyệt đối). Vắng ⇒
  danh mục, mục lục và tools/list y như main `f2473ba4a` (`action-tools-budget.test.mjs`, `server.test.mjs`).

### 4.5 Skill chuẩn

`infra/hermes-skills/ihome-crm-bai-hoc/SKILL.md` (trang `learning` trong `PAGE_SKILLS` của `official-skills.test.mjs`): "duyệt N[,M]" /
"duyệt 4-6" / "bỏ N vì …" ⇒ `crm_action_run` `learning.decide` (numbers = các số N, decision theo động từ, note = phần sau "vì"); không
đoán số, câu mơ hồ thì hỏi lại; phiên vừa đưa ra danh sách đánh số khác (phiếu thu chi, việc, hoá đơn, hợp đồng) thì "duyệt N" không
kèm chữ "bài học" là mơ hồ ⇒ hỏi lại bài học hay phiếu / việc (va chạm với "duyệt lô theo danh sách vừa đọc" của `ihome-crm-thu-chi`);
đọc bản xem trước rồi mới xác nhận; `learning.digest` chỉ job cron gọi; không tự sửa skill / bộ nhớ về cách ghi CRM — bài học loại này
phải qua duyệt. `ihome-crm-ghi-chung` trỏ tới skill này (When to Use + câu "Không tự sửa…").
Điều phối viên thêm `ihome-crm-bai-hoc` vào dòng "Skill có sẵn" của SOUL owner (ngoài PR).

### 4.6 Job cron 21:00 VN cho hồ sơ owner (điều phối viên tạo — PR KHÔNG tạo job)

Điều kiện: đã áp `20261105025453` + migration bật trên production; connector production chạy bản có trang `learning` với cấu hình host
`"actionPages": ["contract", "learning"]` và `"publicWebOrigin"`; skill chuẩn đã triển khai (`deploy.sh`). Kênh Zalo của owner không còn
`outcome_unknown` chưa đối soát (xem 4.7). Plugin `ihome-zalo-native` của hồ sơ là bản có khai `cron_deliver_env_var` (4.6.1) — thiếu thì job
vẫn tạo được nhưng mọi lượt chạy đều bị chặn.

1. Kiểm cú pháp và hành vi của bản Hermes đang chạy (chỉ đọc; cờ dưới đây là MINH HOẠ, dùng đúng tên cờ `--help` in ra):

   ```bash
   docker exec -u 10003:10003 hermes-owner hermes --profile owner cron --help
   docker exec -u 10003:10003 hermes-owner hermes --profile owner cron create --help
   # Cron có bỏ gửi khi câu trả lời là [SILENT] không? Không thấy dấu hiệu này trong mã cron ⇒ DỪNG, không tạo job (báo lại để chọn B).
   docker exec hermes-owner sh -c 'grep -rn "SILENT" /opt/hermes/cron | head'
   ```

2. Tạo job (một lần; chạy lại sẽ tạo job thứ hai — liệt kê trước bằng `cron list`):

   ```bash
   docker exec -u 10003:10003 hermes-owner hermes --profile owner cron create \
     --name ihome-learning-digest-2100 \
     --deliver "zalo_personal:<uid Zalo của chủ>" \
     "0 21 * * *" "$(cat /root/ihome-hermes-cron/learning-digest-prompt.txt)"
   ```

   Bản Hermes chạy ngày 10/11/2026 không có cờ `--schedule`, `--timezone`, `--prompt`: lịch và prompt là hai tham số vị trí như khối
   lệnh trên (bản thiết kế đầu viết ba cờ đó; chạy `cron create --help` ở bước 1 để đối chiếu khi Hermes đổi bản).
   Lịch tính theo múi giờ của `hermes_time` (biến `HERMES_TIMEZONE` → `timezone` trong `config.yaml` của hồ sơ → giờ máy), KHÔNG theo
   đồng hồ container: hồ sơ owner khai `timezone: Asia/Ho_Chi_Minh` ⇒ `0 21 * * *`. Tạo xong đọc dòng `Next run` — phải ra
   `…T21:00:00+07:00`; viết `0 14 * * *` vì thấy container chạy UTC thì job chạy 14:00 VN (đã gặp 10/11, sửa bằng `cron edit --schedule`).
   `deliver` phải là đúng uid đã ghép của chủ (`HERMES_ZALO_PAIRED_UID` của hồ sơ owner) — adapter từ chối đích khác.

3. Prompt (lưu nguyên văn vào file trên host, không sửa chữ):

   ```text
   Gọi đúng một lần tool crm_action_run của connector ihomecrm (tên đầy đủ mcp__ihomecrm__crm_action_run) với {"action": "learning.digest"}:
   không params, không confirmToken, không requestId.
   Nếu kết quả có outcome = "applied" và result.message là một chuỗi: trả lời ĐÚNG NGUYÊN VĂN chuỗi result.message — không thêm, bớt,
   sửa, dịch hay định dạng lại chữ nào, không chào, không giải thích.
   Nếu kết quả là lỗi action_outcome_unknown kèm requestId: gọi tool crm_action_status (tên đầy đủ mcp__ihomecrm__crm_action_status)
   ĐÚNG MỘT lần với {"requestId": "<requestId của lỗi đó, chép nguyên văn>"}. Kết quả có outcome = "applied" và result.message là một
   chuỗi ⇒ trả lời ĐÚNG NGUYÊN VĂN chuỗi đó như trên.
   Mọi trường hợp khác (result.message là null, lỗi khác, needs_input, tra trạng thái không ra applied hoặc không có message, không có
   tool): trả lời đúng một từ [SILENT]. Không gọi crm_action_run lần thứ hai, không gọi tool nào khác, không thử lại.
   ```

   Vì sao tra trạng thái: `action_outcome_unknown` nghĩa là lệnh đã gửi mà mất phản hồi — SQL có thể ĐÃ đánh dấu các mục (khi đó chúng
   không bao giờ vào tin sau). `crm_action_status` cùng requestId trả đúng kết quả đã ghi kèm `message` dựng lại tất định (presenter chạy
   cả ở nhánh tra trạng thái), nên tin hôm đó vẫn tới chủ. Gọi lại `crm_action_run` thì không được: requestId mới ⇒ một lượt đánh dấu mới.

4. Thử: kiểm ở lượt chạy theo lịch, lúc chủ đồng ý: tin tới đúng DM chủ và có dòng audit `HERMES_ACTION_APPLIED`
   `learning.digest`; tối không có đề xuất mới ⇒ không có tin. Không chạy tay `cron run <id>`: trên Hermes v0.22.2 (thấy trên
   production 11/11/2026) lệnh này chạy job ngay trong tiến trình CLI, không có adapter đang sống của gateway, nên tin không giao
   được qua plugin Zalo trong khi job vẫn gọi `learning.digest` và đánh dấu thật. Cũng không thử bằng cách gọi `learning.digest`
   trong chat (đánh dấu thật trên production).

5. Sau lượt chạy đầu (và sau mỗi lần đổi plugin hay nâng bản Hermes), đọc `Last run` của job:

   ```bash
   docker exec -u 10003:10003 hermes-owner hermes --profile owner cron list
   ```

   Trên production 10/11, job tạo với `--deliver zalo_personal:<uid>` vẫn `[active]` và `Next run` vẫn đúng dù cron sẽ chặn nó.
   Chỉ `Last run` của lượt chạy thật mới cho biết (`ok`, hay `blocked_config` kèm lý do).

#### 4.6.1 Sự cố lượt đầu 10/11/2026 và bản sửa plugin

Lượt 21:00 VN ngày 10/11 nổ đúng giờ nhưng `Last run = blocked_config`: `delivery platform 'zalo_personal' is not a known cron
delivery target`. Bước preflight của cron Hermes (`cron/scheduler_preflight.py` → `scheduler_delivery._is_known_delivery_platform`)
chỉ nhận nền tảng dựng sẵn hoặc plugin khai `cron_deliver_env_var` lúc `register_platform`; plugin `ihome-zalo-native` chưa khai, nên
job bị chặn TRƯỚC khi agent chạy: `learning.digest` không được gọi, không đề xuất nào bị đánh dấu `announced_at` (đọc lại production
21:15: 3 chờ duyệt + 1 đã duyệt, `announced_at` trống hết, 0 biên nhận `learning.*` trong ngày).

Bản sửa: `infra/hermes-zalo-native/adapter.py` khai `cron_deliver_env_var="ZALO_PERSONAL_HOME_CHANNEL"`. Đây là tên gateway tự suy
ra cho nền tảng này, và `.env` của hồ sơ owner đã đặt nó bằng UID đã ghép từ 15/10 (bàn giao 15/10 trong [STATUS.md](STATUS.md); để gateway không nhắc "chưa có home channel"
ở lượt đầu mỗi phiên), nên không phải đổi `.env`. Bản nháp đầu của PR khai một tên khác và để trống; đo chỉ đọc trên Hermes
production (v0.22.2, đổi khai báo trong bộ nhớ của một tiến trình riêng) cho thấy với tên khác gateway hỏi theo tên mới và
thấy biến đó trống. Theo mã gateway, đó là điều kiện để tin nhắc quay lại; phần này suy từ mã, chưa ai thấy tin nhắc thật. Vì
vậy bản sửa dùng đúng tên gateway suy ra.

Hệ quả phải biết: home channel của cron nay là DM đã ghép. Ngoài đích ghi rõ ở bước 2, job của hồ sơ owner còn tới DM của chủ qua
`deliver=zalo_personal` trần, `deliver=origin` khi job không có nguồn và `deliver=all`. Lúc sửa, hồ sơ chỉ có một job (bước 2, đích
ghi rõ), nên không job nào đổi đích. Chi tiết và lưu ý `/sethome`: [README plugin](../../../infra/hermes-zalo-native/README.md),
mục hành vi "Cron". Kiểm: probe `cron-preflight` trong `infra/hermes-zalo-native/upstream.test.mjs` chạy preflight và bộ phân giải
đích thật của bản Hermes đã ghim ở CI `hermes-runtime`.

Phát hành production 11/11/2026 (00:36–00:38 giờ VN, hồ sơ owner trên VPS):

- File cài KHÔNG phải `adapter.py` của `main`. `main` còn mang tính năng nhận ảnh Zalo (#268) chưa phát hành, nên file cài là bản
  plugin đang chạy từ 16/10 (commit `986c280d8`, sha256 `cc1770e8c3f3…`) cộng đúng 4 dòng của bản sửa: 11 978 byte, sha256
  `23cd9ff0be0d6b4bcbfcb16bf3f1a9d5c2ce384a0db21644443a9132d0d882c7`. Khi phát hành tính năng nhận ảnh, bản của `main` thay nó.
- Trình tự: xác nhận bot rảnh (0 `tools/call` trong 10 phút, `state.db` không đổi gần 3 giờ, 0 agent đang chạy) → sao lưu → đặt
  file → kiểm trong một tiến trình riêng của container → `docker restart hermes-owner` (17:37:15Z) → kiểm lại. Gateway chạy lại
  sau 20 giây: `gateway_state=running`, Zalo `connected`, `MCP: registered 61 tool(s)`, hook `ihome-session-reset` đăng ký ở
  tiến trình gateway, 0 dòng ERROR. Hai dòng sau cùng nằm ở `logs/agent.log`, không phải `logs/gateway.log`.
- Phép kiểm trên đúng file đã cài (chỉ đọc, Hermes v0.22.2), trước và sau khi khởi động lại: `_preflight_check_delivery` của job
  trả không lỗi (bản cũ trả đúng câu `not a known cron delivery target`); đích của job là DM đã ghép qua đích ghi rõ; gateway
  vẫn hỏi đúng biến `ZALO_PERSONAL_HOME_CHANNEL`; `config.yaml` không có `home_channel` nên không có thông báo khởi động vào DM
  (log sau khởi động lại: 0 dòng `startup notification`).
- `cron list` sau khi cài vẫn hiện `Last run … blocked_config` của lượt 10/11 vì cron không chạy bù; `Next run` là 21:00 ngày
  11/11. **Tin thật tới Zalo chỉ lượt đó chứng minh**: phép kiểm trên dừng ở preflight và phân giải đích, chưa chạy agent và chưa
  gửi tin. Sau 21:00 đọc lại `Last run` bằng lệnh ở 4.6 bước 5.
- Cập nhật 11/11/2026, trước lượt 21:00: theo lệnh chủ, 08:18 VN chạy tay `cron run` cho job này. Job qua preflight và gọi
  `learning.digest` (ba đề xuất chờ được đánh dấu đã báo) nhưng không giao được tin, đúng như cảnh báo ở 4.6 bước 4. Lúc 08:29
  VN đúng nội dung tin đã soạn được giao lại bằng một job một-lần không gọi agent, do ticker trong gateway chạy và giao qua
  adapter đang sống; tin tới DM của chủ. Vậy đường giao của lượt theo lịch đã được chứng minh từ lúc đó, không phải chờ lượt
  21:00. Phần còn chưa chứng minh: một lượt theo lịch mà ticker vừa chạy agent vừa giao tin trong cùng lượt (08:18 agent chạy
  trong CLI, 08:29 không gọi agent); phải chờ lượt theo lịch đầu tiên có đề xuất mới chưa báo, tối nào không có thì không có tin.
- Lùi: chép `/root/ihome-owner-install/backup/adapter-owner-cc1770e8c3f3-20261110T173652Z.py` về `adapter.py` trong thư mục
  plugin của hồ sơ owner (chủ `10003:10003`, quyền `644`), rồi `docker restart hermes-owner`. Lùi xong cron lại chặn job.
- Lúc phát hành, production chạy Hermes v0.22.2 còn repo ghim v0.21.6 (lệch có sẵn, ngoài phạm vi bản sửa): CI kiểm trên bản
  ghim, production kiểm bằng phép chạy trên. Cùng ngày 11/11/2026 repo đã đồng bộ bản ghim lên v0.22.2
  ([infra/hermes-runtime/README.md](../../../infra/hermes-runtime/README.md)); từ đó CI kiểm trên đúng phiên bản Hermes production
  đang chạy, còn plugin production vẫn là bản cài nêu ở đầu mục này.

#### 4.6.2 Tin và nội dung tự học bằng tiếng Việt (chủ dặn 11/11/2026)

Tin thật đầu tiên (08:29 VN 11/11, xem dòng cập nhật 11/11 ở 4.6.1) tới Zalo kèm ba đoạn tiếng Anh. Hai nguồn, hai cách sửa, đều làm trên máy chủ (SOUL và
`config.yaml` của hồ sơ không nằm trong repo):

- **Đầu / cuối tin cron** ("Cronjob Response: …", "To stop or manage this job…") là vỏ bọc của Hermes
  (`cron/scheduler_delivery.py`), không phải của CRM. Tắt bằng `cron.wrap_response: false` trong `config.yaml` của hồ sơ owner
  (đặt 09:00 VN 11/11; sao lưu `/root/ihome-owner-install/backup/config.yaml-20261111T015909Z`). Cron đọc config lúc giao tin
  (`load_config` nhớ theo chữ ký file) nên không khởi động lại gateway. `[SILENT]` xử lý riêng ở `cron/scheduler.py`, không phụ
  thuộc vỏ bọc; các probe cron của plugin Zalo (`upstream-probe.py`) vốn chạy với `wrap_response: False`. Chưa có lượt giao thật
  nào sau khi tắt để chứng minh trên production.
- **Nội dung bài học** tiếng Anh là nguyên văn skill curator viết ngày 31/10 (tin gửi nguyên văn theo quyết định 31/10, không
  dịch). Curator nay không còn viết skill (`curator.consolidate: false` ⇒ chỉ dọn tất định) và nhánh curator không nạp SOUL. Chỗ
  còn tự ghi là công cụ `memory` / `skill_manage` của phiên chính và lượt tự xét sau hội thoại (`agent/background_review.py`
  dùng lại system prompt của phiên, tức có SOUL). SOUL v4.59 (cài 09:35 VN 11/11 cho owner và ba hồ sơ thử) thêm:
  - luật ngôn ngữ: câu trả lời, thông báo, tin tự gửi và mọi nội dung lưu bằng `memory` / `skill_manage` đều tiếng Việt có dấu;
    giữ nguyên định danh kỹ thuật; văn bản công cụ trả để chuyển nguyên văn (`result.message` của tin 21:00) không dịch;
  - sở thích không đụng dữ liệu CRM (ngôn ngữ, xưng hô, độ dài, cách trình bày) được lưu `memory` khi chủ bảo nhớ. Trước đó bot
    từ chối nhầm câu "thông báo, skill, nội dung phải bằng tiếng Việt" như một bài học ghi CRM;
  - một câu có cả sở thích lẫn cách ghi CRM ⇒ lượt đó không gọi `memory`. Bản nháp cho lưu riêng phần sở thích đã lưu lẫn cả quy
    tắc chọn sổ trong một lượt thử, nên bỏ.

Kiểm trên hồ sơ thử `tkt` (CLI qua công cụ hội thoại thử `hermes_conv.py` trên máy chủ, ngoài repo; không qua Zalo), 15/15 ca: 11 ca ghi CRM hoặc câu trộn không gọi `memory`,
3 ca sở thích lưu bằng tiếng Việt, 1 ca hỏi bài học không gọi công cụ. Mốc so sánh v4.58 lưu sở thích bằng tiếng Anh. Chưa chạy
lại ma trận nghiệm thu 78 ca của trang Bài học (đợt 09/11; bộ ca nằm trên máy chủ thử, ngoài repo).

SOUL v4.59 dài 59.328 ký tự; trần nạp của hồ sơ là 65.280 ký tự (`model.context_length` 272000 × 4 × 0,06). Vượt trần thì Hermes
cắt giữa file, nên mỗi lần thêm luật phải đếm lại. Lùi: chép
`/root/ihome-owner-install/backup/soul-owner-c69f56263290-20261111T023552Z.md` về `SOUL.md` của hồ sơ owner (chủ `10003:10003`,
quyền `644`). SOUL mới chỉ vào phiên mới (`/new` rồi `/approve`) hoặc khi phiên được nén.

Chưa làm: viết lại các mục bộ nhớ tiếng Anh có sẵn của hồ sơ owner; gói chữ tiếng Việt cho thông báo hệ thống của chính Hermes
(`display.language` đang `en`, Hermes chưa có `vi`; hồ sơ có thể thêm `locales/vi.yaml`); ba đề xuất tiếng Anh đang chờ chủ quyết.

### 4.7 Rủi ro

- Cron chạy lúc bot đang trả lời chủ ⇒ hai luồng cùng DM; tin ngắn, không hỏi lại trong tin cron.
- Kênh `outcome_unknown` đóng băng tới khi đối soát (trang "Đối soát tin chưa rõ kết quả"). Lệnh digest mất phản hồi: prompt cron tra
  `crm_action_status` đúng một lần (4.6) để vẫn gửi được tin; tra cũng hỏng ⇒ các mục đã đánh dấu không xuất hiện ở tin sau (chỉ còn
  trong số "còn chờ" và trên web) — web là nguồn đúng, tin Zalo là tiện ích.
- Hơn 10 đề xuất mới trong một tối ⇒ phần dư sang tối sau (mỗi tối tối đa 10 số, mục nào đã báo đều có số trong tin).
- `learning.digest` gọi ngoài cron làm tin tối thiếu mục (4.2).
- Số `seq` lộ ra Zalo chỉ là số thứ tự, không phải id.

### 4.8 Tệp đã đổi (đợt 3)

| Phía | Tệp |
|---|---|
| SQL | `20261105025453_hermes_learning_action_v1.sql`: cột `announced_at`; guard bất biến dựng lại (khối `$requires$` ghim md5 thân guard đang chạy `54e4b8fc…` hoặc thân mới `e55ad2c8…`, khuôn C2); digest trần 10 = số dòng tin; vỏ INVOKER `public.hermes_learning_action_v1` (`scripts/hermes-task-function-contract.mjs` externalStandard) + bước DEFINER `app_private.hermes_learning_action_step_v1`; seed khoá TẮT; ghim băm `scripts/__tests__/hermes-durable-forward-fixture.mjs` (thân guard 041523 thành ghim superseded) + `hermes-durable-schema.test.mjs`; provenance + hồ sơ `chua-ap-dung-cho-y` |
| Connector | `learning-action-contract.mjs` (`defineAction` ×2, bộ dựng tin), `learning-digest.mjs` (`LEARNING_DIGEST_MAX_ITEMS`, rút trích thay vì bỏ dòng), `action-catalog.mjs` (`param.list` `unique`) / `action-contract.mjs` / `action-page-catalogs.mjs` (trang `learning`), `action-runtime.mjs` (`presenters`), `action-reasons.mjs` (`learning_not_pending`), `server.mjs`, `capability-contract.mjs` (+ `.d.mts`), `CONNECTOR.md` |
| Web | `src/hermes/capabilityLabels.ts` (+ test) |
| Skill | `infra/hermes-skills/ihome-crm-bai-hoc/SKILL.md`, `ihome-crm-ghi-chung` |
| Test | `learning-action-sql.test.mjs` (PGlite, 23 đột biến; tin dựng bằng presenter thật cho 25 đề xuất dài: mọi mục đã đánh dấu có số), `learning-digest.test.mjs` / `learning-action.test.mjs`, `server.test.mjs` (ghép thật), `action-tools-budget.test.mjs` (so main), `action-catalog` (`unique`) / `action-reasons` / `official-skills`, `capabilityLabels.test.ts`; PR bật: `action-activation-sql.test.mjs` + file lùi |
| Hồ sơ owner | job cron 21:00 VN (4.6) — điều phối viên tạo |

### 4.9 Thứ tự phát hành đợt 3

1. Review chéo PR đợt 3 (tier authorization + migration): base/head + kết luận ghi vào PR.
2. **Promote web** (nhãn `assistant.learning_review`) TRƯỚC hoặc CÙNG lúc bước 3.
3. Lane `20261105025453` TEST rồi production (dry-run → `--apply`, biên nhận) — mốc file đặt SAU chuỗi đang chờ áp J06 `20261104165619`
   → C1 `20261104173640` → C2 `20261104231450` (áp sau chúng; sau C1 hàm mới không tự có EXECUTE của PUBLIC — file này GRANT tường minh
   cho `authenticated` và REVOKE PUBLIC trên cả hai hàm mới); sinh lại provenance, `types.ts` (RPC public mới), surfaces từ
   production; gỡ hồ sơ `chua-ap-dung-cho-y`; merge PR ngay sau (bài học 22/10: áp xong phải merge ngay). Tới bước 5 mọi lời gọi bị guard
   từ chối (chưa có dòng chính sách).
4. Phát hành connector (đổi symlink `current`) có trang `learning`; cấu hình host thêm `"learning"` vào `actionPages` và có
   `publicWebOrigin`, rồi khởi động lại connector (cấu hình host không tự nạp lại). Triển khai skill chuẩn (`deploy.sh`, không cần khởi
   động lại Hermes); SOUL owner thêm `ihome-crm-bai-hoc`.
5. Review PR bật; lane migration bật TEST rồi production ⇒ khoá bật, kết nối `inherit_crm` nhận khoá. Kiểm trên hồ sơ TEST (connector
   8741, DB TEST) trước: `learning.decide` xem trước + xác nhận, `learning.digest` một lần.
   *(10/11/2026: TEST đã có khoá bật và hai dòng chính sách — đọc lại cùng ngày; nghiệm thu trang Bài học 09/11 chạy trên hồ sơ TEST
   này. Production áp 10/11, xem mục 4.)*
6. Tạo job cron 21:00 cho owner (4.6).

Lùi: file lùi của migration bật (tắt khoá, xoá hai dòng chính sách); gỡ `"learning"` khỏi `actionPages`; xoá job cron. Cột `announced_at`
và hai hàm của đợt 3 để lại (vô hại khi không có dòng chính sách).

## 5. Thứ tự phát hành (đợt 2 — PR #371)

1. Review chéo PR (tier authorization + migration): base/head + kết luận ghi vào PR.
2. Áp `20261031041523` qua lane trên TEST rồi production (dry-run → `--apply`, biên nhận); làm tươi provenance/surfaces.
   Migration tạo vai NOLOGIN `hermes_learning_ingest`.
3. Áp `20261101064441` qua lane (vai `hermes_store_learning` NOLOGIN, đúng một nhóm `hermes_learning_ingest`, không mật khẩu), rồi bật đăng nhập trên
   production bằng `scripts/hermes-learning-login.mjs` (một câu `ALTER ROLE … LOGIN PASSWORD`, verifier đọc từ file); mật khẩu chỉ ở VPS
   `/etc/ihome-hermes/learning-store-password`.
   `scripts/test-env/owners.mjs` đã khai sẵn login này (TEST dựng lại NOLOGIN).
4. Promote web (tab "Bài học chờ duyệt"); trước khi áp, trang báo "Máy chủ chưa có chức năng duyệt bài học".
5. Đổi release connector trên VPS sang bản có `infra/hermes-learning-audit/` (chỉ đổi symlink `current`; connector không gọi
   thao tác mới nên không cần restart vì lý do này).
6. Cài user + cấu hình + 5 unit theo README, chạy tay một lần, kiểm báo cáo + dòng `learning_ingest`, rồi bật 2 timer.

## 6. Sau quyết định (làm tay)

- **Duyệt**: điều phối viên đưa bài học vào bộ skill chuẩn `ihome-crm-*` rồi gỡ bản local.
- **Bỏ**: gỡ khỏi trợ lý — skill: `hermes curator rollback <ledgerId>`; bộ nhớ: xoá đúng mục. Nếu trợ lý học lại đúng bài học
  đã bỏ, SQL không đưa lại vào hàng chờ; job nạp báo riêng `rejectedDuplicates` + khoá trong journal.
- Đề xuất đã quyết định **không che, không xoá** — giữ nguyên làm lịch sử (chủ chốt 31/10; trigger chặn mọi sửa/xoá).
