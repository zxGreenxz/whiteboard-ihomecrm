import { describe, expect, it } from 'vitest';
import { parsePublicInvoice } from '../publicInvoicePayload';
describe('public invoice response', () => {
  it('accepts unavailable links and a verified no-invoice result', () => {
    expect(parsePublicInvoice(null)).toBeNull();
    expect(parsePublicInvoice({invoice: null, room: null, building: null})).toEqual({invoice: null, room: null, building: null});
  });
  it.each([{}, {invoice: {}}, {invoice: {id: 'i', items: null}, room: null, building: null}])('rejects malformed data instead of displaying no invoice or zero money', input => {
    expect(() => parsePublicInvoice(input)).toThrow();
  });
});
