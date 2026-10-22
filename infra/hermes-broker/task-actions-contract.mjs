// Danh mục thao tác ghi của trang Công việc (Đợt 2b, docs/plans/hermes-crm/CONG-VIEC-THAO-TAC-GHI.md mục 2). Mốc 2: task.create; Mốc 3: task.update, task.cancel.
// Tên toà/phòng/loại/người do SQL giải dưới RLS người hỏi (public.hermes_task_action_v1, 20261022031548). Lớp reversible + chính
// sách DB never: tự giao, đủ thông tin ⇒ ghi thẳng; máy chủ tự đòi xem trước khi giao người khác, khi phải đoán loại/phòng, khi
// có việc trùng đang mở, khi người nhận không quản lý toà, khi đề xuất người nhận (Q31, Q32, Q35, Q36). Hạn trống = hết ngày mai
// giờ công ty (Q30). Khoá tasks.create: lớp quyền khung chung là nguồn duy nhất của khoá này khi danh mục có task.create (CV1).
import { createActionCatalog, defineAction, param } from './action-catalog.mjs';

export const TASK_CREATE = defineAction({ id: 'task.create', page: 'task', key: 'tasks.create', class: 'reversible', rpc: 'hermes_task_action_v1',
  title: "Tạo/giao việc: toà, phòng ('cả toà'), loại, nội dung, người nhận ('tôi' = mình), hạn trống = hết ngày mai",
  params: {
    buildingName: param.name('building', { optional: true }),
    roomName: param.name('room', { optional: true }),
    jobType: param.name('jobType', { optional: true }),
    content: param.text(1, 200),
    description: param.text(1, 2000, { optional: true }),
    assigneeName: param.name('person', { optional: true }),
    deadline: param.date({ optional: true }),
    deadlineTime: param.time({ optional: true }),
    priority: param.oneOf(['NORMAL', 'URGENT', 'LOW'], { optional: true }),
  },
  reasons: ['task_quota_user', 'task_quota_pair'] });

// Mốc 3 (20261022074741): sửa việc đang mở. Việc tìm theo mã / 4 số cuối / tiêu đề (SQL, không bao giờ tự chọn khi mơ hồ). Máy chủ
// ghi thẳng chỉ khi tìm bằng mã đầy đủ và chỉ thêm ghi chú / đổi ưu tiên; đổi hạn, người nhận, tiêu đề, mô tả ⇒ xem trước.
export const TASK_UPDATE = defineAction({ id: 'task.update', page: 'task', key: 'tasks.edit', class: 'reversible', rpc: 'hermes_task_action_v1',
  title: 'Sửa việc đang mở (mã/tiêu đề): thêm ghi chú tiến độ, đổi hạn, người nhận, ưu tiên, tiêu đề, mô tả',
  params: {
    job: param.name('job'),
    buildingName: param.name('building', { optional: true }),
    roomName: param.name('room', { optional: true }),
    note: param.text(1, 1000, { optional: true }),
    deadline: param.date({ optional: true }),
    deadlineTime: param.time({ optional: true }),
    assigneeName: param.name('person', { optional: true }),
    priority: param.oneOf(['NORMAL', 'URGENT', 'LOW'], { optional: true }),
    content: param.text(1, 200, { optional: true }),
    description: param.text(1, 2000, { optional: true }),
  },
  reasons: ['task_not_open'] });

// Mốc 3: huỷ = xoá hẳn như web, lớp irreversible ⇒ LUÔN xem trước (mã, tiêu đề, toà, phòng, người nhận, hạn). Việc có vật tư hoặc
// ảnh hoàn thành ⇒ cancel_blocked kèm link web. Khoá tasks.delete đang tắt ở production (20261021162612) cho tới khi phiên chính bật.
export const TASK_CANCEL = defineAction({ id: 'task.cancel', page: 'task', key: 'tasks.delete', class: 'irreversible', rpc: 'hermes_task_action_v1',
  title: 'Huỷ hẳn (xoá) việc đang mở theo mã/tiêu đề; luôn xem trước, không khôi phục được',
  params: {
    job: param.name('job'),
    buildingName: param.name('building', { optional: true }),
    roomName: param.name('room', { optional: true }),
    reason: param.text(8, 300, { optional: true }),
  },
  reasons: ['cancel_blocked', 'task_not_open'] });

export const TASK_ACTIONS = Object.freeze([TASK_CREATE, TASK_UPDATE, TASK_CANCEL]);
// Thao tác của danh mục thay họ tool cũ, xét theo TỪNG lời gọi qua danh mục SỐNG phía SQL (broker.mjs): task.create sống ⇒
// crm_task_create / crm_task_status / crm_task_input_options ẩn và bị từ chối; task.update sống ⇒ crm_task_progress; task.cancel
// sống ⇒ crm_task_cancel. Connector mới + DB cũ ⇒ tool cũ còn nguyên.
export const TASK_RETIRED_BY = Object.freeze({ create: 'task.create', status: 'task.create', options: 'task.create', progress: 'task.update', cancel: 'task.cancel' });
export const TASK_RETIRED_OPERATIONS = Object.freeze(Object.keys(TASK_RETIRED_BY));
