// Rào đồng ý ở máy chủ cho thao tác KHÔNG lùi được (lớp irreversible của danh mục; lượt 12 Hợp đồng, nghiệm thu 24/10 —
// ghi sai thật lần thứ 3: contract.return trả confirmation_required, người dùng CHỈ bổ sung chi tiết "trả sớm, quyết toán sau, khách
// đã trả chìa", bot vẫn gọi lại kèm confirmToken ⇒ HĐ thành TERMINATED). Connector không thấy tin của người dùng, nên lượt xác nhận
// của các thao tác này phải kèm consentText = NGUYÊN VĂN tin mới nhất của người dùng; câu đó phải có dấu hiệu đồng ý và không có dấu
// hiệu chưa đồng ý, nếu không ⇒ needs_input consent_unclear, chưa ghi, token CHƯA bị tiêu (người dùng đáp "ok" thì dùng lại được).
// Đây là rào chữ, không phải hiểu ngôn ngữ: đóng an toàn (nghi ngờ ⇒ hỏi lại thêm một câu), và mô hình vẫn có thể trích sai lời —
// rào chặn đúng lớp lỗi "chi tiết bị coi là đồng ý" và để lại vết (sổ audit của host ghi câu đó).
//   Từ: so theo từng từ (ranh giới từ, không khớp chuỗi con), bỏ dấu + chữ thường; từ CÓ dấu thì dấu phải khớp đúng (đúng ≠ đừng,
//     có ≠ cô; vị trí dấu thanh không tính: huỷ = hủy), từ gõ không dấu khớp mọi biến thể có dấu — trừ từ đánh dấu `!` chỉ khớp khi gõ
//     đúng dấu (cho ≠ chờ, o ≠ ờ, co ≠ có: gõ không dấu đã là chữ khác rất thường gặp).
//   Đồng ý: chỉ tính ở ĐẦU một vế (vế = đoạn giữa hai dấu câu / xuống dòng), sau lời gọi/xưng hô ("dạ", "anh", "em ơi"…): "khách đồng
//     ý trả sớm" hay "khách có trả chìa" là chi tiết, không phải đồng ý. Từ yếu (có, được, chốt, ừ, ờ, vâng…) còn phải hết vế (chỉ còn
//     trợ từ "đi", "nhé", "rồi"…): "chốt quyết toán sau", "được hoàn cọc" không tính.
//   Chưa đồng ý: ở bất kỳ đâu (kể cả "ok nhưng khoan đã"); có dấu hỏi "?" cũng coi là chưa đồng ý (người dùng đang hỏi lại).
export const CONSENT_TEXT_MAX = 300;
export const CONSENT_CLASSES = Object.freeze(['irreversible']);
/** Thao tác của danh mục phải kèm consentText ở lượt xác nhận. */
export const consentRequired = action => CONSENT_CLASSES.includes(action?.class);
// Câu tĩnh cho mục lục crm_action_list (khoá consentText của thao tác cần lời đồng ý).
export const CONSENT_HINT = 'trường cạnh confirmToken (không trong params), bắt buộc ở lượt xác nhận: NGUYÊN VĂN tin mới nhất của người dùng (≤ 300 ký tự), ' +
  'phải là lời đồng ý rõ';

const MARK = /\p{M}/u;
const form = raw => {
  const letters = [...raw.normalize('NFD')];
  return { bare: letters.filter(char => !MARK.test(char)).join('').replaceAll('đ', 'd'), marks: letters.filter(char => MARK.test(char) || char === 'đ').sort().join('') };
};
const signs = list => Object.freeze(list.map(phrase => Object.freeze(phrase.replace(/^!/, '').split(' ').map(word => Object.freeze({ ...form(word), strict: phrase.startsWith('!') })))));
const STRONG = signs(['ok', 'oke', 'okie', 'oki', 'okay', 'yes', 'đồng ý', 'xác nhận', 'đúng rồi', 'ghi đi', 'ghi luôn', 'làm đi', 'làm luôn', 'trả phòng đi',
  'huỷ đi']);
const WEAK = signs(['!có', 'được', 'chốt', '!ừ', 'ừm', 'uh', 'uhm', '!ờ', 'vâng']);
const NEGATIVE = signs(['không', 'ko', 'k', 'kh', 'kg', 'hông', 'khum', 'khoan', '!chờ', 'chờ đã', 'chờ chút', 'chờ xíu', 'chờ tí', 'đợi', 'từ từ', 'thôi',
  'đừng', 'dừng', 'chưa', 'sai', 'nhầm', 'sửa lại', 'đổi', 'no', 'not', 'wait', 'stop']);
// Lời gọi / xưng hô đứng trước lời đồng ý, và trợ từ được đứng sau từ yếu.
const LEAD = signs(['dạ', 'à', 'ơi', 'anh', 'chị', 'em', 'a', 'e', 'c', 'tôi', 'mình', 'bạn', 'cứ', 'thì', 'vậy', 'thế', 'rồi', 'bot']);
const TAIL = signs(['đi', 'nhé', 'nha', 'nhá', 'nhe', 'luôn', 'rồi', 'ạ', 'à', 'đó', 'vậy', 'thế', 'anh', 'chị', 'em', 'a', 'e', 'c', 'ơi']);
const EMOJI = /[\u{1F44D}\u{1F44C}\u{2705}]/u;

const same = (word, sign) => word.bare === sign.bare && (word.marks === sign.marks || (!sign.strict && word.marks === ''));
const at = (words, index, sign) => sign.every((part, offset) => index + offset < words.length && same(words[index + offset], part));
const find = (words, index, list) => list.find(sign => at(words, index, sign));

/** true khi câu là lời đồng ý rõ: có dấu hiệu đồng ý ở đầu một vế và không có dấu hiệu chưa đồng ý nào. */
export function consentClear(text) {
  if (typeof text !== 'string' || !text.trim() || [...text].length > CONSENT_TEXT_MAX || /[?？]/.test(text)) return false;
  const clauses = text.normalize('NFC').toLowerCase().split(/[^\p{L}\p{M}\p{N} \t]+/u)
    .map(clause => clause.split(/[ \t]+/).filter(Boolean).map(form)).filter(words => words.length);
  if (clauses.some(words => words.some((_, index) => find(words, index, NEGATIVE)))) return false;
  if (EMOJI.test(text)) return true;
  return clauses.some(words => {
    let index = 0;
    while (index < words.length && find(words, index, LEAD)) index += 1;
    if (find(words, index, STRONG)) return true;
    const weak = find(words, index, WEAK);
    return weak !== undefined && words.slice(index + weak.length).every((_, offset, rest) => find(rest, offset, TAIL)?.length === 1);
  });
}

/** Bản ghi vào sổ audit của host: một dòng, ký tự điều khiển thành khoảng trắng, ≤ 300 ký tự. */
export const consentAuditText = text => [...text.replace(/[\x00-\x1f\x7f-\x9f\p{Zl}\p{Zp}]+/gu, ' ').trim()].slice(0, CONSENT_TEXT_MAX).join('');
