// Khung tin Zalo buổi tối "Bài học chờ duyệt" (đợt 3 của học có kiểm duyệt — CHƯA nối vào danh mục thao tác).
// Hàm thuần, không I/O: bộ dựng tin tất định (số = seq theo công ty, dùng chung với trang web) và bộ đọc câu trả lời
// "duyệt 1,3" / "bỏ 2 vì …" thành tham số của thao tác learning.decide. Thiết kế: docs/plans/hermes-crm/HOC-CO-KIEM-DUYET.md.

export const LEARNING_REVIEW_PATH = '/settings/hermes?tab=bai-hoc';
const MAX_ITEMS = 10;
const MAX_MESSAGE = 1800;
const KIND_LABELS = Object.freeze({ skill_crm_write: 'Skill', memory_crm_write: 'Bộ nhớ' });

const oneLine = (value, max) => {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  const chars = Array.from(text);
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join('').trimEnd()}…`;
};

/** Tin tổng hợp: đề xuất mới (≤ 10 dòng, theo số), số đề xuất cũ còn chờ, cách trả lời, link trang duyệt.
 * `webOrigin` là origin https của web CRM (cấu hình host `publicWebOrigin`); thiếu thì chỉ ghi đường dẫn.
 * Không có đề xuất mới ⇒ null (cron không gửi gì). */
export function formatLearningDigest({ proposals, pendingTotal, webOrigin = null, date = null }) {
  if (!Array.isArray(proposals) || !Number.isSafeInteger(pendingTotal) || pendingTotal < proposals.length) throw new TypeError('invalid_learning_digest');
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
  const rows = items.map(item => `#${item.seq} ${KIND_LABELS[item.kind]} — ${oneLine(item.title, 90)}: «${oneLine(item.content, 140)}»`);
  const older = pendingTotal - items.length;
  const first = items[0].seq;
  const tail = [
    ...(older > 0 ? [`Còn ${older} đề xuất cũ đang chờ.`] : []),
    `Trả lời "duyệt ${first}" hoặc "bỏ ${first}" (nhiều số cách nhau dấu phẩy, có thể kèm lý do sau chữ "vì").`,
    `Xem kỹ: ${webOrigin ? webOrigin + LEARNING_REVIEW_PATH : LEARNING_REVIEW_PATH}`,
  ];
  // Bớt dòng đề xuất (giữ tiêu đề, phần hướng dẫn + link) tới khi vừa giới hạn độ dài của một tin.
  for (let shown = Math.min(MAX_ITEMS, rows.length); shown >= 1; shown--) {
    const more = rows.length > shown ? [`… và ${rows.length - shown} đề xuất mới khác (xem trên web).`] : [];
    const message = [head, ...rows.slice(0, shown), ...more, ...tail].join('\n');
    if (Array.from(message).length <= MAX_MESSAGE) return message;
  }
  return [head, `… ${rows.length} đề xuất mới (xem trên web).`, ...tail].join('\n');
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
