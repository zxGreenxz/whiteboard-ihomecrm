// R2e: kết quả công cụ đổi mốc giờ UTC sang giờ Việt Nam (+07:00) trước khi tới mô hình (vietnam-time.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { toVietnamTime, vietnamTimes, vietnamToolResult } from './vietnam-time.mjs';

test('hạn việc 23:59 giờ VN giữ đúng ngày (ca thật full50e câu 66)', () => {
  assert.equal(toVietnamTime('2026-10-08T16:59:59.999+00:00'), '2026-10-08T23:59:59.999+07:00');
  assert.equal(toVietnamTime('2026-10-11T16:59:59Z'), '2026-10-11T23:59:59+07:00');
});

test('qua nửa đêm UTC+7 thì sang ngày sau, cuối tháng và cuối năm cuộn đúng', () => {
  assert.equal(toVietnamTime('2026-10-31T17:00:00Z'), '2026-11-01T00:00:00+07:00');
  assert.equal(toVietnamTime('2026-12-31T20:30:00.5Z'), '2027-01-01T03:30:00.5+07:00');
  assert.equal(toVietnamTime('2028-02-28T18:00:00+00:00'), '2028-02-29T01:00:00+07:00');
});

test('các đuôi UTC khác nhau và dấu cách thay chữ T đều nhận; micro giây giữ nguyên phần lẻ', () => {
  assert.equal(toVietnamTime('2026-10-21 07:45:25.123456+00'), '2026-10-21T14:45:25.123456+07:00');
  assert.equal(toVietnamTime('2026-10-21T07:45:25+0000'), '2026-10-21T14:45:25+07:00');
  assert.equal(toVietnamTime('2026-10-21T07:45Z'), '2026-10-21T14:45:00+07:00');
});

test('không đổi: ngày thuần, múi giờ khác, chuỗi thường, mốc sai lịch, kiểu khác chuỗi', () => {
  for (const value of ['2026-10-21', '2026-10-21T14:45:25+07:00', '2026-10-21T07:45:25-05:00', 'HĐT-094334/14032026',
    'PC2610045', '', '2026-02-30T10:00:00Z', '2026-10-21T25:00:00Z', 'đã thanh toán 2026-10-21T07:45:25Z',
    `${'x'.repeat(41)}`]) {
    assert.equal(toVietnamTime(value), value, value);
  }
  for (const value of [null, 42, true, undefined]) assert.equal(toVietnamTime(value), value);
});

test('duyệt sâu: đổi trong items/summary lồng nhau, giữ nguyên con trỏ phân trang', () => {
  const input = {
    nextCursor: '2026-10-21T07:45:25Z', fetchedAt: '2026-10-21T07:45:25.784Z',
    summary: { count: 2, overdue: 1, latest: { createdAt: '2026-04-26T07:12:31.659Z', name: 'Ấm Đun' } },
    items: [{ id: '0e351f48-5cd7-4e8f-81bc-1fcc80d9d974', deadline: '2026-10-08T16:59:59.999+00:00', voucherDate: '2026-10-15',
      tags: ['2026-10-01T00:00:00Z', 'giữ nguyên'], nested: { cursor: '2026-10-01T00:00:00Z' } }],
  };
  const out = vietnamTimes(input);
  assert.equal(out.nextCursor, input.nextCursor);
  assert.equal(out.items[0].nested.cursor, '2026-10-01T00:00:00Z');
  assert.equal(out.fetchedAt, '2026-10-21T14:45:25.784+07:00');
  assert.equal(out.summary.latest.createdAt, '2026-04-26T14:12:31.659+07:00');
  assert.equal(out.items[0].deadline, '2026-10-08T23:59:59.999+07:00');
  assert.equal(out.items[0].voucherDate, '2026-10-15');
  assert.deepEqual(out.items[0].tags, ['2026-10-01T07:00:00+07:00', 'giữ nguyên']);
  assert.equal(input.items[0].deadline, '2026-10-08T16:59:59.999+00:00', 'không sửa đối tượng gốc');
});

test('kết quả MCP: chỉ khối text là JSON bị đổi; khối khác và kết quả không có mốc giữ nguyên đối tượng', () => {
  const plain = { content: [{ type: 'text', text: JSON.stringify({ count: 3 }) }], isError: false };
  assert.equal(vietnamToolResult(plain), plain);
  const notJson = { content: [{ type: 'text', text: 'không phải JSON 2026-10-21T07:45:25Z' }], isError: false };
  assert.equal(vietnamToolResult(notJson), notJson);
  const withTime = { content: [{ type: 'text', text: JSON.stringify({ items: [{ deadline: '2026-10-11T16:59:59.999+00:00' }] }) },
    { type: 'image', data: 'AAAA', mimeType: 'image/png' }], isError: false };
  const out = vietnamToolResult(withTime);
  assert.notEqual(out, withTime);
  assert.deepEqual(JSON.parse(out.content[0].text), { items: [{ deadline: '2026-10-11T23:59:59.999+07:00' }] });
  assert.equal(out.content[1], withTime.content[1]);
  assert.equal(out.isError, false);
  for (const value of [null, undefined, {}, { content: 'x' }]) assert.equal(vietnamToolResult(value), value);
});

test('lồng quá sâu thì dừng đổi ở nhánh đó, không ném lỗi', () => {
  let deep = { at: '2026-10-21T07:45:25Z' };
  for (let i = 0; i < 80; i += 1) deep = { child: deep };
  const out = vietnamTimes(deep);
  let node = out;
  for (let i = 0; i < 80; i += 1) node = node.child;
  assert.equal(node.at, '2026-10-21T07:45:25Z');
});
