import { get, set, type FieldErrors, type FieldValues, type Resolver } from 'react-hook-form';

/**
 * Phiếu có hạng mục cọc (`is_deposit`) phải gắn phòng. Cọc chỉ vào được hợp đồng theo phòng —
 * form tạo HĐ (`useOrphanDepositVouchers`) lẫn trigger `trg_contract_link_orphan_deposits` đều lọc
 * `room_id` — nên phiếu cọc chỉ có toà sẽ treo mãi, không HĐ nào nhận. Ca thật: PT2609155
 * (29/09/2026) nhập lại thành PT2610026 ⇒ sổ thừa 1.000.000đ. Máy chủ chặn cùng luật bằng trigger
 * `zz_ie_deposit_requires_room`, và trả đúng câu này (xem `voucherErrorRules.ts`).
 */
export const DEPOSIT_ROOM_REQUIRED_MESSAGE = 'Phiếu có hạng mục Tiền cọc phải chọn phòng.';

export function depositTypeIdSet(types: readonly { id: string; is_deposit?: boolean | null }[]): Set<string> {
  return new Set(types.filter((t) => t.is_deposit).map((t) => t.id));
}

/** Có dòng hạng mục cọc mà phiếu chưa chọn phòng. */
export function needsDepositRoom(
  typeIds: readonly (string | null | undefined)[],
  roomId: string | null | undefined,
  depositTypeIds: ReadonlySet<string>,
): boolean {
  return !roomId && typeIds.some((id) => !!id && depositTypeIds.has(id));
}

/**
 * Bọc resolver của form: thêm lỗi "phải chọn phòng" vào đúng các ô phòng còn thiếu, CÙNG LƯỢT với
 * lỗi zod. Viết thành `superRefine` thì zod chỉ chạy khi mọi ô khác đã hợp lệ — người dùng sửa xong
 * lỗi khác mới thấy lỗi phòng.
 */
export function withDepositRoomRule<T extends FieldValues>(
  resolver: Resolver<T>,
  missingRoomPaths: (values: T) => readonly string[],
): Resolver<T> {
  return async (values, context, options) => {
    const result = await resolver(values, context, options);
    const paths = missingRoomPaths(values);
    if (paths.length === 0) return result;
    const errors: FieldErrors<T> = Object.assign({}, result.errors);
    for (const path of paths) {
      if (!get(errors, path)) set(errors, path, { type: 'deposit_room', message: DEPOSIT_ROOM_REQUIRED_MESSAGE });
    }
    return { values: {}, errors };
  };
}
