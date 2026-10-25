// Quy đổi cụm ngày tiếng Việt người dùng nói ("thứ sáu tuần sau", "cuối tháng", "9h sáng mai", "thứ hai tuần trước") ra ngày cụ thể
// theo giờ Việt Nam (UTC+7, không đổi giờ), tuần bắt đầu THỨ HAI — Công việc lượt 15 (nghiệm thu C3h, 25/10/2026). Gốc: mô hình tự
// tính ngày sai ba lần cùng một kiểu (CV-B01 "cuối tháng", HD-T22 "thứ hai tuần trước" chạy thứ Bảy rồi Chủ nhật, CV-T12 "thứ sáu
// tuần sau" chạy Chủ nhật 25/10 ⇒ 06/11 thay vì 30/10) dù SOUL có luật + ví dụ. Bot gửi NGUYÊN VĂN cụm (deadlinePhrase / datePhrase),
// connector tự tính, ghi đè ngày bot gửi và nêu "Hiểu '…' là thứ Sáu 30/10/2026" để bot đọc lại. Không hiểu ⇒ hỏi lại, không đoán.
// Thuần (không I/O), dùng được từ action-runtime và test.
const DAY = 86_400_000;
const VN_OFFSET = 7 * 3_600_000;
const WEEKDAY_NAMES = ['Chủ nhật', 'thứ Hai', 'thứ Ba', 'thứ Tư', 'thứ Năm', 'thứ Sáu', 'thứ Bảy'];
// thứ trong tuần theo kiểu Việt Nam: thứ Hai = 1 … Chủ nhật = 7.
const WEEKDAY_WORDS = Object.freeze({ hai: 1, ba: 2, tu: 3, nam: 4, sau: 5, bay: 6, 2: 1, 3: 2, 4: 3, 5: 4, 6: 5, 7: 6 });
const NUMBER_WORDS = Object.freeze({ mot: 1, hai: 2, ba: 3, bon: 4, nam: 5, sau: 6, bay: 7, tam: 8, chin: 9, muoi: 10 });

const pad = n => String(n).padStart(2, '0');
const isoOf = ms => new Date(ms).toISOString().slice(0, 10);
const vnWeekday = ms => { const w = new Date(ms).getUTCDay(); return w === 0 ? 7 : w; };
const dayOf = (y, m, d) => {
  const ms = Date.UTC(y, m - 1, d);
  const t = new Date(ms);
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d ? ms : null;
};
const lastDayOfMonth = (y, m) => Date.UTC(y, m, 0);

/** Ngày hôm nay theo giờ Việt Nam, dạng mốc 00:00 UTC của ngày đó (để cộng trừ ngày không lệch múi giờ). */
export function vnTodayMs(nowMs) {
  const t = new Date(nowMs + VN_OFFSET);
  return Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate());
}

/** "thứ Sáu 30/10/2026" (Chủ nhật viết hoa đầu như web). */
export function vnDateLabel(isoDate) {
  const [y, m, d] = isoDate.split('-').map(Number);
  const ms = Date.UTC(y, m - 1, d);
  return `${WEEKDAY_NAMES[new Date(ms).getUTCDay()]} ${pad(d)}/${pad(m)}/${y}`;
}

// Bỏ dấu, chữ thường, gom khoảng trắng; giữ chữ số và / : - . để đọc ngày giờ.
export function foldVn(text) {
  return String(text).normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[đĐ]/g, 'd').toLowerCase()
    .replace(/[^a-z0-9/:.\-\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

// Giờ trong cụm: "9h", "9 giờ sáng", "14h30", "2 giờ chiều", "14:30", "7 giờ tối". Trả {time, rest} (rest = cụm đã bỏ phần giờ) hoặc
// {error} khi giờ sai (25h…). "tối" chỉ là buổi khi đứng ngay sau giờ ("7h tối"); "thứ sáu tới" vẫn là "tới".
function takeTime(folded) {
  const m = folded.match(/\b(\d{1,2})(?:\s*(?:h|g|gio)\s*(\d{1,2})?|:(\d{2}))(?:\s*(sang|trua|chieu|toi|dem))?\b/);
  if (!m) return { time: null, rest: folded };
  let hour = Number(m[1]); const minute = Number(m[2] ?? m[3] ?? 0); const part = m[4];
  if ((part === 'chieu' || part === 'toi') && hour < 12) hour += 12;
  if (part === 'dem' && hour >= 6 && hour < 12) hour += 12;
  if (part === 'trua' && hour < 6) hour += 12;
  if (hour > 23 || minute > 59) return { error: true };
  return { time: `${pad(hour)}:${pad(minute)}`, rest: (folded.slice(0, m.index) + ' ' + folded.slice(m.index + m[0].length)).replace(/\s+/g, ' ').trim() };
}

// Ngày dd/mm(/yyyy) không năm: năm hiện tại; lùi/tiến một năm chỉ khi cách hôm nay hơn 60 ngày theo hướng ngược ngữ cảnh
// (hạn việc "05/01" nói vào tháng 12 ⇒ năm sau; ngày trả phòng "28/12" nói vào tháng 1 ⇒ năm trước). Còn lại giữ nguyên để
// máy chủ kiểm khoảng ngày như cũ (date_out_of_range / return_date_future).
function explicitDate(rest, today, direction) {
  const m = rest.match(/\b(\d{1,2})\s*[/.\-]\s*(\d{1,2})(?:\s*[/.\-]\s*(\d{4}|\d{2}))?\b/);
  if (!m) return undefined;
  const d = Number(m[1]), mo = Number(m[2]);
  const ty = new Date(today).getUTCFullYear();
  if (m[3]) { const y = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]); return dayOf(y, mo, d); }
  let ms = dayOf(ty, mo, d);
  if (ms === null) return null;
  if (direction === 'future' && ms < today - 60 * DAY) ms = dayOf(ty + 1, mo, d);
  if (direction === 'past' && ms > today + 60 * DAY) ms = dayOf(ty - 1, mo, d);
  return ms;
}

function weekdayDate(rest, today, direction) {
  const m = rest.match(/\b(?:thu\s+(hai|ba|tu|nam|sau|bay|[2-7])|(chu\s*nhat|cn))\b(?:\s+(tuan\s+nay|tuan\s+sau\s+nua|tuan\s+sau|tuan\s+toi|tuan\s+truoc|toi|nay))?/);
  if (!m) return undefined;
  const target = m[2] ? 7 : WEEKDAY_WORDS[m[1]];
  // Cụm tuần đứng trước thứ ("tuần trước thứ hai", "tuần sau thứ sáu") cũng tính — người dùng hay nói đảo trật tự.
  const before = m[3] ? null : rest.match(/\btuan\s+(nay|sau\s+nua|sau|toi|truoc)\b/);
  const mod = (m[3] ?? (before ? `tuan ${before[1]}` : '')).replace(/\s+/g, ' ');
  const now = vnWeekday(today);
  const monday = today - (now - 1) * DAY;
  if (mod === 'tuan nay' || mod === 'nay') return monday + (target - 1) * DAY;
  if (mod === 'tuan sau' || mod === 'tuan toi') return monday + 7 * DAY + (target - 1) * DAY;
  if (mod === 'tuan sau nua') return monday + 14 * DAY + (target - 1) * DAY;
  if (mod === 'tuan truoc') return monday - 7 * DAY + (target - 1) * DAY;
  // "thứ X" trần hoặc "thứ X tới": hạn / báo trả ⇒ lần gần nhất SAU hôm nay; ngày đã xảy ra (trả phòng) ⇒ lần gần nhất tới hôm nay.
  if (direction === 'past' && mod !== 'toi') return today - ((now - target + 7) % 7) * DAY;
  return today + (((target - now + 7) % 7) || 7) * DAY;
}

function namedDate(rest, today, direction) {
  const ty = new Date(today).getUTCFullYear(), tm = new Date(today).getUTCMonth() + 1;
  const now = vnWeekday(today), monday = today - (now - 1) * DAY;
  let m;
  if (/\bhom nay\b|\bngay hom nay\b|^nay$|\b(sang|trua|chieu|toi|dem) nay\b/.test(rest)) return today;
  if (/\bhom qua\b/.test(rest)) return today - DAY;
  if (/\bhom kia\b/.test(rest)) return today - 2 * DAY;
  if (/\b(ngay mot|mot|ngay kia)\b/.test(rest)) return today + 2 * DAY;
  if (/\b(ngay mai|mai)\b/.test(rest)) return today + DAY;
  if ((m = rest.match(/\b(\d{1,3}) ngay (nua|toi|sau)\b/))) return today + Number(m[1]) * DAY;
  if ((m = rest.match(/\b(\d{1,3}) ngay truoc\b/))) return today - Number(m[1]) * DAY;
  if ((m = rest.match(/\b(\d{1,2}) tuan (nua|toi|sau)\b/))) return today + 7 * Number(m[1]) * DAY;
  if (/\bcuoi tuan (sau|toi)\b/.test(rest)) return monday + 13 * DAY;
  if (/\bcuoi tuan\b/.test(rest)) return monday + 6 * DAY;
  if (/\bdau tuan (sau|toi)\b/.test(rest)) return monday + 7 * DAY;
  if (/\bcuoi thang (sau|toi)\b/.test(rest)) return lastDayOfMonth(tm === 12 ? ty + 1 : ty, tm === 12 ? 1 : tm + 1);
  if (/\bcuoi thang (truoc)\b/.test(rest)) return lastDayOfMonth(tm === 1 ? ty - 1 : ty, tm === 1 ? 12 : tm - 1);
  if (/\bcuoi thang\b/.test(rest)) return lastDayOfMonth(ty, tm);
  if (/\bdau thang (sau|toi)\b/.test(rest)) return Date.UTC(tm === 12 ? ty + 1 : ty, tm === 12 ? 0 : tm, 1);
  if (/\bgiua thang\b/.test(rest)) return Date.UTC(ty, tm - 1, 15);
  if ((m = rest.match(/\bngay (\d{1,2})\b/))) {
    let ms = dayOf(ty, tm, Number(m[1]));
    if (ms === null) return null;
    if (direction === 'future' && ms < today) ms = dayOf(tm === 12 ? ty + 1 : ty, tm === 12 ? 1 : tm + 1, Number(m[1]));
    if (direction === 'past' && ms > today) ms = dayOf(tm === 1 ? ty - 1 : ty, tm === 1 ? 12 : tm - 1, Number(m[1]));
    return ms;
  }
  return undefined;
}

/**
 * Quy đổi cụm ngày. direction: 'future' (hạn việc, ngày báo trả) | 'past' (ngày khách đã dọn đi).
 * Kết quả: { kind: 'date', date: 'YYYY-MM-DD', time: 'HH:MM' | null, label } hoặc { kind: 'unknown' } (không hiểu / mâu thuẫn ⇒ hỏi lại).
 */
export function resolveVnDatePhrase(phrase, nowMs, { direction = 'future' } = {}) {
  if (typeof phrase !== 'string' || !phrase.trim() || phrase.length > 120 || !Number.isFinite(nowMs)) return { kind: 'unknown' };
  const folded = foldVn(phrase);
  // Hai lựa chọn trong một cụm ("mai hoặc mốt") ⇒ không chọn thay người dùng.
  if (/\b(hoac|hay la)\b/.test(folded)) return { kind: 'unknown' };
  const timed = takeTime(folded);
  if (timed.error) return { kind: 'unknown' };
  // Số viết bằng chữ trước "ngày/tuần" ("một ngày nữa", "hai tuần nữa") ⇒ chữ số, để "một" không bị đọc thành "mốt"; "thứ hai tuần
  // sau" thành "thu 2 tuan sau" vẫn là thứ Hai (WEEKDAY_WORDS nhận cả chữ số).
  timed.rest = timed.rest.replace(/\b(mot|hai|ba|bon|nam|sau|bay|tam|chin|muoi)\s+(ngay|tuan)\b/g, (_, word, unit) => `${NUMBER_WORDS[word]} ${unit}`);
  const today = vnTodayMs(nowMs);
  const explicit = explicitDate(timed.rest, today, direction);
  const weekday = weekdayDate(timed.rest, today, direction);
  const named = explicit === undefined && weekday === undefined ? namedDate(timed.rest, today, direction) : undefined;
  if (explicit === null || named === null) return { kind: 'unknown' };
  // Có cả ngày cụ thể lẫn thứ ("thứ sáu 30/10"): phải trùng nhau, lệch ⇒ hỏi lại.
  if (explicit !== undefined && weekday !== undefined && vnWeekday(explicit) !== vnWeekday(weekday)) return { kind: 'unknown' };
  const ms = explicit ?? weekday ?? named;
  if (ms === undefined) return { kind: 'unknown' };
  const date = isoOf(ms);
  return { kind: 'date', date, time: timed.time, label: vnDateLabel(date) };
}

// Thao tác nào có cụm ngày nào: phrase (tham số mới, nguyên văn) ⇒ date (+ time) mà SQL nhận. Cụm KHÔNG gửi xuống SQL.
export const DATE_PHRASE_FIELDS = Object.freeze({
  'task.create': Object.freeze([{ phrase: 'deadlinePhrase', date: 'deadline', time: 'deadlineTime', direction: 'future' }]),
  'task.update': Object.freeze([{ phrase: 'deadlinePhrase', date: 'deadline', time: 'deadlineTime', direction: 'future' }]),
  'task.create_batch': Object.freeze([{ phrase: 'deadlinePhrase', date: 'deadline', time: 'deadlineTime', direction: 'future', items: true }]),
  'contract.return': Object.freeze([{ phrase: 'datePhrase', date: 'date', time: null, direction: 'past' }]),
  'contract.notice_set': Object.freeze([{ phrase: 'datePhrase', date: 'date', time: null, direction: 'future' }]),
});

function applyOne(record, spec, nowMs, prefix) {
  if (!Object.hasOwn(record, spec.phrase)) return { record, note: null, unclear: null };
  const said = record[spec.phrase];
  const out = { ...record }; delete out[spec.phrase];
  const r = resolveVnDatePhrase(said, nowMs, { direction: spec.direction });
  if (r.kind !== 'date') return { record: out, note: null, unclear: said };
  const sent = typeof record[spec.date] === 'string' ? record[spec.date] : null;
  out[spec.date] = r.date;
  if (spec.time && r.time) out[spec.time] = r.time;
  const clock = spec.time && r.time ? ` lúc ${r.time}` : '';
  const differs = sent && sent !== r.date ? ` (không phải ${vnDateLabel(sent)} như đã tính)` : '';
  const note = `${prefix}Hiểu "${said}" là ${r.label}${clock}${differs}; đọc lại ngày này cho người dùng.`;
  return { record: out, note: note.length <= 300 ? note : `${prefix}Hiểu hạn là ${r.label}${clock}.`, unclear: null };
}

/**
 * Áp cụm ngày cho params ĐÃ kiểm khuôn của một thao tác. Trả { params (để gửi SQL, không còn cụm), notes (≤ 10 câu, mỗi câu ≤ 300 ký tự),
 * unclear (cụm không hiểu — hỏi lại người dùng) }. Thao tác không có cụm ⇒ params giữ nguyên, notes rỗng.
 */
export function applyDatePhrases(actionId, params, nowMs) {
  const specs = DATE_PHRASE_FIELDS[actionId];
  if (!specs || params === null || typeof params !== 'object') return { params, notes: [], unclear: null };
  let result = { ...params }; const notes = [];
  for (const spec of specs) {
    const top = applyOne(result, spec, nowMs, '');
    if (top.unclear !== null) return { params: result, notes, unclear: top.unclear };
    result = top.record; if (top.note) notes.push(top.note);
    if (spec.items && Array.isArray(result.items)) {
      const items = [];
      for (const [index, item] of result.items.entries()) {
        const one = applyOne(item, spec, nowMs, `Mục #${index + 1}: `);
        if (one.unclear !== null) return { params: result, notes, unclear: one.unclear };
        items.push(one.record); if (one.note) notes.push(one.note);
      }
      result.items = items;
    }
  }
  return { params: result, notes: notes.slice(0, 10), unclear: null };
}
