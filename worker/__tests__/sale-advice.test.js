import { describe, it, expect, vi } from 'vitest';
import { adviseSale, saleQuestionKind } from '../lib/sale-advice.js';
import { salePageBuildings, captureSaleQuestion, deliverSaleAdvice } from '../lib/sale-advice-channel.js';

vi.mock('../lib/ctx.js', () => ({ sb: {}, log: vi.fn(), SUPABASE_URL: 'https://example.test' }));

const link = 'https://example.test/r/example';
const page = {
  sale_policy: 'Điện 4k/số · Nước 90k/người · PDV 120k/phòng\nXe miễn phí',
  buildings: [{ id: 'b', name: 'Tòa Sen', district: 'Bình Thạnh', address: 'Đường Sen, Bình Thạnh' }],
  rooms: [
    {
      id: 'p',
      building_id: 'b',
      code: '201',
      status_public: 'pass',
      pass_price: 3700000,
      rent_price: 4200000,
      pass_contact_phone: '0900000123',
      pass_sale_policy: 'Xem sau 15h',
      area: 19,
      amenities: ['Máy lạnh'],
      sale_note_base: 'Có thể xem cuối tuần',
      active_policy_text: 'Tặng một tháng gửi xe',
      pass_avail_date: '2026-12-01',
    },
    {
      id: 'r',
      building_id: 'b',
      code: '202',
      status_public: 'free',
      rent_price: 4500000,
      sale_today: '2026-11-20',
      amenities: ['Máy lạnh'],
    },
    { id: 'x', building_id: 'b', code: '203', status_public: 'rented', rent_price: 1100000 },
  ],
};
const answer = (question, previous, p = page) =>
  adviseSale({
    question,
    previous,
    buildings: salePageBuildings(p),
    today: '2026-11-20',
    viewingPhone: '0923.889.880',
    link,
  });
const source = { accountId: 'a', organizationId: 'o', ownUid: '123', generation: 'g', instanceId: 'i' };
const live = {
  type: 0,
  isSelf: false,
  threadId: '456',
  data: {
    msgType: 'webchat',
    uidFrom: '456',
    idTo: '123',
    msgId: 'sample',
    ts: Date.now(),
    content: 'Còn phòng trống nào?',
  },
};

describe('tư vấn từ đúng trang Sale Phòng', () => {
  it('lọc khu, giá, tiện nghi, ngày vào ở; loại phòng không rao', () => {
    const a = answer('Bình Thạnh dưới 5 triệu, có máy lạnh, đầu tháng sau vào được không?');
    expect(a.memory.ids).toEqual(['r', 'p']);
    expect(answer('Quận 9 dưới 5 triệu').memory.ids).toEqual([]);
    expect(answer('Phòng dưới 3tr5').memory.ids).toEqual([]);
    expect(answer('Còn căn nào trống ngay?').memory.ids).toEqual(['r']);
  });
  it('tách khoảng ngân sách khỏi mã phòng và ngày vào', () => {
    expect(answer('Còn phòng 4 triệu không?').memory.ids).toEqual(['p']);
    for (const question of ['Cần phòng từ 4 đến 5 triệu', 'Tìm phòng 4-5 triệu']) {
      const result = answer(question);
      expect(result.memory.ids).toEqual(['r']);
      expect(result.memory.criteria).toMatchObject({ min: 4000000, max: 5000000 });
      expect(result.memory.criteria).not.toHaveProperty('date');
    }
    const dated = answer('Tìm phòng 4-5 triệu vào ngày 22/11');
    expect(dated.memory.criteria.date).toBe('2026-11-22');
  });
  it('lọc tiện nghi theo mô tả khẳng định', () => {
    const p = structuredClone(page);
    p.rooms[0].description = 'Không có ban công';
    p.rooms[1].amenities.push('Ban công');
    expect(answer('Tìm phòng có ban công', null, p).memory.ids).toEqual(['r']);
  });
  it('phòng pass dùng giá pass, điều kiện, phí, ưu đãi và đúng số khách cuối tin', () => {
    const body = answer('Thông tin phòng 201').messages[0].text;
    for (const part of [
      '3.700.000đ',
      'Xem sau 15h',
      'Có thể xem cuối tuần',
      'Điện 4k/số · Nước 90k/người · PDV 120k/phòng',
      'Khuyến mãi: Tặng một tháng gửi xe',
      link,
    ])
      expect(body).toContain(part);
    expect(body.endsWith('0900000123.')).toBe(true);
    expect(body).not.toContain('0923.889.880');
    const changed = structuredClone(page);
    changed.rooms[0].pass_contact_manager = true;
    expect(answer('Phòng 201', null, changed).messages[0].text).toContain('0923.889.880');
  });
  it('ghi gọn mức đang đăng, phí riêng của căn ưu tiên phí chung', () => {
    const changed = structuredClone(page);
    changed.rooms[0].sale_note_base = 'Điện 3.750đ/kWh';
    changed.sale_policy = 'Điện 4.200đ/kWh, Nước 88.000đ/người, PDV 135.000đ/ phòng';
    expect(answer('Thông tin phòng 201', null, changed).messages[0].text).toContain(
      'Điện 3k75/kWh · Nước 88k/người · PDV 135k/phòng',
    );
  });
  it('không tạo ưu đãi rỗng; báo thiếu phí và giữ điều kiện công bố', () => {
    const changed = structuredClone(page);
    changed.sale_policy = 'Điện 4k/kWh cho nhà thang máy';
    const text = answer('Phòng 202', null, changed).messages[0].text;
    expect(text).not.toMatch(/Khuyến mãi|0900000123/);
    expect(text).toContain('Điện 4k/kWh cho nhà thang máy · Nước chưa cập nhật · PDV chưa cập nhật');
    expect(text.endsWith('0923.889.880.')).toBe(true);
  });
  it('hỏi ảnh theo thứ tự và kiểm lại căn vừa gỡ', () => {
    const prev = answer('Còn phòng trống nào?').memory;
    const next = answer('Gửi ảnh căn thứ hai', prev);
    expect(next.messages[0].room.id).toBe('p');
    expect(
      answer('Gửi ảnh căn thứ hai', prev, { ...page, rooms: page.rooms.slice(1) }).messages[0].text,
    ).toContain('đã gỡ');
    expect(answer('Gửi bảng hôm nay').messages[0].table).toBe(true);
  });
  it('tin không liên quan và yêu cầu CRM riêng không thành câu hỏi sale', () => {
    for (const text of ['ok cảm ơn', 'Sửa giá phòng 201', 'Kiểm tra hóa đơn phòng 201'])
      expect(saleQuestionKind(text)).toBe(null);
    expect(saleQuestionKind('gửi ảnh căn thứ hai')).toBe('followup');
    expect(saleQuestionKind('Phòng 101 khách đang xem rồi', true)).toBe(null);
    expect(saleQuestionKind('Căn 201', true)).toBe('question');
    expect(saleQuestionKind('Phòng 101 còn trống không?', true)).toBe('question');
  });
  it('chỉ nhận tin live với đúng đích và chuyển người hỏi của nhóm vào intake', async () => {
    const db = { rpc: vi.fn(async () => ({ data: 'queued' })) };
    expect(await captureSaleQuestion({ ...live, isSelf: true }, source, db)).toBe(false);
    expect(await captureSaleQuestion({ ...live, threadId: '789' }, source, db)).toBe(false);
    expect(db.rpc).not.toHaveBeenCalled();
    expect(await captureSaleQuestion(live, source, db)).toBe(true);
    expect(
      await captureSaleQuestion(
        { ...live, type: 1, threadId: '789', data: { ...live.data, content: 'Em đang dẫn khách xem phòng 101' } },
        source,
        db,
      ),
    ).toBe(false);
    expect(await captureSaleQuestion({ ...live, type: 1, threadId: '789' }, source, db)).toBe(true);
    expect(db.rpc.mock.lastCall[1].p).toMatchObject({ threadType: 'group', threadId: '789', senderUid: '456' });
  });
  it('gửi ảnh và thông tin cùng lần; dừng nếu trang đã đổi trước send', async () => {
    const snap = { page, link, signature: 's', question: 'Thông tin phòng 201' };
    const job = { id: 'j', account_id: 'a', organization_id: 'o' };
    const send = vi.fn(async () => ({ message: { msgId: '80' } }));
    const photos = vi.fn(async (r) => [{ filename: r.id + '.jpg' }]);
    let authorized = true;
    const db = {
      rpc: vi.fn(async (_, p) =>
        p.p_signature ? { data: { authorized, threadType: 'user', threadId: '456' } } : { data: snap },
      ),
    };
    await deliverSaleAdvice(job, source, send, { db, photos });
    expect(send.mock.calls[0]).toEqual([
      { msg: expect.stringContaining('0900000123'), attachments: [{ filename: 'p.jpg' }] },
      '456',
      0,
    ]);
    authorized = false;
    await expect(deliverSaleAdvice(job, source, send, { db, photos })).rejects.toThrow();
    expect(send).toHaveBeenCalledTimes(1);
  });
});
