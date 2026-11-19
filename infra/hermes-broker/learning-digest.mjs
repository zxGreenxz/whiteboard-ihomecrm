// Tin Zalo buổi tối "Bài học chờ duyệt" (đợt 3 của học có kiểm duyệt; trang thao tác learning-action-contract.mjs dựng `message` của
// learning.digest bằng formatLearningDigest). Hàm thuần, không I/O: bộ dựng tin tất định (số = seq theo công ty, dùng chung với trang
// web) và bộ đọc tham chiếu câu trả lời "duyệt 1,3" / "bỏ 2 vì …" thành tham số của learning.decide (skill chuẩn ihome-crm-bai-hoc mô tả
// cùng luật cho mô hình). Thiết kế: docs/plans/hermes-crm/HOC-CO-KIEM-DUYET.md mục 4.

export const LEARNING_REVIEW_PATH = '/settings/hermes?tab=bai-hoc';
/** Số đề xuất tối đa của một tin tối = trần SQL của learning.digest (LIMIT 10 ở 20261105025453; learning-action-sql.test.mjs giữ hai số
 * bằng nhau). SQL đánh dấu "đã báo" đúng các mục trả về và mục đã đánh dấu không bao giờ hiện lại ở tin sau, nên tin phải có số của
 * MỌI mục nhận được — không bao giờ bỏ dòng; phần vượt trần nằm lại để tối sau báo. */
export const LEARNING_DIGEST_MAX_ITEMS = 10;
const MAX_MESSAGE = 1800;
// Tin dài quá một tin: rút trích nội dung trước (140 → 100 → 60 ký tự), rồi bỏ hẳn trích (giữ tiêu đề); vẫn dài ⇒ chỉ còn danh sách số.
const EXCERPTS = Object.freeze([140, 100, 60, 0]);
const KIND_LABELS = Object.freeze({ skill_crm_write: 'Skill', memory_crm_write: 'Bộ nhớ', audit_warning: 'Cảnh báo kiểm học' });

const oneLine = (value, max) => {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  const chars = Array.from(text);
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join('').trimEnd()}…`;
};

/** Tin tổng hợp: đề xuất mới (≤ 10, mỗi đề xuất một dòng theo số — đủ mọi số), số đề xuất khác còn chờ, cách trả lời, link trang duyệt.
 * `webOrigin` là origin https của web CRM (cấu hình host `publicWebOrigin`); thiếu thì chỉ ghi đường dẫn.
 * Không có đề xuất mới ⇒ null (cron không gửi gì). Quá LEARNING_DIGEST_MAX_ITEMS đề xuất ⇒ TypeError (SQL không bao giờ trả quá). */
export function formatLearningDigest({ proposals, pendingTotal, webOrigin = null, date = null }) {
  if (!Array.isArray(proposals) || proposals.length > LEARNING_DIGEST_MAX_ITEMS || !Number.isSafeInteger(pendingTotal) ||
      pendingTotal < proposals.length) throw new TypeError('invalid_learning_digest');
  if (webOrigin !== null && (typeof webOrigin !== 'string' || !/^https:\/\/[A-Za-z0-9.-]+(?::\d{1,5})?$/.test(webOrigin))) throw new TypeError('invalid_learning_digest');
  for (const item of proposals) {
    if (!Number.isSafeInteger(item?.seq) || item.seq < 1 || !Object.hasOwn(KIND_LABELS, item.kind)) throw new TypeError('invalid_learning_digest');
  }
  if (proposals.length === 0) return null;
  const items = [...proposals].sort((a, b) => a.seq - b.seq);
  // Giờ VN cố định UTC+7 (không giờ mùa hè); tự định dạng để không phụ thuộc dữ liệu ICU của máy chạy.
  const vn = date instanceof Date && Number.isFinite(date.getTime()) ? new Date(date.getTime() + 7 * 3_600_000) : null;
  const day = vn ? `${String(vn.getUTCDate()).padStart(2, '0')}/${String(vn.getUTCMonth() + 1).padStart(2, '0')}` : null;
  const head = `Bài học Hermes chờ duyệt${day ? ` (${day})` : ''}: ${items.length} đề xuất mới về cách ghi dữ liệu CRM.`;
  // Còn chờ ngoài tin này: đề xuất đã báo các tối trước chưa ai quyết định, và đề xuất mới vượt trần (tối sau báo) — không gọi là "cũ".
  const others = pendingTotal - items.length;
  const first = items[0].seq;
  const tail = [
    ...(others > 0 ? [`Còn ${others} đề xuất khác đang chờ duyệt (xem trên web).`] : []),
    `Trả lời "duyệt ${first}" hoặc "bỏ ${first}" (nhiều số cách nhau dấu phẩy, có thể kèm lý do sau chữ "vì").`,
    `Xem kỹ: ${webOrigin ? webOrigin + LEARNING_REVIEW_PATH : LEARNING_REVIEW_PATH}`,
  ];
  // Mọi mục ở đây đã được đánh dấu "đã báo": KHÔNG bỏ dòng nào. Rút / bỏ trích nội dung tới khi vừa giới hạn độ dài của một tin.
  for (const excerpt of EXCERPTS) {
    const rows = items.map(item => `#${item.seq} ${KIND_LABELS[item.kind]} — ${oneLine(item.title, 90)}${excerpt ? `: «${oneLine(item.content, excerpt)}»` : ''}`);
    const message = [head, ...rows, ...tail].join('\n');
    if (Array.from(message).length <= MAX_MESSAGE) return message;
  }
  // Vẫn dài (origin rất dài): chỉ còn số trần — vẫn đủ mọi số đã báo, nội dung xem trên web.
  return [head, `${items.map(item => `#${item.seq}`).join(', ')} — nội dung xem trên web.`, ...tail].join('\n');
}

const fold = value => value.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[đĐ]/g, 'd').toLowerCase();
const REJECT = /^(?:khong duyet|tu choi|bo|loai)\b/;
const APPROVE = /^(?:duyet|dong y|ok|giu)\b/;
const ANY_VERB = /\b(?:khong duyet|tu choi|bo|loai|duyet|dong y|giu)\b/;
const REASON = /(?:^|\s)(?:vì|vi|lý do|ly do)(?=\s|$)|:/u;

/** "duyệt 1,3" | "Duyệt #1 và #3" | "bỏ 2 vì sai quy trình" | "không duyệt 5" | "duyệt 4-6" ⇒ { decision, numbers, note }.
 * Không chắc (không mở đầu bằng động từ, không có số, trộn duyệt + bỏ, quá 20 số, dải ngược) ⇒ null: bot hỏi lại, không đoán. */
export function parseLearningReply(text) {
  if (typeof text !== 'string') return null;
  const raw = text.normalize('NFC').trim();
  if (!raw || Array.from(raw).length > 600) return null;
  const marker = REASON.exec(raw.toLowerCase());
  const head = fold(marker ? raw.slice(0, marker.index) : raw).trim();
  const note = marker ? raw.slice(marker.index + marker[0].length).trim() || null : null;
  const reject = REJECT.exec(head), approve = reject ? null : APPROVE.exec(head);
  const verb = reject ?? approve;
  if (!verb) return null;
  const rest = head.slice(verb[0].length);
  if (ANY_VERB.test(rest)) return null;
  const numbers = [];
  for (const match of rest.matchAll(/#?(\d{1,7})(?:\s*-\s*#?(\d{1,7}))?/g)) {
    const from = Number(match[1]), to = match[2] === undefined ? from : Number(match[2]);
    if (from < 1 || to < from || to - from > 19) return null;
    for (let value = from; value <= to; value++) if (!numbers.includes(value)) numbers.push(value);
  }
  if (numbers.length === 0 || numbers.length > 20) return null;
  if (note !== null && Array.from(note).length > 500) return null;
  return { decision: reject ? 'reject' : 'approve', numbers: numbers.sort((a, b) => a - b), note };
}
