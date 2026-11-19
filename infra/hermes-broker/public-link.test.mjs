import test from 'node:test';
import assert from 'node:assert/strict';
import { publicLink, withReportPublicLinks, REMINDER_LINK_SENTENCE } from './public-link.mjs';
import { finishDomainResult } from './domain-mount.mjs';

// Lượt 12 Hoá đơn (kiểm khói C3 trên TEST 24/10): crm_read_report invoice_reminders trả publicPath tương đối ⇒ bot tự viết
// "https://<domain>/c/…". Connector ghép link tuyệt đối theo origin host (publicWebOrigin, D-HĐ9) như chi tiết HĐ; mô hình chỉ thấy
// publicLink; tin nhắc nợ kèm link thành một khối; vắng origin ⇒ không link và tin không hứa link.
const ORIGIN = 'https://app.example.vn';
const MESSAGE = 'Chào anh/chị, phòng P101 toà Toà A hiện còn 9.500.000đ chưa thanh toán: tháng 10/2026: 2.500.000đ (hạn 10/10/2026).' +
  `${REMINDER_LINK_SENTENCE} Anh/chị vui lòng thanh toán giúp. Cảm ơn anh/chị!`;
const PLAIN = 'Chào anh/chị, phòng P102 toà Toà A hiện còn 400.000đ chưa thanh toán: tháng 09/2026: 100.000đ (hạn 01/09/2026). ' +
  'Anh/chị vui lòng thanh toán giúp. Cảm ơn anh/chị!';
const row = (roomName, publicPath, messageText) => ({ buildingId: 'b', buildingName: 'Toà A', roomId: 'r', roomName, customerName: null, debtTotal: '1.00',
  invoiceCount: 1, oldestDueDate: null, maxOverdueDays: null, details: 'x', publicPath, messageText });
const reminders = () => ({ report: 'invoice_reminders', source: 'crm.invoice_open_debts_v1', unavailable: null,
  summary: { rooms: 2, debtTotal: '2.00', withLink: 1 }, items: [row('P101', '/c/Ab12Cd', MESSAGE), row('P102', null, PLAIN)],
  offset: 0, nextOffset: null, sourceCapped: false });

test('invoice_reminders: publicPath ⇒ publicLink tuyệt đối tại cùng chỗ trong dòng; tin kèm link xuống dòng ở cuối; dòng không link giữ nguyên tin', () => {
  const value = withReportPublicLinks(reminders(), ORIGIN), [p101, p102] = value.items;
  assert.equal(p101.publicLink, 'https://app.example.vn/c/Ab12Cd');
  assert.equal(Object.hasOwn(p101, 'publicPath'), false, 'mô hình chỉ thấy publicLink');
  assert.deepEqual(Object.keys(p101), Object.keys(row('P101', null, '')).map(key => key === 'publicPath' ? 'publicLink' : key), 'thứ tự trường giữ nguyên');
  assert.equal(p101.messageText, `${MESSAGE}\nhttps://app.example.vn/c/Ab12Cd`, 'một khối chép nguyên văn: câu "link kèm theo" + link ở cuối');
  assert.deepEqual([p102.publicLink, p102.messageText, Object.hasOwn(p102, 'publicPath')], [null, PLAIN, false]);
  assert.deepEqual(value.summary, { rooms: 2, debtTotal: '2.00', withLink: 1 });
  assert.deepEqual(reminders().items[0].publicPath, '/c/Ab12Cd', 'không sửa đầu vào');
});

test('vắng origin hoặc origin sai khuôn ⇒ publicLink null, tin bỏ câu hứa link (không để mô hình tự ghép tên miền), withLink = 0', () => {
  for (const origin of [undefined, null, '', 'http://app.example.vn', 'https://app.example.vn/', 'https://user@app.example.vn', 'app.example.vn']) {
    const value = withReportPublicLinks(reminders(), origin), [p101, p102] = value.items;
    assert.equal(p101.publicLink, null, String(origin));
    assert.equal(p101.messageText, MESSAGE.replace(REMINDER_LINK_SENTENCE, ''), String(origin));
    assert.doesNotMatch(p101.messageText, /link|https?:|\/c\//, String(origin));
    assert.deepEqual([p102.messageText, value.summary.withLink], [PLAIN, 0], String(origin));
  }
});

test('đường sai khuôn ⇒ không link dù origin đúng; báo cáo không có publicPath, unavailable, null giữ nguyên', () => {
  const bad = { ...reminders(), items: [row('P101', '/c/../x', MESSAGE)] };
  const [p101] = withReportPublicLinks(bad, ORIGIN).items;
  assert.deepEqual([p101.publicLink, p101.messageText.includes('link')], [null, false]);
  assert.equal(publicLink(ORIGIN, '/c/Ab12Cd'), 'https://app.example.vn/c/Ab12Cd');
  const debts = { report: 'invoice_room_debts', source: 'crm.invoice_open_debts_v1', unavailable: null, summary: null, items: [{ roomName: 'P101', debtTotal: '1.00' }],
    offset: 0, nextOffset: null, sourceCapped: false };
  assert.equal(withReportPublicLinks(debts, ORIGIN), debts);
  const unavailable = { ...reminders(), unavailable: 'no_building_scope', summary: null, items: [] };
  assert.equal(withReportPublicLinks(unavailable, ORIGIN), unavailable);
  assert.equal(withReportPublicLinks(null, ORIGIN), null);
});

test('đường đọc miền thật (domain-mount finishDomainResult) ghép cả chi tiết HĐ lẫn dòng báo cáo; bỏ một trong hai bước ⇒ đỏ', () => {
  const [p101] = finishDomainResult(reminders(), ORIGIN).items;
  assert.deepEqual([p101.publicLink, Object.hasOwn(p101, 'publicPath'), p101.messageText.endsWith('\nhttps://app.example.vn/c/Ab12Cd')], [
    'https://app.example.vn/c/Ab12Cd', false, true]);
  assert.equal(finishDomainResult(reminders(), undefined).items[0].messageText.includes('link'), false);
  const detail = finishDomainResult({ domain: 'contract_detail', item: { id: 'c', publicPath: '/c/Ab12Cd' } }, ORIGIN);
  assert.deepEqual(detail.item, { id: 'c', publicLink: 'https://app.example.vn/c/Ab12Cd' });
});
