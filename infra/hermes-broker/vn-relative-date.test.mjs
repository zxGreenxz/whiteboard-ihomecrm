import test from 'node:test';
import assert from 'node:assert/strict';
import { applyDatePhrases, foldVn, resolveVnDatePhrase, vnDateLabel, vnTodayMs } from './vn-relative-date.mjs';

// Công việc lượt 15 (nghiệm thu C3h 25/10/2026): bảng vàng quy đổi cụm ngày tiếng Việt. Mốc "hôm nay" theo giờ Việt Nam (UTC+7).
const at = iso => Date.parse(iso);
const SUN = at('2026-10-25T03:00:00Z'); // Chủ nhật 25/10/2026 10:00 giờ VN — ngày của hai ghi sai CV-T12 / HD-T22
const SAT = at('2026-10-24T03:00:00Z'); // thứ Bảy 24/10
const MON = at('2026-10-26T03:00:00Z'); // thứ Hai 26/10
const EOM = at('2026-10-31T03:00:00Z'); // thứ Bảy 31/10 (cuối tháng)
const EOY = at('2026-12-31T03:00:00Z'); // thứ Năm 31/12 (cuối năm)
const LATE = at('2026-10-25T18:30:00Z'); // 26/10 01:30 giờ VN (UTC vẫn là 25/10) ⇒ hôm nay là thứ Hai 26/10
const date = (phrase, now, direction = 'future') => {
  const r = resolveVnDatePhrase(phrase, now, { direction });
  return r.kind === 'date' ? (r.time ? `${r.date} ${r.time}` : r.date) : r.kind;
};

test('giờ Việt Nam và nhãn thứ', () => {
  assert.equal(new Date(vnTodayMs(LATE)).toISOString().slice(0, 10), '2026-10-26');
  assert.equal(vnDateLabel('2026-10-30'), 'thứ Sáu 30/10/2026');
  assert.equal(vnDateLabel('2026-11-01'), 'Chủ nhật 01/11/2026');
  assert.equal(foldVn('Thứ SÁU  tuần   sau!'), 'thu sau tuan sau');
});

test('ghi sai thật của lượt cuối: Chủ nhật 25/10 — tuần bắt đầu thứ Hai', () => {
  assert.equal(date('thứ sáu tuần sau', SUN), '2026-10-30', 'CV-T12: không phải 06/11');
  assert.equal(date('thứ hai tuần trước', SUN, 'past'), '2026-10-12', 'HD-T22: không phải 19/10');
  assert.equal(date('thứ hai tuần trước', SAT, 'past'), '2026-10-12', 'HD-T22 lô đầu chạy thứ Bảy');
  assert.equal(date('tuần trước thứ hai', SUN, 'past'), '2026-10-12', 'đảo trật tự vẫn là thứ Hai tuần trước, không phải thứ Hai gần nhất');
  assert.equal(date('tuần sau, thứ sáu nhé', SUN), '2026-10-30');
});

test('bảng vàng — hôm nay Chủ nhật 25/10/2026', () => {
  const cases = {
    'hôm nay': '2026-10-25', 'mai': '2026-10-26', 'ngày mai': '2026-10-26', 'mốt': '2026-10-27', 'ngày kia': '2026-10-27',
    '3 ngày nữa': '2026-10-28', 'một ngày nữa': '2026-10-26', 'hai tuần nữa': '2026-11-08',
    'thứ hai': '2026-10-26', 'thứ hai tới': '2026-10-26', 'thứ sáu': '2026-10-30', 'thứ 6': '2026-10-30', 'chủ nhật': '2026-11-01',
    'thứ hai tuần này': '2026-10-19', 'thứ sáu tuần này': '2026-10-23', 'chủ nhật tuần này': '2026-10-25',
    'thứ hai tuần sau': '2026-10-26', 'thứ sáu tuần tới': '2026-10-30', 'chủ nhật tuần sau': '2026-11-01', 'thứ ba tuần sau nữa': '2026-11-03',
    'cuối tuần': '2026-10-25', 'cuối tuần sau': '2026-11-01', 'đầu tuần sau': '2026-10-26',
    'cuối tháng': '2026-10-31', 'cuối tháng sau': '2026-11-30', 'đầu tháng sau': '2026-11-01', 'giữa tháng': '2026-10-15',
    '30/10': '2026-10-30', '30-10-2026': '2026-10-30', 'ngày 30/10': '2026-10-30', 'ngày 28': '2026-10-28', 'ngày 3': '2026-11-03',
    'thứ sáu 30/10': '2026-10-30', 'thứ năm ngày 29/10': '2026-10-29',
    '9h sáng mai': '2026-10-26 09:00', '9 giờ sáng mai': '2026-10-26 09:00', 'mai 14h30': '2026-10-26 14:30', '2 giờ chiều thứ sáu': '2026-10-30 14:00',
    '7 giờ tối nay': '2026-10-25 19:00', 'tối nay': '2026-10-25', 'thứ sáu tới 10:15': '2026-10-30 10:15',
    'THU SAU TUAN SAU': '2026-10-30', 'thu 2': '2026-10-26',
  };
  for (const [phrase, want] of Object.entries(cases)) assert.equal(date(phrase, SUN), want, phrase);
});

test('ngày đã xảy ra (trả phòng): "thứ X" trần là lần gần nhất tới hôm nay', () => {
  assert.equal(date('thứ hai', SUN, 'past'), '2026-10-19');
  assert.equal(date('chủ nhật', SUN, 'past'), '2026-10-25');
  assert.equal(date('hôm qua', SUN, 'past'), '2026-10-24');
  assert.equal(date('hôm kia', SUN, 'past'), '2026-10-23');
  assert.equal(date('3 ngày trước', SUN, 'past'), '2026-10-22');
  assert.equal(date('28/12', at('2027-01-05T03:00:00Z'), 'past'), '2026-12-28', 'ngày trả phòng nói đầu năm ⇒ năm trước');
  assert.equal(date('ngày 28', SUN, 'past'), '2026-09-28', '"ngày 28" chưa tới ⇒ tháng trước');
});

test('thứ Bảy, thứ Hai, cuối tháng, cuối năm, gần nửa đêm', () => {
  assert.equal(date('thứ sáu tuần sau', SAT), '2026-10-30');
  assert.equal(date('cuối tuần', SAT), '2026-10-25');
  assert.equal(date('thứ hai', SAT), '2026-10-26');
  assert.equal(date('thứ hai tuần sau', MON), '2026-11-02');
  assert.equal(date('thứ hai', MON), '2026-11-02', 'trần: SAU hôm nay');
  assert.equal(date('thứ hai tuần này', MON), '2026-10-26');
  assert.equal(date('cuối tháng', EOM), '2026-10-31');
  assert.equal(date('mai', EOM), '2026-11-01');
  assert.equal(date('cuối tháng sau', EOY), '2027-01-31');
  assert.equal(date('đầu tháng sau', EOY), '2027-01-01');
  assert.equal(date('05/01', EOY), '2027-01-05', 'hạn đầu năm nói cuối năm ⇒ năm sau');
  assert.equal(date('thứ sáu tuần sau', EOY), '2027-01-08');
  assert.equal(date('mai', LATE), '2026-10-27', 'giờ VN đã sang thứ Hai 26/10');
  assert.equal(date('thứ sáu tuần sau', LATE), '2026-11-06', 'hôm nay (giờ VN) là thứ Hai 26/10 ⇒ tuần sau là 02–08/11');
});

test('không hiểu / mâu thuẫn ⇒ unknown (hỏi lại, không đoán)', () => {
  for (const phrase of ['tuần sau', 'sớm nhất có thể', 'mai hoặc mốt', 'thứ sáu 31/10', '32/10', '30/13', '25h', 'thứ tám', '', '   '])
    assert.equal(date(phrase, SUN), 'unknown', JSON.stringify(phrase));
  assert.equal(resolveVnDatePhrase('x'.repeat(121), SUN).kind, 'unknown');
  assert.equal(resolveVnDatePhrase(null, SUN).kind, 'unknown');
});

test('đột biến: tuần bắt đầu Chủ nhật (kiểu Mỹ) làm sai đúng ca ghi sai ⇒ bảng vàng bắt được', () => {
  // Đúng thứ mô hình đã tính: coi Chủ nhật 25/10 là đầu tuần mới ⇒ "tuần sau" = 01–07/11 ⇒ thứ Sáu 06/11.
  const sundayStart = phrase => { const today = vnTodayMs(SUN); const sunday = today - new Date(today).getUTCDay() * 86_400_000;
    return phrase === 'thứ sáu tuần sau' ? new Date(sunday + 7 * 86_400_000 + 5 * 86_400_000).toISOString().slice(0, 10) : null; };
  assert.equal(sundayStart('thứ sáu tuần sau'), '2026-11-06');
  assert.notEqual(date('thứ sáu tuần sau', SUN), sundayStart('thứ sáu tuần sau'));
});

test('applyDatePhrases: ghi đè ngày bot tính, bỏ cụm trước khi gửi SQL, nêu câu đọc lại; lô theo từng mục', () => {
  const created = applyDatePhrases('task.create', { content: 'Trang trí lại sảnh', deadline: '2026-11-06', deadlinePhrase: 'thứ sáu tuần sau' }, SUN);
  assert.deepEqual(created.params, { content: 'Trang trí lại sảnh', deadline: '2026-10-30' });
  assert.equal(created.unclear, null);
  assert.equal(created.notes.length, 1);
  assert.match(created.notes[0], /^Hiểu "thứ sáu tuần sau" là thứ Sáu 30\/10\/2026 \(không phải thứ Sáu 06\/11\/2026 như đã tính\)/);
  const timed = applyDatePhrases('task.create', { content: 'Mua ổ khoá', deadlinePhrase: '9 giờ sáng mai' }, SUN);
  assert.deepEqual(timed.params, { content: 'Mua ổ khoá', deadline: '2026-10-26', deadlineTime: '09:00' });
  const ret = applyDatePhrases('contract.return', { buildingName: '950', roomName: 'MADRID 3', date: '2026-10-19', datePhrase: 'thứ hai tuần trước', note: 'x' }, SUN);
  assert.equal(ret.params.date, '2026-10-12');
  assert.ok(!Object.hasOwn(ret.params, 'datePhrase'));
  const batch = applyDatePhrases('task.create_batch', { deadlinePhrase: 'cuối tháng', items: [{ roomName: '101' }, { roomName: '102', deadlinePhrase: 'mai' }] }, SUN);
  assert.deepEqual(batch.params, { deadline: '2026-10-31', items: [{ roomName: '101' }, { roomName: '102', deadline: '2026-10-26' }] });
  assert.equal(batch.notes.length, 2);
  assert.match(batch.notes[1], /^Mục #2: Hiểu "mai" là thứ Hai 26\/10\/2026/);
  const unclear = applyDatePhrases('task.update', { job: 'JOB-1', deadlinePhrase: 'sớm nhất có thể' }, SUN);
  assert.equal(unclear.unclear, 'sớm nhất có thể');
  const none = { content: 'x', deadline: '2026-10-30' };
  assert.equal(applyDatePhrases('task.create', none, SUN).params.deadline, '2026-10-30');
  assert.deepEqual(applyDatePhrases('expense.create', { items: [] }, SUN).notes, []);
});

// C3l (nghiệm thu C3d TC-A04 "Thứ hai tuần trước anh có chi 2 củ sơn lại tường… ghi bù"): ngày phiếu chi là ngày ĐÃ xảy ra ⇒ hướng quá khứ,
// ghi đè voucherDate từng mục (expense.create) và của phiếu (expense.edit); cụm không xuống SQL.
test('expense.create / expense.edit: voucherDatePhrase hướng quá khứ ghi đè voucherDate', () => {
  const one = (now, phrase) => applyDatePhrases('expense.create', { items: [{ content: 'sơn lại tường', voucherDate: '2026-10-01', voucherDatePhrase: phrase }] }, now);
  for (const [now, phrase, want] of [[SUN, 'thứ hai tuần trước', '2026-10-12'], [MON, 'thứ hai tuần trước', '2026-10-19'], [MON, 'hôm qua', '2026-10-25'],
    [MON, 'cuối tháng trước', '2026-09-30'], [MON, 'thứ sáu', '2026-10-23'], [MON, 'hôm kia', '2026-10-24']]) {
    const r = one(now, phrase);
    assert.equal(r.params.items[0].voucherDate, want, phrase);
    assert.ok(!Object.hasOwn(r.params.items[0], 'voucherDatePhrase'));
    assert.match(r.notes[0], /^Mục #1: Hiểu "/);
  }
  assert.equal(one(MON, 'sớm nhất có thể').unclear, 'sớm nhất có thể');
  assert.deepEqual(applyDatePhrases('expense.edit', { voucherCode: 'PC2610001', voucherDatePhrase: 'hôm qua' }, MON).params,
    { voucherCode: 'PC2610001', voucherDate: '2026-10-25' });
});
