import { describe, expect, it } from 'vitest';
import {
  DEPOSIT_CONTRACT_CHOICE_REQUIRED_MESSAGE,
  DEPOSIT_CONTRACT_EXISTING_MISSING_MESSAGE,
  choiceFromPickedContract,
  contractIdForChoice,
  contractLabel,
  depositContractChoiceError,
  depositContractChoiceRequired,
  effectiveRoomContracts,
  newTenantNoticeWarning,
  type RoomContractLike,
} from '../depositContractChoice';

const hd = (o: Partial<RoomContractLike> = {}): RoomContractLike => ({
  id: 'hd-1', status: 'ACTIVE', actual_end_date: null, expected_move_out_date: null, contract_number: 'HD-2026-00411',
  tenant: { full_name: 'Khách Cũ' }, ...o,
});

describe('HĐ hiệu lực của phòng', () => {
  it('ACTIVE và EXTENDED chưa ghi ngày trả thực tế; thanh lý / nháp / đã trả thì không', () => {
    const rows = [hd({ id: 'a' }), hd({ id: 'e', status: 'EXTENDED' }), hd({ id: 't', status: 'TERMINATED' }), hd({ id: 'd', status: 'DRAFT' }),
      hd({ id: 'x', actual_end_date: '2026-11-20' })];
    expect(effectiveRoomContracts(rows).map(c => c.id)).toEqual(['a', 'e']);
  });
});

describe('khi nào phải hỏi', () => {
  const base = { creating: true, voucherType: 'INCOME', hasDepositItem: true, effectiveContractCount: 1 };
  it('phiếu THU tạo mới có cọc ở phòng có HĐ hiệu lực ⇒ hỏi', () => {
    expect(depositContractChoiceRequired(base)).toBe(true);
  });
  it('sửa phiếu, phiếu CHI, không có cọc, phòng không HĐ ⇒ không hỏi', () => {
    expect(depositContractChoiceRequired({ ...base, creating: false })).toBe(false);
    expect(depositContractChoiceRequired({ ...base, voucherType: 'EXPENSE' })).toBe(false);
    expect(depositContractChoiceRequired({ ...base, hasDepositItem: false })).toBe(false);
    expect(depositContractChoiceRequired({ ...base, effectiveContractCount: 0 })).toBe(false);
  });
});

describe('lựa chọn ⇒ hợp đồng gắn phiếu, lỗi chặn lưu', () => {
  it('«khách đang ở» chỉ tự điền khi đúng một HĐ hiệu lực; «khách mới» luôn trống', () => {
    expect(contractIdForChoice('existing', [hd()])).toBe('hd-1');
    expect(contractIdForChoice('existing', [hd(), hd({ id: 'hd-2' })])).toBeNull();
    expect(contractIdForChoice('new', [hd()])).toBeNull();
  });
  it('tự chọn ở ô Hợp đồng là lựa chọn rõ', () => {
    expect(choiceFromPickedContract('hd-1')).toBe('existing');
    expect(choiceFromPickedContract(null)).toBe('new');
  });
  it('chưa chọn ⇒ chặn; «khách đang ở» chưa có HĐ ⇒ chặn; còn lại không chặn; không phải hỏi ⇒ không chặn', () => {
    expect(depositContractChoiceError({ required: true, choice: null, contractId: 'hd-1' })).toBe(DEPOSIT_CONTRACT_CHOICE_REQUIRED_MESSAGE);
    expect(depositContractChoiceError({ required: true, choice: 'existing', contractId: null })).toBe(DEPOSIT_CONTRACT_EXISTING_MISSING_MESSAGE);
    expect(depositContractChoiceError({ required: true, choice: 'existing', contractId: 'hd-1' })).toBeNull();
    expect(depositContractChoiceError({ required: true, choice: 'new', contractId: null })).toBeNull();
    expect(depositContractChoiceError({ required: false, choice: null, contractId: null })).toBeNull();
  });
});

describe('cảnh báo «phòng chưa báo trả» khi chọn khách mới', () => {
  it('nêu HĐ chưa có ngày trả; đã báo trả thì không cảnh báo', () => {
    expect(newTenantNoticeWarning([hd()])).toBe('Phòng chưa báo trả: HD-2026-00411 · Khách Cũ chưa có ngày trả phòng. Vẫn lưu được; nhớ ghi báo trả cho khách đang ở.');
    expect(newTenantNoticeWarning([hd({ expected_move_out_date: '2026-12-01' })])).toBeNull();
  });
  it('nhãn HĐ thiếu số / thiếu tên khách vẫn đọc được', () => {
    expect(contractLabel(hd({ contract_number: null, tenant: null }))).toBe('HĐ chưa có số');
  });
});
