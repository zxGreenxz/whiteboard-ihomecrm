import { describe, expect, it, vi } from 'vitest';
import { parseEmailBill } from '../parser';

// Synthetic examples for conservative parsing, not vendor email samples.
const encode = (text: string) => Buffer.from(text).toString('base64url');
function message(text: string, from = 'Grab <receipts@grab.com>', subject = 'Payment receipt') {
  return { id: 'message-1', payload: { mimeType: 'text/plain', headers: [
    { name: 'From', value: from }, { name: 'Subject', value: subject },
  ], body: { data: encode(text) } } };
}
const receipt = 'Receipt ID: GRAB-12345\nPayment completed\nDate: 2026-10-04\nSubtotal: 75.000đ\nTotal: 85.000đ';

describe('parseEmailBill', () => {
  it('reads separate table label/value lines without colons', () => {
    const input = message('');
    input.payload.mimeType = 'text/html';
    input.payload.body.data = encode('<p>Payment completed</p><table><tr><td>Booking ID</td><td>GRAB-12345</td></tr><tr><td>Date</td><td>2026-10-04</td></tr><tr><td>Total Paid</td><td>85.000đ</td></tr></table>');
    expect(parseEmailBill(input, 'fixture@example.test')).toMatchObject({ amount: 85000, date: '2026-10-04', blocked: false, source: { receipt_id: 'GRAB-12345' } });
  });
  it('uses explicit VND total rather than subtotal', () => {
    expect(parseEmailBill(message(receipt), 'fixture@example.test')).toMatchObject({
      amount: 85000, date: '2026-10-04', blocked: false,
      source: { provider: 'grab', receipt_id: 'GRAB-12345', message_id: 'message-1' },
    });
  });
  it('keeps the receipt identity across message IDs and subject changes', () => {
    const copy = { ...message(receipt, undefined, 'Resent receipt'), id: 'message-2' };
    expect(parseEmailBill(copy, 'fixture@example.test')?.source.receipt_id).toBe('GRAB-12345');
  });
  it.each(['receipts@grab.com.evil.test', 'Grab <receipts@evil.test>', 'a@grab.com, b@evil.test'])('rejects untrusted From %s', (from) => {
    expect(parseEmailBill(message(receipt, from), 'fixture@example.test')).toBeNull();
  });
  it.each([
    ['Total: 85.000đ\nTotal: 90.000đ', null],
    ['Subtotal: 85.000đ', null],
    ['Total: 85.50 VND', null],
    ['Total: 85.000 USD', null],
    ['Total: -85.000đ', null],
    ['Total: 85.000đ (includes fees)', null],
  ])('blocks uncertain amount %s', (total, want) => {
    const bill = parseEmailBill(message(`Receipt ID: GRAB-12345\nPayment completed\n${total}`), 'fixture@example.test');
    expect(bill?.amount).toBe(want);
    expect(bill?.blocked).toBe(true);
  });
  it('does not invent receipt identity from message ID', () => {
    const bill = parseEmailBill(message('Payment completed\nTotal: 85.000đ'), 'fixture@example.test');
    expect(bill?.source.receipt_id).toBe('');
    expect(bill?.blocked).toBe(true);
  });
  it('blocks conflicting receipt identities', () => {
    expect(parseEmailBill(message(`${receipt}\nReceipt ID: GRAB-54321`), 'fixture@example.test')?.blocked).toBe(true);
  });
  it.each(['Đã hủy', 'Refund successful', 'Hoàn tiền', 'Order confirmation', 'Payment pending', 'Amount due'])('blocks status %s', (status) => {
    expect(parseEmailBill(message(`${receipt}\n${status}`), 'fixture@example.test')?.blocked).toBe(true);
  });
  it('blocks order confirmation even when total and order ID exist', () => {
    expect(parseEmailBill(message('Order ID: SP-12345\nTotal: 85.000đ', 'no-reply@shopee.vn', 'Order confirmation'), 'fixture@example.test')?.blocked).toBe(true);
  });
  it('requires explicit valid date and never uses received timestamp', () => {
    expect(parseEmailBill(message(receipt.replace('2026-10-04', '2026-02-30')), 'fixture@example.test')?.date).toBeNull();
    expect(parseEmailBill(message(receipt.replace('Date: 2026-10-04\n', '')), 'fixture@example.test')?.date).toBeNull();
  });
  it('prefers plain text in multipart alternative without double counting HTML', () => {
    const input = message('');
    input.payload = { ...input.payload, mimeType: 'multipart/alternative', parts: [
      { mimeType: 'text/plain', body: { data: encode(receipt) } },
      { mimeType: 'text/html', body: { data: encode('<p>Total: 999.000đ</p>') } },
    ] } as typeof input.payload;
    expect(parseEmailBill(input, 'fixture@example.test')?.amount).toBe(85000);
  });
  it('extracts inert HTML text without loading images, styles, frames, or scripts', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const input = message('');
    input.payload.mimeType = 'text/html';
    input.payload.body.data = encode('<img src="https://evil.test/pixel"><style>@import "https://evil.test/a";</style><script>throw Error()</script><iframe src="https://evil.test/"></iframe><p>Receipt ID: GRAB-12345</p><p>Payment completed</p><p>Total: 85.000&#273;</p>');
    const bill = parseEmailBill(input, 'fixture@example.test');
    expect(bill?.amount).toBe(85000);
    expect(bill?.text).not.toMatch(/evil\.test|throw|<img/);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
  it('ignores attached text files as bill bodies', () => {
    const input = message('');
    input.payload = { ...input.payload, mimeType: 'multipart/mixed', parts: [
      { mimeType: 'text/plain', body: { data: encode(receipt) } },
      { mimeType: 'text/plain', filename: 'attached.txt', body: { data: encode('Total: 999.000đ') } },
    ] } as typeof input.payload;
    expect(parseEmailBill(input, 'fixture@example.test')?.amount).toBe(85000);
  });
  it('accepts explicit Shopee paid receipt and Vietnamese labels', () => {
    const bill = parseEmailBill(message('Mã đơn hàng: SP-12345\nĐã thanh toán\nNgày thanh toán: 04/10/2026\nTổng thanh toán: 85,000 VND', 'Shopee <receipts@email.shopee.vn>', 'Biên nhận'), 'fixture@example.test');
    expect(bill).toMatchObject({ amount: 85000, date: '2026-10-04', blocked: false, source: { provider: 'shopee', receipt_id: 'SP-12345' } });
  });
  it('rejects mixed grouping separators instead of guessing the decimal convention', () => {
    expect(parseEmailBill(message(receipt.replace('85.000đ', '1.234,567 VND')), 'fixture@example.test')?.amount).toBeNull();
  });
  it('does not treat mere invoice heading as proof of payment', () => {
    expect(parseEmailBill(message('Order ID: SP-12345\nTotal: 85.000đ', 'receipts@shopee.vn', 'Invoice'), 'fixture@example.test')?.blocked).toBe(true);
  });
  it('blocks invalid MIME encoding without crashing', () => {
    const input = message(receipt); input.payload.body.data = 'not base64!';
    expect(parseEmailBill(input, 'fixture@example.test')).toMatchObject({ amount: null, blocked: true });
  });
  it('does not parse forwarded message/rfc822 as a vendor receipt', () => {
    const input = message(receipt); input.payload.mimeType = 'message/rfc822';
    expect(parseEmailBill(input, 'fixture@example.test')?.blocked).toBe(true);
  });
  it('rejects malformed brackets in sender address', () => {
    expect(parseEmailBill(message(receipt, 'Grab <receipts@grab.com'), 'fixture@example.test')).toBeNull();
  });
  it('keeps HTML table label/value pairs readable', () => {
    const input = message(''); input.payload.mimeType = 'text/html';
    input.payload.body.data = encode('<h1>Receipt</h1><table><tr><td>Receipt ID:</td><td>GRAB-12345</td></tr><tr><td>Total:</td><td>85.000đ</td></tr></table>');
    expect(parseEmailBill(input, 'fixture@example.test')?.amount).toBe(85000);
  });
  it.each(['Payment failed', 'Payment unsuccessful', 'Not paid'])('blocks a receipt describing unsuccessful status %s', (status) => {
    expect(parseEmailBill(message(`${receipt}\n${status}`), 'fixture@example.test')?.blocked).toBe(true);
  });
  it('does not infer paid status from the receipt ID label alone', () => {
    expect(parseEmailBill(message('Receipt ID: GRAB-12345\nTotal: 85.000đ', undefined, 'Invoice'), 'fixture@example.test')?.blocked).toBe(true);
  });
  it('does not infer paid status from text saying no receipt has been issued', () => {
    expect(parseEmailBill(message('Receipt ID: GRAB-12345\nNo payment receipt has been issued\nTotal: 85.000đ', undefined, 'Invoice'), 'fixture@example.test')?.blocked).toBe(true);
  });
  it.each([
    'Payment status: To be paid on delivery',
    'Payment status: Will be paid later',
    'Payment method: Cash on delivery',
    'Payment method: COD',
    'Payment status: Partially paid',
    'Payment status: Paid in part',
    'Payment status: Processing',
    'Trạng thái thanh toán: Sẽ thanh toán khi nhận hàng',
    'Phương thức thanh toán: Thanh toán khi nhận hàng',
    'Trạng thái thanh toán: Đã thanh toán một phần',
    'Trạng thái thanh toán: Chưa thanh toán đủ',
    'Trạng thái thanh toán: Dự kiến thanh toán',
  ])('blocks future/COD/partial status regardless of receipt title: %s', (status) => {
    const text = `Order ID: SP-12345\nDate: 2026-10-04\n${status}\nTotal: 85.000đ`;
    expect(parseEmailBill(message(text, 'receipts@shopee.vn', 'Order details'), 'fixture@example.test')?.blocked).toBe(true);
    expect(parseEmailBill(message(text, 'receipts@shopee.vn', 'Payment receipt'), 'fixture@example.test')?.blocked).toBe(true);
  });
  it.each(['Payment status: Paid', 'Payment status: Paid in full', 'Payment status: Completed', 'Trạng thái thanh toán: Đã thanh toán', 'Trạng thái thanh toán: Thanh toán thành công'])('accepts explicit affirmative payment label %s', (status) => {
    const text = `Order ID: SP-12345\nDate: 2026-10-04\n${status}\nTotal: 85.000đ`;
    expect(parseEmailBill(message(text, 'receipts@shopee.vn', 'Order details'), 'fixture@example.test')).toMatchObject({ blocked: false, amount: 85000 });
  });
  it('does not treat incidental paid text as a payment confirmation', () => {
    const text = 'Order ID: SP-12345\nDate: 2026-10-04\nPaid membership benefits\nTotal: 85.000đ';
    expect(parseEmailBill(message(text, 'receipts@shopee.vn', 'Order details'), 'fixture@example.test')?.blocked).toBe(true);
  });
});
