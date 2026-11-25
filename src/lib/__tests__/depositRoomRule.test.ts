import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Resolver } from 'react-hook-form';
import { DEPOSIT_ROOM_REQUIRED_MESSAGE, depositTypeIdSet, needsDepositRoom, withDepositRoomRule, withFieldErrors } from '../depositRoomRule';
import { DEPOSIT_AMOUNT_REQUIRED_MESSAGE, DEPOSIT_AMOUNT_SERVER_MESSAGE, DEPOSIT_INCOME_LINE_INVALID_MESSAGE } from '../incomeExpenseValidation';
import { friendlyError } from '../friendlyError';
import { VOUCHER_ERROR_RULES } from '../voucherErrorRules';
import { voucherFailureMessage } from '../voucherFeedback';

const coc = depositTypeIdSet([
  { id: 'tien-coc', is_deposit: true },
  { id: 'sua-chua', is_deposit: false },
  { id: 'khac', is_deposit: null },
]);

describe('needsDepositRoom', () => {
  it('có dòng cọc mà chưa chọn phòng ⇒ cần phòng', () => {
    expect(needsDepositRoom(['sua-chua', 'tien-coc'], null, coc)).toBe(true);
    expect(needsDepositRoom(['tien-coc'], '', coc)).toBe(true);
    expect(needsDepositRoom(['tien-coc'], undefined, coc)).toBe(true);
  });

  it('đã chọn phòng, hoặc không có dòng cọc ⇒ không chặn', () => {
    expect(needsDepositRoom(['tien-coc'], 'g03', coc)).toBe(false);
    expect(needsDepositRoom(['sua-chua', 'khac', null, undefined], null, coc)).toBe(false);
    expect(needsDepositRoom([], null, coc)).toBe(false);
  });
});

type Values = { name: string; room_id: string | null; items: { room_id: string | null }[] };
const zodLike =
  (errors: Record<string, unknown>): Resolver<Values> =>
  async (values) =>
    Object.keys(errors).length ? { values: {}, errors: errors as never } : { values, errors: {} };

describe('withDepositRoomRule', () => {
  const values: Values = { name: '', room_id: null, items: [{ room_id: 'p1' }, { room_id: null }] };
  const opts = { shouldUseNativeValidation: false, fields: {} } as never;

  it('lỗi phòng hiện CÙNG LƯỢT với lỗi khác của form, không đợi ô khác hợp lệ', async () => {
    const resolver = withDepositRoomRule(zodLike({ name: { type: 'too_small', message: 'Nhập tên' } }), () => ['room_id']);
    const out = await resolver(values, undefined, opts);
    expect(out.values).toEqual({});
    expect(out.errors).toEqual({
      name: { type: 'too_small', message: 'Nhập tên' },
      room_id: { type: 'deposit_room', message: DEPOSIT_ROOM_REQUIRED_MESSAGE },
    });
  });

  it('gắn lỗi đúng dòng của phiếu tổng (items.1.room_id), giữ lỗi zod sẵn có của dòng', async () => {
    const resolver = withDepositRoomRule(
      zodLike({ items: [undefined, { unit_price: { type: 'too_small', message: 'Số tiền' } }] }),
      () => ['items.1.room_id'],
    );
    const out = await resolver(values, undefined, opts);
    const rows = (out.errors as { items: Array<Record<string, { type: string }> | undefined> }).items;
    expect(rows[0]).toBeUndefined();
    expect(rows[1]?.unit_price?.type).toBe('too_small');
    expect(rows[1]?.room_id?.type).toBe('deposit_room');
  });

  it('không thiếu phòng ⇒ trả nguyên kết quả resolver gốc', async () => {
    const resolver = withDepositRoomRule(zodLike({}), () => []);
    expect(await resolver(values, undefined, opts)).toEqual({ values, errors: {} });
  });

  it('không ghi đè lỗi zod sẵn có ở chính ô phòng', async () => {
    const resolver = withDepositRoomRule(zodLike({ room_id: { type: 'custom', message: 'Phòng khác toà' } }), () => ['room_id']);
    const out = await resolver(values, undefined, opts);
    expect(out.errors).toEqual({ room_id: { type: 'custom', message: 'Phòng khác toà' } });
  });
});

describe('máy chủ chặn phiếu cọc thiếu phòng (trigger zz_ie_deposit_requires_room)', () => {
  const loiMayChu = {
    code: '23514',
    message: DEPOSIT_ROOM_REQUIRED_MESSAGE,
    details: 'Phiếu PT2610999 chưa gắn phòng.',
    hint: 'Chọn phòng của khách đặt cọc rồi lưu lại.',
  };

  it('form phiếu lẻ: lỗi dẫn về ô Phòng, nói rõ nguyên nhân', () => {
    const fb = friendlyError(loiMayChu, 'Chưa lưu được phiếu', { operation: 'lưu phiếu', financial: true, rules: VOUCHER_ERROR_RULES });
    expect(fb.fieldErrors).toEqual({
      room_id: 'Phiếu có hạng mục Tiền cọc phải chọn phòng. Chọn phòng của khách đặt cọc rồi lưu lại.',
    });
  });

  it('phiếu tổng / Báo chi nhanh: câu báo lỗi là nguyên nhân, không phải lỗi chung chung', () => {
    expect(voucherFailureMessage(loiMayChu, 'tạo phiếu')).toBe(
      'Phiếu có hạng mục Tiền cọc phải chọn phòng. Chọn phòng của khách đặt cọc rồi lưu lại.',
    );
  });
});

describe('câu lỗi máy chủ khớp câu client', () => {
  it('migration raise ĐÚNG DEPOSIT_ROOM_REQUIRED_MESSAGE — lệch là client mất đường dẫn lỗi về ô Phòng', () => {
    const sql = readFileSync('supabase/migrations/20261006173923_phieu_coc_bat_buoc_phong.sql', 'utf8');
    expect(sql).toContain(`RAISE EXCEPTION '${DEPOSIT_ROOM_REQUIRED_MESSAGE}'`);
    expect(sql).toContain("ERRCODE = '23514'");
  });
});

describe('máy chủ chặn phiếu cọc 0 đ (trigger zz_ie_item_deposit_amount_positive, Sale phòng đợt 3)', () => {
  const loiMayChu = {
    code: '23514',
    message: DEPOSIT_AMOUNT_SERVER_MESSAGE,
    details: 'Phiếu PT2611442 có hạng mục Tiền cọc nhưng tổng tiền cọc không lớn hơn 0 và chưa gắn hợp đồng.',
    hint: 'Nhập số tiền cọc lớn hơn 0 hoặc bỏ hạng mục Tiền cọc.',
  };
  it('form phiếu lẻ / phiếu tổng / Báo chi nhanh: câu báo là nguyên nhân, cùng chữ hộp Cọc trang Sale', () => {
    const fb = friendlyError(loiMayChu, 'Chưa lưu được phiếu', { operation: 'lưu phiếu', financial: true, rules: VOUCHER_ERROR_RULES });
    expect(fb.description).toBe(DEPOSIT_AMOUNT_REQUIRED_MESSAGE);
    expect(voucherFailureMessage(loiMayChu, 'tạo phiếu')).toBe(DEPOSIT_AMOUNT_REQUIRED_MESSAGE);
  });
  it('câu 22023 của #499 («Phiếu PTxxxx thiếu dòng cọc hợp lệ», mã phiếu đã bị huỷ cùng giao dịch) ⇒ câu dễ hiểu, không nêu mã', () => {
    for (const message of ['Phiếu PT2611488 thiếu dòng cọc hợp lệ', 'Phiếu  thiếu dòng cọc hợp lệ', 'Phiếu PT2611488 chưa có dòng tiền cọc']) {
      expect(voucherFailureMessage({ code: '22023', message }, 'tạo phiếu')).toBe(DEPOSIT_INCOME_LINE_INVALID_MESSAGE);
    }
    expect(voucherFailureMessage({ code: '22023', message: 'Phiếu X thiếu dòng cọc hợp lệ khác' }, 'tạo phiếu')).not.toBe(DEPOSIT_INCOME_LINE_INVALID_MESSAGE);
  });
  it('migration raise ĐÚNG DEPOSIT_AMOUNT_SERVER_MESSAGE với 23514', () => {
    const sql = readFileSync('supabase/migrations/20261125165113_coc_thu_chi_chan_0d_va_khoi_da_coc_tren_dot_giu_cho.sql', 'utf8');
    expect(sql).toContain(`RAISE EXCEPTION '${DEPOSIT_AMOUNT_SERVER_MESSAGE}'`);
    expect(sql).toContain("USING ERRCODE = '23514'");
  });
});

describe('withFieldErrors: luật ngoài zod cùng lượt, không ghi đè lỗi zod', () => {
  const opts = { shouldUseNativeValidation: false, fields: {} } as never;
  const values: Values = { name: 'x', room_id: 'p1', items: [{ room_id: 'p1' }] };
  it('thêm lỗi đúng đường dẫn; lỗi zod sẵn có ở cùng ô được giữ', async () => {
    const resolver = withFieldErrors(zodLike({ name: { type: 'too_small', message: 'Nhập tên' } }), () => [
      { path: 'items.0.unit_price', type: 'deposit_amount', message: 'Số tiền cọc' },
      { path: 'name', type: 'khac', message: 'không được đè' },
    ]);
    const out = await resolver(values, undefined, opts);
    expect(out.values).toEqual({});
    expect(out.errors).toEqual({ name: { type: 'too_small', message: 'Nhập tên' }, items: [{ unit_price: { type: 'deposit_amount', message: 'Số tiền cọc' } }] });
  });
  it('không có lỗi thêm ⇒ trả nguyên kết quả gốc', async () => {
    const resolver = withFieldErrors(zodLike({}), () => []);
    expect(await resolver(values, undefined, opts)).toEqual({ values, errors: {} });
  });
});
