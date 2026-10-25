// Danh mục thao tác ghi của trang Công việc (Đợt 2b, docs/plans/hermes-crm/CONG-VIEC-THAO-TAC-GHI.md mục 2). Mốc 2: task.create; Mốc 3: task.update, task.cancel;
// Mốc 4: task.create_batch; Mốc 5: task.recurring_create / _update / _pause / _delete.
// Tên toà/phòng/loại/người do SQL giải dưới RLS người hỏi (public.hermes_task_action_v1, 20261022031548). Lớp reversible + chính
// sách DB never: tự giao, đủ thông tin ⇒ ghi thẳng; máy chủ tự đòi xem trước khi giao người khác, khi phải đoán loại/phòng, khi
// có việc trùng đang mở, khi người nhận không quản lý toà, khi đề xuất người nhận (Q31, Q32, Q35, Q36). Hạn trống = hết ngày mai
// giờ công ty (Q30). Khoá tasks.create: lớp quyền khung chung là nguồn duy nhất của khoá này khi danh mục có task.create (CV1).
import { createActionCatalog, defineAction, param } from './action-catalog.mjs';

// Lượt 15 (nghiệm thu C3h: mô hình tự tính ngày sai — "thứ sáu tuần sau" hôm Chủ nhật): cụm hạn NGUYÊN VĂN, connector tự quy đổi
// (vn-relative-date.mjs) và ghi đè deadline / deadlineTime trước khi gửi SQL; cụm không xuống SQL.
const DEADLINE_PHRASE = () => param.text(1, 80, { optional: true,
  hint: 'NGUYÊN VĂN cụm hạn người dùng nói ("thứ sáu tuần sau", "cuối tháng", "9h sáng mai"); connector tự đổi ra ngày, ghi đè deadline' });

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
    deadlinePhrase: DEADLINE_PHRASE(),
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
    deadlinePhrase: DEADLINE_PHRASE(),
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

// Mốc 4 (20261022164201): giao tối đa 20 việc MỘT lần đồng ý (Q37), cả lô hoặc không gì. Mỗi mục theo đúng luật task.create (giá trị chung
// ở ngoài — kể cả buildingName cho "toà X, mỗi phòng một việc" — mục đè từng trường); buildingsManagedBy thay items = mỗi toà người đó quản lý một việc (người nhận trống = chính người đó). Chính
// sách DB always ⇒ máy chủ LUÔN xem trước một lần cho cả lô; mục đầu tiên chưa ổn ⇒ needs_input kèm số mục.
export const TASK_BATCH_MAX = 20;
export const TASK_CREATE_BATCH = defineAction({ id: 'task.create_batch', page: 'task', key: 'tasks.create', class: 'reversible', rpc: 'hermes_task_action_v1',
  title: 'Giao nhiều việc một lần (≤20, một lần đồng ý): items từng toà/phòng, hoặc buildingsManagedBy = mỗi toà người đó quản lý',
  params: {
    items: param.list(param.record({
      buildingName: param.name('building', { optional: true }), roomName: param.name('room', { optional: true }),
      content: param.text(1, 200, { optional: true }), jobType: param.name('jobType', { optional: true }),
      assigneeName: param.name('person', { optional: true }), deadline: param.date({ optional: true }),
      deadlineTime: param.time({ optional: true }), deadlinePhrase: DEADLINE_PHRASE(), priority: param.oneOf(['NORMAL', 'URGENT', 'LOW'], { optional: true }),
    }), { min: 1, max: TASK_BATCH_MAX, optional: true, overflow: 'batch_too_large' }),
    buildingsManagedBy: param.name('person', { optional: true }),
    // Lượt 14: "toà X, mỗi phòng một việc" ⇒ perRoom=true + buildingName (không items): máy chủ dựng mỗi phòng một mục; > 20 phòng ⇒
    // batch_too_large kèm số phòng thật.
    perRoom: param.bool({ optional: true, hint: 'true = mỗi phòng của buildingName một việc (không gửi items); > 20 phòng ⇒ chia lô' }),
    buildingName: param.name('building', { optional: true }),
    jobType: param.name('jobType', { optional: true }),
    content: param.text(1, 200, { optional: true }),
    description: param.text(1, 2000, { optional: true }),
    assigneeName: param.name('person', { optional: true }),
    deadline: param.date({ optional: true }),
    deadlineTime: param.time({ optional: true }),
    deadlinePhrase: DEADLINE_PHRASE(),
    priority: param.oneOf(['NORMAL', 'URGENT', 'LOW'], { optional: true }),
  },
  reasons: ['task_quota_user', 'task_quota_pair', 'batch_too_large'] });

// Mốc 5 (20261023042424 bảng + hàm ghi CRM dùng chung; 20261023042436 thao tác): việc định kỳ. Chính sách DB always ⇒ máy chủ LUÔN xem
// trước (lịch dạng chữ + ba lần tới). Quy tắc tìm theo mã DK-… hoặc nội dung (SQL, không bao giờ tự chọn khi mơ hồ). Migration KHÔNG chèn
// dòng chính sách: bốn thao tác chỉ sống khi phiên chính bật bằng migration riêng (danh mục sống quyết định quảng bá).
const RECURRENCE_SCHEDULE = Object.freeze({
  every: param.int(1, 12, { optional: true }),
  weekdays: param.list(param.oneOf(['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN']), { min: 1, max: 7, optional: true }),
  monthDay: param.int(-1, 31, { optional: true }),
  startDate: param.date({ optional: true }),
  endDate: param.date({ optional: true }),
  dueDays: param.int(0, 30, { optional: true }),
});
export const TASK_RECURRING_CREATE = defineAction({ id: 'task.recurring_create', page: 'task', key: 'tasks.create', class: 'reversible',
  rpc: 'hermes_task_action_v1',
  title: 'Tạo việc định kỳ (mỗi ngày/tuần/tháng): toà, phòng, loại, nội dung, người nhận, lịch; mỗi lần sinh một việc thường',
  params: {
    buildingName: param.name('building', { optional: true }),
    roomName: param.name('room', { optional: true }),
    jobType: param.name('jobType', { optional: true }),
    content: param.text(1, 200),
    description: param.text(1, 2000, { optional: true }),
    assigneeName: param.name('person', { optional: true }),
    priority: param.oneOf(['NORMAL', 'URGENT', 'LOW'], { optional: true }),
    frequency: param.oneOf(['daily', 'weekly', 'monthly']),
    ...RECURRENCE_SCHEDULE,
  },
  reasons: ['recurrence_quota'] });
export const TASK_RECURRING_UPDATE = defineAction({ id: 'task.recurring_update', page: 'task', key: 'tasks.edit', class: 'reversible',
  rpc: 'hermes_task_action_v1',
  title: 'Sửa việc định kỳ (mã DK-…/nội dung): lịch, người nhận, nội dung, ưu tiên, hạn sau mấy ngày; việc đã sinh không đổi',
  params: {
    rule: param.name('recurrence'),
    content: param.text(1, 200, { optional: true }),
    description: param.text(1, 2000, { optional: true }),
    assigneeName: param.name('person', { optional: true }),
    priority: param.oneOf(['NORMAL', 'URGENT', 'LOW'], { optional: true }),
    frequency: param.oneOf(['daily', 'weekly', 'monthly'], { optional: true }),
    ...RECURRENCE_SCHEDULE,
  },
  reasons: ['recurrence_unchanged'] });
export const TASK_RECURRING_PAUSE = defineAction({ id: 'task.recurring_pause', page: 'task', key: 'tasks.edit', class: 'reversible',
  rpc: 'hermes_task_action_v1',
  title: 'Tạm dừng việc định kỳ (resume=true để chạy lại); việc đã sinh giữ nguyên',
  params: { rule: param.name('recurrence'), resume: param.bool({ optional: true }) },
  reasons: ['recurrence_unchanged'] });
export const TASK_RECURRING_DELETE = defineAction({ id: 'task.recurring_delete', page: 'task', key: 'tasks.delete', class: 'reversible',
  rpc: 'hermes_task_action_v1',
  title: 'Xoá việc định kỳ (mã DK-…/nội dung); việc đã sinh giữ nguyên',
  params: { rule: param.name('recurrence') } });

export const TASK_ACTIONS = Object.freeze([TASK_CREATE, TASK_CREATE_BATCH, TASK_UPDATE, TASK_CANCEL, TASK_RECURRING_CREATE, TASK_RECURRING_UPDATE,
  TASK_RECURRING_PAUSE, TASK_RECURRING_DELETE]);
// Thao tác của danh mục thay họ tool cũ, xét theo TỪNG lời gọi qua danh mục SỐNG phía SQL (broker.mjs): task.create sống ⇒
// crm_task_create / crm_task_status / crm_task_input_options ẩn và bị từ chối; task.update sống ⇒ crm_task_progress; task.cancel
// sống ⇒ crm_task_cancel. Connector mới + DB cũ ⇒ tool cũ còn nguyên.
export const TASK_RETIRED_BY = Object.freeze({ create: 'task.create', status: 'task.create', options: 'task.create', progress: 'task.update', cancel: 'task.cancel' });
export const TASK_RETIRED_OPERATIONS = Object.freeze(Object.keys(TASK_RETIRED_BY));
