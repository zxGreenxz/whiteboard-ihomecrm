// Thao tác ghi của trang BÀI HỌC — đợt 3 học có kiểm duyệt (docs/plans/hermes-crm/HOC-CO-KIEM-DUYET.md mục 4): tin Zalo 21:00 "Bài học
// Hermes chờ duyệt" và duyệt qua Zalo. Cắm vào khung chung crm_action_* (0 byte tools/list: khuôn tham số nằm trong kết quả
// crm_action_list). Một RPC trang public.hermes_learning_action_v1 (20261105025453): vỏ INVOKER → bước DEFINER (guard chung → cổng
// users.edit như trang web → basis → ghi qua lõi dùng chung với web → biên nhận). Khoá riêng Hermes assistant.learning_review (seed TẮT,
// quyền CRM giao vào users.edit). Trang chỉ nạp khi cấu hình host bật actionPages ["learning"]; vắng ⇒ danh mục như cũ.
import { defineAction, param } from './action-catalog.mjs';
import { HERMES_LEARNING_ACTION_KEYS } from './capability-contract.mjs';
import { formatLearningDigest, LEARNING_DIGEST_MAX_ITEMS } from './learning-digest.mjs';

export const LEARNING_REVIEW_KEY = HERMES_LEARNING_ACTION_KEYS[0];
const RPC = 'hermes_learning_action_v1';

// Chỉ job cron 21:00 của hồ sơ chủ gọi: SQL đánh dấu "đã báo" các đề xuất chờ chưa báo của CẢ công ty (một lần), connector dựng
// result.message tất định. Database tự giữ luật này (20261111015658): lượt ghi chỉ được nhận khi đồng hồ database nằm trong khung
// [20:55:00, 21:10:00) giờ Asia/Ho_Chi_Minh; ngoài khung ⇒ action_rejected learning_digest_outside_window, không dòng nào đổi (trước đó
// một lời gọi trong chat hay một lượt chạy tay làm đề xuất rời khỏi mọi tin tối mà chủ không nhận được tin nào — sáng 11/11).
export const LEARNING_DIGEST = defineAction({ id: 'learning.digest', page: 'learning', key: LEARNING_REVIEW_KEY, class: 'reversible', rpc: RPC,
  title: 'Chỉ job tin tối 21:00 gọi: đánh dấu đã báo, trả result.message để gửi nguyên văn (null ⇒ không gửi)',
  reasons: ['learning_digest_outside_window'] });
// numbers = số #N của tin tối / trang web (seq theo công ty, ổn định giữa các tối); note = phần sau "vì". SQL luôn xem trước.
// Số trùng ("duyệt 1-3, 2") khử ở connector, giữ thứ tự lần đầu — SQL vẫn tự từ chối số trùng (22023) nếu có ai gọi thẳng.
export const LEARNING_DECIDE = defineAction({ id: 'learning.decide', page: 'learning', key: LEARNING_REVIEW_KEY, class: 'reversible', rpc: RPC,
  title: 'Duyệt / bỏ đề xuất bài học theo số của tin tối ("duyệt 1,3", "bỏ 2 vì …"); luôn xem trước, không đoán số',
  params: { numbers: param.list(param.int(1, 9_999_999, { hint: 'số đề xuất #N người dùng nói' }), { max: 20, unique: true }),
    decision: param.oneOf(['approve', 'reject']),
    note: param.text(1, 500, { optional: true, hint: 'NGUYÊN VĂN phần lý do sau chữ "vì"; không có thì bỏ' }) },
  reasons: ['learning_not_pending'] });

/** Danh mục của trang (server.mjs nạp khi host bật actionPages ["learning"]). */
export const LEARNING_ACTIONS = Object.freeze([LEARNING_DIGEST, LEARNING_DECIDE]);

const data = value => value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
const exact = (value, keys) => data(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const MICROS_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

/** Kết quả đã ghi của learning.digest (SQL: {announcedAt, pendingTotal, items ≤ LEARNING_DIGEST_MAX_ITEMS}) ⇒ kết quả mô hình thấy: message
 * dựng TẤT ĐỊNH bằng formatLearningDigest (có số của MỌI mục SQL vừa đánh dấu; ngày = announcedAt của SQL nên phát lại / crm_action_status
 * cho đúng tin cũ; link theo origin của host), số mục mới, các số đã báo và tổng đang chờ — không chuyển nội dung đề xuất (mô hình chỉ gửi
 * nguyên văn message). Khuôn lệch (kể cả nhiều mục hơn tin liệt kê được) ⇒ TypeError. */
export function presentLearningDigest(result, { webOrigin = null } = {}) {
  if (!exact(result, ['announcedAt', 'pendingTotal', 'items']) || typeof result.announcedAt !== 'string' || !MICROS_UTC.test(result.announcedAt) ||
      !Number.isSafeInteger(result.pendingTotal) || result.pendingTotal < 0 || !Array.isArray(result.items) || result.items.length > LEARNING_DIGEST_MAX_ITEMS ||
      result.items.some(item => !exact(item, ['seq', 'kind', 'title', 'content']) || typeof item.title !== 'string' || typeof item.content !== 'string'))
    throw new TypeError('invalid_learning_digest_result');
  const date = new Date(result.announcedAt);
  if (!Number.isFinite(date.getTime())) throw new TypeError('invalid_learning_digest_result');
  const message = formatLearningDigest({ proposals: result.items, pendingTotal: result.pendingTotal, webOrigin, date });
  return { message, newCount: result.items.length, numbers: result.items.map(item => item.seq), pendingTotal: result.pendingTotal };
}

/** Bộ dựng kết quả của trang cho createActionRuntime({ presenters }). Origin (publicWebOrigin của host) kiểm ngay lúc dựng: host bật trang
 * với origin tin tối không nhận ⇒ connector không khởi động (không đợi 21:00 mới hỏng). */
export function learningPresenters({ webOrigin = null } = {}) {
  formatLearningDigest({ proposals: [], pendingTotal: 0, webOrigin });
  return Object.freeze({ [LEARNING_DIGEST.id]: result => presentLearningDigest(result, { webOrigin }) });
}
