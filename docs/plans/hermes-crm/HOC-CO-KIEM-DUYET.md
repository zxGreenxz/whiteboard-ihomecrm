# Học có kiểm duyệt cho Hermes (đợt 2 kế hoạch trị tận gốc — chủ duyệt 31/10/2026)

**Trạng thái:** (1) job kiểm học tập, (2) kho đề xuất + trang duyệt, (4) timer: đã viết trong cùng PR (đã sửa theo review chéo
REQUEST CHANGES 31/10) — **migration `20261031041523` + `20261101064441` đã áp TEST và production 01/11 qua lane; vai `hermes_store_learning` còn NOLOGIN, chưa bật login, chưa cài trên VPS** (runbook C→G trong PR #371). (3) tin Zalo 21:00 + duyệt qua Zalo: **đã phát hành production 10/11/2026** (mục 4) — migration
`20261105025453` áp 05/11, migration bật `20261105030528` áp 10/11 qua lane, connector production khai `actionPages: ["contract", "learning"]`,
job cron `ihome-learning-digest-2100` tạo 10/11 (4.6).
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
`outcome_unknown` chưa đối soát (xem 4.7).

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
     --schedule "0 21 * * *" --timezone Asia/Ho_Chi_Minh \
     --deliver "zalo_personal:<uid Zalo của chủ>" \
     --prompt "$(cat /root/ihome-hermes-cron/learning-digest-prompt.txt)"
   ```

   Bản Hermes chạy ngày 10/11/2026 KHÔNG có cờ múi giờ, lịch và prompt là tham số vị trí:
   `cron create --name ihome-learning-digest-2100 --deliver "zalo_personal:<uid>" "0 21 * * *" "$(cat …prompt.txt)"`.
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

4. Thử: chạy tay job một lần lúc chủ đồng ý (`cron run <id>` nếu bản Hermes có), kiểm tin tới đúng DM chủ và dòng audit
   `HERMES_ACTION_APPLIED` `learning.digest`; tối không có đề xuất mới ⇒ không có tin. Không thử bằng cách gọi `learning.digest` trong
   chat (đánh dấu thật trên production).

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
