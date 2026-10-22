// Danh mục thao tác ghi của trang Công việc (Đợt 2b, docs/plans/hermes-crm/CONG-VIEC-THAO-TAC-GHI.md mục 2). Mốc 2: task.create.
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

export const TASK_ACTIONS = Object.freeze([TASK_CREATE]);
// Thao tác của danh mục này thay họ tool cũ: crm_task_create / crm_task_status / crm_task_input_options ẩn và bị từ chối khi
// task.create có trong danh mục (broker.mjs). Theo dõi, tiến độ, huỷ cũ giữ tới Mốc 3.
export const TASK_RETIRED_OPERATIONS = Object.freeze(['create', 'status', 'options']);
