---
name: ihome-crm-cong-viec
description: "Công việc CRM: giao, sửa, huỷ, định kỳ, theo dõi việc."
version: 1.0.0
author: iHome CRM
metadata:
  hermes:
    tags: [crm, ihome, official, tasks]
    related_skills: [ihome-crm-ghi-chung]
---

# Công việc (trang /tasks)

Hướng dẫn chuẩn, cùng connector; khác skill tự học thì theo đây. Vòng ghi, xem trước, xác nhận, lỗi: `ihome-crm-ghi-chung`.
Tool việc kiểu cũ đã nghỉ: chỉ dùng các thao tác dưới đây (bảng tên cũ ở `ihome-crm-ghi-chung`).

## When to Use

Giao / tạo việc, giao nhiều việc, sửa hạn hay người nhận, ghi tiến độ, huỷ việc, việc định kỳ, theo dõi và nhắc việc, hỏi việc
đang mở. Câu có "giao (cho) …" hoặc "hạn …" là GIAO VIỆC kể cả khi mở đầu bằng "mua …" (không phải phiếu chi).

## Giao việc — `crm_action_run` action `task.create`

- Gọi NGAY khi người dùng yêu cầu; không tự đọc `crm_read_tasks` để kiểm trùng trước (máy chủ tự kiểm trùng, quyền, người quản
  lý toà, toà ngoài phạm vi) và không hỏi xác nhận trước — bản xem trước là bước xác nhận.
- `params`: `buildingName`, `roomName` (bỏ trống = cả toà), `content` (bắt buộc, mở đầu bằng cụm việc chính người dùng nói,
  không nhét hạn vào), `description`, `jobType`, `assigneeName`, `deadline` / `deadlineTime`, `deadlinePhrase`, `priority`
  (NORMAL / URGENT / LOW).
- `jobType`: chỉ khi người dùng nêu đúng tên một loại việc (kể cả gõ không dấu); không nêu thì bỏ trống, không tự đặt. Máy chủ
  hỏi chọn loại ⇒ nêu đề xuất đầu tiên trước; người dùng đáp "ok" ⇒ dùng đề xuất đầu tiên.
- `assigneeName`: "tôi" CHỈ khi người dùng tự giao cho mình ("giao tôi", "toi lam", "để mình làm"…). "anh/chị" đứng một mình là
  mơ hồ ⇒ hỏi "giao cho chính anh/chị hay cho ai ạ?". Không nêu người nhận ⇒ bỏ trống; máy chủ đề xuất người quản lý toà ⇒ đọc
  nguyên văn đề xuất và hỏi. Khách thuê không phải thành viên ⇒ không giao được, hỏi giao nhân viên nào.
- Hạn: người dùng nói hạn bằng lời ở bất kỳ đâu trong câu ⇒ BẮT BUỘC gửi `deadlinePhrase` = nguyên văn cụm đó. Không nói hạn ⇒
  bỏ trống, máy chủ đặt hết ngày mai; khi đọc xem trước nói rõ hạn mặc định (kèm thứ). Xem trước ra hạn mặc định mà người dùng
  đã nói hạn ⇒ gọi lại ngay với `deadlinePhrase` đúng.
- Thiếu nội dung việc (chỉ có nơi + người) ⇒ hỏi "việc gì ạ?". Trả lời mở đầu "thôi / khỏi / để đó" ⇒ không tạo, nói chưa tạo
  việc nào.
- `applied` ⇒ báo mã việc, người nhận, hạn. Muốn theo dõi ngay ⇒ `crm_task_follow_set` với `jobId` = `result.job.jobId`.

## Giao nhiều việc — `task.create_batch`

Tối đa 20 việc, một lần đồng ý cho cả lô: `items` [{buildingName, roomName, content, …}]; hoặc `buildingsManagedBy` = tên người
(mỗi toà người đó quản lý một việc); hoặc `perRoom` = true + `buildingName` (mỗi phòng một việc, không cần xin danh sách phòng).
`batch_too_large` ⇒ nói số phòng/việc, đề nghị chia lô. `task_quota_*` ⇒ chạm hạn mức giao việc qua bot trong một giờ, chưa tạo
việc nào.

## Sửa, huỷ, hoàn thành

- `task.update` {`job` = mã JOB-… / 4 số cuối / tiêu đề như người dùng nói, `note` (ghi tiến độ), `deadline`, `deadlinePhrase`,
  `assigneeName`, `priority`, `content`, `description`}. Nhiều việc khớp ⇒ đọc danh sách ứng viên, hỏi chọn, không tự chọn.
- `task.cancel` {`job`, `reason` tuỳ chọn — không hỏi lý do trước}: xoá hẳn, KHÔNG lùi được, luôn xem trước; lượt xác nhận kèm
  `consentText`. Bị chặn (`cancel_blocked`, `task_not_open`) ⇒ đưa đúng `link` web.
- "Xong rồi / hoàn thành giúp": không có thao tác (cần ảnh hoàn thành + GPS) ⇒ làm trên web/app trang Công việc (/tasks). Đính
  ảnh vào việc cũng làm trên web.

## Việc định kỳ

`task.recurring_create` {`content`, `frequency` daily / weekly / monthly, `weekdays` MON…SUN, `monthDay` (-1 = cuối tháng),
`every`, `startDate`, `endDate`, `dueDays`, `buildingName`, `roomName`, `assigneeName`}. Đổi: `task.recurring_update`; dừng:
`task.recurring_pause` (`resume` = true để chạy lại); xoá: `task.recurring_delete` — `rule` = mã DK-… hoặc nội dung. Chép nguyên
`preview.text` (lịch + ba lần tới), không tự tính ngày. Việc đã sinh là việc thường (huỷ bằng `task.cancel`).

## Theo dõi và nhắc (tool riêng, requestId từ `crm_new_request_id`)

- Tìm việc theo mã: `crm_task_follow_list` status=open, limit=50, lần lượt role=assigned_by_me, assigned_to_me, team; khớp đúng
  `code`, lấy `id` làm `jobId`.
- Đặt theo dõi: `crm_task_follow_set` {requestId, jobId, objective, remindBeforeMinutes, notifyAssigner}. Dừng:
  `crm_task_follow_stop` {requestId, followId, expectedVersion}. CRM tự nhắc; không tạo cron Hermes.

## Đọc việc

- Đang mở / quá hạn: `crm_read_tasks` status=IN_PROGRESS (+ `buildingName`, `query` = tên người, `givenByMe` = true cho "việc tôi
  giao người khác"); số lấy từ `summary` (count, overdue, byBuilding, byAssignee). Hạn hôm nay chưa phải quá hạn.
- "Việc giao cho tôi": `crm_task_follow_list` role=assigned_to_me.
- Loại việc: `crm_read_report` report=task_types; tiến độ tuần: report=tasks_board; việc định kỳ: report=task_recurrences.
