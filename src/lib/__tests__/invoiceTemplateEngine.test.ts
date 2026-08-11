import { describe, it, expect } from 'vitest';
import {
  formatCurrencyVND,
  numberToVietnameseWords,
  renderInvoiceTemplate,
  type InvoiceTemplateData,
} from '../invoiceTemplateEngine';

// =============================================
// formatCurrencyVND
// =============================================

describe('formatCurrencyVND', () => {
  it('formats zero', () => {
    expect(formatCurrencyVND(0)).toBe('0');
  });

  it('formats small numbers without dots', () => {
    expect(formatCurrencyVND(1)).toBe('1');
    expect(formatCurrencyVND(999)).toBe('999');
  });

  it('formats thousands with dot separator', () => {
    expect(formatCurrencyVND(1000)).toBe('1.000');
    expect(formatCurrencyVND(10000)).toBe('10.000');
    expect(formatCurrencyVND(100000)).toBe('100.000');
  });

  it('formats millions', () => {
    expect(formatCurrencyVND(1000000)).toBe('1.000.000');
    expect(formatCurrencyVND(1500000)).toBe('1.500.000');
  });

  it('formats large numbers', () => {
    expect(formatCurrencyVND(999999999)).toBe('999.999.999');
  });

  it('handles negative numbers', () => {
    expect(formatCurrencyVND(-1500)).toBe('-1.500');
    expect(formatCurrencyVND(-1000000)).toBe('-1.000.000');
  });

  it('rounds decimals', () => {
    expect(formatCurrencyVND(1000.7)).toBe('1.001');
    expect(formatCurrencyVND(1000.3)).toBe('1.000');
  });
});

// =============================================
// numberToVietnameseWords
// =============================================

describe('numberToVietnameseWords', () => {
  it('converts 0', () => {
    expect(numberToVietnameseWords(0)).toBe('không đồng');
  });

  it('converts single digits', () => {
    expect(numberToVietnameseWords(1)).toBe('một đồng');
    expect(numberToVietnameseWords(5)).toBe('năm đồng');
  });

  it('converts tens', () => {
    expect(numberToVietnameseWords(10)).toBe('mười đồng');
    expect(numberToVietnameseWords(11)).toBe('mười một đồng');
    expect(numberToVietnameseWords(15)).toBe('mười lăm đồng');
    expect(numberToVietnameseWords(21)).toBe('hai mươi mốt đồng');
    expect(numberToVietnameseWords(24)).toBe('hai mươi tư đồng');
    expect(numberToVietnameseWords(25)).toBe('hai mươi lăm đồng');
  });

  it('converts hundreds', () => {
    expect(numberToVietnameseWords(100)).toBe('một trăm đồng');
    expect(numberToVietnameseWords(101)).toBe('một trăm lẻ một đồng');
    expect(numberToVietnameseWords(110)).toBe('một trăm mười đồng');
    expect(numberToVietnameseWords(999)).toBe('chín trăm chín mươi chín đồng');
  });

  it('converts thousands', () => {
    expect(numberToVietnameseWords(1000)).toBe('một nghìn đồng');
    expect(numberToVietnameseWords(1001)).toBe('một nghìn không trăm lẻ một đồng');
    expect(numberToVietnameseWords(10000)).toBe('mười nghìn đồng');
    expect(numberToVietnameseWords(100000)).toBe('một trăm nghìn đồng');
  });

  it('converts millions', () => {
    expect(numberToVietnameseWords(1000000)).toBe('một triệu đồng');
    expect(numberToVietnameseWords(1500000)).toBe('một triệu năm trăm nghìn đồng');
  });

  it('converts billions', () => {
    expect(numberToVietnameseWords(1000000000)).toBe('một tỷ đồng');
    expect(numberToVietnameseWords(2000000000)).toBe('hai tỷ đồng');
  });

  it('converts complex numbers', () => {
    expect(numberToVietnameseWords(1234567)).toBe(
      'một triệu hai trăm ba mươi tư nghìn năm trăm sáu mươi bảy đồng'
    );
  });
});

// =============================================
// renderInvoiceTemplate
// =============================================

describe('renderInvoiceTemplate', () => {
  const baseData: InvoiceTemplateData = {
    APARTMENT_NAME: 'Toà nhà A',
    ROOM_NAME: 'Phòng 101',
    CONTRACT_NAME: 'Nguyễn Văn A',
    INVOICE_CODE: 'INV-001',
    ISSUE_DATE: '01/06/2025',
    DUE_DATE: '06/06/2025',
    SUBTOTAL: '5.000.000',
    DISCOUNT_WITH_PROMOTION: '0',
    DEBT: '0',
    TOTAL_WITH_DEBT: '5.000.000',
    PAID: '0',
    REMAIN: '5.000.000',
    AMOUNT_IN_WORDS_WITH_DEBT: 'năm triệu đồng',
    NOTE: 'Thanh toán trước hạn',
    FEES: [
      { index: 1, name: 'Tiền phòng', price: '3.000.000', quantity: '1', coefficient: '1', total: '3.000.000' },
      { index: 2, name: 'Điện', price: '4.000', quantity: '100', coefficient: '1', total: '400.000' },
    ],
  };

  it('replaces simple placeholders', () => {
    const template = 'Toà nhà: {APARTMENT_NAME}, Phòng: {ROOM_NAME}';
    const result = renderInvoiceTemplate(template, baseData);
    expect(result).toBe('Toà nhà: Toà nhà A, Phòng: Phòng 101');
  });

  it('replaces all known placeholders', () => {
    const template = '{INVOICE_CODE} - {CONTRACT_NAME} - {ISSUE_DATE} - {DUE_DATE}';
    const result = renderInvoiceTemplate(template, baseData);
    expect(result).toBe('INV-001 - Nguyễn Văn A - 01/06/2025 - 06/06/2025');
  });

  it('replaces unknown placeholders with empty string', () => {
    const template = 'Value: {UNKNOWN_FIELD}';
    const result = renderInvoiceTemplate(template, baseData);
    expect(result).toBe('Value: ');
  });

  it('renders FEES loop', () => {
    const template = '<table>{#FEES}<tr><td>{index}</td><td>{name}</td><td>{total}</td></tr>{/FEES}</table>';
    const result = renderInvoiceTemplate(template, baseData);
    expect(result).toBe(
      '<table><tr><td>1</td><td>Tiền phòng</td><td>3.000.000</td></tr>' +
      '<tr><td>2</td><td>Điện</td><td>400.000</td></tr></table>'
    );
  });

  it('renders empty FEES loop as empty string', () => {
    const template = '<table>{#FEES}<tr>{name}</tr>{/FEES}</table>';
    const data: InvoiceTemplateData = { ...baseData, FEES: [] };
    const result = renderInvoiceTemplate(template, data);
    expect(result).toBe('<table></table>');
  });

  it('replaces logo placeholder with img tag', () => {
    const template = '+++IMAGE LOGO()+++ <h1>Invoice</h1>';
    const data = { ...baseData, LOGO_URL: 'https://example.com/logo.png' };
    const result = renderInvoiceTemplate(template, data);
    expect(result).toBe('<img src="https://example.com/logo.png" alt="Logo" /> <h1>Invoice</h1>');
  });

  it('removes logo placeholder when no LOGO_URL', () => {
    const template = '+++IMAGE LOGO()+++ <h1>Invoice</h1>';
    const result = renderInvoiceTemplate(template, baseData);
    expect(result).toBe(' <h1>Invoice</h1>');
  });

  it('handles template with all features combined', () => {
    const template = '+++IMAGE LOGO()+++ {APARTMENT_NAME} {#FEES}[{name}]{/FEES} {UNKNOWN}';
    const data = { ...baseData, LOGO_URL: 'https://logo.png' };
    const result = renderInvoiceTemplate(template, data);
    expect(result).toBe('<img src="https://logo.png" alt="Logo" /> Toà nhà A [Tiền phòng][Điện] ');
  });

  it('replaces FEES loop fields: price, quantity, coefficient', () => {
    const template = '{#FEES}{price}-{quantity}-{coefficient}\n{/FEES}';
    const result = renderInvoiceTemplate(template, baseData);
    expect(result).toBe('3.000.000-1-1\n4.000-100-1\n');
  });
});
