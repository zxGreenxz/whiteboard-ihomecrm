# Thao tác ghi Hermes — trang CÔNG VIỆC (Đợt 2b: thiết kế đã duyệt, Mốc 2 + 2b + 2c + 3 đã hiện thực)

Ngày 22/10/2026 (giờ Việt Nam). Mốc 1–2c: nhánh `claude/hermes-cong-viec-ghi-20261022` (PR #272). Mốc 3: nhánh
`claude/hermes-cong-viec-moc3-20261022`, xếp chồng trên #272, đã gộp `origin/main` (#271 Thu chi).
Phiên chính duyệt Mốc 1 (22/10): CV1–CV14 theo mặc định mục 12; CV5 và CV10 chờ chủ (Q64, Q65). Mốc 2 (mục 16) và Mốc 2b sửa
theo review độc lập (mục 17) có hai migration, một bản nháp Q64 chờ chủ (ngoài `supabase/migrations/`) và mã connector.
`031548` + `031600` + `065634` (Mốc 2c, mục 18) đã áp TEST và production (provenance 22/10: catalog-proven). Mốc 3 (mục 19:
`task.update`, `task.cancel`, CV12) thêm migration `074741`, chưa áp. Thứ tự áp: mục 19.

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
                   assigneeName name(person)     "tôi"/"tui"/"chính mình"/"bản thân" = người hỏi (ghi thẳng được); "mình"/"anh"/"chị"/"em" hay tên chính mình
                                                 ⇒ giải tên như mọi tên, luôn xem trước kèm câu "hiểu là …" (mục 17); trống ⇒ Q31
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
| Loại việc | **Mốc 2c (mục 18):** `jobType` khớp đúng một loại ⇒ dùng; không khớp ⇒ coi như chưa nêu, chấm điểm theo nội dung + chính chuỗi đó (đầu nội dung, chứa tên loại, đồng nghĩa trỏ tới tên loại thật), đúng một loại điểm cao nhất ⇒ dùng và luôn xem trước; không thì hỏi lại kèm ≤ 5 gợi ý xếp theo độ gần. Thiết kế gốc: có `jobType` ⇒ hàm giải tên ghi (bỏ loại đã tắt). Trống ⇒ đoán: loại đang bật có tên (bỏ dấu) là một từ hoặc cụm đứng đầu `content`, như `jobQuickInput.ts:122-124`; đúng một ⇒ dùng + đòi xác nhận; 0 hoặc ≥ 2 ⇒ `needs_input` (`field: jobType`) kèm ≤ 8 loại đang bật |
| Người nhận | Chỉ token tự xưng không thể là tên (`tôi`, `tui`, `self`, `me`, `chính mình`, `chính tôi`, `bản thân`) ⇒ người hỏi. `mình`/`anh`/`chị`/`em` (có thể là tên như "Minh", "Anh") ⇒ hàm giải tên như mọi tên; không khớp ai thấy được ⇒ người hỏi; khớp chính người hỏi hay khớp người khác đều đòi xem trước kèm câu "hiểu là …". Còn lại ⇒ hàm giải tên ghi (`person`: hồ sơ thấy qua RLS + thành viên ACTIVE theo `hermes_task_assignee_member_v1`, đúng luật hàm tạo việc đang dùng) |
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

Kết quả `applied` có tên: `{text, job:{jobId, code, title, building, room, assignee, deadline, priority}, deadlineDefaulted, link}`; `link` = `/tasks?job=<id>` (khung chung cho phép UUID trong link). `job.jobId` (UUID, Mốc 2b) là id duy nhất trong kết quả, để bot nối thẳng `crm_task_follow_set` (`jobId`) sau khi tạo. Lô: `jobs[]` từng dòng. Q30: tạo thẳng với hạn mặc định thì `text` nói rõ "hạn mặc định hết ngày mai 23/10".

### 2.6 Trùng việc (Q36)

- **Định nghĩa:** cùng toà + cùng phòng (hoặc cùng "cả toà") + cùng loại + đang mở. Production: 25/383 việc (6,5 %) rơi vào trường hợp này.
- **Hàm dùng chung** `public.job_open_duplicates_v1(p_building uuid, p_room uuid, p_job_type uuid)` INVOKER STABLE, dưới RLS người gọi; trả ≤ 5 việc (mã, tiêu đề, người nhận, hạn). Web dùng được khi làm lại ô tạo việc (Q40 về sau).
- Có trùng ⇒ máy chủ đòi xác nhận và nêu việc trùng. Tập id trùng nằm trong `basis`: có thêm việc trùng giữa hai lượt ⇒ `state_changed`.
- Hai lời gọi song song: guard khung chung đã khoá dòng công ty (`lock_org_for_decision_v1`, FOR NO KEY UPDATE) trước mọi quyết định; Mốc 2b thêm khoá tư vấn `(công ty, toà)` lấy TRƯỚC khi tính trùng ở lượt ghi (không lấy ở `preview`). Test PG17 hai kết nối đo riêng từng lớp (mục 17). Web tạo việc không đi qua khoá nào (như hiện nay).
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

- **Web:** policy SELECT cộng thêm `jobs_select_own_assignee` `USING (assignee_id = (SELECT auth.uid()))` (dạng initplan, Mốc 2b), không viết lại `jobs_select_rbac`. Thông báo E4 mở `/tasks?job=<id>` sẽ thấy việc thay vì "Không tìm thấy".
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
- **Phát hành:** migration trước, connector sau. Lý do: connector đang chạy không biết khoá công việc trong danh mục thao tác nên bỏ qua dòng chính sách mới. Mốc 2b: connector mới gặp DB cũ (chưa có dòng `task.create`) tự nhận ra qua danh mục SỐNG `hermes_action_capabilities_v1.actions` ⇒ giữ tool tạo việc cũ và quyền `tasks.create` kiểu cũ, không quảng bá `crm_action_run`; DB có dòng ⇒ đổi ngay ở lời gọi kế (mục 17).

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
| ~~`20261022031605_jobs_assignee_progress_complete_v1`~~ → bản nháp `docs/plans/hermes-crm/cho-chu/q64_jobs_assignee_progress_complete.sql` (Mốc 2b, Q64) | Policy UPDATE `jobs_update_own_assignee` + guard cột `zz_jobs_assignee_update_guard` (DEFINER + WHEN `current_user`): người nhận ngoài phạm vi chỉ ghi tiến độ / hoàn thành việc của mình, không đổi cột khác, không mở lại | Cần CV-M2; **chỉ áp khi chủ chọn Q64 (a)** |

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

## 17. Mốc 2b — sửa theo review độc lập (22/10)

| # | Review | Đã sửa |
| --- | --- | --- |
| 1 | Từ "mình/anh/chị/em" bị coi là tự giao, ghi thẳng sai người nếu có thành viên tên Minh/Anh | Chỉ token tự xưng không thể là tên (`tôi`, `tui`, `self`, `me`, `chính mình`, `chính tôi`, `bản thân`) là tự giao. `mình`/`anh`/`chị`/`em` đi qua giải tên như mọi tên; khớp người khác ⇒ xem trước "Hiểu '…' là người nhận X; nếu ý là chính anh/chị, nói "giao cho tôi""; không khớp ai thấy được ⇒ chính người hỏi nhưng vẫn xem trước "Hiểu '…' là chính anh/chị"; tên khớp chính người hỏi cũng xem trước. Mơ hồ luôn đòi xác nhận (`v_confirm`) |
| 2 | Q64 nằm trong `supabase/migrations/` dù chủ chưa trả lời | Dời (git mv) sang `docs/plans/hermes-crm/cho-chu/q64_jobs_assignee_progress_complete.sql`, đầu file ghi rõ là bản nháp và cách đưa vào khi chủ chọn (a). Gỡ khỏi provenance và hồ sơ unknown. Test `jobs-assignee-sql` vẫn chạy bản nháp |
| 3 | Policy `jobs_select_own_assignee` gọi hàm từng hàng | `USING (assignee_id = (SELECT auth.uid()))` (initplan); khối kiểm cuối đọc đúng dạng này. Hàm `job_visible_as_assignee_v1` giữ cho reader DEFINER của Hermes |
| 4 | Kiểm trùng chạy trước khoá ⇒ hai lời gọi song song cùng ghi | Khoá tư vấn `(công ty, toà)` lấy TRƯỚC `job_open_duplicates_v1` ở lượt ghi. Test PG17 hai kết nối (`task-action-race-pg.test.mjs`): lời gọi sau chờ rồi thấy việc vừa tạo ⇒ xem trước, đúng 1 việc. **Phát hiện:** đường thật đã tuần tự sẵn nhờ guard khung chung khoá dòng công ty (`lock_org_for_decision_v1`, FOR NO KEY UPDATE); test đo riêng hai lớp — có khoá công ty (B chờ `transactionid`) và gỡ khoá công ty (B chờ `advisory`) — đột biến "tính trùng trước khoá"/"bỏ khoá" chỉ làm đỏ ca thứ hai |
| 5 | Kết quả không có id để nối theo dõi việc | `result.job.jobId` (UUID). Test: `taskFollowInput('set', {jobId})` nhận; tầng 2: `hermes_task_follow_action_v1('set')` bằng `jobId` vừa tạo ⇒ theo dõi `active` đúng việc |
| 6 | Connector mới + DB cũ: ẩn tool cũ mà `task.create` chưa có | Danh mục SỐNG (`createActionLiveCatalog`, ghi từ `hermes_action_capabilities_v1.actions` mỗi lần đọc quyền). Runtime chỉ quảng bá / chạy thao tác sống; broker chỉ ẩn tool tạo việc cũ khi `task.create` sống; lớp task cấp `tasks.create` kiểu cũ khi chưa sống. Test tổ hợp "connector mới + DB cũ" (đổi ngay ở lời gọi kế khi DB có dòng) |
| 7 | Q64 chưa chạy trên bảng `jobs` thật với mọi trigger | Tầng 2 trên TEST (bên dưới) chạy đúng câu UPDATE của web (`useCompleteJob`, RETURNING) qua 8 trigger thật |

Tuỳ chọn của review cũng làm: ca NOT `v_manages` (giao "huy" ⇒ cảnh báo không có `tasks.edit`); Q30 tính kỳ vọng độc lập (`Intl` giờ Việt Nam, mốc UTC); ghi `description` + `URGENT`.

**Tầng 2 trên TEST** (`test-env:thu-sql`, ROLLBACK, không `--ghi`; ghép 031548 + 031600 + phần A + bản nháp Q64 + phần B; binding thật của chủ và joey):

| Ca | Kết quả |
| --- | --- |
| Trigger `jobs` trên TEST | `jobs_set_user_id_audit`, `trg_autofill_org`, `trigger_generate_job_code` (BEFORE INSERT); `trigger_jobs_stamp_completion_time`, `trigger_jobs_updated_at`, `zz_khoa_organization_id` (BEFORE UPDATE); `z95_notify_job_assigned_ins/upd` (AFTER) |
| D1 tạo → theo dõi bằng `jobId` | OK, theo dõi `active` đúng việc |
| D2 "mình", "anh", "chị", "em", tên chính chủ | OK — xem trước kèm câu "hiểu là" (TEST không có thành viên tên Minh ⇒ hiểu là chính chủ); "chính mình", "tui" ⇒ tự giao rõ ràng |
| D3a trước Q64: joey bấm "Hoàn thành" như web ở việc toà ngoài phạm vi | 0 hàng (như hiện nay) |
| D3b sau Q64: cùng câu UPDATE | 1 hàng, `COMPLETED`, `completion_time` do trigger đóng dấu, ảnh + GPS ghi đủ; guard không chặn cột nào trigger tự đổi |
| D3c hai RPC web gọi tiếp dưới JWT joey | `award_job_bonus` 1 dòng thưởng; `v5_tick_from_job` chạy được |
| D3d mở lại / đổi tiêu đề | 42501 (guard) |
| D3e chủ có `tasks.edit` sửa tiêu đề và hoàn thành như web | không bị guard chạm |

Dấu vết trên TEST: giao dịch ROLLBACK, nhưng SEQUENCE không lùi (bộ đếm mã việc / id các bảng phụ có thể nhích vài số).

**Số lời gọi REST:** lớp task chỉ đọc capability tạo việc cũ khi `task.create` chưa sống (lần đọc quyền trước), cùng đợt với lớp dưới; DB vừa mất dòng giữa hai lời gọi thì đọc bù tuần tự. `mcp-latency` (DB chưa có `task.create`): 16 → 17 lời gọi mỗi lượt đọc quyền (31 → 33 với `crm_auth_context`), số bước tuần tự không đổi; DB mới không tốn lời gọi này (`task-actions.test.mjs` đếm).

**Test:** PGlite `task-action-sql` 13/13, `jobs-assignee-sql` 4/4; PG17 `task-action-race-pg` 1 test + 2 ca; connector `task-actions` 7/7, `mcp-latency` 5/5. Đột biến 25/25: SQL 10, RLS 4, connector 9 (thêm "đọc bù" và "không tốn lời gọi"), thứ tự khoá trên PG17 2.

**Thứ tự áp (phiên chính, qua lane, TEST rồi production):**
1. `20261022031548_hermes_task_action_create_v1` và `20261022031600_jobs_assignee_visible_v1` trong **cùng một lượt** (lane chạy theo version: 031548 rồi 031600). Hai file độc lập về phụ thuộc; nếu phải tách lượt thì áp liền nhau, không để 031548 chạy một mình trên production: câu cảnh báo "vẫn thấy việc nhưng không sửa/hoàn thành được" trong bản xem trước chỉ đúng khi 031600 đã áp.
2. `gen:types` (hàm public mới: `job_deadline_v1`, `job_open_duplicates_v1`, `hermes_task_action_v1`, `job_visible_as_assignee_v1`).
3. Áp production xong mới gộp PR (cửa idempotent / permission-catalog của CI).
4. Connector phát hành SAU bước 1. Connector mới gặp DB chưa áp vẫn an toàn (mục 6), nhưng không có `task.create`.
5. Q64: chỉ khi chủ chọn (a) — cấp tên mới bằng `scripts/tao-ten-migration.mjs` (version sau 031600), chép nguyên văn bản nháp, đăng ký provenance + hồ sơ unknown, áp SAU 031600.

## 18. Mốc 2c — loại việc khi mô hình tự đặt tên (22/10)

**Bối cảnh:** phiên chính áp `031548` + `031600` lên TEST, chạy bot thật (connector `3a352226`, SOUL 4.9). Lỗi lớn nhất: mô hình tự đặt `jobType` không có trong danh mục ("kiểm tra điện", "Bảo trì", "Dọn vệ sinh", "Sửa chữa", "sửa chữa") ⇒ `needs_input` kèm gợi ý theo chữ cái ("check", "checkin", "làm"…) ⇒ 5/11 ca không tạo được việc.

**Danh mục loại thật** (production = TEST, chỉ đọc 22/10): `sửa` (dùng 250–275 lần), `checkin`, `OT`, `check`, `thay`, `làm`, `vesinh`, `decor`, `mua`, `giặt`, `vệ`, `950nk`, `thông`, `162nvk`, `ml`.

**Migration `20261022065634_hermes_task_type_infer_v1`** (chưa áp): chỉ thay thân `hermes_task_resolve_core_v1` và `hermes_task_action_prepare_v1` của `031548`, dựng từ thân đang chạy trên TEST và ghim md5 (`2c7dd0a8…`, `0a01318d…`; thân khác ⇒ dừng). Cùng chữ ký ⇒ OID giữ nguyên, vỏ BEGIN ATOMIC không phải dựng lại. Không đổi tên hay thứ tự `031548`/`031600` (đã áp TEST).

| Luật | Chi tiết |
| --- | --- |
| `jobType` khớp đúng một loại | Dùng, không đoán (như cũ) |
| `jobType` không khớp, hoặc trống | Coi như chưa nêu; chấm điểm trên loại đang bật thấy được (RLS): 95 chuỗi loại bỏ khoảng trắng trùng tên ("ve sinh" ~ `vesinh`) > 90 đầu nội dung > 80 chuỗi loại chứa tên loại > 70 đồng nghĩa trong chuỗi loại > 60 nội dung chứa tên loại > 50 đồng nghĩa trong nội dung; cùng mức thì tên dài hơn thắng. So theo từ sau khi bỏ dấu và dấu câu |
| Đồng nghĩa | Trỏ tới tên loại thật (bỏ dấu, bỏ khoảng trắng): sửa chữa / bảo trì / bảo dưỡng / khắc phục / hỏng / lắp đặt → `sửa`; kiểm tra / rà soát → `check`; nhận phòng / làm hợp đồng → `checkin`; dọn dẹp / dọn phòng / lau chùi / vệ sinh → `vesinh` (hoặc `vệ`); thay thế → `thay`; mua sắm → `mua`; giặt ủi → `giặt`; thông tắc / tắc nghẽn → `thông`; trang trí → `decor`; tăng ca / ngoài giờ / thu tiền → `OT`. Công ty không có loại đích thì dòng tự bỏ qua |
| Đúng một loại điểm cao nhất (≥ mức 50) | Dùng + cờ đoán ⇒ luôn xem trước: "(loại X, tự chọn theo nội dung)"; nếu mô hình đã nêu chuỗi khác thì cảnh báo "Không khớp loại việc '…'; tự chọn loại 'X' theo nội dung — hỏi lại nếu sai." |
| Không suy được hoặc hoà | `needs_input` (`why: unspecified`) kèm ≤ 5 gợi ý xếp theo độ gần (điểm, rồi tiền tố chung dài nhất với một từ), không theo chữ cái; chỉ một loại thấy được mà nội dung không nhắc tới cũng hỏi lại |
| Không thấy loại nào (vd thiếu `task_types.view`) | Giữ kết quả hàm giải tên như cũ, không gợi ý |

**Mục 2 (hạn chỉ ngày):** `deadline: "2026-10-25"` = hết 25/10 23:59:59.999 giờ VN (đúng từ Mốc 2, `job_deadline_v1`); thêm test độc lập (Intl + mốc UTC) và tầng 2. **Mục 3 ("cho mình"):** đi đúng nhánh mơ hồ của Mốc 2b ⇒ xem trước (CVDM1 trước đây dừng ở loại việc nên chưa tới bước người nhận).

**Test:** `task-type-infer-sql.test.mjs` 10/10 (danh mục thật; 5 chuỗi bot trượt + "Giặt rèm"; trống loại: đầu nội dung, đồng nghĩa, dấu câu; tên loại đúng; hoà; xếp gợi ý; một loại duy nhất; hạn chỉ ngày; "mình"; không thấy loại). `task-action-sql` 13/13 trên chuỗi 031548 → 065634. Đột biến riêng (tự tính lại md5 ghim sau mỗi đột biến): xem báo cáo.

**Tầng 2 trên TEST** (ROLLBACK, binding thật của chủ, danh mục thật): CVD07 → `check`; CVD02, CVD10, CVDM1 → `sửa`; CVDJ2 → `vesinh`; CVD01 (không `jobType`) → `check`; tất cả xem trước có câu "tự chọn theo nội dung"; CVDM1 thêm "Hiểu 'mình' là chính anh/chị…"; chuỗi không suy được ⇒ hỏi lại kèm `check, checkin, mua, 162nvk, 950nk`; hạn `2026-10-25` ⇒ "hết Chủ nhật 25/10/2026 (còn 3 ngày)".

**Thứ tự áp (phiên chính, qua lane):**
1. TEST: áp `20261022065634` (031548 + 031600 đã có). Connector không đổi (bản `3a352226` dùng được; kết quả có thêm trường `jobTypeWanted` trong `resolved`, connector giữ nguyên khối này).
2. Production: `20261022031548` + `20261022031600` cùng một lượt, rồi `20261022065634` (cùng lượt hoặc ngay sau, trước khi phát hành connector); `gen:types` (không thêm hàm public mới ở 065634).
3. Áp production xong mới gộp PR; connector phát hành sau.

## 19. Mốc 3 — sửa và huỷ việc bằng tên, từ chối kèm link (22/10)

**Phạm vi:** `task.update`, `task.cancel` (mục 2.2, 2.4, 13) và CV12. Không thêm tool hay khuôn mới vào `tools/list`: hai thao tác nằm trong danh mục chung (`crm_action_list`), và tool cũ `crm_task_progress` / `crm_task_cancel` nghỉ hưu khi thao tác thay sống.

**Migration `20261022074741_hermes_task_action_edit_v1`** (chưa áp). Dùng lại vỏ `public.hermes_task_action_v1` (BEGIN ATOMIC, gắn OID — không dựng lại, băm ở `hermes-task-function-contract` không đổi). Thay THÂN bốn tầng vỏ gắn (lõi giải tên + chuẩn bị của `065634`, ghi + chốt của `031548`), dựng từ thân đang chạy, ghim md5 (`8b1e8543…`, `f044e2e6…`, `3c359620…`, `f4406f3a…`); cùng chữ ký ⇒ OID giữ nguyên. Thêm hai hàm DEFINER `app_private.hermes_task_edit_prepare_v1`, `hermes_task_edit_finish_v1` (không cấp EXECUTE cho authenticated: chỉ hàm DEFINER gọi).

| Phần | Luật |
| --- | --- |
| Dòng chính sách | `task.update`: khoá `tasks.edit`, reversible, never (máy chủ quyết xem trước). `task.cancel`: khoá `tasks.delete`, irreversible, always (sàn `hermes_action_policy_floor`) |
| Tìm việc (`job`, INVOKER dưới RLS) | Mã đầy đủ (mọi trạng thái); 3–4 số cuối; "vừa giao"/"vừa tạo" = việc mới nhất người hỏi tạo trong 24 giờ; tiêu đề bỏ dấu chứa chuỗi. Ba cách sau chỉ xét việc ĐANG MỞ. Chỉ trong phạm vi toà của khoá (`tasks.edit` / `tasks.delete`); nêu toà/phòng thì lọc thêm. Khớp nhiều ⇒ `needs_input` `ambiguous` kèm "mã · tiêu đề (phòng, người nhận)" + toà, **không bao giờ tự chọn**. Chỉ khớp việc đã xong ⇒ `task_not_open` (kèm link nếu biết đúng việc) |
| Sửa | Ghi chú tiến độ ghi NỐI vào `completion_description` (ô ghi chú của web) dạng "DD/MM HH:MM Tên: …"; đổi hạn (ngày, giờ; chỉ giờ ⇒ giữ ngày cũ), người nhận (luật xưng hô như `task.create`), ưu tiên, tiêu đề (`content`), mô tả. Chỉ cột thật sự đổi vào kế hoạch; không đổi gì ⇒ `invalid_params`. UPDATE dưới RLS `tasks.edit` + trigger như web (đổi người nhận ⇒ thông báo E4 như web). Ghi chú báo người giao đang theo dõi (như `crm_task_progress` cũ) |
| Xác nhận của sửa | Ghi thẳng chỉ khi tìm bằng mã đầy đủ VÀ chỉ thêm ghi chú / đổi ưu tiên. Đổi hạn, người nhận, tiêu đề, mô tả; tìm theo số cuối / tiêu đề / "vừa giao"; người nhận mơ hồ hoặc không quản lý toà ⇒ xem trước |
| Huỷ | LUÔN xem trước (kể cả `auto`): "Huỷ hẳn việc JOB-… 'tiêu đề' — toà, phòng — giao … — hạn … — đang làm. Không khôi phục được; nhật ký giữ mã và tiêu đề." Xoá hẳn như web (RLS `tasks.delete`). Có vật tư (`material_usages`) hoặc ảnh hoàn thành ⇒ `cancel_blocked` kèm link web. Audit `HERMES_TASK_CANCELLED` (old_state: mã, tiêu đề, toà, phòng, người nhận, người tạo, hạn; lý do). Đóng theo dõi (`job_cancelled`) + báo người giao và người nhận như `crm_task_cancel` cũ; bộ quét theo dõi cũng tự đóng theo dõi của việc đã xoá |
| Lượt 2 | basis = trạng thái hiện tại của việc + thay đổi; đổi giữa hai lượt ⇒ `state_changed`. Guard chạy lại: mất quyền ở toà ⇒ `not_allowed`. Khoá dòng việc FOR UPDATE ở lượt có thể ghi. Phát lại theo requestId trước mọi quyết định |

**CV12 (khung chung, dùng được cho mọi trang):** kết cục `rejected` của RPC trang được kèm `link` (đường dẫn web tương đối `/…`, khuôn `ACTION_WEB_LINK`); runtime kiểm khuôn (sai khuôn sau khi đã gửi lệnh ghi ⇒ `action_outcome_unknown`), `actionRejected(code, link)` chỉ giữ link đúng khuôn, mcp-http chuyển `link` cùng `reason` + câu tĩnh. Hai lý do mới: `cancel_blocked`, `task_not_open` (cả `action-reasons.mjs` lẫn sổ audit `host-ownership.mjs`).

**Connector:** `TASK_UPDATE`, `TASK_CANCEL` (`param.name('job')`, nhãn "việc"); `TASK_RETIRED_BY` = tool cũ ↔ thao tác thay (create/status/options ↔ `task.create`, progress ↔ `task.update`, cancel ↔ `task.cancel`), xét theo danh mục SỐNG từng lời gọi. Lớp theo dõi (`extendTaskFollowAuthorization`) thôi cấp `tasks.edit` / `tasks.delete` khi `task.update` / `task.cancel` sống (lớp khung chung là nguồn), như `tasks.create` ở Mốc 2b; DB chưa có Mốc 3 ⇒ như cũ.

**Khoá `tasks.delete` (phiên chính):** registry đang TẮT ở production (`20261021162612`, sau sự cố huỷ nhầm 21/10) nên `task.cancel` chưa chạy được ở production dù đã áp `074741`. Bật lại theo thứ tự:
1. Áp `074741` (TEST rồi production) và phát hành connector có Mốc 3 lên MỌI host (TEST 8741 và production). Kiểm `crm_task_cancel` không còn trong `tools/list` của kết nối giữ `tasks.delete` (danh mục sống có `task.cancel`).
2. Forward migration riêng: `UPDATE app_private.hermes_capabilities SET enabled=true WHERE capability='tasks.delete' AND mode='action'` (có rào: không còn kết nối `legacy_allowlist` ACTIVE giữ khoá này, như `20261021162612`). Bật trước khi connector mới chạy khắp nơi ⇒ connector cũ quảng bá lại `crm_task_cancel` không xem trước — đúng lớp sự cố 21/10.
3. Chạy ma trận bot cho huỷ (mơ hồ ⇒ hỏi lại; luôn xem trước; việc có vật tư ⇒ link web).

**Test:**
- PGlite `task-edit-sql` 7 ca (tìm theo mã / số cuối / "vừa giao" / tiêu đề, mơ hồ hai toà, chỉ việc đang mở, ghi chú nối + phát lại, đổi hạn / người nhận / tiêu đề, basis, không có gì đổi, việc đã xong, huỷ luôn xem trước + audit + phát lại, ngoài phạm vi khoá xoá, chặn vật tư / ảnh, mất quyền giữa hai lượt).
- `task-action-sql`, `task-type-infer-sql` trên chuỗi 031548 → 065634 → 074741; connector (danh mục, nghỉ hưu từng tool theo danh mục sống, lớp theo dõi thôi cấp khoá trùng, CV12 runtime + mcp-http).
- Đột biến 20/20 (SQL 13, connector 7).
- Tầng 2 trên TEST (ROLLBACK, bật tạm `tasks.delete` trong giao dịch; chủ / joey / bosshuy): ghi chú theo mã ghi thẳng + nối; "tầng 3" khớp 3 việc ⇒ hỏi lại kèm mã; đổi hạn và giao lại joey ⇒ xem trước (cảnh báo joey không quản lý toà) ⇒ lượt 2; joey ghi chú việc có theo dõi ⇒ báo người giao (notified 1); huỷ ⇒ xem trước ⇒ xoá, audit giữ mã; việc có ảnh ⇒ `cancel_blocked` + link; joey huỷ việc toà ngoài phạm vi ⇒ không thấy; việc đã xong ⇒ `task_not_open` + link; bosshuy sửa được việc ở toà mình có `tasks.edit` (như web).

**Thứ tự áp `074741`:** sau `065634` (đã ở production). Không thêm hàm public ⇒ `gen:types` không đổi. Connector phát hành SAU khi áp; connector mới gặp DB chưa có `074741` thì giữ `crm_task_progress` / `crm_task_cancel` và quyền theo dõi cũ.

## 20. Mốc 3b — sửa theo ma trận nghiệm thu pha A vòng 1 (22/10)

Ma trận Công việc pha A vòng 1 (bot thật trên TEST, chỉ đọc): 29/36 đạt, 0 ghi sai. Mốc này sửa bốn ca trượt do thiếu công cụ hoặc rào sai. Nó không đụng `074741` (Mốc 3, chưa áp) hay ba migration của #272: phần SQL là một file mới, ghim thân đang chạy.

**CV-R13 (rào sai ở connector).** Quản lý hỏi "việc đang giao cho tôi" thì `crm_task_follow_list` (`role=assigned_to_me`) trả `backend_unavailable`. SQL (`031600`, Q35) trả đúng cả việc giao cho chính người hỏi ở toà ngoài phạm vi, nhưng `taskFollowResult` từ chối mọi mục ngoài phạm vi toà. Nay connector nhận mục ngoài phạm vi khi role là `assigned_to_me` và `assigneeId` là người hỏi. `assigned_by_me` / `team` vẫn rào phạm vi toà: SQL của hai role này cũng lọc theo toà nên không có mục ngoài phạm vi hợp lệ.

**CV-R01 / R03 / R04 / R06 (thiếu người nhận, mô hình tự cộng).** Chọn mở rộng `crm_read_tasks` (tool bot đã chọn đúng cho cả bốn câu), không định tuyến sang `crm_task_follow_list` `team`:

- `team` không có số đếm, chỉ trả id toà, tối đa 50 dòng một trang và 200 dòng tổng (offset). Mô hình vẫn phải tự cộng nhiều trang, đúng lỗi của R06 (59 thay vì 54).
- `tasks_board` (Mốc 4, W2 gói C) vẫn giữ phần riêng: trục ngày (việc xong trong tuần, CV-R09), `status=OVERDUE`, Q35 qua RLS, tiến độ, link. Mốc 3b chỉ lấy phần đếm theo nhóm cho tool đang dùng.

**Migration `20261022153345_hermes_domain_tasks_assignee_v1`** (chưa áp):

- Chỉ thay NHÁNH `tasks` của `public.hermes_domain_read_v1`. Mọi nhánh khác giữ từng byte như `20261021063452`, là thân đang chạy trên TEST và production.
- Ghim md5: `$requires$` nhận `b0d16d1a…` (thân 063452) hoặc `d79bb632…` (thân của file này khi chạy lại); thân khác thì dừng. `$check$` đòi đúng `d79bb632…` cùng quyền như cũ.
- Cùng chữ ký nên OID giữ nguyên. Không thêm hàm, khoá input hay ERRCODE mới.

| Phần | Luật |
| --- | --- |
| Dòng | Thêm `assigneeName`: tên người nhận như web /tasks (`profiles.full_name`, rồi `jobs.assignee_name` gõ tay; null = chưa giao) |
| `query` | Khớp tiêu đề/mã như cũ HOẶC tên người nhận bỏ dấu (`public.hermes_name_fold_v1`). Lọc theo người không tốn khoá input; `tools/list` chỉ đổi câu gợi ý "Tên/mã việc hoặc tên người nhận." |
| `summary.byBuilding` | `[{buildingId, buildingName, count, overdue}]`, ≤ 50 nhóm, nhiều việc trước; hoà thì id toà tăng dần, việc không toà (null) cuối |
| `summary.byAssignee` | `[{assigneeName, count, overdue}]`, ≤ 50 nhóm, nhiều việc trước; hoà thì tên theo byte (`COLLATE "C"`), chưa giao (null) cuối. Gộp theo TÊN hiển thị: hai người trùng tên thành một nhóm |
| `summary.givenByMe` | `{count, overdue}`: việc người hỏi tạo mà người nhận khác người hỏi, kể cả chưa giao (đúng định nghĩa `cv_r06_given_by_me`) |
| Tập tính | Cả tập lọc: phạm vi toà của khoá `tasks.view`, trạng thái, toà, query; không cursor, không LIMIT. Một CTE `MATERIALIZED` cho mọi số |

**Connector:**

- Khai `assigneeName` (nullable) và ba khoá summary mới. Cửa sổ một bản: `DOMAIN_READS.tasks.tolerant=['assigneeName']` và `DOMAIN_SUMMARY_KEY_TOLERANT.tasks`. Connector Mốc 3b lên TRƯỚC migration, vì connector cũ từ chối khoá lạ (`backend_unavailable`).
- Bất biến:
  - Mỗi nhóm có ≥ 1 việc, quá hạn ≤ số việc; không trùng khoá; nhiều việc trước.
  - Cộng các nhóm ≤ `count` / `overdue`. Dưới 50 nhóm (không bị cắt) thì phải BẰNG đúng.
  - Toà của `byBuilding` nằm trong phạm vi khoá và đúng toà lọc; hoà thì toà null đứng cuối.
  - `givenByMe` ≤ `count`; quá hạn của nó ≤ số giao và ≤ `overdue`.
- `summarizeRows` (lọc phòng ở connector) tính nhóm từ dòng. `byAssignee` chỉ có khi mọi dòng mang `assigneeName`, để không đoán "chưa giao" từ dòng của SQL cũ. `givenByMe` = null vì dòng không mang người tạo.

**CV-R11 (danh mục loại việc).** Báo cáo W2 `task_types` (gói D, `crm_read_report`) đã có từ trước; bot chỉ không tìm thấy. Thêm `task_types` vào danh sách mã khám phá trong mô tả `crm_read_report` (+12 B; hai tool meta 1 599 / 1 600 B). Không kèm nhãn tiếng Việt vì sẽ vượt trần. Đường chắc chắn là luật SOUL (mục dưới).

**Test:**
- Toàn bộ test connector: 1 848 đạt, 8 bỏ qua, 1 trượt (WAL Windows đã biết). Nhóm `tools/list` / W2 chạy lại sau khi đổi danh sách khám phá: 174/174. `tool-plan-cases` thêm ba ca CV-R04 / R06 / R11 (đường trả lời có trong khuôn kết quả).
- `domain-tolerance`: cửa sổ phát hành + 25 ca từ chối. `domain-summary`: nhóm + trần 50. `domain-composition` (PGlite): thân mới + dữ liệu tổng hợp 10 việc (toà ngoài khoá, không toà, công ty khác, hồ sơ trống ⇒ tên gõ tay, tự giao, người khác tạo), query bỏ dấu, phân trang, Toàn tổ chức. Cùng test chạy chính file migration: nhận thân 063452, chạy lại được, thân khác ⇒ dừng.
- `task-follow`: hồi quy CV-R13.
- `hermes-durable-schema` 98/98 (forward 28 file / 101 hàm).
- Đột biến: SQL 9/9 trong `domain-composition`. Connector 25/26; ca còn lại tương đương — role `assigned_to_me` đã bị buộc `assigneeId` = người hỏi ở rào kế bên.

**Tầng 2 trên TEST** (ROLLBACK, thân mới thay trong giao dịch; số khớp `truth.sql` của ma trận):

| Câu | chủ | joey | bosshuy |
| --- | --- | --- | --- |
| R01 việc mở | 62 việc, 4 quá hạn, 15 toà; NATHAN 33 / JOEY 25 / NG TÂM 4; cộng nhóm = 62 | 28 việc, 6 toà | 50 việc, 12 toà |
| R04 `query=nathan` | 33 việc, 10 toà | 3 (toà của joey) | 25 |
| R03 toà 44TL | 6 việc, NATHAN 4 / JOEY 2 | 42501 (ngoài phạm vi) | 42501 |
| R06 `givenByMe` | 54 | 0 | 0 |
| R11 `task_types` | 15 loại | 15 loại | 42501 (không có `task_types.view` CRM) |

Trang 2 mang đúng summary của trang 1. Mọi dòng có `assigneeName`. Tốc độ (chủ, 482 việc, 6 lượt ấm trong một giao dịch): thân cũ 145–148 ms, thân mới 152–159 ms; kết quả 16,4 KB → 20,1 KB.

**Thứ tự phát hành (phiên chính):**
1. Phát hành connector có Mốc 3b lên mọi host (TEST 8741, production).
2. Áp `20261022153345` qua lane (TEST rồi production). Provenance xếp file này `catalog-proven` dù CHƯA áp, vì hàm cùng tên đã có. Phải áp đích danh, không trông vào `list-forward-migrations`.
3. Bản connector kế tiếp gỡ hai cửa sổ của `tasks`.

Rollback: chạy lại câu lệnh hàm của `063452`; `$requires$` của file này nhận cả hai thân. File không phụ thuộc `074741`, áp trước hay sau đều được.

## 21. Mốc 4 — giao nhiều việc một lần, bảng việc, theo dõi kiểm toà (23/10)

**Phạm vi:** `task.create_batch` (Q37, CV8), báo cáo W2 `tasks_board` (CV14, mục 4), known-gap `hermes-pham-vi-toa-chua-giao-web` mục (3). Không thêm tool nào vào `tools/list`: lô nằm trong danh mục chung (`crm_action_list`), bảng việc nằm trong `crm_read_report` (hai tool meta giữ 1 599 / 1 600 B). Năm migration, đều là file mới, chưa áp.

**`20261022164201_hermes_task_batch_v1`** (áp SAU `074741`). Vỏ `hermes_task_action_v1` giữ nguyên. Thay thân bốn tầng vỏ gắn, dựng từ thân `074741` và ghim md5 (`$requires$` nhận thân `074741` hoặc thân của file này). Thêm ba hàm DEFINER không cấp EXECUTE cho vai API: `hermes_task_managed_buildings_v1`, `hermes_task_batch_prepare_v1`, `hermes_task_batch_finish_v1`.

| Phần | Luật |
| --- | --- |
| Dòng chính sách | `task.create_batch`: khoá `tasks.create`, reversible, `always` ⇒ LUÔN xem trước MỘT lần cho cả lô |
| Tham số | `items` (1–20 bản ghi: toà, phòng, nội dung, loại, người nhận, hạn, giờ, ưu tiên) HOẶC `buildingsManagedBy` (đúng một trong hai, không thì `invalid_params`). Giá trị chung ở ngoài (`buildingName`, `jobType`, `content`, `description`, `assigneeName`, `deadline`, `deadlineTime`, `priority`), mục đè từng trường. "Toà X, mỗi phòng một việc" chỉ nêu toà một lần (thêm sau tầng 2: CV-B04/B05 nêu toà chung). `buildingsManagedBy` kèm `buildingName` là mâu thuẫn ⇒ `invalid_params` |
| Mỗi mục | Đúng luật `task.create`: giải tên dưới RLS người hỏi, đoán loại (Mốc 2c), hạn trống = hết ngày mai, toà ảo không nhận, tiêu đề như web. Người nhận phải nêu rõ (lô không đề xuất người quản lý Q31). Mục đầu tiên chưa giải được ⇒ `needs_input` kèm `item` (1–20); connector ghi "Mục #n: …" |
| `buildingsManagedBy` | Giải người, rồi trải ra mọi toà trong phạm vi khoá mà người đó quản lý theo luật Q31 (thành viên ACTIVE không phải OWNER, có `tasks.edit` + `buildings.view` ở toà), xếp theo tên toà; mỗi toà một việc cả toà. Người nhận trống = chính người đó. Không quản lý toà nào ⇒ `needs_input` `building` `unspecified` |
| Kiểm | Trùng đang mở (như `task.create`) + hai mục trùng nhau trong lô + người nhận không quản lý toà ⇒ cảnh báo theo mục. Hạn mức Q37 tính cho CẢ lô, vượt ⇒ `rejected` ngay ở bản xem trước (`task_quota_user` / `task_quota_pair`) và kiểm lại ở lượt ghi. > 20 mục ⇒ `batch_too_large` (connector chặn trước ở khuôn danh sách 1–20) |
| Lượt 2 | Khoá công ty (guard) → khoá tư vấn (công ty, toà) theo thứ tự id toà → mọi INSERT trong một khối dưới RLS + trigger như web; một hàng lỗi ⇒ cả lô lùi, biên nhận `rejected`. Basis = md5 nối basis từng mục; lệch ⇒ `state_changed`. Phát lại theo `requestId` trước mọi quyết định |
| Chốt | Đối chiếu từng hàng như `task.create`, sổ `hermes_task_jobs` (`action='task.create_batch'`), audit `HERMES_TASK_CREATED` từng việc (kèm `item`/`items`). `result` = câu "Đã tạo N việc: mã (toà phòng), …" + `count` + `jobs[]` (id, mã, tiêu đề, toà, phòng, người nhận, hạn); `link` `/tasks` |

**Khung chung (connector):** `needs_input` nhận thêm `item` (số nguyên 1–20), runtime kiểm khuôn. Trường bản ghi nhận thêm loại `time`. Lý do mới `batch_too_large` (lớp `needs_input`, câu "Tối đa 20 việc một lần giao…").

**`tasks_board`** (gói C, `crm_read_report`). Ba file, áp theo thứ tự:
1. `20261022180359_hermes_w2_tasks_view_reused_v1`: thêm `tasks.view` vào `hermes_w2_reused_keys_v1`. Dựng từ thân production, đã có `contracts.view` của `20261022043540` (#270). `W2_REUSED_KEYS` ở JS khớp cả hai khoá.
2. `20261022180400_hermes_w2c_jobs_board_shared_v1`: hàm dùng chung `public.jobs_board_v1` (INVOKER, `search_path=''`, chỉ `authenticated`). Nội dung file không có chữ `hermes_` (luật hàm dùng chung CRM).
3. `20261022180402_hermes_w2c_tasks_board_v1`: thay `hermes_w2c_catalog_v1` (thân production `20261018030200`) và `hermes_w2c_read_v1` (thân production `20261019040948`; nhận thêm thân cuối chuỗi file của fixture), thêm một mục catalog và một nhánh đọc; ghim md5.

| Phần | Luật |
| --- | --- |
| Khoá, phạm vi | `tasks.view`, `rls_buildings`: toà công ty ∩ phạm vi kết nối, RLS `jobs` của người hỏi quyết từng việc, kể cả việc giao cho chính người hỏi ở toà ngoài khoá (Q35). Việc không gắn toà chỉ hiện khi Toàn tổ chức. Rào `fence` của broker nhận đúng các hàng (test) nên giữ `rls_buildings` |
| Tham số | `query` (mã, tiêu đề, tên người nhận bỏ dấu), `status` IN_PROGRESS / COMPLETED / OVERDUE (= đang làm mà quá hạn lúc gọi), `kind` deadline / created / completed + `fromDate`/`toDate` (ngày giờ công ty), `buildingId`, `roomId`, `staffId`. Tên toà/phòng đi qua `buildingName`/`roomName` của cơ chế giải tên W2 sẵn có |
| Hàng | mã, tiêu đề, loại, toà, phòng, người nhận, người giao, hạn "YYYY-MM-DD HH:MM", số ngày quá hạn, tiến độ (300 ký tự đầu `completion_description`), ngày tạo/xong, `link` `/tasks?job=…`. Đang làm + quá hạn đứng đầu |
| `summary` | Do SQL tính trên CẢ tập khớp: `total`, `overdue`, `byAssignee` (≤ 20, nhiều việc trước, chưa giao cuối), `byBuilding` (≤ 50, toà null cuối) |

Lệch so với mục 4: không có trường "nguồn (web/Hermes/định kỳ)", vì `task_recurrences` chưa làm. Tên không xem được trả null (theo RLS `profiles`), không phải chuỗi "(không xem được tên)". `byAssignee` đếm việc + quá hạn của tập lọc, không tách "mở".

**`20261022180351_hermes_task_follow_building_v1`** (known-gap mục 3). Dựng từ thân `hermes_task_follow_grant_v1` đang chạy (`20261015130000`, ghim md5), thêm đúng một điều kiện: người giao phải còn `buildings.view` ở toà của việc (`authorize_tenant_action_v3`). Mất quyền ⇒ `permission_lost` ⇒ lượt nhắc đóng theo dõi, không báo thêm. Việc không gắn toà giữ luật cũ. `known-gaps.yaml` ghi bản sửa, gỡ mục (3) khi file đã áp production.

**Soát deadlock 40P01 (yêu cầu phiên chính 23/10): không có vòng, không cần NOWAIT.** Đo catalog production, chỉ đọc:
- Guard dùng `lock_org_for_decision_v1`. Hàm này khoá dòng công ty bằng `FOR NO KEY UPDATE`, không xung đột với `FOR KEY SHARE` mà kiểm khoá ngoại lấy.
- Trigger trên `jobs`: `jobs_set_user_id_audit`, `trg_autofill_org`, `trigger_generate_job_code` (khoá tư vấn khi INSERT), `trigger_jobs_stamp_completion_time`, `trigger_jobs_updated_at`, `z95_notify_job_assigned_ins/upd`, `zz_khoa_organization_id`. Không trigger nào khoá hay UPDATE dòng `organizations`.
- Trigger E4 chèn `notifications`. Bốn trigger trên `notifications` cũng không khoá dòng công ty; khoá ngoại `notifications/jobs/material_usages → organizations` chỉ lấy KEY SHARE.
- Hàm vừa chạm `jobs`/`material_usages` vừa gọi guard: chỉ có `hermes_task_follow_tick_v1`, và hàm này khoá công ty TRƯỚC (cùng thứ tự với Hermes, `lock_timeout` ⇒ bỏ qua công ty bận). Gọi gián tiếp một bậc: hai hàm đọc Hermes, không khoá dòng việc. Không hàm nào chạm `jobs` mà UPDATE hay khoá `organizations`.
- Vậy web khoá dòng việc xong không bao giờ phải chờ dòng công ty mà Hermes đang giữ. Lô không khoá dòng việc có sẵn, chỉ INSERT.

**Test:**
- PGlite `task-batch-sql` 8/8: xem trước một lần, ghi, phát lại, sổ, audit; mục đầu chưa giải kèm số mục; toà chung + mục đè; > 20; `buildingsManagedBy`; cả lô hoặc không gì; `state_changed` + cảnh báo trùng; hạn mức ở bản xem trước; mất phạm vi giữa hai lượt.
- `wave2-c-tasks-board` 4/4: hàng + summary + lọc (CV-R09, OVERDUE, tên bỏ dấu, người nhận, phòng, trục ngày tạo), Toàn tổ chức có việc không toà, Q35 qua policy, 3 đột biến hàm dùng chung. Chạy trên RLS `jobs` thật của baseline và rào broker.
- `task-follow-review-fixes`: known-gap (3) có file ⇒ REVOKED, bản trước ⇒ vẫn nhắc. `task-follow-mutation` thêm ca bỏ điều kiện `buildings.view`.
- `hermes-durable-schema` 100/100 (forward 31 file / 106 hàm). Test W2 cập nhật: dải nền thêm `180359`, `tasks_board` là báo cáo `rls_buildings` thứ hai, ví dụ khai sai đổi `contracts.view` → `customers.view` (giống #270).

**Tầng 2 trên TEST** (ROLLBACK, nạp `074741` → `164201` → `180351` → `180359` → `180400` → `180402` trong giao dịch; chủ / joey / bosshuy):

| Ca | Kết quả | Ma trận |
| --- | --- | --- |
| B01 mỗi toà Nathan quản lý | xem trước 9 toà (102LVT, 1392QT, 15KV, 331PHI, 403PVB, 405PVB, 44TL, 481NVK, 512TT) ⇒ 9 việc, NATHAN, 31/10 23:59; phát lại không thêm; sổ 9, audit 9 | 9 toà, đúng danh sách |
| B02 ba toà cho Joey | xem trước 3 ⇒ 3 việc, 30/10 23:59 | 3 |
| B03 21 mục | `batch_too_large` | tối đa 20 |
| B04 phòng 999 | `needs_input` mục #3 `room` `not_visible`, chưa tạo gì; bỏ mục ⇒ 2 việc 403PVB/101, 102 | cả lô hoặc không gì |
| B05 joey 11 việc cho Nathan | `rejected` `task_quota_pair` ở lượt 1, không tạo gì (10 việc ⇒ xem trước được) | chặn cả lô |
| R09 tuần này xong | chủ 50 việc (NATHAN 29, JOEY 20, chưa giao 1); joey 21; bosshuy 37 | truth: 49 có người nhận / 50, NATHAN 29 |
| Quá hạn | chủ 4 việc | truth 4 |

bosshuy giao lô bị `needs_input` `jobType` `not_visible`: tài khoản này không thấy loại việc (không có `task_types.view` CRM, như R11 của Mốc 3b). Đây là hành vi sẵn có của `task.create`, không riêng lô. TEST không có lượt theo dõi ACTIVE nên chưa đo được số lượt sẽ đóng theo điều kiện mới.

**Thứ tự phát hành (phiên chính):**
1. Lô: áp `074741` rồi `164201` qua lane (TEST rồi production), sau đó phát hành connector có Mốc 4. Danh mục sống quyết việc quảng bá `task.create_batch`; connector cũ bỏ qua thao tác lạ.
2. Bảng việc: áp `180359` → `180400` → `180402` (`180402` đòi hai file trước). Phát hành connector có `tasks_board` cùng lúc hoặc sau: connector cũ không có báo cáo trong sổ nên không gọi tới.
3. Theo dõi: áp `180351` lúc nào cũng được. Provenance xếp `180351`, `180359`, `180402` là `catalog-proven` dù CHƯA áp (hàm cùng tên đã có) ⇒ phải áp đích danh.
4. `180359` dựng từ thân có `contracts.view` (#270 đã áp production). Gộp main có #270 thì `wave2-kit.mjs` / test dải nền sẽ xung đột nhẹ: giữ cả hai khoá và cả hai file trong dải.

Rollback: chạy lại câu lệnh hàm của file trước (`074741`, `20261015130000`, thân production của reused keys / catalog / reader gói C); `$requires$` của mỗi file nhận cả thân cũ lẫn thân mới. `public.jobs_board_v1` để lại không hại (không ai gọi ngoài nhánh mới).

## 22. Mốc 5 — việc định kỳ (23/10)

**Phạm vi:** mục 5 (Q39 = b, CV9). Đây là tính năng CRM mới: web chưa có bảng hay hàm định kỳ cho việc (chỉ có phiếu định kỳ của Thu chi). Phần dùng chung đặt trong DB để web gọi lại sau (Q40 = b, chưa làm giao diện). Không thêm tool vào `tools/list`: bốn thao tác nằm trong `crm_action_list`, báo cáo nằm trong `crm_read_report`. Năm migration mới, đều chưa áp.

**Khoá để TẮT:** không file nào chèn dòng chính sách `task.recurring_*`. Khi không có dòng chính sách, danh mục thao tác sống không có bốn thao tác ⇒ connector không quảng bá và guard từ chối. Bảng, hàm ghi CRM, bộ sinh và báo cáo vẫn có (bảng rỗng ⇒ bộ sinh không làm gì). Vai API gọi thẳng được bốn hàm ghi CRM qua PostgREST, với đúng quyền `tasks.create` / `tasks.edit` / `tasks.delete` như web; giao diện web chưa có. Phiên chính bật bằng một migration riêng, sau khi connector có Mốc 5 và chủ đồng ý:

```sql
INSERT INTO app_private.hermes_action_policies(action,capability,crm_permission,action_class,confirm,private_only) VALUES
  ('task.recurring_create','tasks.create','tasks.create','reversible','always',true),
  ('task.recurring_update','tasks.edit','tasks.edit','reversible','always',true),
  ('task.recurring_pause','tasks.edit','tasks.edit','reversible','always',true),
  ('task.recurring_delete','tasks.delete','tasks.delete','reversible','always',true)
  ON CONFLICT(action) DO NOTHING;
```

`task.recurring_delete` dùng khoá `tasks.delete`, mà khoá này đang tắt ở production (#259) ⇒ xoá quy tắc chỉ chạy khi khoá đó đã bật lại.

**`20261023042424_job_recurrence_v1`** (CRM dùng chung; nội dung không có chữ `hermes_`):

| Phần | Luật |
| --- | --- |
| `public.job_recurrence_rules` | Việc mẫu (toà bắt buộc, phòng, loại, tiêu đề, mô tả, người nhận, ưu tiên) + lịch: `daily` / `weekly` / `monthly`, mỗi N (1–12), thứ ISO 1–7, ngày -1–31 (-1 = cuối tháng), từ / tới ngày, hạn = ngày sinh + N ngày (0–30). Mã `DK-NNNN` theo công ty. Xoá mềm. Tạm dừng có lý do (`user` / `permission_lost` / `membership_lost` / `target_deleted`). `version` tăng khi cột người dùng thấy đổi; bộ sinh cập nhật `last_generated_date` thì không tăng |
| `public.job_recurrence_occurrences` | Khoá `(quy tắc, ngày)` ⇒ không bao giờ sinh hai việc cho một ngày. Việc bị xoá ⇒ `job_id` về NULL, lần sinh còn (không sinh lại) |
| RLS | Soi gương policy `jobs` đọc 23/10: SELECT như `jobs_select_rbac`; INSERT đòi `tasks.create` ở toà; UPDATE đòi `tasks.edit` hoặc `tasks.delete` (qua `app_private.buildings_for_v3`) + ranh giới công ty. Vai API chỉ có quyền cột ghi được, không DELETE; bảng lần sinh chỉ SELECT |
| Trigger (DEFINER, `WHEN current_user` là vai API) | Xoá mềm đòi đúng `tasks.delete`, đổi khác đòi `tasks.edit` (`authorize_tenant_action_v3`); cột bất biến; ngày bắt đầu không ở quá khứ; trần 100 quy tắc đang chạy mỗi công ty (lỗi 54000); mã cấp dưới khoá tư vấn theo công ty; chuẩn hoá lịch (weekly mặc định thứ của ngày bắt đầu, monthly mặc định ngày của ngày bắt đầu); chạy lại không bù các ngày đã dừng. Trigger thứ hai (vai hệ thống) chỉ chuẩn hoá + tăng `version` |
| `public.job_recurrence_dates_v1` | Thuần. Tháng tính từ tháng neo, không cộng dồn (29–31 rơi vào tháng thiếu ⇒ cuối tháng đó, tháng sau trở lại đúng ngày). Tuần neo theo tuần ISO của ngày bắt đầu. Tối đa 400 ngày một lần gọi |
| `public.job_recurrence_schedule_text_v1` | "hằng ngày", "mỗi thứ Hai, thứ Năm", "mỗi 2 tuần vào Chủ nhật", "ngày cuối tháng hằng tháng", "ngày 15, mỗi 3 tháng" |
| Bốn hàm ghi (INVOKER, `search_path=''`) | `job_recurrence_create_v1` / `_update_v1` (khoá = tên cột) / `_set_paused_v1` / `_delete_v1`, CAS theo `version`. Lỗi: 42501 không quyền, 22023 dữ liệu sai, P0002 không thấy, 40001 version lệch, 54000 vượt trần |

**`20261023042431_hermes_task_recurrence_generate_v1`:** bộ sinh `app_private.hermes_task_recurrence_generate_v1(p_today)` (DEFINER), cron `job-recurrence-daily` lúc 17:10 UTC (00:10 giờ VN).
- Mỗi quy tắc đang chạy: các ngày đến hạn trong (`last_generated_date`, hôm nay theo giờ công ty], bù tối đa 7 ngày.
- Dòng quy tắc khoá `FOR NO KEY UPDATE SKIP LOCKED`: đang bị sửa ⇒ bỏ lượt này, lượt sau bù.
- INSERT lần sinh `ON CONFLICT DO NOTHING`; chỉ ngày vừa chèn được mới sinh việc.
- Kiểm lại: người tạo còn ACTIVE + còn `tasks.create` ở toà, toà / phòng / loại còn sống, người nhận còn là thành viên. Hỏng ⇒ tạm dừng kèm lý do, lần sinh `skipped`, audit `JOB_RECURRENCE_PAUSED`.
- Thành viên đọc thẳng `organization_memberships` (ACTIVE, chưa thu hồi, trong `valid_from`/`valid_to`). Không gọi `hermes_task_assignee_member_v1`: helper đó đòi JWT `authenticated`, cron không có ⇒ bản đầu sẽ tạm dừng MỌI quy tắc ở lần chạy đầu (phát hiện khi soát Mốc 6, 23/10; sửa tại chỗ vì file chưa áp). Các trigger trên `jobs` / `notifications` và `append_authz_audit_v1` chỉ đọc `auth.uid()` để ghi người thao tác (NULL = hệ thống, cột audit cho NULL).
- Việc sinh ra là việc thường: `user_id` = người tạo quy tắc (trigger chỉ điền khi trống ⇒ không cần đặt claims; thông báo E4 ghi người giao là "hệ thống"), hạn cuối ngày (ngày sinh + N), mô tả có "(định kỳ DK-NNNN)". Sổ `hermes_task_jobs` ghi `source = recurrence` (không tính hạn mức Q37).
- Mỗi quy tắc một khối con. Không khoá dòng công ty.

**`20261023042436_hermes_task_recurring_v1`** (áp SAU `164201` và `042424`): thay thân bốn tầng vỏ `hermes_task_action_v1`, dựng từ thân `164201` và ghim md5. Thêm `app_private.hermes_task_recurring_prepare_v1` / `_finish_v1` (DEFINER, không cấp cho vai API).

| Thao tác | Khoá | Luật |
| --- | --- | --- |
| `task.recurring_create` | `tasks.create` | Đi chung nhánh một mục của `task.create` (toà / phòng / loại / người nhận / tiêu đề như web, Q31 đề xuất người quản lý). Lịch chuẩn hoá như trigger CRM; ngày bắt đầu quá khứ / kết thúc trước bắt đầu / lịch không ra ngày nào ⇒ `date_out_of_range`; tham số lịch sai ⇒ `invalid_params`. Trần 100 ⇒ `recurrence_quota` ngay ở bản xem trước |
| `task.recurring_update` | `tasks.edit` | Lịch, người nhận (luật như `task.update`), nội dung, mô tả, ưu tiên, từ / tới ngày, hạn sau N ngày. Chỉ cột thật sự đổi vào kế hoạch; không đổi gì ⇒ `recurrence_unchanged`. Việc đã sinh không đổi |
| `task.recurring_pause` | `tasks.edit` | `resume=true` = chạy lại; trạng thái đã đúng ⇒ `recurrence_unchanged`. Chạy lại không bù các ngày đã dừng |
| `task.recurring_delete` | `tasks.delete` | Xoá mềm; việc đã sinh giữ nguyên |
| Chung | — | Tìm quy tắc: mã `DK-NNNN` (chấp nhận "dk3", "DK 0003") hoặc nội dung bỏ dấu, dưới RLS người hỏi, trong phạm vi toà của khoá; mơ hồ ⇒ hỏi lại kèm "mã · nội dung (phòng, lịch)" + toà, không tự chọn. Chính sách `always` ⇒ luôn xem trước kèm lịch dạng chữ và ba lần tới. Lượt 2: basis = bản đã giải (tạo) hoặc id + `version` + thay đổi; khoá dòng quy tắc `FOR UPDATE NOWAIT` (bận ⇒ 55P03 ⇒ `state_changed`); ghi qua đúng bốn hàm ghi CRM; chốt đối chiếu dòng, audit `HERMES_TASK_RECURRING_CREATED/UPDATED/PAUSED/RESUMED/DELETED` |

**Báo cáo `task_recurrences`** (gói C): `20261023042445` hàm dùng chung `public.job_recurrences_list_v1` (INVOKER) → `20261023042450` catalog + hàm đọc gói C dựng từ thân `180402` và ghim md5. Khoá `tasks.view`, phạm vi `rls_buildings`. Lọc `status` ACTIVE / PAUSED / ENDED, `query` (mã, nội dung, tên người nhận bỏ dấu), `buildingId`. Mỗi hàng có lịch dạng chữ và lần sinh kế tiếp. `summary` = tổng / đang chạy / tạm dừng / đã kết thúc.

**Connector:** `TASK_RECURRING_CREATE/UPDATE/PAUSE/DELETE` (tham số 14 / 12 / 2 / 1; `weekdays` là danh sách `oneOf` MON…SUN); `param.name('recurrence')` (nhãn "việc định kỳ"); lý do `recurrence_quota` (rejected), `recurrence_unchanged` (needs_input); báo cáo `task_recurrences` trong W2 gói C (22 báo cáo).

**Soát 40P01:** guard khoá dòng công ty (`FOR NO KEY UPDATE`) rồi mới khoá dòng quy tắc. Không đường nào khoá dòng quy tắc rồi mới khoá công ty: bộ sinh và hàm ghi CRM không khoá công ty, trigger CRM chỉ lấy khoá tư vấn theo công ty khi INSERT (không xung đột khoá dòng). Vậy không có vòng. Hermes vẫn lấy dòng quy tắc bằng NOWAIT để không đứng chờ bộ sinh.

**Test:**
- PGlite `task-recurring-sql`: bảng ngày (31, tháng 2, năm nhuận, mỗi 2 tuần, cuối tháng, tới ngày); hàm ghi CRM dưới RLS + trigger (mã, mặc định, cột bất biến, CAS, xoá cần `tasks.delete`, quyền cột, trần 100); bốn thao tác Hermes (xem trước một lần + ba lần tới, Q31, phát lại, audit, lịch sai ⇒ hỏi lại, mơ hồ ⇒ hỏi lại, đổi giữa hai lượt ⇒ `state_changed`, không có dòng chính sách ⇒ guard từ chối); bộ sinh (một lần mỗi ngày, chạy lại an toàn, bù ≤ 7 ngày, người tạo đứng tên, hạn cuối ngày + N, mất quyền / thành viên / loại ⇒ tạm dừng có lý do; chạy như cron không JWT với thân THẬT của helper thành viên ⇒ vẫn sinh, không tạm dừng); 4 đột biến (bỏ kiểm quyền người tạo ở bộ sinh, bộ sinh dùng lại helper đòi JWT, xoá chỉ cần `tasks.edit`, lõi tự chọn khi mơ hồ) đều bị bắt.
- PG17 `task-recurring-race-pg`: hai lượt sinh song song ⇒ lượt sau bỏ qua dòng đang bị giữ, đúng một việc; Hermes tạm dừng lúc bộ sinh giữ dòng ⇒ 55P03 ngay.
- `wave2-c-task-recurrences`: hàng, lịch, lần kế tiếp, trạng thái, summary, Toàn tổ chức, RLS giấu toà không xem được, rào broker.
- Tầng 2 trên TEST (ROLLBACK; nạp năm file trong giao dịch, bật tạm bốn dòng chính sách + `tasks.delete`; chủ / joey / bosshuy): chủ tạo "mỗi thứ Hai" ⇒ xem trước có lịch chữ + 26/10, 02/11, 09/11 ⇒ `DK-0001`; "ngày cuối tháng" ⇒ 31/10, 30/11, 31/12; lịch sai / bắt đầu hôm qua ⇒ hỏi lại; joey tạo, tạm dừng theo mã, chạy lại theo nội dung không dấu; chủ sửa lịch + người nhận ⇒ xem trước đúng hai thay đổi + cảnh báo người nhận thiếu quyền ở toà; nội dung khớp hai quy tắc ⇒ hỏi lại kèm 2 ứng viên; bosshuy gọi quy tắc ở toà ngoài phạm vi ⇒ `not_visible`; bộ sinh chạy trong ngữ cảnh đã xoá claims (như cron: `auth.role()`/`auth.uid()` NULL, helper thành viên trả false) hôm nay 1 việc, chạy lại 0, tới +7 thêm 5 (đúng lịch), không tạm dừng quy tắc nào, người tạo đứng tên, hạn cuối ngày; xoá ⇒ báo cáo bỏ quy tắc đã xoá; 7 biên nhận, 7 audit.

**Thứ tự áp (phiên chính):** `042424` → `042431` → `042436` (sau `164201`) → `042445` → `042450`. `042450` bị provenance xếp `catalog-proven` dù chưa áp (thay hàm đã có) ⇒ áp đích danh. Connector Mốc 5 phát hành trước hay sau migration đều an toàn: không có dòng chính sách thì thao tác ẩn; báo cáo chỉ hiện khi catalog SQL có. Cuối cùng mới bật bốn dòng chính sách bằng migration riêng.

Rollback: chạy lại câu lệnh hàm của `164201` / `180402` (`$requires$` nhận cả hai thân); xoá lịch cron `job-recurrence-daily`; bảng mới để lại không hại.

## 23. Mốc 6 — nhắc việc qua Zalo, phần DB (23/10)

**Phạm vi:** mục 6 (Q38 = b, CV11). Hàng đợi + bộ sinh nhắc + ba RPC cho worker. Không đổi worker, không thêm tool Hermes, không đổi connector. Hai migration mới, chưa áp; chỉ thêm đối tượng mới (không thay thân hàm nào ⇒ không ghim md5, không file nào ghim chéo thân file trước). Hợp đồng cho worker: [CONG-VIEC-NHAC-ZALO-WORKER.md](CONG-VIEC-NHAC-ZALO-WORKER.md).

**Khoá để TẮT:** không chèn dòng `app_private.task_reminder_config` nào ⇒ bộ sinh chạy cron nhưng không làm gì. Phiên chính bật bằng migration riêng sau khi worker có vòng claim / begin / settle (SQL ở tài liệu worker mục 6).

**`20261023063140_task_reminder_v1`** (không hàm nào tên `hermes_`):

| Phần | Luật |
| --- | --- |
| `task_reminder_config` | Theo công ty: `enabled` (mặc định false), `due_hour` 8, `overdue_hour` 8, `overdue_days` 3 (1–14), `daily_cap` 2 (1–2), `send_until_hour` 11 (không sinh nhắc mới sau giờ này, để không nhắn giữa ngày cho việc vừa báo bằng E4), `app_base_url` (https, cho link `/tasks`) |
| `task_reminder_outbox` | Như mục 6.2, thêm `binding_id`, `job_total`, `updated_at`. `UNIQUE(công ty, người, loại, ngày)` ⇒ chạy lại / hai lượt song song không gửi trùng. CHECK: lease có khi và chỉ khi `claimed`/`sending`; `sending`/`sent`/`unknown` phải có `provider_started_at`. Hai bảng ở `app_private`, RLS bật, không cấp cho vai nào (kể cả `service_role`) |
| Chọn việc `task_reminder_jobs_v1` | Việc `IN_PROGRESS` (huỷ = xoá) giao cho người đó ở công ty đó; `due_today` = hạn (giờ công ty) đúng hôm nay; `overdue` = hạn trong [hôm nay − N, hôm qua] |
| Người nhận `task_reminder_recipient_v1` | Thành viên ACTIVE (đọc thẳng `organization_memberships`, không dùng helper đòi JWT) + liên kết `hermes_zalo_bindings` ACTIVE chưa thu hồi, nick bot của chính công ty đang bật đúng phiên bản, trợ lý ACTIVE (đúng điều kiện provisioning của worker). Không có đường nào tới khách / người ngoài |
| Nội dung `task_reminder_body_v1` | Mã · tiêu đề (≤ 60 ký tự) · toà/phòng · hạn giờ hoặc "quá hạn N ngày (hạn dd/mm)"; ≤ 10 việc, ≤ 1000 ký tự, phần dư "… và N việc khác"; link `/tasks` khi có `app_base_url` |
| Giờ yên | `app_private.notify_in_quiet_hours_v1` (công ty + cá nhân) khi DB có — production có từ đợt thông báo 21/10 nhưng chuỗi migration repo chưa có, nên gọi theo tên chỉ khi `to_regprocedure` thấy; không thì giờ yên công ty `notification_org_config` (mặc định 21→7). Đang yên ⇒ `not_before` = đầu giờ tròn hết yên; yên tới quá `send_until_hour` ⇒ bỏ |
| Bộ sinh `task_reminder_enqueue_v1(p_now)` | DEFINER, cron `task-reminders-15m`. Dọn lease quá hạn (giờ thật), xoá nhật ký > 30 ngày. Mỗi công ty bật: khoá tư vấn THỬ theo công ty (bận ⇒ bỏ lượt), khối con riêng; chỉ trong [giờ nhắc, `send_until_hour`); mỗi người nhận có việc: kiểm người nhận + E4 (`notify_gate_v1`: tắt cả chuông lẫn push ⇒ không nhắc Zalo; người chưa có dòng sở thích nhận `(NULL, NULL)` ⇒ coi là bật như mọi nơi gọi — tầng 2 bắt được bản đầu coi NULL là tắt) ⇒ `due_today` rồi `overdue`, dừng khi đủ `daily_cap` |

**`20261023063142_zalo_worker_task_reminder_v1`:** `zalo_worker_claim_task_reminders_v1` / `_begin_task_reminder_v1` / `_settle_task_reminder_v1`, DEFINER, chỉ `service_role`, đòi lease singleton `zalo_worker_lease` như `zalo_worker_claim_job_v1`. Claim SKIP LOCKED, giữ 60 s, kiểm lại cấu hình / ngày / người nhận. Begin là cổng ngay trước khi gọi Zalo: kiểm lại cấu hình, ngày, người nhận, E4, giờ yên (đang yên cùng ngày ⇒ về `queued` với `not_before` mới), dựng lại nội dung từ việc còn mở (hết ⇒ `skipped`), chuyển `sending` giữ 90 s. Settle: `failed` (chắc chắn chưa gửi) thử lại tối đa 3 lần (+5 / +30 phút), `unknown` không bao giờ gửi lại, phát lại cùng kết quả an toàn. Lease quá hạn: `claimed` ⇒ `queued`, `sending` ⇒ `unknown`.

**Soát 40P01 / cron:** không khoá dòng công ty (chỉ khoá tư vấn thử theo công ty và khoá dòng hàng đợi SKIP LOCKED / FOR UPDATE ngắn); worker giữ lease FOR SHARE. Không vòng với guard Hermes hay hàng đợi `zalo_send_queue`. Mọi hàm chạy từ cron / worker không dùng helper đòi `auth.role()` / `auth.uid()`.

**Test:**
- PGlite `task-reminder-sql` (nền: migration THẬT của trợ lý / phiên / liên kết Zalo, bảng giờ yên như production): khoá để TẮT + khung giờ; chọn việc (hạn hôm nay, quá hạn ≤ 3 ngày, việc xong / ngày mai / công ty khác / người chưa liên kết bị loại), một tin mỗi loại, chạy lại không trùng, nội dung đúng từng ký tự, > 10 việc; E4 tắt / thành viên nghỉ / hết hạn / liên kết thu hồi / nick tắt ⇒ không nhắc, trần 1 tin; giờ yên công ty ⇒ dời 09:00, yên quá giờ ⇒ bỏ, helper công ty + cá nhân khi có; worker: lease, claim một lần, begin dựng lại nội dung khi một việc đã xong, settle phát lại, ACL `service_role` (authenticated bị từ chối; `service_role` không đọc thẳng bảng, không gọi bộ sinh); thử lại ≤ 3 lần giãn cách, `unknown` không trao lại, lease quá hạn, tin cũ ⇒ `skipped`; 5 đột biến (bỏ kiểm thành viên, bỏ kiểm lease, trao lại `unknown`, bỏ giờ yên, begin không kiểm việc còn mở) đều bị bắt.
- PG17 `task-reminder-race-pg`: hai lượt bộ sinh song song ⇒ lượt sau `busy`, không chờ, không trùng; hai worker claim ⇒ hai tin rời nhau; dọn lease không chờ tin đang begin.
- Tầng 2 trên TEST (ROLLBACK; nạp hai file trong giao dịch; người nhận = liên kết Zalo ACTIVE thật, hai việc tổng hợp; bộ sinh chạy như cron không JWT): chưa bật ⇒ 0; 07:30 ⇒ 0; 08:05 ⇒ 2 tin, chạy lại 0; cron đã đăng ký; vai `authenticated` gọi claim / `service_role` đọc thẳng bảng ⇒ 42501; lease khác ⇒ `lease_lost`; claim 2 tin (có UID), claim lại 0; begin trả nội dung có link; settle `sent` + phát lại; việc bị huỷ giữa claim và begin ⇒ `jobs_closed`; giờ yên 21→9 ⇒ dời 09:00. TEST chưa có helper giờ yên cá nhân (production có) ⇒ nhánh giờ yên công ty.

**Thứ tự áp:** `063140` → `063142`, độc lập với Mốc 5. Không file nào `catalog-proven` giả (bảng / hàm đều mới). Rồi worker (phiên chính), rồi migration bật cấu hình.

Rollback: `SELECT cron.unschedule('task-reminders-15m')`; hai bảng + mười hàm mới để lại không hại (cấu hình tắt).

## 24. Lượt 11 — sửa theo nghiệm thu bot thật trên TEST (24/10)

**Phạm vi:** sáu lỗi phía máy chủ / tool rút từ nghiệm thu 23–24/10 (luật SOUL do phiên chính sửa riêng). Ba migration mới, mỗi file dựng từ thân production đang chạy và ghim md5; chưa áp.

| # | Lỗi | Sửa | File |
| --- | --- | --- | --- |
| 1 | Hỏi chọn người nhận (Q31, nhiều người quản lý toà) xong vẫn đòi thêm một lượt xác nhận | Bước chuẩn bị ghi lời mời chọn 15 phút (bảng mới `app_private.hermes_task_assignee_offers`: người hỏi, md5 nội dung lệnh trừ `assigneeName`, toà, ≤ 8 người đã nêu). Lượt sau nêu đúng một người trong danh sách với cùng nội dung ⇒ bỏ lý do xem trước "giao người khác" (Q32) — mọi lý do khác (đoán loại, thiếu phòng, trùng việc, người nhận không quản lý toà, mơ hồ) giữ nguyên; lời mời bị xoá cùng giao dịch ghi (`SKIP LOCKED`). Người ngoài danh sách / người hỏi khác / toà khác / đổi nội dung / quá 15 phút / pha xem trước ⇒ xem trước như cũ, lời mời không bị tiêu. Máy chủ KHÔNG phân biệt được người dùng chọn hay bot tự điền một cái tên trong danh sách: rào thực tế là luật SOUL (hỏi rồi chờ người dùng trả lời), và ngoại lệ chỉ có tác dụng khi chính sách `task.create` là `confirm='never'`. Không đụng thao tác tiền | `20261023185116` |
| 2 | Gợi ý loại việc có "162nvk", "950nk", "ml" | Gốc: dữ liệu thật trong `job_types` (production: `162nvk`, `950nk` trùng tên toà, 0 việc; `ml`, `thông` 0 việc) — không phải lỗi ghép chuỗi. Hàm dùng chung mới `public.job_type_building_like_v1` (INVOKER, dưới RLS): bộ giải tên dùng chung không nhận loại trùng tên / mã / tên gọi chung của toà, lõi task bỏ chúng khỏi danh mục suy loại; gợi ý chỉ nêu loại đã từng dùng hoặc có điểm. Không xoá dữ liệu (đề xuất dọn cho chủ) | `20261023185114`, `20261023185116` |
| 3 | "việc sửa vòi nước phòng 203" không tìm thấy | Tách "phòng N" (cả `P.203`, `ph 203`) và tên / mã toà trong phạm vi khoá khỏi chuỗi khớp tiêu đề; bỏ "việc" đứng đầu, giới từ đứng cuối; so theo từ. Phần tách ra là cách khớp THÊM (tiêu đề chứa phần chữ còn lại + đúng phòng theo khoá phòng / đúng một toà); luật cũ (cả chuỗi nằm trong tiêu đề) giữ ⇒ việc cả toà ghi phòng trong tiêu đề vẫn tìm được. Mơ hồ vẫn hỏi lại kèm toà | `20261023185116` |
| 4 | "anh Huy" không giải ra người | Bộ giải tên dùng chung: không ai khớp nguyên chuỗi ⇒ bỏ danh xưng (anh/chị/em/cô/chú/bác/ông/bà/thầy/dì/cậu, a/c/e) rồi khớp lại: bằng cả tên (bỏ dấu câu) trước, sau đó trọn từ. Chuỗi CÒN danh xưng không bao giờ khớp kiểu "chứa" ("anh huy" nằm trong "thanh huy", "e hoa" nằm trong "le hoa" ⇒ 11b sửa). Khớp nguyên chuỗi trước nên tên thật mở đầu bằng "Anh" (Anh Tú) không bị cắt. Danh xưng đứng một mình không đổi gì: bẫy "mình / anh / chị / em" của lõi task giữ nguyên | `20261023185114` |
| 5 | "Việc giao cho tôi" chỉ trả 20 dòng | `hermes_task_follow_read_v1` trả `total` + `summary` {total, open, overdue, completed, byBuilding ≤ 50} của cả tập lọc; trang + `nextOffset` như cũ | `20261023185118` |
| 6 | Bot không nêu được toà / phòng của việc | Mỗi dòng của đường đọc trên thêm `buildingName` (chữ, có thể rỗng) và `roomName` (null = cả toà). `crm_read_tasks` và `tasks_board` vốn đã có đủ tên toà / phòng / người nhận (kiểm khuôn) | `20261023185118` |

**Connector:** `task-follow-contract.mjs` nhận cả khuôn cũ lẫn khuôn mới của `crm_task_follow_list` (có đủ cặp `total` + `summary` và cặp tên trên mọi dòng), kiểm chặt khi có (tổng ≥ dòng tới hết trang, đúng bằng ở trang cuối; open + completed = total; overdue ≤ open; nhóm toà giảm dần, cộng đúng; tên phòng chỉ khi có phòng). Mô tả tool không đổi (giữ số byte `tools/list`).

**Thứ tự áp:** connector có `task-follow-contract.mjs` mới lên mọi host TRƯỚC `20261023185118` (connector cũ kiểm khoá chặt sẽ từ chối khoá mới). `20261023185114` → `20261023185116` (lõi task gọi hàm dùng chung của 185114) không cần connector trước. `20261023185118` bị provenance xếp `catalog-proven` dù chưa áp (chỉ thay một hàm đã có) ⇒ áp đích danh; 185114 / 185116 là `unknown` (có đối tượng mới vắng). Ghim chéo: 185114 ghim thân `20261021132433`, 185116 ghim hai thân `20261023042436`, 185118 ghim thân `20261022031600` ⇒ sau khi áp, ba file cũ đó cần ngoại lệ idempotent pinned (bài học #297/#298).

**Test:** PGlite `task-nghiem-thu-sql` (6 ca + 13 đột biến, sau 11b: mỗi rào của lời mời một đột biến — đồng ý, nội dung, toà, danh sách, 15 phút, người hỏi, pha, xoá sau khi dùng — cộng lọc loại trùng tên toà, lọc loại chưa dùng, bỏ danh xưng, thứ tự khớp danh xưng, tách phòng / toà), `task-nghiem-thu-race-pg` (PG17 hai kết nối: hai lượt cùng dùng một lời mời ⇒ một việc, lượt sau xem trước), `write-name-resolve-sql` (mọi vector `name-match-vectors.json` chạy lại trên thân 185114 + ca danh xưng / loại trùng mã toà) và `task-follow-total-sql` (trang 20 dòng / 25 việc: total + summary + tên; trang 2; trang rỗng; connector nhận khuôn mới và cũ, từ chối 9 kiểu lệch; 1 đột biến summary theo trang). Tầng 2 trên TEST (ROLLBACK, CHỈ ĐỌC vì phiên nghiệm thu đang dùng TEST; ca Q31 có bước ghi nên chỉ chạy PGlite): loại trùng tên toà = `162nvk`, `950nk`; gợi ý khi không suy được loại = check, checkin, decor, giặt, làm (không mục rác); `950nk` nêu thẳng ⇒ không nhận; "anh <tên>" 5/5 thành viên; "việc <tiêu đề> phòng <N>" 15/15 việc đang mở có phòng, kèm toà ⇒ đúng một việc; đường đọc theo dõi: total 11 = số việc thật, summary khớp, 11/11 dòng có tên toà.

**Lượt 11b (review độc lập, 24/10):** sửa thẳng trong hai file chưa áp. `185114`: bỏ khớp "chứa" trên chuỗi còn danh xưng; tên đã bỏ danh xưng khớp bằng cả tên rồi trọn từ. `185116`: hai câu xoá lời mời (sau khi dùng, dọn lời mời cũ hơn 1 ngày) dùng `FOR UPDATE SKIP LOCKED`, không đứng chờ khoá dòng; bỏ một rào trùng (pha `auto` đã nằm trong `p_phase='preview' OR …`) để mỗi rào còn lại có đột biến riêng. md5 thân mới: lõi giải tên `081243f1965abdde1431607e762be438`, bước chuẩn bị `3cc9a78f2974335f9c3fe94775779f89`; lõi task `bc2815291c35227110d0546a6d7a3b37` và đường đọc `54ee44b8d50a5d44611b0ac5e1616b85` không đổi. Tầng 2 chạy lại trên TEST với thân mới (ROLLBACK): kết quả như trên.

Rollback: chạy lại câu lệnh hàm của `20261021132433` / `20261023042436` / `20261022031600`; bảng lời mời và hàm dùng chung để lại không hại.

## 25. Lượt 12 — hai lỗi còn sót sau C1 (24/10)

**Phạm vi:** nghiệm thu chạy lại trên TEST với connector C1 + SOUL v4.18. Một migration mới `20261024091500_hermes_task_nghiem_thu_2_v1`, dựng từ thân production = TEST của `20261023185116` (lõi `bc2815291c35227110d0546a6d7a3b37`, chuẩn bị `3cc9a78f2974335f9c3fe94775779f89`), ghim md5; chưa áp. Không đụng bộ giải tên dùng chung (Hợp đồng / Hoá đơn đang sửa nó).

**Soát biên nhận TEST (chỉ đọc):** 27 lượt `task.create` đã ghi sau C1 — 19 lượt bot KHÔNG truyền `jobType` (nội dung mở đầu bằng tên loại: "Sửa …", "Thay …", "Mua …", "Thông …"), 8 lượt truyền cụm ("sửa vòi nước", "thay bóng đèn", "kiểm tra điện", "bảo trì", "dọn vệ sinh"). Cả 27 đều bị máy chủ coi là đoán. Biên nhận chỉ ghi lượt đã ghi (bản xem trước không lưu) nên câu chữ của lượt bị hỏi lại không đọc được; kết luận: lỗi ở CẢ hai phía — bot hay không truyền / truyền cụm (việc của SOUL), và máy chủ coi cả trường hợp nêu rõ loại là đoán (sửa ở đây).

| # | Lỗi | Sửa |
| --- | --- | --- |
| 1 | Gõ đúng tên loại vẫn ra bản xem trước "tự chọn theo nội dung" | Loại được NÊU rõ không còn là đoán: chuỗi loại trùng tên loại bỏ dấu / hoa thường / dấu câu / khoảng trắng (95: "vesinh" = "vệ sinh"); chuỗi loại mở đầu bằng tên loại (mức mới 92: "sửa vòi nước"); nội dung mở đầu bằng tên loại (90, như cú pháp `<loại> <mô tả>` của ô gõ nhanh web); nội dung / chuỗi loại mở đầu bằng cụm đồng nghĩa của bảng đồng nghĩa trỏ tới loại đó ("Kiểm tra điện" → check). Ba trường hợp sau chỉ khi chuỗi loại không trỏ sang loại khác (không loại nào khác ở mức 80 / 70, trừ loại có tên nằm lọt trong tên loại đứng đầu: "vệ" trong "vệ sinh"). Từ giữa câu ("Đèn hành lang cần kiểm tra") vẫn là đoán. Thứ hạng và loại chọn ra không đổi |
| 2 | Còn đòi thêm một lượt xác nhận sau khi trả lời câu hỏi chọn | Lời mời 15 phút của Q31 (cùng bảng, cùng rào: người hỏi, nội dung lệnh trừ người nhận, toà, người trong danh sách) nay ghi ở mọi câu hỏi chọn người nhận của `task.create`: (a) nhiều người quản lý (Q31), (b) tên mơ hồ — lõi kèm id ứng viên (mỗi tên giải lại đúng một người dưới RLS; khoá nội bộ không ra khỏi bước chuẩn bị), (c) đề xuất đúng một người quản lý (CHECK bảng nới 2–8 thành 1–8). Sửa / huỷ nhận lại nhãn ứng viên đã đưa (`<mã> · …` ⇒ tìm theo mã đầy đủ ⇒ ghi chú / ưu tiên ghi thẳng như Mốc 3). Chọn loại / phòng / toà từ danh sách vốn đã giải đúng một ⇒ không thêm lý do. Huỷ (irreversible) LUÔN xem trước; tạo lô và việc định kỳ `confirm='always'` không đổi; "việc trùng — vẫn tạo?" là xác nhận bình thường (bot phải gọi pha apply) |
| 3 | Lô vẫn hỏi chọn loại dù nội dung đã rõ | Cảnh báo lô "Loại việc do bot chọn theo nội dung … — hỏi lại nếu sai" khiến bot hỏi lại; cùng luật (1) ⇒ mục nêu rõ loại không còn trong cảnh báo |

**Ghim chéo / áp:** file ghim hai thân của `185116` ⇒ sau khi áp cần ngoại lệ idempotent pinned `20261023185116` ⇐ `20261024091500` (mục `20261023042436` ⇐ `185116` của C1 giữ, vì 042436 vẫn ném đúng lỗi cũ). Provenance xếp file `catalog-proven` dù chưa áp (chỉ thay hàm đã có + đổi CHECK) ⇒ áp đích danh. Không cần connector mới.

**Test:** PGlite `task-nghiem-thu-2-sql` (7 ca + 9 đột biến: thân requires; loại nêu rõ theo từng mức + đồng nghĩa giữa câu vẫn đoán + mâu thuẫn chuỗi loại; lô; tên mơ hồ chọn = đồng ý + người ngoài danh sách / đổi lệnh vẫn xem trước; đề xuất một người; nhãn sửa / huỷ; mỗi luật mới một đột biến). Tầng 2 trên TEST (ROLLBACK, chỉ gọi lõi STABLE dưới RLS của chính người gửi, không chạm phiên / kết nối / lời mời): 27 lượt `task.create` sau C1 chạy lại params thật — trước 27 đoán, nay 0, loại giữ nguyên 27/27; lô 28 mục — trước 28 bị cảnh báo, nay 0; nhãn sửa việc 8/8 tìm đúng theo mã. Tên mơ hồ không có cặp tên trùng thấy được trên TEST ⇒ chỉ PGlite.

Rollback: chạy lại câu lệnh hai hàm của `20261023185116` (CHECK 1–8 để lại không hại).

## 26. Lượt 13 — chặn ghi sai "tự giao cho mình" ở máy chủ (24/10)

**Vì sao:** nghiệm thu lượt cuối trên TEST (connector C3, SOUL v4.20) có hai việc ghi thẳng cho chính người gửi lệnh (`JOB-20261024-0055`, `JOB-20261024-0056`): bot tự điền `assigneeName: "tôi"` dù người dùng không tự giao — một lần sau khi người dùng bỏ câu hỏi chọn giữa hai người trùng tên ("thôi, để anh tự làm"), một lần với "giao anh sửa …". `task.create` có `confirm='never'` nên không có bản xem trước để chặn. Lần thứ hai SOUL sai đúng đường này ⇒ rào ở máy chủ. Migration `20261024145100_hermes_task_self_assign_guard_v1`, dựng từ thân `20261024091500` (lõi `c96652431f5af223f203a74e3d612e4b`, chuẩn bị `e1830d6d1940712b511669f97519e8da`; đang chạy trên TEST) và thân `20261022164201` (chuẩn bị lô `4adeb9ab54fbc7c44a517693d6c9ea26`; production = TEST); chưa áp.

| # | Luật mới | Ở đâu |
| --- | --- | --- |
| 1 | Người nhận = CHÍNH người gửi lệnh ⇒ `task.create` LUÔN xem trước, kể cả khi mọi thứ khác đã đủ và kể cả khi chọn chính mình từ danh sách đã hỏi (lời mời Q31 / tên mơ hồ không áp cho chính mình, không bị tiêu). Bản xem trước ghi "giao CHÍNH anh/chị", cảnh báo đầu tiên "Giao cho CHÍNH anh/chị (người gửi lệnh): chỉ ghi khi anh/chị đồng ý; muốn giao người khác thì nêu tên người đó."; chỉ ghi ở pha apply có basis (token xác nhận). Người nhận là người khác giữ chính sách cũ (Q32: xem trước, trừ khi chọn từ danh sách đã hỏi) | chuẩn bị `task.create` |
| 2 | `task.create_batch` vốn luôn xem trước (chính sách `always` + khối `p_phase<>'apply'`, có đột biến): cột người nhận ghi "CHÍNH anh/chị" và thêm cảnh báo "Giao cho CHÍNH anh/chị (người gửi lệnh) ở mục #…" | chuẩn bị lô |
| 3 | `assigneeName` là danh xưng trơn (bỏ dấu, bỏ dấu câu: anh, chị, em, cô, chú, bác, ông, bà, thầy, dì, cậu, bạn, a, c, e — "ảnh", "chỉ", "ổng", "bả" cùng gốc — kèm hoặc không "ấy" / "ta" / "kia" / "đó") ⇒ `needs_input` `name_unresolved` field `person`, why `unspecified`, `wanted` rỗng ("Chưa nêu người; hỏi người dùng."). Không thành chính người gửi, không thành người quản lý (Q31). Áp cho tạo việc, mục của lô, việc định kỳ mới, sửa việc, sửa việc định kỳ. Danh xưng + tên ("anh Huy") giữ luật lượt 11; "mình" giữ luật cũ (tên Minh hoặc chính mình, luôn xem trước). Lưu ý: "Chủ" trơn là "chú" ⇒ cũng hỏi | lõi |
| 4 | Lô > 20 mục ⇒ connector trả `needs_input` `batch_too_large` kèm "Đã gửi N mục ở items (tối đa 20)" thay cho `invalid_params` chung (khuôn list khai `overflow`; SQL đã có `batch_too_large` cho `buildingsManagedBy` > 20). Mảng sai khuôn vẫn là `invalid_params` | connector |

**Khuôn SOUL / bộ chấm cần biết:** tự giao (kể cả "tôi") nay luôn là `confirmation_required` ⇒ hỏi người dùng đồng ý rồi gửi lại với `confirmToken`; danh xưng trơn ⇒ hỏi "giao cho ai", không tự điền "tôi"; lô quá 20 ⇒ `batch_too_large` (chia lô).

**Ghim chéo / áp:** áp SAU `20261024091500` (C3). Provenance xếp `catalog-proven` dù chưa áp (chỉ thay hàm đã có) ⇒ áp đích danh. Sau khi áp cần ngoại lệ idempotent pinned `20261024091500` ⇐ `20261024145100` (`20261022164201` vốn đã có ngoại lệ: khối requires của nó ném trước). Phần SQL không cần connector trước (connector cũ chuyển nguyên `needs_input` / `confirmation_required`); phần `batch_too_large` chỉ có tác dụng khi phát hành connector mới.

**Test:** PGlite `task-tu-giao-sql` (7 ca + 4 đột biến: tự giao xem trước rồi apply ghi; chọn chính mình từ danh sách vẫn xem trước, lời mời còn; 13 danh xưng trơn ⇒ hỏi, "anh Huy" / "Anh Tú" / "mình" giữ luật; mục của lô, sửa việc, sửa việc định kỳ; lô nêu mục tự giao; đột biến: bỏ luật tự giao, bỏ rào danh xưng ở tạo / sửa, lô ghi không qua apply). Connector `action-catalog` + `task-actions` (`overflow` chỉ khi dài hơn max, khai sai ⇒ lỗi nạp; runtime trả `batch_too_large` với số mục, không gọi SQL). Tầng 2 TEST (ROLLBACK, chỉ gọi lõi dưới RLS của chính người gửi): hai biên nhận sự cố — params bot gửi `assigneeName: "tôi"`, lõi giải ra chính người gửi ⇒ bước chuẩn bị mới buộc xem trước; 24/10 có 53 lượt `task.create` đã ghi, 14 lượt tự giao (nay phải xem trước + đồng ý); danh xưng trơn 11/11 hỏi; "anh <tên>" 5/5.

Rollback: chạy lại câu lệnh ba hàm của `20261024091500` / `20261022164201`.

## 27. Lượt 14 — hai lỗi máy chủ theo nghiệm thu lượt cuối C3f (25/10)

**Vì sao:** pha A trên TEST (connector `1a915197`, SOUL v4.25) đạt 36/46, 0 ghi sai; hai lỗi phía máy chủ còn lại. Migration `20261025003100_hermes_task_given_per_room_v1` thay ba thân: bộ đọc miền v1 `public.hermes_domain_read_v1` (thân `20261022153345`, md5 `d79bb632be427768e64b6f3e7f543e73`, production = TEST — chỉ nhánh tasks + khoá input, mọi nhánh khác giữ từng byte), lõi + chuẩn bị lô của vỏ task (thân `20261024145100`, md5 `fdbb5d453243c8b920debc632f234b1e` / `1ea792d430d0c5f929d08a87984cf5a3`, đang chạy trên TEST). Chưa áp.

| # | Lỗi | Sửa | Ở đâu |
| --- | --- | --- | --- |
| 1 | "Việc tôi đã giao cho người khác mà chưa xong": `crm_read_tasks` đếm đúng `summary.givenByMe` nhưng `byBuilding` / `byAssignee` / `overdue` tính trên cả tập lọc ⇒ bot không nêu được người nhận của việc mình giao | Cờ input `givenByMe` (boolean, chỉ miền tasks): dòng VÀ mọi phần `summary` (count, byStatus, overdue, byBuilding, byAssignee, givenByMe) tính trên đúng tập việc người hỏi tạo mà người nhận khác người hỏi (kể cả chưa giao). Connector chỉ gửi khoá khi `true` (input năm khoá của SQL cũ không đổi khi không dùng) và từ chối kết quả có `givenByMe.count ≠ count` khi đã lọc. Mô tả tool: "việc anh/chị giao cho người khác: givenByMe=true" | bộ đọc v1 + connector `domain-contract` |
| 2 | "Mỗi phòng một việc" cho cả toà: bot phải hỏi xin danh sách phòng | `task.create_batch` nhận `perRoom: true` + `buildingName` (không `items`, không `buildingsManagedBy`): mỗi phòng chưa xoá của toà (RLS người hỏi) một mục theo tên phòng, xem trước như lô. > 20 phòng ⇒ `needs_input` `batch_too_large` kèm `rooms` = số phòng thật; connector nói "Toà có N phòng; tối đa 20 việc một lần — chia lô (vd theo tầng, gửi items từng phòng) hoặc tạo trên web." Toà không có phòng ⇒ hỏi lại phòng | lõi + chuẩn bị lô + connector |
| 3 | Đọc toàn công ty / theo người chỉ nêu 5 toà | Soát: `summary.byBuilding` của `crm_read_tasks` đã đủ mọi toà tới 50 nhóm (SQL `LIMIT 50`, connector không cắt); TEST có 16–17 toà có việc mở ⇒ đủ. Không sửa máy chủ — lỗi ở cách bot đọc | — |

**Khuôn SOUL cần biết:** "việc anh/chị giao (cho người khác)" ⇒ `crm_read_tasks {givenByMe: true, status: 'IN_PROGRESS'}` rồi đọc `summary.byAssignee` / `summary.byBuilding` (đã là tập đó). "Toà X, mỗi phòng một việc" ⇒ `task.create_batch {buildingName, perRoom: true, …}`; `batch_too_large` kèm số phòng ⇒ đề nghị chia lô (gửi `items`). `summary.byBuilding` luôn đủ mọi toà (≤ 50) — nêu hết, không chọn 5.

**Thứ tự áp:** file này TRƯỚC connector lượt 14 (connector gửi `givenByMe` / `perRoom`; SQL cũ từ chối khoá `givenByMe`). Connector cũ + SQL mới: input năm khoá vẫn qua; `perRoom` không tới được SQL (connector cũ từ chối tham số lạ). Áp SAU `20261024145100` (C3). Provenance xếp `catalog-proven` dù chưa áp (chỉ thay hàm đã có) ⇒ áp đích danh. Sau khi áp cần ngoại lệ idempotent pinned: `20261022153345` ⇐ `20261025003100` (153345 ghim thân v1 của nó) và `20261024145100` ⇐ `20261025003100` (145100 ghim thân lõi / chuẩn bị lô).

**Test:** connector `task-luot14-contract` (cờ chỉ ở tasks, chỉ gửi khi true, bất biến givenByMe = count khi lọc; `perRoom` + câu `rooms`, `rooms` sai lý do / ≤ 20 / sai kiểu ⇒ từ chối), nhóm connector đọc + thao tác 244/244 (tools/list ≤ 64 000 B). SQL: `domain-composition` (thân v1 mới: tập givenByMe = J1, J2, J5, J6, J7, summary đủ phần trên tập đó, phân trang, khoá lạ / sai kiểu ⇒ 22023, false = không lọc; 2 đột biến lọc dòng / lọc summary), `task-luot14-sql` PGlite (4 ca + 4 đột biến: mỗi phòng một mục + ghi, phòng đã xoá không tính, 26 phòng ⇒ `batch_too_large` rooms 26, dùng sai ⇒ invalid_params, lô items > 20 vẫn không kèm số phòng). Tầng 2 TEST CHỈ ĐỌC (nghiệm thu đang chạy, không gọi hàm lệnh / hàm ghi): với nick chủ, tập "đã giao cho người khác, chưa xong" = NATHAN 39, JOEY 34 trên 17 toà; toà 102LVT có 40 phòng ⇒ perRoom sẽ trả `batch_too_large` rooms 40.

Rollback: chạy lại câu lệnh hàm của `20261022153345` (bộ đọc v1) và `20261024145100` (lõi, chuẩn bị lô).

## 28. Lượt 15 — connector tự quy đổi cụm ngày tiếng Việt (25/10)

**Vì sao:** ba ghi sai thật cùng gốc — mô hình tự tính ngày: "cuối tháng" không truyền hạn (v4.15), "thứ hai tuần trước" chạy thứ Bảy rồi Chủ nhật (HD-T22: ghi trả phòng 19/10, đúng 12/10), "thứ sáu tuần sau" chạy Chủ nhật 25/10 (CV-T12: hạn 06/11, đúng 30/10). SOUL đã có luật bốn bước kèm ví dụ đúng ngày đó mà mô hình vẫn tính sai.

| Đổi | Chi tiết |
| --- | --- |
| `infra/hermes-broker/vn-relative-date.mjs` (mới) | Quy đổi cụm ngày theo giờ VN (UTC+7), tuần bắt đầu thứ Hai: hôm nay / mai / mốt / N ngày nữa / hôm qua; thứ X (trần, "tới", tuần này / sau / sau nữa / trước, cả khi cụm tuần đứng trước thứ); chủ nhật; cuối tuần (sau); đầu tuần sau; cuối / đầu / giữa tháng; dd/mm(/yyyy), "ngày N"; giờ ("9h sáng", "14h30", "2 giờ chiều", "7 giờ tối"). Hai lựa chọn, ngày sai, thứ lệch ngày ⇒ không hiểu |
| Tham số mới | `deadlinePhrase` cho `task.create`, `task.update`, `task.create_batch` (chung và từng mục); `datePhrase` cho `contract.return` (ngày đã xảy ra: "thứ X" trần = lần gần nhất tới hôm nay) và `contract.notice_set` |
| `action-runtime.mjs` | Có cụm ⇒ connector tự đổi và GHI ĐÈ `deadline` / `deadlineTime` / `date` mô hình gửi; SQL nhận params đã đổi (cụm không xuống SQL); token vẫn gắn params mô hình gửi. Xem trước: câu "Hiểu '…' là thứ … dd/mm/yyyy (không phải … như đã tính)" đứng đầu `warnings`; ghi thẳng: `notes`. Không hiểu ⇒ `needs_input date_out_of_range` "Chưa hiểu ngày '…'", không gửi gì xuống SQL |

**Phát hành:** chỉ connector, KHÔNG có migration; connector cũ không nhận tham số mới (mô hình gửi ⇒ invalid_params) nên SOUL v4.27 (dặn gửi cụm) lên CÙNG connector.

**Test:** `vn-relative-date.test.mjs` (bảng vàng ~60 cụm với hôm nay là Chủ nhật / thứ Bảy / thứ Hai / cuối tháng / cuối năm / gần nửa đêm UTC; hai ca ghi sai thật; ca không hiểu); `action-runtime-date-phrase.test.mjs` (qua broker thật: SQL nhận 30/10 thay 06/11, câu đọc lại, lượt đồng ý gửi y nguyên vẫn khớp và gửi đúng ngày, cụm không hiểu ⇒ không gửi gì). Đột biến bằng tay: bỏ ghi đè (SQL nhận params mô hình) ⇒ ca đầu đỏ.

## 29. Lượt 16 — phòng trùng nhiều toà: việc khớp chọn toà (C3k, 26/10)

**Vì sao:** nghiệm thu C3h CV-H04 "Huỷ giúp anh việc sửa khoá cửa phòng 302" — `task.cancel` / `task.update` chỉ nêu phòng, phòng 302 có ở ~20 toà ⇒ máy chủ hỏi chọn toà trong 8 toà đầu theo tên (thiếu đúng 417LVT có việc); bot không nêu được ứng viên đúng, người dùng phải tự nhớ toà.

| Đổi | Chi tiết |
| --- | --- |
| `20261026014500_hermes_task_room_by_job_v1.sql` | Dựng lại `app_private.hermes_task_resolve_core_v1` từ thân 003100 (md5 `adea03b2…` ⇒ `3ca074bb…`), chỉ nhánh tìm việc của `task.update` / `task.cancel`: chưa nêu toà mà phòng trùng nhiều toà ⇒ lọc việc theo khoá phòng (luật của bộ giải tên: tên hoặc bí danh, toà thật chưa xoá) ở mọi toà trong phạm vi khoá. Một việc khớp ⇒ xem trước việc đó (nêu toà); nhiều ⇒ hỏi chọn VIỆC kèm toà, không tự chọn; không việc nào ⇒ hỏi toà như cũ. Nêu toà ⇒ như cũ. |

**Phát hành:** chỉ SQL (dạng trả về như cũ, không cần connector mới). Chạy lại 003100 sau file này ném `hermes_task_given_per_room_dependency_invalid` (ghim md5 chéo) ⇒ ngoại lệ pinned 003100⇐014500 ở commit sau-áp.

**Test:** `task-luot16-sql.test.mjs` (PGlite, mỗi file hai lượt): phòng "201" trùng Toà A / Toà B; một việc khớp ⇒ xem trước đúng việc ở toà B (việc cùng tên ở phòng khác không tính), sửa ghi vào đúng việc; hai việc ⇒ hỏi chọn việc, ứng viên kèm hai toà; không việc nào ⇒ câu hỏi toà như cũ; nêu toà vẫn thu hẹp. Đột biến: tắt nhánh, bỏ lọc khoá phòng, bỏ câu hỏi toà khi không khớp ⇒ mỗi cái làm một ca đỏ.
