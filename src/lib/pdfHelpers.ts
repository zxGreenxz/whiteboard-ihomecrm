/**
 * PDF Generation Helpers
 * Uses html2pdf.js for generating PDFs from HTML templates
 */

import { format } from 'date-fns';
import { vi } from 'date-fns/locale';

// Format currency in Vietnamese
export function formatCurrency(amount: number): string {
  return new Intl.NumberFormat('vi-VN', {
    style: 'currency',
    currency: 'VND',
  }).format(amount);
}

// Format date in Vietnamese
export function formatDate(date: string | Date): string {
  return format(new Date(date), 'dd/MM/yyyy', { locale: vi });
}

// Format datetime in Vietnamese
export function formatDateTime(date: string | Date): string {
  return format(new Date(date), 'dd/MM/yyyy HH:mm', { locale: vi });
}

// Number to Vietnamese words
export function numberToVietnameseWords(num: number): string {
  const ones = ['', 'một', 'hai', 'ba', 'bốn', 'năm', 'sáu', 'bảy', 'tám', 'chín'];
  const tens = ['', 'mười', 'hai mươi', 'ba mươi', 'bốn mươi', 'năm mươi', 'sáu mươi', 'bảy mươi', 'tám mươi', 'chín mươi'];

  if (num === 0) return 'không';
  if (num < 0) return 'âm ' + numberToVietnameseWords(-num);

  let words = '';

  // Billions
  if (num >= 1000000000) {
    words += numberToVietnameseWords(Math.floor(num / 1000000000)) + ' tỷ ';
    num %= 1000000000;
  }

  // Millions
  if (num >= 1000000) {
    words += numberToVietnameseWords(Math.floor(num / 1000000)) + ' triệu ';
    num %= 1000000;
  }

  // Thousands
  if (num >= 1000) {
    words += numberToVietnameseWords(Math.floor(num / 1000)) + ' nghìn ';
    num %= 1000;
  }

  // Hundreds
  if (num >= 100) {
    words += ones[Math.floor(num / 100)] + ' trăm ';
    num %= 100;
    if (num > 0 && num < 10) {
      words += 'lẻ ';
    }
  }

  // Tens and ones
  if (num >= 10) {
    words += tens[Math.floor(num / 10)] + ' ';
    num %= 10;
    if (num === 1) {
      words += 'mốt';
      num = 0;
    } else if (num === 5) {
      words += 'lăm';
      num = 0;
    }
  }

  if (num > 0) {
    words += ones[num];
  }

  return words.trim() + ' đồng';
}

// Generate Invoice PDF HTML Template
export function generateInvoiceHTML(invoice: {
  invoice_number: string;
  issued_date: string;
  due_date: string;
  billing_period_from: string;
  billing_period_to: string;
  tenant: {
    full_name: string;
    phone: string;
    id_number?: string;
  };
  room: {
    name: string;
    building: { name: string };
  };
  items: Array<{
    item_type: string;
    description: string;
    quantity: number;
    unit_price: number;
    amount: number;
  }>;
  subtotal: number;
  previous_debt: number;
  discount_amount: number;
  tax_amount: number;
  total_amount: number;
  paid_amount: number;
  company?: {
    name: string;
    address: string;
    phone: string;
    email: string;
    bank_name?: string;
    bank_account?: string;
  };
}): string {
  const remainingAmount = invoice.total_amount - invoice.paid_amount;

  return `
<!DOCTYPE html>
<html lang="vi">
<head>
  <meta charset="UTF-8">
  <title>Hóa đơn ${invoice.invoice_number}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: 'Times New Roman', serif; font-size: 12pt; line-height: 1.4; padding: 20mm; }
    .header { text-align: center; margin-bottom: 20px; }
    .company-name { font-size: 16pt; font-weight: bold; color: #1a5f2e; }
    .invoice-title { font-size: 18pt; font-weight: bold; margin: 15px 0; }
    .invoice-number { color: #666; }
    .info-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; margin: 20px 0; }
    .info-box { padding: 10px; border: 1px solid #ddd; border-radius: 4px; }
    .info-box h4 { font-size: 11pt; color: #666; margin-bottom: 8px; border-bottom: 1px solid #eee; padding-bottom: 5px; }
    .info-row { display: flex; margin: 4px 0; }
    .info-label { min-width: 100px; color: #666; }
    table { width: 100%; border-collapse: collapse; margin: 20px 0; }
    th, td { border: 1px solid #ddd; padding: 8px; text-align: left; }
    th { background: #f5f5f5; font-weight: bold; }
    .text-right { text-align: right; }
    .text-center { text-align: center; }
    .total-row { font-weight: bold; background: #f0f9f0; }
    .amount-words { font-style: italic; margin: 10px 0; padding: 10px; background: #f9f9f9; border-radius: 4px; }
    .payment-info { margin: 20px 0; padding: 15px; border: 1px solid #1a5f2e; border-radius: 4px; }
    .payment-info h4 { color: #1a5f2e; margin-bottom: 10px; }
    .signature-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 40px; margin-top: 40px; text-align: center; }
    .signature-box { padding: 20px; }
    .signature-title { font-weight: bold; margin-bottom: 60px; }
    .footer { margin-top: 30px; text-align: center; font-size: 10pt; color: #666; }
  </style>
</head>
<body>
  <div class="header">
    <div class="company-name">${invoice.company?.name || 'iHomeCRM'}</div>
    <div>${invoice.company?.address || ''}</div>
    <div>ĐT: ${invoice.company?.phone || ''} | Email: ${invoice.company?.email || ''}</div>
    <div class="invoice-title">HÓA ĐƠN DỊCH VỤ</div>
    <div class="invoice-number">Số: ${invoice.invoice_number}</div>
  </div>

  <div class="info-grid">
    <div class="info-box">
      <h4>THÔNG TIN KHÁCH HÀNG</h4>
      <div class="info-row"><span class="info-label">Họ tên:</span> <span>${invoice.tenant.full_name}</span></div>
      <div class="info-row"><span class="info-label">Điện thoại:</span> <span>${invoice.tenant.phone}</span></div>
      <div class="info-row"><span class="info-label">CCCD:</span> <span>${invoice.tenant.id_number || 'N/A'}</span></div>
      <div class="info-row"><span class="info-label">Căn hộ:</span> <span>${invoice.room.building.name} - ${invoice.room.name}</span></div>
    </div>
    <div class="info-box">
      <h4>THÔNG TIN HÓA ĐƠN</h4>
      <div class="info-row"><span class="info-label">Kỳ thanh toán:</span> <span>${formatDate(invoice.billing_period_from)} - ${formatDate(invoice.billing_period_to)}</span></div>
      <div class="info-row"><span class="info-label">Ngày lập:</span> <span>${formatDate(invoice.issued_date)}</span></div>
      <div class="info-row"><span class="info-label">Hạn thanh toán:</span> <span>${formatDate(invoice.due_date)}</span></div>
    </div>
  </div>

  <table>
    <thead>
      <tr>
        <th style="width: 5%">STT</th>
        <th style="width: 40%">Mô tả</th>
        <th style="width: 15%" class="text-center">Số lượng</th>
        <th style="width: 20%" class="text-right">Đơn giá</th>
        <th style="width: 20%" class="text-right">Thành tiền</th>
      </tr>
    </thead>
    <tbody>
      ${invoice.items.map((item, index) => `
      <tr>
        <td class="text-center">${index + 1}</td>
        <td>${item.description || item.item_type}</td>
        <td class="text-center">${item.quantity}</td>
        <td class="text-right">${formatCurrency(item.unit_price)}</td>
        <td class="text-right">${formatCurrency(item.amount)}</td>
      </tr>
      `).join('')}
      <tr>
        <td colspan="4" class="text-right">Cộng tiền dịch vụ:</td>
        <td class="text-right">${formatCurrency(invoice.subtotal)}</td>
      </tr>
      ${invoice.previous_debt > 0 ? `
      <tr>
        <td colspan="4" class="text-right">Công nợ kỳ trước:</td>
        <td class="text-right">${formatCurrency(invoice.previous_debt)}</td>
      </tr>
      ` : ''}
      ${invoice.discount_amount > 0 ? `
      <tr>
        <td colspan="4" class="text-right">Giảm giá:</td>
        <td class="text-right">-${formatCurrency(invoice.discount_amount)}</td>
      </tr>
      ` : ''}
      ${invoice.tax_amount > 0 ? `
      <tr>
        <td colspan="4" class="text-right">Thuế VAT:</td>
        <td class="text-right">${formatCurrency(invoice.tax_amount)}</td>
      </tr>
      ` : ''}
      <tr class="total-row">
        <td colspan="4" class="text-right">TỔNG CỘNG:</td>
        <td class="text-right">${formatCurrency(invoice.total_amount)}</td>
      </tr>
      ${invoice.paid_amount > 0 ? `
      <tr>
        <td colspan="4" class="text-right">Đã thanh toán:</td>
        <td class="text-right">${formatCurrency(invoice.paid_amount)}</td>
      </tr>
      <tr class="total-row">
        <td colspan="4" class="text-right">CÒN LẠI:</td>
        <td class="text-right">${formatCurrency(remainingAmount)}</td>
      </tr>
      ` : ''}
    </tbody>
  </table>

  <div class="amount-words">
    <strong>Bằng chữ:</strong> ${numberToVietnameseWords(remainingAmount > 0 ? remainingAmount : invoice.total_amount)}
  </div>

  ${invoice.company?.bank_account ? `
  <div class="payment-info">
    <h4>THÔNG TIN THANH TOÁN</h4>
    <div class="info-row"><span class="info-label">Ngân hàng:</span> <span>${invoice.company.bank_name}</span></div>
    <div class="info-row"><span class="info-label">Số tài khoản:</span> <span>${invoice.company.bank_account}</span></div>
    <div class="info-row"><span class="info-label">Nội dung CK:</span> <span>${invoice.invoice_number} - ${invoice.tenant.full_name}</span></div>
  </div>
  ` : ''}

  <div class="signature-grid">
    <div class="signature-box">
      <div class="signature-title">KHÁCH HÀNG</div>
      <div>(Ký, ghi rõ họ tên)</div>
    </div>
    <div class="signature-box">
      <div class="signature-title">BÊN CHO THUÊ</div>
      <div>(Ký, ghi rõ họ tên)</div>
    </div>
  </div>

  <div class="footer">
    In ngày: ${formatDateTime(new Date())}
  </div>
</body>
</html>
`;
}

// Generate Contract PDF HTML Template
export function generateContractHTML(contract: {
  contract_number: string;
  signed_date: string;
  start_date: string;
  end_date: string;
  tenant: {
    full_name: string;
    phone: string;
    email?: string;
    id_number?: string;
    id_issued_date?: string;
    id_issued_place?: string;
    permanent_address?: string;
  };
  room: {
    name: string;
    building: {
      name: string;
      street_address?: string;
      ward?: string;
      district?: string;
      province?: string;
    };
  };
  rent_price: number;
  total_deposit: number;
  payment_cycle: string;
  services?: Array<{
    name: string;
    unit_price: number;
    unit: string;
  }>;
  company?: {
    name: string;
    address: string;
    phone: string;
    representative?: string;
  };
}): string {
  const paymentCycleText: Record<string, string> = {
    MONTHLY: 'hàng tháng',
    QUARTERLY: 'hàng quý (3 tháng)',
    SEMI_ANNUAL: 'nửa năm (6 tháng)',
    ANNUAL: 'hàng năm',
  };

  const buildingAddress = [
    contract.room.building.street_address,
    contract.room.building.ward,
    contract.room.building.district,
    contract.room.building.province,
  ].filter(Boolean).join(', ');

  return `
<!DOCTYPE html>
<html lang="vi">
<head>
  <meta charset="UTF-8">
  <title>Hợp đồng thuê căn hộ ${contract.contract_number}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: 'Times New Roman', serif; font-size: 12pt; line-height: 1.6; padding: 20mm; }
    .header { text-align: center; margin-bottom: 30px; }
    .country { font-size: 13pt; font-weight: bold; }
    .slogan { font-size: 11pt; margin-bottom: 20px; }
    .title { font-size: 16pt; font-weight: bold; margin: 20px 0; }
    .contract-number { font-style: italic; margin-bottom: 10px; }
    .section { margin: 20px 0; }
    .section-title { font-weight: bold; margin-bottom: 10px; }
    .party-info { margin: 15px 0; padding-left: 20px; }
    .party-name { font-weight: bold; }
    .article { margin: 15px 0; }
    .article-title { font-weight: bold; text-decoration: underline; }
    .article-content { padding-left: 20px; margin-top: 5px; }
    ul { margin: 10px 0; padding-left: 40px; }
    li { margin: 5px 0; }
    .signature-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 40px; margin-top: 50px; text-align: center; }
    .signature-box { padding: 20px; }
    .signature-title { font-weight: bold; margin-bottom: 80px; }
    .footer { margin-top: 30px; text-align: center; font-size: 10pt; color: #666; }
  </style>
</head>
<body>
  <div class="header">
    <div class="country">CỘNG HÒA XÃ HỘI CHỦ NGHĨA VIỆT NAM</div>
    <div class="slogan">Độc lập - Tự do - Hạnh phúc</div>
    <div>---oOo---</div>
    <div class="title">HỢP ĐỒNG THUÊ CĂN HỘ</div>
    <div class="contract-number">Số: ${contract.contract_number}</div>
  </div>

  <p style="text-align: center; margin-bottom: 20px;">
    Hôm nay, ngày ${format(new Date(contract.signed_date), 'dd')} tháng ${format(new Date(contract.signed_date), 'MM')} năm ${format(new Date(contract.signed_date), 'yyyy')}, tại ${buildingAddress || contract.room.building.name}
  </p>

  <p>Chúng tôi gồm có:</p>

  <div class="section">
    <div class="section-title">BÊN A (BÊN CHO THUÊ):</div>
    <div class="party-info">
      <p><span class="party-name">Ông/Bà:</span> ${contract.company?.representative || '...................................'}</p>
      <p>Địa chỉ: ${contract.company?.address || buildingAddress || '...................................'}</p>
      <p>Điện thoại: ${contract.company?.phone || '...................................'}</p>
    </div>
  </div>

  <div class="section">
    <div class="section-title">BÊN B (BÊN THUÊ):</div>
    <div class="party-info">
      <p><span class="party-name">Ông/Bà:</span> ${contract.tenant.full_name}</p>
      <p>CCCD/CMND số: ${contract.tenant.id_number || '...................................'}</p>
      <p>Ngày cấp: ${contract.tenant.id_issued_date ? formatDate(contract.tenant.id_issued_date) : '...........'} Nơi cấp: ${contract.tenant.id_issued_place || '...................................'}</p>
      <p>Địa chỉ thường trú: ${contract.tenant.permanent_address || '...................................'}</p>
      <p>Điện thoại: ${contract.tenant.phone}</p>
      <p>Email: ${contract.tenant.email || '...................................'}</p>
    </div>
  </div>

  <p style="margin: 20px 0;">Hai bên cùng thỏa thuận và ký kết hợp đồng thuê căn hộ với các điều khoản sau:</p>

  <div class="article">
    <div class="article-title">ĐIỀU 1: ĐỐI TƯỢNG CHO THUÊ</div>
    <div class="article-content">
      <p>Bên A đồng ý cho Bên B thuê căn hộ tại địa chỉ:</p>
      <p><strong>Căn hộ ${contract.room.name}, ${contract.room.building.name}</strong></p>
      <p>Địa chỉ: ${buildingAddress}</p>
    </div>
  </div>

  <div class="article">
    <div class="article-title">ĐIỀU 2: THỜI HẠN THUÊ</div>
    <div class="article-content">
      <p>Thời hạn thuê: Từ ngày ${formatDate(contract.start_date)} đến ngày ${formatDate(contract.end_date)}</p>
    </div>
  </div>

  <div class="article">
    <div class="article-title">ĐIỀU 3: GIÁ THUÊ VÀ PHƯƠNG THỨC THANH TOÁN</div>
    <div class="article-content">
      <p>- Giá thuê căn hộ: <strong>${formatCurrency(contract.rent_price)}</strong>/tháng</p>
      <p>- Chu kỳ thanh toán: ${paymentCycleText[contract.payment_cycle] || contract.payment_cycle}</p>
      <p>- Tiền đặt cọc: <strong>${formatCurrency(contract.total_deposit)}</strong></p>
      ${contract.services && contract.services.length > 0 ? `
      <p>- Phí dịch vụ:</p>
      <ul>
        ${contract.services.map(s => `<li>${s.name}: ${formatCurrency(s.unit_price)}/${s.unit}</li>`).join('')}
      </ul>
      ` : ''}
    </div>
  </div>

  <div class="article">
    <div class="article-title">ĐIỀU 4: QUYỀN VÀ NGHĨA VỤ CỦA BÊN A</div>
    <div class="article-content">
      <ul>
        <li>Bàn giao căn hộ cho Bên B đúng thời hạn và đảm bảo các tiện ích đã thỏa thuận.</li>
        <li>Đảm bảo quyền sử dụng hợp pháp cho Bên B trong thời gian thuê.</li>
        <li>Thông báo trước ít nhất 30 ngày nếu có thay đổi liên quan đến hợp đồng.</li>
      </ul>
    </div>
  </div>

  <div class="article">
    <div class="article-title">ĐIỀU 5: QUYỀN VÀ NGHĨA VỤ CỦA BÊN B</div>
    <div class="article-content">
      <ul>
        <li>Thanh toán tiền thuê đầy đủ và đúng hạn.</li>
        <li>Sử dụng căn hộ đúng mục đích thuê, giữ gìn vệ sinh và tài sản.</li>
        <li>Không được cho người khác thuê lại hoặc chuyển nhượng khi chưa có sự đồng ý của Bên A.</li>
        <li>Thông báo trước ít nhất 30 ngày nếu muốn chấm dứt hợp đồng trước hạn.</li>
        <li>Chịu trách nhiệm bồi thường nếu làm hư hỏng tài sản của Bên A.</li>
      </ul>
    </div>
  </div>

  <div class="article">
    <div class="article-title">ĐIỀU 6: ĐIỀU KHOẢN CHUNG</div>
    <div class="article-content">
      <p>Hợp đồng này có hiệu lực kể từ ngày ký. Mọi sửa đổi, bổ sung phải được lập thành văn bản và có chữ ký của cả hai bên.</p>
      <p>Hợp đồng được lập thành 02 bản có giá trị pháp lý như nhau, mỗi bên giữ 01 bản.</p>
    </div>
  </div>

  <div class="signature-grid">
    <div class="signature-box">
      <div class="signature-title">BÊN A (BÊN CHO THUÊ)</div>
      <div>(Ký, ghi rõ họ tên)</div>
    </div>
    <div class="signature-box">
      <div class="signature-title">BÊN B (BÊN THUÊ)</div>
      <div>(Ký, ghi rõ họ tên)</div>
    </div>
  </div>

  <div class="footer">
    In ngày: ${formatDateTime(new Date())}
  </div>
</body>
</html>
`;
}

// Generate Asset Handover PDF HTML Template
export function generateHandoverHTML(handover: {
  handover_date: string;
  type: 'CHECK_IN' | 'CHECK_OUT';
  contract: {
    contract_number: string;
    tenant: {
      full_name: string;
      phone: string;
      id_number?: string;
    };
    room: {
      name: string;
      building: { name: string };
    };
  };
  items: Array<{
    asset_name: string;
    quantity: number;
    condition: string;
    notes?: string;
  }>;
  notes?: string;
  tenant_signature?: string;
  landlord_signature?: string;
}): string {
  const typeText = handover.type === 'CHECK_IN' ? 'NHẬN CĂN HỘ' : 'TRẢ CĂN HỘ';
  const conditionText: Record<string, string> = {
    NEW: 'Mới',
    GOOD: 'Tốt',
    FAIR: 'Khá',
    POOR: 'Kém',
    BROKEN: 'Hư hỏng',
  };

  return `
<!DOCTYPE html>
<html lang="vi">
<head>
  <meta charset="UTF-8">
  <title>Biên bản bàn giao ${typeText.toLowerCase()}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: 'Times New Roman', serif; font-size: 12pt; line-height: 1.6; padding: 20mm; }
    .header { text-align: center; margin-bottom: 30px; }
    .title { font-size: 16pt; font-weight: bold; margin: 20px 0; text-transform: uppercase; }
    .info-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; margin: 20px 0; }
    .info-box { padding: 10px; }
    .info-row { margin: 5px 0; }
    .info-label { font-weight: bold; }
    table { width: 100%; border-collapse: collapse; margin: 20px 0; }
    th, td { border: 1px solid #333; padding: 8px; text-align: left; }
    th { background: #f0f0f0; font-weight: bold; }
    .text-center { text-align: center; }
    .notes { margin: 20px 0; padding: 15px; border: 1px solid #ddd; border-radius: 4px; }
    .signature-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 40px; margin-top: 50px; text-align: center; }
    .signature-box { padding: 20px; border: 1px solid #ddd; min-height: 150px; }
    .signature-title { font-weight: bold; margin-bottom: 10px; }
    .signature-image { max-height: 80px; margin: 10px 0; }
  </style>
</head>
<body>
  <div class="header">
    <div class="title">BIÊN BẢN BÀN GIAO ${typeText}</div>
    <p>Ngày: ${formatDate(handover.handover_date)}</p>
  </div>

  <div class="info-grid">
    <div class="info-box">
      <div class="info-row"><span class="info-label">Số hợp đồng:</span> ${handover.contract.contract_number}</div>
      <div class="info-row"><span class="info-label">Căn hộ:</span> ${handover.contract.room.building.name} - ${handover.contract.room.name}</div>
    </div>
    <div class="info-box">
      <div class="info-row"><span class="info-label">Khách hàng:</span> ${handover.contract.tenant.full_name}</div>
      <div class="info-row"><span class="info-label">SĐT:</span> ${handover.contract.tenant.phone}</div>
      <div class="info-row"><span class="info-label">CCCD:</span> ${handover.contract.tenant.id_number || 'N/A'}</div>
    </div>
  </div>

  <h3>DANH SÁCH TÀI SẢN BÀN GIAO</h3>
  <table>
    <thead>
      <tr>
        <th style="width: 5%">STT</th>
        <th style="width: 40%">Tên tài sản</th>
        <th style="width: 15%" class="text-center">Số lượng</th>
        <th style="width: 15%">Tình trạng</th>
        <th style="width: 25%">Ghi chú</th>
      </tr>
    </thead>
    <tbody>
      ${handover.items.map((item, index) => `
      <tr>
        <td class="text-center">${index + 1}</td>
        <td>${item.asset_name}</td>
        <td class="text-center">${item.quantity}</td>
        <td>${conditionText[item.condition] || item.condition}</td>
        <td>${item.notes || ''}</td>
      </tr>
      `).join('')}
    </tbody>
  </table>

  ${handover.notes ? `
  <div class="notes">
    <strong>Ghi chú:</strong><br/>
    ${handover.notes}
  </div>
  ` : ''}

  <p style="margin: 20px 0;">
    Hai bên đã kiểm tra và xác nhận tình trạng tài sản như trên. Biên bản được lập thành 02 bản, mỗi bên giữ 01 bản.
  </p>

  <div class="signature-grid">
    <div class="signature-box">
      <div class="signature-title">BÊN CHO THUÊ</div>
      ${handover.landlord_signature ? `<img src="${handover.landlord_signature}" class="signature-image" alt="Chữ ký"/>` : ''}
      <div>(Ký, ghi rõ họ tên)</div>
    </div>
    <div class="signature-box">
      <div class="signature-title">BÊN THUÊ</div>
      ${handover.tenant_signature ? `<img src="${handover.tenant_signature}" class="signature-image" alt="Chữ ký"/>` : ''}
      <div>(Ký, ghi rõ họ tên)</div>
    </div>
  </div>
</body>
</html>
`;
}

// Download PDF using html2pdf.js
export async function downloadPDF(htmlContent: string, filename: string): Promise<void> {
  // Dynamically import html2pdf
  const html2pdf = (await import('html2pdf.js')).default;

  const element = document.createElement('div');
  element.innerHTML = htmlContent;
  document.body.appendChild(element);

  const opt = {
    margin: 0,
    filename: `${filename}.pdf`,
    image: { type: 'jpeg', quality: 0.98 },
    html2canvas: { scale: 2, useCORS: true },
    jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' },
  };

  try {
    await html2pdf().set(opt).from(element).save();
  } finally {
    document.body.removeChild(element);
  }
}

// Print HTML directly
export function printHTML(htmlContent: string): void {
  const printWindow = window.open('', '_blank');
  if (printWindow) {
    printWindow.document.write(htmlContent);
    printWindow.document.close();
    printWindow.focus();
    printWindow.print();
    printWindow.close();
  }
}
