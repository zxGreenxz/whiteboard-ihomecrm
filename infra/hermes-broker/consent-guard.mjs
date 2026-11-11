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
//     ý trả sớm" hay "khách có trả chìa" là chi tiết, không phải đồng ý. Từ yếu (có, được / đc, chốt, ừ, ờ, vâng…) còn phải hết vế (chỉ
//     còn trợ từ "đi", "nhé", "rồi"…): "chốt quyết toán sau", "được hoàn cọc" không tính.
//   Chưa đồng ý: ở bất kỳ đâu (kể cả "ok nhưng khoan đã"); có dấu hỏi "?" cũng coi là chưa đồng ý (người dùng đang hỏi lại).
//   Luật này (consentClear) nhận cả câu mở đầu bằng lời đồng ý rồi kèm lệnh / chi tiết ("Ok em, trả phòng 302 hôm nay") — nó KHÔNG chặn việc
//   mô hình trích câu ra lệnh mở đầu bằng "ok" làm lời đồng ý cho thao tác không lùi được.
// PS-K03 / PS-D05 (ma trận Phòng sale lô ps08 10/11/2026 — ghi sai thật: mô hình tự đổi giờ giữ phòng / tự đặt lý do dừng chương trình
// rồi ghi ngay trong lượt người dùng ra lệnh): thao tác có sàn xem trước — reversible khai confirm: 'always' (contract.room_lock,
// room-lock-guard.mjs) và dừng chương trình sale (policy-cancel-guard.mjs) — dùng luật CHẶT hơn, replyConsent: chỉ nhận CÂU ĐÁP THUẦN, mọi
// chữ của câu thuộc bộ từ lời đồng ý / xưng hô / trợ từ / cảm ơn / động từ của chính thao tác ("ừ giữ đi", "ok dừng đi", "dừng luôn", "đc").
// Có số, tên phòng / toà, "phòng", "chương trình", lý do hay bất kỳ chữ nào khác ⇒ chưa đồng ý. Điều được bảo đảm: câu nêu đối tượng của
// lệnh — phòng / toà / số giờ / chương trình — (kể cả "Ok em, giữ phòng 303 toà 44TL 8 tiếng nhé", "Vâng, ngưng chương trình ưu đãi phòng
// 105…") và câu chọn / nêu giá trị ("12 tiếng đi em", "ok 12 tiếng") không bao giờ là lời đồng ý, nên mô hình trích đúng câu đó cũng không
// tự xác nhận được. KHÔNG chặn được: câu lệnh không nêu đối tượng ("giữ đi em", "dừng luôn" ngay sau khi bot vừa nói về phòng — chữ y hệt
// lời đồng ý) và consentText bịa ("ok"): connector không thấy lượt người dùng; hai ca này chỉ còn vết trong sổ audit của host.
export const CONSENT_TEXT_MAX = 300;
export const CONSENT_CLASSES = Object.freeze(['irreversible']);
/** Thao tác của danh mục phải kèm consentText ở lượt xác nhận: lớp irreversible, và thao tác reversible khai confirm: 'always'. */
export const consentRequired = action => CONSENT_CLASSES.includes(action?.class) || (action?.class === 'reversible' && action?.confirm === 'always');
// Câu tĩnh cho mục lục crm_action_list (khoá consentText của thao tác cần lời đồng ý).
export const CONSENT_HINT = 'trường cạnh confirmToken (không trong params), bắt buộc ở lượt xác nhận: NGUYÊN VĂN tin mới nhất của người dùng (≤ 300 ký tự), ' +
  'phải là lời đồng ý rõ';

const MARK = /\p{M}/u;
const form = raw => {
  const letters = [...raw.normalize('NFD')];
  return { bare: letters.filter(char => !MARK.test(char)).join('').replaceAll('đ', 'd'), marks: letters.filter(char => MARK.test(char) || char === 'đ').sort().join('') };
};
const signs = list => Object.freeze(list.map(phrase => Object.freeze(phrase.replace(/^!/, '').split(' ').map(word => Object.freeze({ ...form(word), strict: phrase.startsWith('!') })))));
// Lời đồng ý chung; luật cũ (thao tác không lùi được) thêm động từ của chính các thao tác đó ("trả phòng đi", "huỷ đi").
const AGREE = ['ok', 'oke', 'okie', 'oki', 'okay', 'yes', 'đồng ý', 'xác nhận', 'đúng rồi', 'ghi đi', 'ghi luôn', 'làm đi', 'làm luôn'];
const STRONG = signs([...AGREE, 'trả phòng đi', 'huỷ đi']);
const WEAK = signs(['!có', 'được', 'đc', 'chốt', '!ừ', 'ừm', 'uh', 'uhm', '!ờ', 'vâng']);
// "dừng" là chưa đồng ý với mọi thao tác TRỪ thao tác dừng (replyConsent nhận nó làm động từ); các dấu hiệu còn lại không thao tác nào gỡ được.
const HARD_NEGATIVE = signs(['không', 'ko', 'k', 'kh', 'kg', 'hông', 'khum', 'khoan', '!chờ', 'chờ đã', 'chờ chút', 'chờ xíu', 'chờ tí', 'đợi', 'từ từ',
  'thôi', 'đừng', 'chưa', 'sai', 'nhầm', 'sửa lại', 'đổi', 'no', 'not', 'wait', 'stop']);
const NEGATIVE = Object.freeze([...HARD_NEGATIVE, ...signs(['dừng'])]);
// Lời gọi / xưng hô đứng trước lời đồng ý, và trợ từ được đứng sau từ yếu.
const LEAD = signs(['dạ', 'à', 'ơi', 'anh', 'chị', 'em', 'a', 'e', 'c', 'tôi', 'mình', 'bạn', 'cứ', 'thì', 'vậy', 'thế', 'rồi', 'bot']);
const TAIL = signs(['đi', 'nhé', 'nha', 'nhá', 'nhe', 'luôn', 'rồi', 'ạ', 'à', 'đó', 'vậy', 'thế', 'anh', 'chị', 'em', 'a', 'e', 'c', 'ơi']);
const EMOJI = /[\u{1F44D}\u{1F44C}\u{2705}]/u;

const same = (word, sign) => word.bare === sign.bare && (word.marks === sign.marks || (!sign.strict && word.marks === ''));
const at = (words, index, sign) => sign.every((part, offset) => index + offset < words.length && same(words[index + offset], part));
const find = (words, index, list) => list.find(sign => at(words, index, sign));
// Vế đã tách từ (chuẩn hoá NFC, chữ thường); null = không phải chuỗi, rỗng, quá trần hay có dấu hỏi.
const clausesOf = text => typeof text !== 'string' || !text.trim() || [...text].length > CONSENT_TEXT_MAX || /[?？]/.test(text) ? null
  : text.normalize('NFC').toLowerCase().split(/[^\p{L}\p{M}\p{N} \t]+/u).map(clause => clause.split(/[ \t]+/).filter(Boolean).map(form))
    .filter(words => words.length);

/** true khi câu là lời đồng ý rõ: có dấu hiệu đồng ý ở đầu một vế và không có dấu hiệu chưa đồng ý nào. */
export function consentClear(text) {
  const clauses = clausesOf(text);
  if (clauses === null) return false;
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

// Câu đáp thuần. Sau lời đồng ý / động từ chỉ được: thêm lời đồng ý / động từ, trợ từ (như TAIL nhưng bỏ "à" — "giữ à" là hỏi lại — và
// "đó"; "chị" phải gõ đúng dấu vì "giữ chi" = giữ làm gì; thêm "giúp / giùm / dùm", "ngay / liền"), cảm ơn; "rồi" chỉ ngay sau lời đồng ý
// ("được rồi", "ok rồi"), không sau động từ ("dừng rồi" = đã dừng).
const REPLY_AGREE = signs(AGREE);
const REPLY_TAIL = signs(['đi', 'nhé', 'nha', 'nhá', 'nhe', 'luôn', 'ngay', 'liền', 'ạ', 'vậy', 'thế', 'anh', '!chị', 'em', 'a', 'e', 'c', 'ơi', 'giúp',
  'giùm', 'dùm']);
const AFTER_AGREE = signs(['rồi']);
const THANKS = signs(['cảm ơn', 'cám ơn', 'thanks', 'thank you', 'tks', 'thx']);
const sameSign = (left, right) => left.length === right.length && left.every((part, index) => part.bare === right[index].bare &&
  part.marks === right[index].marks && part.strict === right[index].strict);
const longest = (words, index, list) => list.reduce((best, sign) => sign.length > (best?.length ?? 0) && at(words, index, sign) ? sign : best, undefined);
const listed = (word, list) => list.some(sign => sign.length === 1 && same(word, sign[0]));

/**
 * Rào lời đồng ý của thao tác có sàn xem trước: { clear(text) ⇒ boolean, detail } — clear chỉ nhận câu đáp thuần (đầu file); verbs = động
 * từ của CHÍNH thao tác, đứng một mình hay sau lời đồng ý ("giữ đi em", "ừ dừng đi"); động từ trùng "dừng" thì với thao tác này "dừng"
 * không còn là chưa đồng ý ("đừng" vẫn là). examples = vài lời đáp nhận được, cho câu consent_unclear (detail) mô hình đọc.
 */
export function replyConsent({ verbs = [], examples = ['ok', 'đồng ý'] } = {}) {
  const phrases = list => Array.isArray(list) && list.every(item => typeof item === 'string' && /^!?\p{L}+( \p{L}+)*$/u.test(item.normalize('NFC')));
  if (!phrases(verbs) || !phrases(examples) || !examples.length) throw new TypeError('invalid_reply_consent');
  const own = signs(verbs.map(verb => verb.normalize('NFC').toLowerCase()));
  // Động từ không được chứa dấu hiệu chưa đồng ý không gỡ được (kể cả gõ không dấu trùng chữ đó: "dung" ≈ "đừng").
  if (own.some(verb => verb.some((_, index) => find(verb, index, HARD_NEGATIVE)))) throw new TypeError('invalid_reply_consent');
  const negative = NEGATIVE.filter(sign => !own.some(verb => sameSign(verb, sign)));
  const heads = [...REPLY_AGREE, ...WEAK, ...own];
  // Một vế ⇒ 'filler' (chỉ xưng hô / trợ từ / cảm ơn), 'consent' (xưng hô… rồi lời đồng ý hay động từ, sau đó đúng bộ từ trên), null (chữ khác).
  const clause = words => {
    const tokens = [];
    for (let index = 0; index < words.length;) {
      const sign = longest(words, index, heads), thanks = sign ? undefined : longest(words, index, THANKS);
      tokens.push(sign ? { kind: own.includes(sign) ? 'verb' : 'agree' } : thanks ? { kind: 'thanks' } : { kind: 'word', word: words[index] });
      index += (sign ?? thanks)?.length ?? 1;
    }
    const head = tokens.findIndex(token => token.kind === 'agree' || token.kind === 'verb');
    if (head === -1) return tokens.every(token => token.kind === 'thanks' || listed(token.word, LEAD) || listed(token.word, REPLY_TAIL)) ? 'filler' : null;
    const before = tokens.slice(0, head).every(token => token.kind === 'thanks' || listed(token.word, LEAD));
    const after = tokens.slice(head + 1).every((token, offset) => token.kind !== 'word' || listed(token.word, REPLY_TAIL) ||
      (listed(token.word, AFTER_AGREE) && tokens[head + offset].kind === 'agree'));
    return before && after ? 'consent' : null;
  };
  const clear = text => {
    const clauses = clausesOf(text);
    if (clauses === null || clauses.some(words => words.some((_, index) => find(words, index, negative)))) return false;
    const kinds = clauses.map(clause);
    return !kinds.includes(null) && (kinds.includes('consent') || EMOJI.test(text));
  };
  const detail = `Chưa thấy lời đồng ý rõ cho bản xem trước này. Lời đồng ý là câu người dùng ĐÁP sau khi xem, chỉ gồm lời đồng ý (vd ${
    examples.map(example => `"${example}"`).join(', ')}); câu nêu lại phòng, toà, số giờ, chương trình hay lý do — kể cả câu yêu cầu ban đầu ` +
    '— và câu chỉ chọn giá trị chưa phải đồng ý. Hỏi lại người dùng có đồng ý không; không tự viết câu đồng ý thay họ.';
  return Object.freeze({ clear, detail });
}
/** Câu đáp thuần không kèm động từ riêng: thao tác reversible khai confirm: 'always' chưa khai động từ của mình. */
export const PLAIN_REPLY_CONSENT = replyConsent();

// Bản ghi audit che dãy số dài (≥ 9 chữ số, cho phép tới 3 dấu cách / chấm / gạch giữa hai chữ số (không tính dấu phẩy: hai số tiền liệt kê): SĐT, CCCD, số tài khoản), giữ 4 số cuối
// như SĐT che của connector (room-pass-contract.mjs phoneMasked "***1234"); tên và chữ còn lại giữ nguyên để lần lại lời đồng ý. Che TRƯỚC
// khi cắt ở 300 ký tự (không để sót nửa dãy số ở cuối).
const LONG_DIGITS = /\+?\d(?:[ .-]{0,3}\d){8,}/g;
/** Bản ghi vào sổ audit của host: một dòng, ký tự điều khiển thành khoảng trắng, dãy số dài bị che, ≤ 300 ký tự. */
export const consentAuditText = text => [...text.replace(/[\x00-\x1f\x7f-\x9f\p{Zl}\p{Zp}]+/gu, ' ').trim()
  .replace(LONG_DIGITS, run => `***${run.replace(/\D/g, '').slice(-4)}`)].slice(0, CONSENT_TEXT_MAX).join('');
