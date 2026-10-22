# Thao tác ghi Hermes — trang CÔNG VIỆC (Đợt 2b: thiết kế đã duyệt, Mốc 2 đã hiện thực)

Ngày 22/10/2026 (giờ Việt Nam). Nhánh `claude/hermes-cong-viec-ghi-20261022`, gốc `origin/main` `2d0a0099a` (đã gộp `3ae1d57f6`).
Phiên chính duyệt Mốc 1 (22/10): CV1–CV14 theo mặc định mục 12; CV5 và CV10 chờ chủ (Q64, Q65). Mốc 2 (mục 16) có ba migration
và mã connector; **chưa áp migration nào, chưa đổi TEST hay production**.

Nguồn:
- Khung chung [NEN-CHUNG-THAO-TAC-GHI.md](NEN-CHUNG-THAO-TAC-GHI.md) mục 3–8 và 12 (đã gộp `main` #253, đã lên production 22/10).
- Khảo sát Công việc ngày 21/10 (máy làm việc, không nằm trong repo): §1 kiểm kê, §2 thao tác hay dùng, §3 khoảng trống R1–R24, §5 plan nháp P0–P8. Phần "tool riêng" của plan nháp nay thay bằng thao tác trong danh mục chung.
- Đáp án 40 câu của chủ (21/10). Đáp án là luật; plan mâu thuẫn với đáp án thì theo đáp án. Câu liên quan: Q2, Q3, Q5, Q7, Q27, Q28–Q40.
- Lô thử bot 22/10 trên TEST (sau #261, #262): tạo việc đúng 15/19; lỗi còn lại là trùng việc và hạn mức 10 việc/giờ/cặp mà bot không nói được lý do.
- Thiết kế anh em: Thu chi (PR #271), Hợp đồng (PR #270). Dùng chung kiểu `list`/`record` của Thu chi (TC8).

Ký hiệu: `HB` = `infra/hermes-broker`; `M/<ts>` = `supabase/migrations/<ts>_*.sql`; `B` = `supabase/baseline/schema.sql`.

Số đo production đọc cho tài liệu này (22/10, chỉ đọc, chỉ đếm): 383 việc; 1 việc đang mở; 0 việc giao cho người khác; tối đa 5 việc/giờ cho một cặp người giao–nhận và 8 việc/ngày cho một người; 25/383 việc (6,5 %) được tạo khi đã có việc cùng toà + phòng + loại đang mở; 2 việc ở toà ảo, 0 đang mở; 5 thành viên ACTIVE (2 chủ, 2 nhân viên, 1 partner), chỉ 1 người (một chủ) đã liên kết Zalo với bot.

## 0. Kết luận

1. **Bảy thao tác `task.*`, cắm vào `crm_action_*`, không thêm byte `tools/list`.**

   | Thao tác | Làm gì | Xem trước |
   | --- | --- | --- |
   | `task.create` | Tạo/giao một việc bằng tên toà, phòng, loại, người nhận, hạn | Khi giao người khác, khi phải đoán (loại, phòng), khi trùng việc đang mở, khi thiếu người nhận (Q31, Q32, Q36). Tự giao, đủ thông tin ⇒ tạo luôn |
   | `task.create_batch` | Giao tối đa 20 việc một lần (Q37) | Luôn, một lần cho cả lô |
   | `task.update` | Ghi nối tiến độ, đổi hạn, đổi người nhận, ưu tiên, tiêu đề/mô tả | Khi đổi người nhận |
   | `task.cancel` | Huỷ (xoá hẳn như web, Q34) | Luôn (Q33) |
   | `task.recurring_create` / `_pause` / `_delete` | Việc định kỳ (Q39, tính năng CRM mới) | Luôn |

   Gỡ 5 tool cũ cùng bản phát hành: `crm_task_create`, `crm_task_status`, `crm_task_input_options`, `crm_task_progress`, `crm_task_cancel` (−4 838 B). Giữ `crm_task_follow_list/set/stop`.
2. **Một RPC trang `public.hermes_task_action_v1`, bốn tầng, đúng khuôn của `hermes_task_create_action_v1` đang chạy production** (`M/20261014092945`): vỏ INVOKER thân SQL-standard → chuẩn bị DEFINER (guard, phạm vi, hạn mức, basis, biên nhận) → **ghi INVOKER dưới RLS người dùng** (INSERT/UPDATE/DELETE `jobs` như web, trigger mã việc và E4 chạy như web) → chốt DEFINER (đối chiếu hàng, biên nhận, audit). Web ghi `jobs` thẳng qua RLS, không có hàm ghi; vì vậy tầng ghi phải là INVOKER, không gọi từ trong DEFINER.
3. **Luật của chủ nằm trong SQL, không nằm trong lời dặn bot:** hạn mặc định hết ngày mai theo giờ công ty (Q30); thiếu người nhận ⇒ đề xuất người quản lý toà trong một câu (Q31); máy chủ đòi xác nhận theo Q32/Q36; huỷ chặn việc có vật tư/ảnh hoàn thành (Q33); hạn mức cấu hình được, nới cho chủ (Q37).
4. **Q35 sửa RLS `jobs` cho cả web lẫn Hermes:** thêm vế "người được giao thấy việc của mình" vào `jobs_select_rbac`. Vế này từng có và bị gỡ 28/05 (`M/20260528000003:257`). Bản xem trước cảnh báo khi người nhận không có quyền công việc ở toà đó.
5. **Khoá dùng lại `tasks.create` / `tasks.edit` / `tasks.delete`, một nguồn quyền.** Lớp quyền của khung chung cấp cả ba khoá; lớp quyền công việc cũ thôi cấp khoá. Nhờ vậy theo dõi việc dùng cùng phạm vi đã giao `buildings.view`, đóng mục (4) của known-gap `hermes-pham-vi-toa-chua-giao-web` cho công việc. `tasks.delete` chỉ bật lại sau khi `task.cancel` lên production (Q28).
6. **Việc định kỳ:** bảng quy tắc + bảng lần sinh khoá `(quy tắc, ngày)` chống trùng, cron ngày sinh việc dưới tên người tạo quy tắc; mất quyền ⇒ tự tạm dừng. Web để sau (Q40 = b).
7. **Nhắc qua Zalo:** hàng đợi trong DB (chống gửi trùng, giờ yên, trần tin/ngày) và ba RPC cho worker. **Hiện chỉ 1/5 thành viên đã liên kết Zalo, 0/2 nhân viên nhận việc** ⇒ phải có đường liên kết Zalo cho nhân viên thì tính năng mới có tác dụng (CV10).
8. **14 điểm cần chốt** (mục 12), đều có mặc định. Ước công 12–16 ngày kỹ sư, 5 mốc hiện thực (mục 13).

## 1. Phạm vi

| Làm (Đợt 2b) | Không làm, bot từ chối có chỉ đường web |
| --- | --- |
| Tạo/giao việc bằng tên, lô ≤ 20, sửa, ghi tiến độ nối, huỷ có xem trước | Hoàn thành việc thay người làm (ảnh chụp + GPS + thưởng, khảo sát #12) |
| Q35: RLS người nhận thấy việc; cảnh báo người nhận ngoài phạm vi | Ảnh việc: chỉ chừa `attachments` theo khuôn chung; đường ảnh Zalo là hạng mục riêng của phiên chính |
| Báo cáo đọc `tasks_board`, `task_recurrences` qua `crm_read_report` | Vật tư, tạo loại việc, giao bằng tên tự do (`assignee_name`) |
| Việc định kỳ: bảng, hàm sinh, cron, thao tác bot | Giao diện `/tasks` (Q40 = b), kể cả màn quy tắc định kỳ |
| Nhắc Zalo: hàng đợi DB, cron sinh nhắc, hợp đồng RPC với worker | Mã worker/VPS, liên kết Zalo trên web (phiên chính; CV10) |

## 2. Danh mục thao tác

### 2.1 Khai báo

Danh mục mới ở `HB/task-actions-contract.mjs`, khuôn `action-probe-contract.mjs`. Mọi thao tác dùng chung RPC `hermes_task_action_v1`.

| `id` | Khoá (registry + `capability-contract.mjs`) | `crm_permission` | Lớp | Chính sách DB | Máy chủ đòi xác nhận khi |
| --- | --- | --- | --- | --- | --- |
| `task.create` | `tasks.create` | `tasks.create` | `reversible` | `never`, `private_only` | người nhận ≠ người hỏi; loại hoặc phòng do máy chủ đoán; có việc trùng đang mở; người nhận không quản lý toà; thiếu người nhận và có đúng một người quản lý để đề xuất |
| `task.create_batch` | `tasks.create` | `tasks.create` | `reversible` | `always` | (luôn) |
| `task.update` | `tasks.edit` | `tasks.edit` | `reversible` | `never` | đổi người nhận |
| `task.cancel` | `tasks.delete` | `tasks.delete` | `irreversible` | `always` | (sàn D2) |
| `task.recurring_create` | `tasks.create` | `tasks.create` | `reversible` | `always` | (luôn) |
| `task.recurring_pause` | `tasks.edit` | `tasks.edit` | `reversible` | `always` | (luôn) |
| `task.recurring_delete` | `tasks.delete` | `tasks.delete` | `reversible` | `always` | (luôn; xoá quy tắc không xoá việc đã sinh) |

- Cả ba khoá đã có trong registry (`tasks.create`, `tasks.edit` bật; `tasks.delete` TẮT từ #259) và trong `capability-contract.mjs` (gói D). Không seed khoá mới.
- Một khoá nhiều thao tác ⇒ cùng `crm_permission` (ràng buộc của `hermes_action_capabilities_v1`): đúng như bảng.
- Khớp RLS `jobs`: tạo = `tasks.create`, sửa = `tasks.edit`, xoá = `tasks.delete` theo toà (`M/20260725200000:334-342`).

### 2.2 Tham số

Tên là chuỗi như người dùng nói; SQL giải (mục 2.3). Ngày theo giờ công ty (`org_today_v1`).

```text
task.create        buildingName name(building)   trống được khi roomName chỉ có ở một toà trong phạm vi
                   roomName     name(room)       trống, "tn", "toà", "cả toà" = cả toà (như web textMatch.ts:19)
                   jobType      name(jobType)    trống ⇒ SQL đoán theo content; đoán ⇒ xem trước
                   content*     text 1–200       nội dung ngắn; tiêu đề = "<loại> <content>" như web (bỏ lặp nếu content đã mở đầu bằng tên loại)
                   description  text 1–2000      trống = content
                   assigneeName name(person)     "tôi"/"mình"/"em"/"anh"/"chị" đứng một mình = người hỏi; trống ⇒ Q31
                   deadline     date             trống ⇒ hết ngày mai (Q30); quá khứ ⇒ needs_input date_out_of_range
                   deadlineTime time HH:MM       trống ⇒ 23:59:59.999 như web
                   priority     oneOf NORMAL, URGENT, LOW   trống ⇒ NORMAL
task.create_batch  items        list 1–20 của record {buildingName, roomName, content, jobType, assigneeName, deadline, deadlineTime, priority}
                   buildingsManagedBy name(person)   thay cho items: mỗi toà người này quản lý (trong phạm vi ghi) một việc
                   jobType, content, assigneeName, deadline, deadlineTime, priority   giá trị chung; mục thiếu trong item lấy từ đây
                   (đúng một trong items / buildingsManagedBy)
task.update        job*         name(job)        mã việc "JOB-20261021-0003", 4 số cuối, "vừa giao", hoặc tiêu đề
                   buildingName, roomName        thu hẹp khi tìm theo tiêu đề
                   note         text 1–1000      ghi NỐI vào tiến độ
                   deadline, deadlineTime, assigneeName, priority, content (đổi tiêu đề), description   (ít nhất một trường đổi)
task.cancel        job*, buildingName, roomName, reason text 8–300 (tuỳ chọn; vào audit)
task.recurring_create  buildingName*, roomName, jobType, content*, assigneeName, priority,
                   frequency* oneOf daily, weekly, monthly; every int 1–12 (mặc định 1);
                   weekdays list 1–7 của oneOf MON…SUN (weekly); monthDay int -1–31 (monthly; -1 = cuối tháng);
                   startDate date (mặc định hôm nay); endDate date; dueDays int 0–30 (hạn = ngày sinh + N, cuối ngày)
task.recurring_pause   rule* name(recurrence) (mã "DK-0003" hoặc nội dung), resume bool (true = chạy lại)
task.recurring_delete  rule*
```

- Kiểu mới cho file chung: `param.time()`; `param.name` thêm `jobType`, `job`, `recurrence` (mục 9). `list`/`record` lấy của Thu chi; nếu `list` chưa nhận phần tử vô hướng thì `weekdays` là text `"MON,THU"` và SQL kiểm.
- `requestId` do connector cấp như khung chung; bot không cần `crm_new_request_id` cho thao tác mới.

### 2.3 Giải tên

Lõi giải tên riêng của trang `app_private.hermes_task_resolve_core_v1` (plpgsql INVOKER, chỉ tham chiếu `public.*`, gắn OID trong vỏ như lõi giải tên của khung chung). Chạy dưới RLS người hỏi, trong phạm vi toà của khoá ghi.

| Trường | Luật |
| --- | --- |
| Toà, phòng | `public.hermes_write_name_resolve_v1` (D7): toà bỏ dấu, bỏ tiền tố, mã tách bí danh, tên thường gọi; phòng chỉ khớp bằng; chỉ nêu phòng ⇒ toà suy từ phòng duy nhất. Từ khoá cả toà xử lý trước khi gọi |
| Toà ảo | **Không nhận** (CV6). Hàm giải tên ghi đã loại toà ảo; web cũng không tạo việc ở toà ảo (`useBuildings` lọc `is_virtual`, RLS SELECT `jobs` đi qua `accessible_building_ids()` vốn loại toà ảo). Production: 2/383 việc ở toà ảo, 0 đang mở |
| Loại việc | Có `jobType` ⇒ hàm giải tên ghi (bỏ loại đã tắt). Trống ⇒ đoán: loại đang bật có tên (bỏ dấu) là một từ hoặc cụm đứng đầu `content`, như `jobQuickInput.ts:122-124`; đúng một ⇒ dùng + đòi xác nhận; 0 hoặc ≥ 2 ⇒ `needs_input` (`field: jobType`) kèm ≤ 8 loại đang bật |
| Người nhận | Từ chỉ chính mình ⇒ người hỏi. Còn lại ⇒ hàm giải tên ghi (`person`: hồ sơ thấy qua RLS + thành viên ACTIVE theo `hermes_task_assignee_member_v1`, đúng luật hàm tạo việc đang dùng) |
| Thiếu người nhận (Q31) | `app_private.hermes_task_building_managers_v1(org, toà)` (DEFINER) trả id người quản lý toà (mục 3.4); lõi chỉ giữ người mà người hỏi thấy hồ sơ. Đúng 1 ⇒ bản xem trước "Chưa nêu người nhận — giao Nathan (quản lý toà 44TL) nhé?"; 0 hoặc ≥ 2 ⇒ `needs_input` (`field: person`, `why: unspecified`) kèm danh sách |
| Việc (`job`) | Mã đầy đủ khớp bằng (không phân biệt hoa thường); 3–4 chữ số ⇒ đuôi mã trong các việc đang mở; "vừa giao"/"vừa tạo" ⇒ việc mới nhất người hỏi tạo qua Hermes trong 24 giờ; còn lại ⇒ tiêu đề bỏ dấu chứa chuỗi, chỉ trong việc ĐANG MỞ thấy được qua RLS và trong phạm vi khoá, lọc thêm theo toà/phòng nếu có. 0 ⇒ `not_found`; chỉ khớp việc đã xong ⇒ `task_not_open`; ≥ 2 ⇒ `name_unresolved` kèm ứng viên "JOB-…-0003 · sửa vòi nước (44TL/201, Nathan)". **Không bao giờ tự chọn** (sự cố 21/10: huỷ nhầm việc cùng tên ở 158PVC) |
| Quy tắc (`rule`) | Mã `DK-NNNN` khớp bằng; còn lại nội dung bỏ dấu chứa chuỗi trong quy tắc chưa xoá; luật mơ hồ như `job` |

### 2.4 Lý do riêng của trang (thêm vào danh sách đóng)

| Mã | Dạng | Câu tĩnh (dự kiến) | Nguồn |
| --- | --- | --- | --- |
| `cancel_blocked` | rejected | Việc đã có vật tư hoặc ảnh hoàn thành nên không huỷ qua bot; mở việc trên web (link kèm theo) để xử lý. | bước chuẩn bị đọc `material_usages`, `completion_attachments` (như `hermes_task_cancel_blocked`) |
| `task_not_open` | rejected | Việc đã hoàn thành; không sửa hay huỷ qua bot được. | `status <> 'IN_PROGRESS'` |
| `task_quota_user` | rejected | Anh/chị đã giao quá số việc cho phép trong 1 giờ qua bot (mặc định 30 việc/giờ; chủ 60); thử lại sau ít phút hoặc tạo trên web. | hạn mức theo người tạo (mục 3.5) |
| `task_quota_pair` | rejected | Đã giao quá số việc cho phép cho cùng một người nhận trong 1 giờ (mặc định 10 việc/giờ; chủ 40); thử lại sau ít phút. | hạn mức theo cặp, cả hai chiều |

- Không dùng hai tên nháp `loop_blocked`, `assignee_cannot_see_building` của nền chung mục 6.1: "vòng" thực chất là hạn mức theo cặp; người nhận ngoài phạm vi nay là **cảnh báo** (Q35), không chặn.
- Số trong câu tĩnh là giá trị seed của bảng hạn mức; test tầng 1 đọc seed trong migration và so với câu. Đổi seed mà quên câu ⇒ đỏ.
- Mã chung dùng lại: `not_found`, `name_unresolved`, `date_out_of_range`, `invalid_params` (needs_input); `not_allowed`, `state_changed`, `request_conflict`, `crm_refused`, `web_only` (rejected).
- Ánh xạ trong `app_private.hermes_task_reason_v1(sqlstate, message, constraint)`: khớp mẫu riêng của trang trước, không khớp thì gọi `hermes_action_reason_v1`. Hàm chung không đổi ⇒ không xung đột SQL với Thu chi, Hợp đồng.

### 2.5 Bản xem trước nói gì

Mỗi bản xem trước có `text` (một đoạn để bot đọc nguyên văn, như trang Hợp đồng) và trường có cấu trúc; không có UUID. Ngày luôn kèm thứ và khoảng cách tới hôm nay để người dùng bắt lỗi ngày tương đối.

```text
create   text: "Tạo việc 'sửa vòi nước' (loại sửa) — toà 1392QT, phòng 201 — giao Nathan — hạn hết thứ Năm 23/10/2026 (ngày mai, mặc định) — ưu tiên Bình thường."
         warnings: ["Loại việc 'sửa' do bot chọn theo nội dung.",
                    "Đã có việc JOB-20261021-0004 'sửa vòi nước' đang mở ở phòng này (giao Joey, hạn 22/10) — vẫn tạo thêm?",
                    "Nathan không có quyền công việc ở toà 1392QT: vẫn thấy việc nhưng không sửa/hoàn thành được trên web.",
                    "Chưa nêu phòng: việc cho CẢ TOÀ."]
batch    text: "Giao 18 việc 'kiểm đồng hồ điện' cho Nathan, hạn hết thứ Sáu 31/10/2026 (còn 9 ngày): 1392QT, 44TL, … (đủ danh sách)."
         items: [{stt, building, room, title, assignee, deadline}], warnings: trùng từng dòng, hạn mức còn lại
update   text: "Việc JOB-20261021-0003 'sửa vòi nước' (44TL/201): đổi người nhận Joey → Nathan; hạn 22/10 → 25/10."
cancel   text: "Huỷ hẳn việc JOB-20261021-0003 'sửa vòi nước' — 44TL, phòng 201 — giao Nathan — hạn 22/10 — đang làm. Không khôi phục được; nhật ký giữ mã và tiêu đề."
recurring_create text: "Tạo việc định kỳ 'kiểm máy bơm' — 111PVC, cả toà — giao Nathan — mỗi thứ Hai, từ 27/10/2026, hạn cuối ngày sinh. Ba lần tới: 27/10, 03/11, 10/11."
```

Kết quả `applied` có tên: `{text, job:{code, title, building, room, assignee, deadline, priority}, deadlineDefaulted, link}`; `link` = `/tasks?job=<id>` (khung chung cho phép UUID trong link). Lô: `jobs[]` từng dòng. Q30: tạo thẳng với hạn mặc định thì `text` nói rõ "hạn mặc định hết ngày mai 23/10".

### 2.6 Trùng việc (Q36)

- **Định nghĩa:** cùng toà + cùng phòng (hoặc cùng "cả toà") + cùng loại + đang mở. Production: 25/383 việc (6,5 %) rơi vào trường hợp này.
- **Hàm dùng chung** `public.job_open_duplicates_v1(p_building uuid, p_room uuid, p_job_type uuid)` INVOKER STABLE, dưới RLS người gọi; trả ≤ 5 việc (mã, tiêu đề, người nhận, hạn). Web dùng được khi làm lại ô tạo việc (Q40 về sau).
- Có trùng ⇒ máy chủ đòi xác nhận và nêu việc trùng. Tập id trùng nằm trong `basis`: có thêm việc trùng giữa hai lượt ⇒ `state_changed`.
- Lô: trùng với việc đang mở và trùng giữa các dòng trong lô đều thành cảnh báo theo dòng.

## 3. SQL

### 3.1 RPC bốn tầng

```text
public.hermes_task_action_v1(p_binding, p_action, p_phase, p_request_id, p_params, p_resolved, p_expected_basis)
  INVOKER, thân SQL-standard (BEGIN ATOMIC), search_path pg_catalog,public — băm ghim ở scripts/hermes-task-function-contract.mjs
  g  = app_private.hermes_action_guard_v1(binding, action)                 -- khung chung: binding, registry, khoá, quyền CRM, tập toà ∩ web
  r  = app_private.hermes_task_resolve_core_v1(g, action, params)          -- INVOKER, RLS người hỏi; chỉ ở preview/auto
  p  = app_private.hermes_task_action_prepare_v1(binding, action, phase, rid, params, resolved, basis, r)   -- DEFINER
  w  = app_private.hermes_task_action_write_v1(p)                          -- INVOKER: INSERT/UPDATE/DELETE jobs dưới RLS
  →    app_private.hermes_task_action_finish_v1(binding, action, w)        -- DEFINER
```

- **Chuẩn bị (DEFINER).** Chạy lại guard; kiểm bản đã giải còn trong phạm vi (toà ∈ `ctx.buildingIds`, phòng thuộc toà, loại đang bật thuộc công ty, người nhận là thành viên ACTIVE); khoá hàng `jobs` bằng `FOR UPDATE` với update/cancel; tính `basis`; quyết định xác nhận; ở lượt ghi thì kiểm hạn mức (khoá tư vấn theo công ty + người hỏi) rồi mở biên nhận bằng `hermes_action_receipt_begin_v1` và cấp sẵn id việc. Trả kế hoạch jsonb. Kế hoạch là preview / needs_input / rejected / replay thì hai tầng sau chỉ chuyển tiếp.
- **Ghi (INVOKER).** Chạy dưới vai `authenticated` với JWT người dùng, nên RLS `jobs` và trigger (`trg_autofill_org`, `jobs_set_user_id_audit`, `generate_job_code`, E4 `notify_job_assigned_v1`) chạy y như web. Bọc lệnh ghi bằng `EXCEPTION WHEN OTHERS`: lỗi tạm `40001/40P01/55P03/PT409` thì `RAISE` lại (cả giao dịch lùi, kể cả biên nhận); lỗi khác ⇒ `hermes_task_reason_v1` và kế hoạch mang `rejected`. Ghi 0 hàng (RLS chặn) ⇒ `not_allowed`.
- **Chốt (DEFINER).** Đọc lại hàng vừa ghi, đối chiếu với kế hoạch (như `hermes_task_finish_v1` cũ: người tạo, toà, phòng, loại, người nhận, hạn, trạng thái, có mã); ghi sổ `app_private.hermes_task_jobs`; audit `HERMES_TASK_CREATED/UPDATED/CANCELLED` (huỷ giữ mã + tiêu đề, Q34); báo người theo dõi; chốt biên nhận bằng `hermes_action_receipt_finish_v1`.
- **Vì sao không gọi tầng ghi từ trong DEFINER:** hàm INVOKER gọi từ DEFINER chạy dưới vai chủ hàm và bỏ qua RLS. Chuỗi phải nằm ở cấp vỏ, như `hermes_task_create_action_v1` và `hermes_task_follow_action_v1` đang làm.
- **Quyền thực thi:** `authenticated` có EXECUTE trên vỏ, guard, lõi giải tên, ba tầng; không có USAGE `app_private` (tới qua OID). Biên nhận, ánh xạ lý do, hàm quản lý toà, hạn mức chỉ DEFINER gọi. Khối kiểm cuối migration đòi vỏ có `prosqlbody`, theo khuôn M1.

### 3.2 `basis` và lượt 2

| Thao tác | `basis` = md5 của | Lượt 2 |
| --- | --- | --- |
| `create` | id toà/phòng/loại/người nhận, hạn, tiêu đề, tập id việc trùng, cờ người nhận quản lý toà | Lệch ⇒ `state_changed`, không chốt biên nhận |
| `create_batch` | nối basis từng dòng theo thứ tự | **Cả lô hoặc không gì** (CV8): ghi lần lượt trong một khối con; một dòng lỗi ⇒ lùi cả lô, chốt `rejected` với lý do của dòng đầu tiên kèm số dòng ở `result` của biên nhận; lỗi tạm ⇒ `RAISE` |
| `update` | id việc + md5 các cột đổi được (tiêu đề, mô tả, hạn, người nhận, ưu tiên, trạng thái, tiến độ) | Ghi chú thêm thẳng không cần basis (thao tác `auto`); đổi người nhận ở lượt 2 kiểm basis |
| `cancel` | id việc + trạng thái, tiêu đề, người nhận, toà, phòng, số dòng vật tư, có ảnh hoàn thành | Khoá `FOR UPDATE` ở bước chuẩn bị chặn chèn vật tư đồng thời (FK cần khoá KEY SHARE trên hàng việc) |
| `recurring_*` | id quy tắc + `version` | CAS theo `version` |

### 3.3 Ghi chú tiến độ (`update.note`)

- Ghi NỐI vào `completion_description` một dòng `[dd/mm HH:MM Tên] nội dung`; giữ 4 000 ký tự cuối. Đây đúng cột mà `crm_task_progress` đang thay toàn bộ; web hiện chỉ hiện cột này sau khi việc xong (khảo sát R13; sửa web để sau theo Q40).
- Quyền theo web: ai có `tasks.edit` ở toà (RLS). Luật cũ của Hermes "chỉ người tạo hoặc người nhận" bỏ (CV4).
- Báo người theo dõi bằng đúng `app_private.hermes_task_follow_notify_v1(…, 'progress', …)` như tool cũ.

### 3.4 Hàm dùng chung mới (luật 17/10)

| Hàm | Kiểu | Dùng ở | Ghi chú |
| --- | --- | --- | --- |
| `public.job_deadline_v1(p_organization_id, p_date date, p_time time)` | INVOKER IMMUTABLE theo múi giờ công ty (đọc `organization_timezones` như `org_today_v1`) | Hermes tạo/sửa, quy tắc định kỳ; web ô gõ nhanh về sau | `p_date` NULL ⇒ ngày mai; `p_time` NULL ⇒ 23:59:59.999. Web hiện tính theo múi giờ trình duyệt (khảo sát R21) |
| `public.job_open_duplicates_v1(…)` | INVOKER STABLE | Q36 (mục 2.6) | |
| `app_private.hermes_task_building_managers_v1(p_org, p_building)` | DEFINER STABLE | Q31, cảnh báo Q35, `buildingsManagedBy` | Không có bảng "quản lý toà": `staff_assignments` là hệ cũ, `profit_managers` là lương. Dùng quyền hiệu lực như `M/20260928024843:79-87`: thành viên ACTIVE có `tasks.edit` và `buildings.view` ở toà theo `authorize_tenant_action_v3`, **bỏ người có phạm vi Toàn tổ chức** (chủ) để gợi ý đúng người quản lý; nếu chỉ còn chủ thì trả rỗng |
| `app_private.hermes_task_quota_v1(p_org, p_actor, p_assignees uuid[])` | DEFINER | `create`, `create_batch` | Đọc `app_private.hermes_task_limits`; đếm sổ `hermes_task_jobs` 60 phút |

### 3.5 Hạn mức (Q37)

- **Bảng** `app_private.hermes_task_limits(organization_id uuid NULL, tier text CHECK (tier IN ('owner','member')), per_actor_hour int, per_pair_hour int, updated_at)`, `organization_id` NULL = mặc định. Đổi bằng migration qua lane.
- **Seed đề xuất:** `member` 30/giờ/người tạo và 10/giờ/cặp (giữ đúng số hiện nay ở `M/20261015110000:87,94`); `owner` 60 và 40. Hạng `owner` = `organization_memberships.member_type = 'OWNER'`. Lô 20 việc cho một người vì vậy qua được với chủ, như ví dụ Q37 (18 toà cho Nathan).
- **Đếm việc Hermes tạo**, không đếm việc tạo trên web: sổ `app_private.hermes_task_jobs(job_id PK, organization_id, actor_id, assignee_id, request_id, action, source 'action'|'recurrence', rule_id, created_at)`. Sổ này còn dùng cho "vừa giao". Việc do quy tắc định kỳ sinh không tính vào hạn mức.
- Hạn mức cũ là trigger trên `hermes_task_create_receipts` (chỉ chạy với tool cũ), giữ nguyên cho tới khi gỡ tool cũ.
- Đo production: tối đa 5 việc/giờ/cặp và 8 việc/ngày/người ⇒ hạn mức không chạm cách dùng web hiện nay.

### 3.6 Q35 — người được giao luôn thấy việc của mình

- **Web:** `jobs_select_rbac` thêm vế `OR (assignee_id IS NOT NULL AND assignee_id = (SELECT auth.uid()))`, viết kiểu tập hợp như các vế hiện có. Thông báo E4 mở `/tasks?job=<id>` sẽ thấy việc thay vì "Không tìm thấy".
- **Hermes:** mọi đường đọc mới (`tasks_board`, lõi giải tên `job`) đi qua RLS nên tự có. Đường DEFINER cũ `hermes_task_follow_read_v1` (`role=assigned_to_me`) thêm đúng một vế cùng nghĩa; reader `tasks` của họ đọc v1 tra lại ở Mốc 2 và làm tương tự nếu là DEFINER. Test PG17 khoá: cùng fixture, RLS và các reader DEFINER cho cùng tập việc của người nhận ngoài phạm vi.
- **Giới hạn:** chỉ là XEM. Người nhận ngoài phạm vi vẫn không sửa/hoàn thành được trên web (RLS UPDATE đòi `tasks.edit` ở toà). Bản xem trước cảnh báo đúng điều này (CV5). Hoàn thành cho người nhận ngoài phạm vi là câu hỏi mới cho chủ.
- **Phụ thuộc Q53** (chủ chưa trả lời: siết SELECT `jobs` đòi `tasks.view`). Nếu chủ chọn siết thì gộp cùng migration để chỉ thay policy một lần.
- Production hiện 0 việc giao cho người khác ⇒ vế mới chưa làm ai thấy thêm việc nào. Đo lại số người thấy thêm trước khi áp (truy vấn chỉ đọc trong việc phiên chính phải làm).

## 4. Đọc một lần đủ ý (W2, không thêm tool)

| Báo cáo | Gói / khoá | Tham số (có sẵn trong `W2_PARAMS`) | Hàng / summary |
| --- | --- | --- | --- |
| `tasks_board` | C (`van_hanh`), `tasks.view` | `buildingId`/`buildingName`, `roomId`/`roomName`, `staffId` (người nhận), `query` (mã, tiêu đề, **tên người nhận** bỏ dấu), `status` = `IN_PROGRESS` / `COMPLETED` / `OVERDUE`, `kind` = trục ngày `deadline` / `created` / `completed` + `fromDate`/`toDate` | mã, tiêu đề, loại, toà, phòng, người nhận, người giao, hạn (giờ công ty), quá hạn N ngày, tiến độ (300 ký tự đầu), ngày tạo/xong, nguồn (web/Hermes/định kỳ), link; summary `count`, `overdue`, `byAssignee` (≤ 20: mở, quá hạn), `byBuilding` (≤ 50) |
| `task_recurrences` | C, `tasks.view` | `buildingId`/`buildingName`, `status` = `ACTIVE` / `PAUSED` | mã DK, nội dung, toà/phòng, người nhận, chu kỳ dạng chữ, lần tới, trạng thái + lý do tạm dừng |

- **Hai việc ở file chung W2** (yêu cầu cho "gói Z"): thêm `tasks.view` vào `W2_REUSED_KEYS` (`wave2-kit.mjs:114`) và `hermes_w2_reused_keys_v1`; test `wave2-foundation.test.mjs:111` so SQL với JS. Không thêm tham số mới (lọc tên người nhận đi qua `query`).
- **Phạm vi:** dùng `rls_buildings` để việc của người nhận ngoài phạm vi (Q35) hiện được; Mốc 4 kiểm rào `fence` của broker với phạm vi này, không hợp thì dùng `rows` và ghi giới hạn.
- Reader thay `hermes_w2c_catalog_v1` / `hermes_w2c_read_v1` bằng migration mới, ghim md5 thân đang chạy production (bài học #267). Nguồn dữ liệu là hàm INVOKER mới `public.jobs_board_v1(p_organization_id, p_building_ids, …)`, dùng lại được cho web.
- **Known-gap `hermes-pham-vi-toa-chua-giao-web`:** mục (4) của công việc đóng vì gỡ `crm_task_input_options` và vì khoá công việc nay lấy phạm vi từ khung chung (đã giao `buildings.view`). Mục (3) (lượt theo dõi tạo trước #261): thay `hermes_task_follow_grant_v1` kiểm thêm `buildings.view`, đóng lượt theo dõi khi mất toà; làm ở Mốc 4, ghim md5.
- Tên người trong hàng/summary theo RLS `profiles` của người hỏi; tên không xem được ghi "(không xem được tên)". Bot đứng tên NG TÂM (Q27) nên cần kiểm ở tầng 2.

## 5. Việc định kỳ (Q39 = b)

### 5.1 Dữ liệu (CRM, schema `public`, RLS bật)

```text
public.job_recurrence_rules(id, organization_id, code 'DK-NNNN' UNIQUE theo công ty, building_id NOT NULL, room_id, job_type_id NOT NULL,
  title, description, assignee_id, priority, frequency CHECK (daily|weekly|monthly), every 1–12, weekdays smallint[] (ISO 1–7),
  month_day -1–31, start_date, end_date, due_days 0–30, created_by, created_at, updated_at, version,
  paused_at, paused_reason CHECK (user|permission_lost|membership_lost|target_deleted), deleted_at, last_generated_date)
public.job_recurrence_occurrences(rule_id, occurrence_date, job_id NULL (ON DELETE SET NULL), outcome generated|skipped, reason, created_at,
  PRIMARY KEY(rule_id, occurrence_date))                               -- khoá tự nhiên: một quy tắc không bao giờ sinh hai việc cho một ngày
```

- RLS: SELECT như `jobs` (theo `buildings.view` của toà). Ghi chỉ qua hàm: `public.job_recurrence_create_v1 / _set_paused_v1 / _delete_v1` (INVOKER, dưới policy INSERT/UPDATE/DELETE đòi `tasks.create/edit/delete` ở toà). Web về sau gọi đúng các hàm này; tầng ghi của Hermes cũng gọi chúng.
- Xoá quy tắc là xoá mềm (`deleted_at`): giữ lịch sử lần sinh cho khoá chống trùng. Việc đã sinh không bị xoá.
- Trần: ≤ 100 quy tắc đang chạy mỗi công ty (cấu hình trong bảng hạn mức).

### 5.2 Sinh việc

- **Ngày sinh:** `public.job_recurrence_dates_v1(frequency, every, weekdays, month_day, start_date, end_date, p_from, p_to)` IMMUTABLE, dùng cho bộ sinh, bản xem trước ("ba lần tới") và web về sau. Tháng tính từ mốc neo, không cộng dồn: ngày 29–31 rơi vào tháng thiếu ⇒ ngày cuối tháng đó, tháng sau trở lại đúng ngày. Đây là bài học của phiếu định kỳ (`M/20260603000010:5,43`).
- **Bộ sinh** `app_private.job_recurrence_generate_v1(p_today date DEFAULT NULL)` DEFINER, cron `job-recurrence-daily` lúc 00:10 giờ Việt Nam. pg_cron có sẵn: migration đã đặt 7 lịch, trong đó có `hermes-task-follow-15m`.
  1. Với mỗi quy tắc đang chạy, lấy các ngày đến hạn trong (`last_generated_date`, hôm nay], bù tối đa 7 ngày sau sự cố.
  2. `INSERT … occurrences ON CONFLICT DO NOTHING`; chỉ ngày vừa chèn được mới sinh việc ⇒ chạy lại hay hai lần chạy song song không sinh trùng.
  3. Kiểm lại: người tạo còn là thành viên ACTIVE và còn `tasks.create` ở toà (`authorize_tenant_action_v3`, cùng hàm mà policy INSERT dựa vào); người nhận còn là thành viên; toà/phòng/loại còn sống. Hỏng ⇒ tạm dừng quy tắc với lý do, ghi lần sinh `skipped`, audit `JOB_RECURRENCE_PAUSED`.
  4. Đặt `request.jwt.claims` cục bộ = người tạo quy tắc rồi INSERT `jobs`: trigger `jobs_set_user_id_audit`, mã việc và E4 thấy đúng người tạo, như khi người đó tự tạo.
  5. Mỗi quy tắc một khối con: một quy tắc lỗi không chặn các quy tắc khác. Ghi sổ `hermes_task_jobs` (`source = recurrence`).
- Việc sinh ra là việc thường: hiện ở `/tasks`, được nhắc như việc thường; mô tả có dòng "(định kỳ DK-0003)".

### 5.3 Web (Q40 = b)

Không làm giao diện. Đề xuất cho đợt web sau: một thẻ "Việc định kỳ" ở `/tasks` (danh sách, tạm dừng, xoá) gọi đúng ba hàm ở 5.1 và báo cáo nguồn `task_recurrences`. Trong lúc chưa có, chủ xem/tắt quy tắc qua bot.

## 6. Nhắc việc qua Zalo (Q38 = b)

### 6.1 Hiện trạng (đã tra)

- Nhắc hiện có: chuông + push qua `hermes_task_follow_notify_v1`, chỉ cho việc Hermes đang theo dõi (`hermes-task-follow-15m`); E4 khi giao. Không có đường Zalo.
- Gửi ra Zalo hiện chỉ đi qua `zalo_send_queue` (worker poll 2 giây). Nhưng với nick bot Hermes, guard `hermes_zalo_shared_inbox_guard_v1` chặn mọi DM thường ⇒ **không dùng được `zalo_send_queue` để DM nhân viên**.
- Liên kết người dùng CRM ↔ Zalo duy nhất là `app_private.hermes_zalo_bindings` (ghép qua `/hermes-link`). Production: 1/5 thành viên có liên kết (một chủ); 0/2 nhân viên đang nhận việc.
- Nick bot là nick cá nhân (zca-js). Chỉ gửi được cho người đã nhắn với bot (đã có hội thoại). Tài liệu Zalo (`docs/zalo/PLAN.md`) đặt trần khởi điểm 1 tin/3 giây, 30 tin/giờ, 200 tin/ngày mỗi nick, không tra SĐT hàng loạt.

### 6.2 Thiết kế phía DB (Mốc 6, trong repo)

```text
app_private.task_reminder_config(organization_id PK, enabled bool DEFAULT false, due_hour 8, overdue_hour 8, overdue_days 3,
  daily_cap 2, app_base_url text)                                   -- seed TẮT; phiên chính bật bằng migration riêng
app_private.task_reminder_outbox(id, organization_id, user_id, channel 'zalo', kind CHECK (due_today|overdue), reminder_date date,
  job_ids uuid[] (≤ 10), body text (≤ 1000), state CHECK (queued|claimed|sending|sent|failed|skipped|unknown), not_before,
  attempts ≤ 3, lease_until, instance_id, provider_started_at, sent_at, error_code, created_at,
  UNIQUE(organization_id, user_id, kind, reminder_date))            -- chống gửi trùng: tối đa một tin mỗi loại mỗi ngày mỗi người
```

- **Sinh nhắc** `app_private.task_reminder_enqueue_v1()`, cron `task-reminders-15m`. Với công ty bật nhắc, mỗi người nhận có liên kết Zalo:
  - `due_today`: việc đang mở hạn trong hôm nay, từ `due_hour`;
  - `overdue`: việc quá hạn, mỗi sáng từ `overdue_hour`, tối đa `overdue_days` ngày rồi thôi (production đang có việc quá hạn 6–12 ngày; nhắc mãi thì thành rác);
  - gom mọi việc của người đó vào MỘT tin mỗi loại; ≤ `daily_cap` tin/người/ngày;
  - tôn trọng `notify_gate_v1(user, org, 'E4')` (tắt E4 ⇒ không nhắc Zalo) và giờ yên của công ty (`notification_org_config`, mặc định 21–7) bằng `not_before`;
  - nội dung chỉ có mã, tiêu đề, toà/phòng, hạn và link `/tasks`; không SĐT, không tên khách.
- **Ba RPC cho worker** (chỉ `service_role`, khuôn `zalo_worker_claim_job_v1` / `zalo_worker_begin_provider_v1`):
  - `zalo_worker_claim_task_reminders_v1(p_instance, p_limit)` ⇒ dòng `queued` đến giờ, chuyển `claimed`, lease 60 s, trả `{id, accountId, peerUid, body}`;
  - `zalo_worker_begin_task_reminder_v1(p_id, p_instance)` ⇒ cổng ngay trước khi gọi Zalo: việc còn mở (hết ⇒ `skipped`), liên kết còn ACTIVE, ngoài giờ yên, lease còn; chuyển `sending`, ghi `provider_started_at`;
  - `zalo_worker_settle_task_reminder_v1(p_id, p_instance, p_outcome sent|failed|unknown, p_error_code)`. `failed` thử lại tối đa 3 lần, giãn cách; `unknown` (đã gọi Zalo, mất phản hồi) **không bao giờ gửi lại**. Lease quá hạn: `claimed` ⇒ `queued`; `sending` ⇒ `unknown`.
- Hàng đợi là nhật ký gửi; worker không ghi `zalo_messages` cho tin nhắc (tránh guard hộp thư chung), giống cách cầu native `/v1/send` gửi cho người đã ghép.
- Chuông + push giữ nguyên. Zalo là kênh thêm, không thay.

### 6.3 Phần của phiên chính

Worker: gọi claim → `api.sendMessage(peerUid)` bằng nick bot → settle, trong nhịp tự động hoá 60 s; tuân trần tin của nick. Liên kết Zalo cho nhân viên theo CV10. Bật `task_reminder_config.enabled` bằng migration riêng sau khi worker lên.

## 7. Connector

1. `HB/task-actions-contract.mjs`: danh mục 7 thao tác bằng `defineAction`, `rpc: 'hermes_task_action_v1'`, `page: 'task'`.
2. `HB/server.mjs` nạp danh mục production (một dòng cho trang Công việc cạnh dòng của Thu chi/Hợp đồng). Thiếu RPC trang (PGRST202) ⇒ `action_disabled`, như khung đã xử.
3. **Một nguồn quyền cho khoá công việc (CV1).** `createActionAuth` cấp `tasks.create/edit/delete` từ `hermes_action_capabilities_v1` (phạm vi đã giao `buildings.view`). `createTaskAuth` thôi cấp `tasks.create`; `extendTaskFollowAuthorization` thôi cấp `tasks.edit`/`tasks.delete` (giữ `assistant.memory.supervise`). Nếu không đổi, hai lớp cùng cấp một khoá ⇒ `context_changed` (rào hiện có ở `task-adapter.mjs:39`, `action-adapter.mjs`). Theo dõi việc tiếp tục đọc `tasks.create` trong quyền hiệu lực, nay đến từ lớp khung chung.
4. **Gỡ tool cũ (CV2):** `crm_task_create`, `crm_task_status`, `crm_task_input_options`, `crm_task_progress`, `crm_task_cancel` cùng adapter/hợp đồng của chúng; SQL cũ giữ nguyên, không DROP. Gỡ `crm_task_cancel` là điều kiện để bật lại `tasks.delete` mà không làm tool cũ hiện lại.
5. **Byte `tools/list`:** họ thao tác 1 959 B (đo của nền chung) hiện khi kết nối giữ khoá công việc; production bớt 3 901 B của bốn tool cũ đang hiện (`crm_task_cancel` đã ẩn) ⇒ ròng ≈ −1 942 B. Test byte cập nhật trong cùng commit.
6. `CONNECTOR.md`: dòng `task.*`; bỏ dòng tool cũ; sửa dòng theo dõi việc (khoá từ khung chung).
7. `tool-plan-cases.mjs` thêm ca: "giao … sửa vòi …" ⇒ `crm_action_run task.create`; "huỷ việc vừa giao" ⇒ `task.cancel` (luôn xem trước); "đánh dấu xong" ⇒ không có thao tác (chỉ đường web); "việc quá hạn của anh X" ⇒ `crm_read_report tasks_board`.

## 8. Kiểm thử

### 8.1 Tầng 1, offline (`node:test`)

- Danh mục: khuôn 7 thao tác; `time`; `list`/`record` của lô (biên 1–20, khoá lạ trong record, đúng một trong `items`/`buildingsManagedBy`).
- Runtime với dịch vụ giả: `create` tự giao đủ thông tin ⇒ `applied` một lượt; giao người khác ⇒ `confirmation_required`; Q31 một người quản lý ⇒ xem trước có đề xuất, nhiều người ⇒ `needs_input` kèm danh sách; `cancel` luôn xem trước dù chính sách ghi `never`; `job` mơ hồ ⇒ `needs_input`, không bao giờ `applied`.
- Lý do: 4 mã mới có câu tĩnh, có trong `AUDIT_REASONS`; số trong câu hạn mức khớp seed migration.
- Quyền: khoá công việc chỉ đến từ lớp khung chung; theo dõi việc vẫn hiện khi có `tasks.create`; không còn `context_changed` khi cả hai lớp chạy.
- Byte: production có danh mục Công việc ≤ trần; họ thao tác + bộ theo dõi giữ nguyên số đo; tool cũ không còn trong `tools/list`.
- **Kiểm đột biến** (Contract §8, quyền + chống ghi sai). Gỡ từng rào phải có test đỏ: sàn xác nhận của `cancel`; đòi xác nhận khi giao người khác; không tự chọn `job` khi mơ hồ; kiểm phạm vi của bản đã giải ở lượt 2; chặn huỷ việc có vật tư; khoá `(quy tắc, ngày)`; `unknown` không gửi lại.

### 8.2 SQL trên PostgreSQL 17 dùng một lần (khuôn `action-foundation-sql.test.mjs`)

- Fixture RLS thật của `jobs` (policy production + `buildings_for_v3` giả lập theo bảng quyền thử), không dùng `fixture_task_acl`.
- Biên nhận: phát lại, `request_conflict`, lỗi tạm không chốt, từ chối cuối chốt và phát lại; trigger "settled".
- Ghi đi qua RLS: người không có `tasks.create` ở toà ⇒ `not_allowed` (0 hàng), không bao giờ ghi.
- Q35: người nhận ngoài phạm vi thấy việc qua RLS và qua reader DEFINER; người khác không thấy.
- Hạn mức hai hạng; lô cả-hoặc-không; trùng việc đổi giữa hai lượt ⇒ `state_changed`.
- Định kỳ: bảng ngày (ngày 31, tháng 2, năm nhuận, mỗi 2 tuần, ngày cuối tháng); chạy bộ sinh hai lần/song song ⇒ đúng một việc; mất quyền ⇒ tạm dừng.
- Nhắc: một tin/người/loại/ngày; giờ yên; việc xong giữa claim và begin ⇒ `skipped`; lease quá hạn ⇒ `unknown`.
- Vỏ là SQL-standard; không cấp EXECUTE thừa; `hermes_task_reason_v1` với bảng câu lỗi thật (mục 2.4 + lỗi RLS/trigger thật).

### 8.3 Tầng 2, SQL thật trên TEST, không model (`npm run test-env:thu-sql`, ROLLBACK, không `--ghi`)

- Ghép migration (bỏ `BEGIN;`/`COMMIT;`) + kịch bản: bật khoá ở registry, tạo kết nối/phiên/binding thử, đặt `request.jwt.claims`, `SET ROLE authenticated`, gọi `hermes_task_action_v1` preview → apply, `SET CONSTRAINTS ALL IMMEDIATE`, chấm bằng SELECT, ROLLBACK.
- Persona: chủ (lưu ý tài khoản thử của chủ trên TEST là Super Admin nên không thử được rào toà); Quản Lý Tòa trong phạm vi; Quản Lý Tòa giao ở toà ngoài phạm vi; vai Partner có `tasks.*` hẹp; vai thiếu `tasks.delete`.
- Chấm: `jobs` (toà, phòng, loại, người nhận, hạn = 23:59:59.999+07 khi chỉ nêu ngày, tiêu đề), `notifications` E4, `app_private.hermes_action_receipts`, `hermes_task_jobs`, audit `HERMES_ACTION_*` / `HERMES_TASK_*`.

### 8.4 Tầng 3, bot thật (phiên chính)

Ma trận độc lập ≥ 60 câu do phiên chính soạn; mỗi ca 3 lần; đạt khi 0 ghi sai và ≥ 95 % ca đạt cả 3 lần. Phiên con đề xuất 20 ca phát triển ở `cong-viec-ca-phat-trien.json` (scratchpad của phiên chính).

## 9. File dùng chung (giữ khối nhỏ, gom riêng)

| File | Đổi | Ghi chú gộp |
| --- | --- | --- |
| `HB/action-catalog.mjs` | `param.time()`; `param.name` thêm `jobType`, `job`, `recurrence` | `list`/`record` dùng của Thu chi (TC8); ai gộp sau rebase |
| `HB/action-contract.mjs` + `action-runtime.mjs` | `NAME_FIELDS`/`LABELS` thêm `job` (việc), `recurrence` (việc định kỳ); `why: unspecified` (trường chưa nêu, kèm gợi ý) cho Q31 | ~10 dòng |
| `HB/action-runtime.mjs` + `broker.mjs` + `mcp-http.mjs` | Kết cục `rejected` được kèm `link` (đường dẫn web bắt đầu bằng `/`), chuyển tới mô hình cùng `reason`/`detail` (CV12) | Khung chung mục 6.1 đã định `web_only` "kèm link" nhưng chưa làm; Thu chi/Hợp đồng dùng được |
| `HB/action-reasons.mjs` + `infra/hermes-runtime/host-ownership.mjs` | 4 mã mục 2.4 | Khối "Trang Công việc" cuối mỗi danh sách |
| `HB/wave2-kit.mjs` + SQL `hermes_w2_reused_keys_v1` | `tasks.view` vào khoá W2 dùng lại | Yêu cầu "gói Z" |
| `HB/server.mjs` | Một dòng nạp danh mục; bỏ dịch vụ tool cũ | Xung đột với Thu chi (cùng chỗ gỡ họ cũ) ⇒ gộp tay |
| `CONNECTOR.md`, `supabase/migration-provenance.json`, `tooling/test-matrix.json`, `scripts/hermes-task-function-contract.mjs` | Dòng của Công việc | Sinh lại bằng generator khi xung đột |

## 10. Migration dự kiến (chỉ file; phiên chính áp qua lane)

Tên lấy bằng `scripts/tao-ten-migration.mjs` ở mốc tương ứng.

| # | Nội dung | Mốc |
| --- | --- | --- |
| CV-M1 | Dòng chính sách `task.create`; `hermes_task_jobs`, `hermes_task_limits` (+ seed); `job_deadline_v1`, `job_open_duplicates_v1`, `hermes_task_building_managers_v1`, `hermes_task_quota_v1`, `hermes_task_reason_v1`; lõi giải tên, ba tầng, vỏ `hermes_task_action_v1` | 2 |
| CV-M2 | Q35: `jobs_select_rbac` + vế người nhận ở `hermes_task_follow_read_v1` (ghim md5 thân đang chạy) | 2 |
| CV-M3 | `update`, `cancel`: thay ba tầng (ghim md5 thân CV-M1) + 2 dòng chính sách | 3 |
| CV-M4 | `create_batch`; W2 gói C `tasks_board` (ghim md5 catalog/read); `tasks.view` vào khoá dùng lại; `hermes_task_follow_grant_v1` kiểm `buildings.view` (known-gap mục 3) | 4 |
| CV-M5 | Việc định kỳ: hai bảng, ba hàm ghi, `job_recurrence_dates_v1`, bộ sinh + cron, 3 dòng chính sách, W2 `task_recurrences` | 5 |
| CV-M6 | Nhắc Zalo: cấu hình (TẮT), hàng đợi, sinh nhắc + cron, ba RPC worker | 6 |
| (phiên chính) | Bật `tasks.delete` (rào legacy như `M/20261021162612`) sau khi `task.cancel` và bản connector gỡ `crm_task_cancel` lên production; bật `task_reminder_config` sau worker | sau Mốc 3 / 6 |

- **Thứ tự áp production trước khi gộp:** CV-M3 ghim md5 thân của CV-M1, CV-M4 ghim thân W2 đang chạy. Cửa idempotent của CI chạy từng migration trên trạng thái production, nên chuỗi phải được áp production theo đúng thứ tự CV-M1 → CV-M2 → CV-M3 → CV-M4 → CV-M5 → CV-M6 trước khi gộp nhánh chứa migration sau.
- Có hàm public mới ⇒ `gen:types` sau mỗi lần áp.
- **Phát hành:** migration trước, connector sau. Lý do: connector đang chạy không biết khoá công việc trong danh mục thao tác nên bỏ qua dòng chính sách mới; còn connector mới mà thiếu dòng chính sách thì lớp khung chung không cấp `tasks.create` ⇒ theo dõi việc tạm ẩn.

## 11. Rủi ro

| Rủi ro | Mức | Giảm |
| --- | --- | --- |
| Bot tự gọi lượt 2 khi người dùng chưa đồng ý (giao người khác, huỷ) | Cao | Sàn xác nhận, câu `huongDan`, SOUL; ca N10 của nền chung đo lại cho Công việc |
| Huỷ nhầm việc cùng tên ở toà khác (sự cố 21/10) | Cao | `job` mơ hồ ⇒ hỏi lại; huỷ luôn xem trước có mã + toà + phòng + người nhận; đột biến khoá cả hai |
| Đổi lớp quyền làm mất theo dõi việc trong cửa sổ phát hành | Vừa | Migration trước connector (mục 10); test composition bộ theo dõi |
| Q35 làm người ngoài toà thấy việc qua thông báo | Thấp | Chỉ người được giao; 0 việc giao người khác hiện nay; đo trước khi áp |
| Bộ sinh định kỳ chạy dưới tên người tạo nhưng bỏ qua RLS | Vừa | Kiểm lại bằng cùng `authorize_tenant_action_v3` mà policy dùng; mất quyền ⇒ tạm dừng; audit từng lần |
| Nhắc Zalo làm nick bot bị khoá vì gửi nhiều | Thấp | ≤ 2 tin/người/ngày, gom việc, trần nick ở worker; chỉ gửi người đã nhắn với bot |
| Nhắc Zalo không tới ai vì nhân viên chưa liên kết | Chắc chắn nếu không làm CV10 | CV10; báo cáo `task_recurrences`/`tasks_board` không phụ thuộc |
| Xung đột file chung với Thu chi/Hợp đồng | Thấp | Khối riêng; phiên gộp sau rebase |

## 12. Điểm cần chốt (mặc định đề xuất in đậm)

| # | Câu hỏi | Mặc định |
| --- | --- | --- |
| CV1 | Khoá cho thao tác công việc | **Dùng lại `tasks.create/edit/delete`; lớp khung chung là nguồn quyền duy nhất của ba khoá** (theo dõi việc đọc khoá từ đó) |
| CV2 | Gỡ tool cũ nào cùng bản | **Cả năm: create, status, input_options, progress, cancel.** Phương án khác: giữ `crm_task_input_options` để tra danh bạ (tốn 1 075 B, phạm vi chưa giao web) |
| CV3 | Q31 khi thiếu người nhận | **Đúng một người quản lý ⇒ xem trước có đề xuất (một câu hỏi); 0/≥ 2 ⇒ hỏi kèm danh sách.** "Người quản lý toà" = thành viên ACTIVE có `tasks.edit` + `buildings.view` ở toà, không tính phạm vi Toàn tổ chức |
| CV4 | Ai được ghi tiến độ | **Như web: ai có `tasks.edit` ở toà**; bỏ luật cũ "chỉ người tạo/người nhận" |
| CV5 | Q35 tới đâu | **Chỉ XEM ở đợt này**; hoàn thành việc của người nhận ngoài phạm vi là câu hỏi mới cho chủ; nếu Q53 = siết thì gộp cùng migration |
| CV6 | Toà ảo | **Không nhận** (khớp web) |
| CV7 | Hạn mức | **Bảng cấu hình; member 30/10, chủ (OWNER) 60/40; chỉ đếm việc Hermes tạo** |
| CV8 | Lô ở lượt 2 | **Cả lô hoặc không gì**; ≤ 20; có `buildingsManagedBy` |
| CV9 | Việc định kỳ | **Quyền CRM `tasks.create/edit/delete` theo toà; người tạo quy tắc đứng tên việc sinh ra; mất quyền ⇒ tự tạm dừng; bù tối đa 7 ngày; ≤ 100 quy tắc/công ty** |
| CV10 | Zalo của nhân viên | **Thêm luồng liên kết "chỉ nhận nhắc"** (nhân viên nhắn mã cho nick bot, không cần kết nối Hermes; phiên chính làm phần worker + trang web nhỏ). Phương án khác: chờ cấp Hermes cho Quản Lý Tòa (Q7) rồi ghép `/hermes-link`; tới lúc đó Zalo chỉ nhắc được chủ |
| CV11 | Nhịp nhắc Zalo | **08:00 việc hạn hôm nay; 08:00 việc quá hạn, tối đa 3 ngày; ≤ 2 tin/người/ngày; giờ yên của công ty; theo công tắc E4** |
| CV12 | Từ chối kèm link | **Làm** (khối nhỏ ở runtime/broker/mcp-http, dùng chung ba trang) |
| CV13 | Định nghĩa trùng (Q36) | **Cùng toà + cùng phòng (hoặc cùng cả toà) + cùng loại + đang mở** |
| CV14 | `tasks_board` | **Gói C, khoá `tasks.view` (thêm vào khoá W2 dùng lại), lọc tên người nhận qua `query`, phạm vi `rls_buildings`** |

## 13. Các mốc

| Mốc | Nội dung | Test | Công |
| --- | --- | --- | --- |
| 1 | Tài liệu này | docs gate | 0,5 |
| 2 | `task.create` (CV-M1), Q35 (CV-M2), danh mục connector, đổi lớp quyền, gỡ tool cũ, 4 lý do, `time`, `job`, `why: unspecified` | tầng 1 + PG17 + tầng 2 | 3–4 |
| 3 | `task.update`, `task.cancel` (CV-M3), từ chối kèm link | tầng 1 + 2 | 2 |
| 4 | `task.create_batch`, `tasks_board`, known-gap mục 3 (CV-M4) | tầng 1 + 2 | 2–3 |
| 5 | Việc định kỳ (CV-M5) | tầng 1 + PG17 + 2 | 3 |
| 6 | Nhắc Zalo phía DB (CV-M6) + tài liệu bàn giao worker | tầng 1 + PG17 + 2 | 2–3 |

Mốc 4 dùng `list`/`record` của Thu chi; nếu PR #271 chưa gộp thì Mốc 4 đổi chỗ với Mốc 5.

## 14. Việc phiên chính phải làm

1. Chốt CV1–CV14; hỏi chủ câu mới ở CV5 (hoàn thành việc của người nhận ngoài phạm vi) và CV10.
2. Sau mỗi mốc: áp CV-M* lên TEST rồi production qua `migrate:forward`, đúng thứ tự mục 10; `gen:types`. Migration trước, connector sau.
3. Trên TEST: kết nối thử giữ `tasks.create/edit` (đã bật); bật `tasks.delete` bằng script TEST cho Mốc 3; chạy ma trận ≥ 60 câu.
4. Production: bật `tasks.delete` bằng migration có rào legacy **chỉ sau khi** connector gỡ `crm_task_cancel` và có `task.cancel` đang chạy (Q28).
5. Trước khi áp CV-M2: đếm (chỉ đọc) số người sẽ thấy thêm việc nhờ vế người nhận.
6. Worker Zalo (mục 6.3) và luồng liên kết theo CV10; bật `task_reminder_config` sau khi worker lên.
7. **SOUL bản 5, đoạn Công việc đề xuất:**
   - "Giao/tạo việc …" ⇒ `crm_action_run` `task.create` bằng tên; không tự điền hạn, người nhận hay loại; để máy chủ áp mặc định và đọc nguyên văn `text` của kết quả hoặc bản xem trước.
   - `confirmation_required` ⇒ đọc `text` + mọi `warnings` (trùng việc, người nhận ngoài toà, loại do bot chọn); chỉ gọi lượt 2 khi người dùng đồng ý rõ.
   - Nhiều việc một lần ⇒ `task.create_batch` (≤ 20), một lần đồng ý.
   - Huỷ/sửa: dùng mã việc nếu có (từ kết quả trước); mơ hồ thì hỏi lại theo danh sách ứng viên, không tự chọn.
   - "Xong rồi / đánh dấu hoàn thành" ⇒ không làm; nói cần chụp ảnh + GPS trên web, đưa link `/tasks?job=…`.
   - "Mỗi thứ Hai …" ⇒ `task.recurring_create`; "dừng việc định kỳ …" ⇒ `task.recurring_pause`.
   - "Việc quá hạn / của anh X / toà Y" ⇒ `crm_read_report` `tasks_board` (`status=OVERDUE`, `query`=tên người).
   - Hạn mức (`task_quota_*`): báo đúng câu, gợi ý giao nhiều việc một lần hoặc chờ.
8. Trước khi cấp Hermes cho Quản Lý Tòa (Q7): xem lại khoá `tasks.delete` trong kết nối của họ.

## 15. Chưa xác minh

- `crm_read_tasks` (họ đọc v1) chưa có vế Q35: Mốc 2 chỉ thêm vào danh sách "giao cho tôi" (`hermes_task_follow_read_v1`) và RLS web; báo cáo `tasks_board` (Mốc 4, qua RLS) sẽ phủ. Chưa tra reader v1 là INVOKER hay DEFINER.
- Rào `fence` của broker W2 với phạm vi `rls_buildings` (Mốc 4).
- `list` của Thu chi có nhận phần tử vô hướng (`weekdays`).
- ~~RLS `profiles` cho NG TÂM thấy hồ sơ nhân viên~~: tầng 2 trên TEST (Mốc 2) thấy JOEY và B.Huy (giải tên người nhận + gợi ý người quản lý).
- Thời gian lô 20 việc trong `statement_timeout` của `authenticated` (đo tầng 2).
- Giờ yên cá nhân (đợt thông báo 21/10) đã có bảng chưa; hiện thiết kế chỉ dùng giờ yên công ty.
- Nick bot gửi được DM cho người đã nhắn mã liên kết mà không cần kết bạn (phiên chính kiểm trên VPS).

## 16. Mốc 2 — đã làm (22/10)

**Phạm vi:** `task.create` (mục 1 đề bài) + Q35 phần XEM (mục 2 đề bài) + Q64 thành migration riêng (CV5, chờ chủ).

| Migration (chỉ file) | Nội dung | Phụ thuộc / áp |
| --- | --- | --- |
| `20261022031548_hermes_task_action_create_v1` (CV-M1) | Dòng chính sách `task.create`; bảng `hermes_task_limits` (seed member 30/10, owner 60/40) và `hermes_task_jobs`; `public.job_deadline_v1`, `public.job_open_duplicates_v1`; `hermes_task_building_managers_v1`, `hermes_task_quota_v1`, `hermes_task_when_v1`; lõi giải tên + ba tầng + vỏ `hermes_task_action_v1` | Cần M5/M1 của nền chung (đã ở production) |
| `20261022031600_jobs_assignee_visible_v1` (CV-M2, Q35 XEM) | `public.job_visible_as_assignee_v1`; policy SELECT mới `jobs_select_own_assignee` (cộng thêm, không sửa `jobs_select_rbac`); `hermes_task_follow_read_v1` (`assigned_to_me`) thêm cùng vế, dựng từ thân production md5 `78f403b9…` | Độc lập với CV-M1 |
| `20261022031605_jobs_assignee_progress_complete_v1` (CV-M2b, Q64) | Policy UPDATE `jobs_update_own_assignee` + guard cột `zz_jobs_assignee_update_guard` (DEFINER + WHEN `current_user`): người nhận ngoài phạm vi chỉ ghi tiến độ / hoàn thành việc của mình, không đổi cột khác, không mở lại | Cần CV-M2; **chỉ áp khi chủ chọn Q64 (a)** |

**Khác thiết kế (đã sửa ngay trong mã):**
- Không làm `hermes_task_reason_v1`: lỗi tầng ghi của `task.create` chỉ có RLS (42501 ⇒ `not_allowed`) và lỗi lạ, ánh xạ chung đủ; hạn mức trả mã thẳng. Mốc 3 thêm nếu `cancel`/`update` cần.
- Người quản lý toà bỏ thành viên **OWNER** (`member_type`), thay cho "phạm vi Toàn tổ chức" (không đo được phạm vi của người khác ngoài `authorize_tenant_action_v3` từng toà).
- Q35 phía web là policy cộng thêm, không viết lại `jobs_select_rbac` ⇒ gỡ bằng một `DROP POLICY`.
- Mốc 2 chỉ gỡ `crm_task_create` / `crm_task_status` / `crm_task_input_options` (−3 KB). `crm_task_progress` và `crm_task_cancel` giữ tới Mốc 3 (khi có `task.update` / `task.cancel`); lớp task cũ vẫn cấp `tasks.edit` / `tasks.delete`.
- **Lỗi bắt được khi test:** gọi lại cùng `requestId` sau khi đã ghi phải phát lại TRƯỚC mọi quyết định, nếu không việc vừa tạo bị coi là "việc trùng" và lại đòi xem trước. Đã sửa trong bước chuẩn bị.

**Connector:** `task-actions-contract.mjs` (`task.create`); `server.mjs` nạp danh mục production; `createTaskAuth({ createFromActions })` (CV1); broker ẩn + từ chối ba tool tạo việc cũ khi danh mục có `task.create`; `param.time`, `param.name('jobType')`, `why: unspecified`; lý do `task_quota_user`, `task_quota_pair` (+ `host-ownership.mjs`).

**Byte `tools/list`:** như production 22/10 (tắt `income_expenses.create`, `tasks.delete`) 59 708 → 58 796 B (−912 B); đủ quyền 63 801 → 59 734 B.

**Test:**
- PGlite: `task-action-sql.test.mjs` 12/12; `jobs-assignee-sql.test.mjs` 4/4 (RLS + danh sách "giao cho tôi" + Q64).
- Connector: `task-actions.test.mjs` 6/6; nhóm `action-*`, `audit-codes`, `tool-argument-shape`, composition xanh (mục báo cáo).
- Quản trị: `hermes-durable-schema` 98/98 (12 hàm ghim băm, quyền EXECUTE đúng danh sách), private-flow / lane / task-function-catalog / copilot-independence xanh; lane `buildTransaction` nhận cả ba file.
- Đột biến: 16/16 bị bắt (9 SQL task.create, 3 RLS Q35/Q64, 4 connector).
- **Tầng 2 trên TEST** (`test-env:thu-sql`, ROLLBACK, 3 persona thật, binding từ kết nối Hermes ACTIVE): tự giao ghi thẳng (597 ms), phát lại cùng `requestId`, giao joey ⇒ xem trước có cảnh báo ⇒ lượt 2 ghi; joey thấy việc ở toà ngoài phạm vi (Q35) và ghi tiến độ được (Q64); joey ngoài phạm vi ⇒ hỏi lại không nêu tên; phòng 201 ⇒ 8 ứng viên; thiếu người nhận ở 111PVC ⇒ hỏi kèm 2 người quản lý; toà ảo ⇒ không nhận.

**Phát hiện trên TEST:**
- Phạm vi ghi của joey (guard chung) có cả toà ảo "Kho Văn Phòng Chung"; giải tên việc không nhận toà ảo (CV6) nên không ghi được việc ở đó, khớp web.
- bosshuy không có `task_types.view` ⇒ không thấy loại việc nào ⇒ `needs_input` loại việc. Web cũng không chọn được loại (cùng RLS). Muốn bosshuy giao việc qua bot thì cấp `task_types.view` cho vai đó.
