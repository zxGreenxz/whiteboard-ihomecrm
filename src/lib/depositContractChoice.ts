/**
 * Cọc lập ở Thu chi cho phòng đang có hợp đồng hiệu lực (Sale phòng đợt 3, chủ chốt 24/11/2026): LUÔN bắt người lập chọn
 * «Bổ sung cọc cho khách đang ở» (gắn hợp đồng đó) hay «Cọc giữ phòng của khách mới» (để trống hợp đồng, phòng ẩn khỏi
 * sale, hợp đồng mới tự nhận phiếu) — form không tự đoán nữa.
 *
 * Trước đây form tự gắn phiếu cọc vào HĐ đang chạy khi HĐ đó còn thiếu cọc (audit 24/11, ca 331PHI·201): ở phòng sắp
 * trống, cọc của khách MỚI thành cọc khách cũ, bị hoàn cho khách cũ khi thanh lý, HĐ mới không thấy phiếu.
 *
 * Chỉ phiếu THU tạo mới (kể cả tạo bản sao) có hạng mục cọc. Phiếu CHI có hạng mục cọc (hoàn / cấn cọc) và sửa phiếu chờ
 * duyệt giữ cách cũ. Phần hỏi / chặn nằm TRƯỚC bước lưu (resolver của form), ngoài vùng chống rớt mạng của
 * `formCreatePending`.
 */

export type DepositContractChoice = 'existing' | 'new';

/** Dạng tối thiểu của một hợp đồng trên phòng (hàng của `useContractsLegacy`). */
export interface RoomContractLike {
  id: string;
  status: string;
  actual_end_date?: string | null;
  expected_move_out_date?: string | null;
  contract_number?: string | null;
  tenant?: { full_name?: string | null } | null;
}

/** Cùng nghĩa «hợp đồng đang ở» với máy chủ (room_sale_workflow_base_fact_v1, create_room_reservation_v1). */
const EFFECTIVE_STATUSES: readonly string[] = ['ACTIVE', 'EXTENDED'];

export const DEPOSIT_CONTRACT_CHOICE_REQUIRED_MESSAGE =
  'Phòng đang có hợp đồng hiệu lực: chọn «Bổ sung cọc cho khách đang ở» hoặc «Cọc giữ phòng của khách mới».';
export const DEPOSIT_CONTRACT_EXISTING_MISSING_MESSAGE =
  'Chọn hợp đồng của khách đang ở để gắn phiếu cọc bổ sung.';

/** Hợp đồng hiệu lực (kể cả đã gia hạn), chưa ghi ngày trả thực tế. */
export function effectiveRoomContracts<T extends RoomContractLike>(contracts: readonly T[]): T[] {
  return contracts.filter((c) => EFFECTIVE_STATUSES.includes(c.status) && !c.actual_end_date);
}

export interface DepositChoiceContext {
  /** Tạo phiếu mới (kể cả tạo bản sao); sửa phiếu chờ duyệt thì false. */
  creating: boolean;
  voucherType: string | null | undefined;
  hasDepositItem: boolean;
  /** Số hợp đồng hiệu lực trên phòng đã chọn (0 khi chưa chọn phòng). */
  effectiveContractCount: number;
}

/** Form phải hỏi người lập chọn cọc này của ai. */
export function depositContractChoiceRequired(ctx: DepositChoiceContext): boolean {
  return ctx.creating && ctx.voucherType === 'INCOME' && ctx.hasDepositItem && ctx.effectiveContractCount > 0;
}

/** Hợp đồng gắn vào phiếu theo lựa chọn: «khách đang ở» chỉ tự điền khi phòng có đúng một hợp đồng hiệu lực. */
export function contractIdForChoice(choice: DepositContractChoice, effective: readonly RoomContractLike[]): string | null {
  return choice === 'existing' && effective.length === 1 ? effective[0].id : null;
}

/** Lựa chọn suy từ ô Hợp đồng khi người dùng TỰ chọn ở ô đó (không phải giá trị form tự điền). */
export function choiceFromPickedContract(contractId: string | null | undefined): DepositContractChoice {
  return contractId ? 'existing' : 'new';
}

/** Lỗi chặn lưu, hoặc null. */
export function depositContractChoiceError(input: {
  required: boolean;
  choice: DepositContractChoice | null | undefined;
  contractId: string | null | undefined;
}): string | null {
  if (!input.required) return null;
  if (!input.choice) return DEPOSIT_CONTRACT_CHOICE_REQUIRED_MESSAGE;
  if (input.choice === 'existing' && !input.contractId) return DEPOSIT_CONTRACT_EXISTING_MISSING_MESSAGE;
  return null;
}

/**
 * Chọn «khách mới» khi hợp đồng đang ở CHƯA báo trả: cảnh báo, vẫn cho lưu (nhân viên hay thu cọc trước rồi mới ghi
 * báo trả; nút Cọc ở trang Sale thì chặn hẳn). Trả các hợp đồng chưa báo trả để nêu tên.
 */
export function contractsWithoutNotice<T extends RoomContractLike>(effective: readonly T[]): T[] {
  return effective.filter((c) => !c.expected_move_out_date);
}

export function contractLabel(c: RoomContractLike): string {
  const who = c.tenant?.full_name?.trim();
  return [c.contract_number?.trim() || 'HĐ chưa có số', who].filter(Boolean).join(' · ');
}

export function newTenantNoticeWarning(effective: readonly RoomContractLike[]): string | null {
  const missing = contractsWithoutNotice(effective);
  if (missing.length === 0) return null;
  return `Phòng chưa báo trả: ${missing.map(contractLabel).join(', ')} chưa có ngày trả phòng. Vẫn lưu được; nhớ ghi báo trả cho khách đang ở.`;
}
