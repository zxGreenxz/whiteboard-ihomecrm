import { friendlyError } from '@/lib/friendlyError';
import { COMMISSION_REASON_MESSAGE } from '@/lib/commissionAudit';

const unavailableMessage = 'Phòng đã chọn không còn trống hoặc không còn sử dụng. Vui lòng chọn phòng khác.';
const unavailableRules = [
  { code: '55000', message: 'Phòng mới không còn trống', description: unavailableMessage },
  { code: 'P0001', message: 'Phòng mới đã có hợp đồng đang hiệu lực', description: unavailableMessage },
  { code: 'P0001', message: 'Phòng mới không tồn tại', description: unavailableMessage },
];

export function isTransferRoomUnavailable(error: unknown): boolean {
  if (!error || typeof error !== 'object' || !('code' in error) || !('message' in error)) return false;
  return unavailableRules.some(rule => error.code === rule.code && error.message === rule.message);
}

export function transferRoomFeedback(error: unknown) {
  return friendlyError(error, 'Chưa chuyển phòng.', {
    operation: 'chuyển phòng',
    financial: true,
    rules: [
      ...unavailableRules,
      { code: '42501', message: /^Phòng mới thuộc toà khác/, description: 'Chuyển phòng chỉ áp dụng trong cùng tòa. Nếu đổi tòa, hãy thanh lý hợp đồng cũ rồi lập hợp đồng mới.' },
      { code: 'PT409', message: /^Hợp đồng đã thay đổi/, description: 'Hợp đồng đã thay đổi. Hãy mở lại biểu mẫu và kiểm tra thông tin mới trước khi chuyển phòng.' },
      { code: 'P0001', message: 'Chỉ chuyển phòng được khi hợp đồng đang hiệu lực', description: 'Hợp đồng đã hết hiệu lực chuyển phòng. Hãy kiểm tra lại trạng thái hợp đồng.' },
      { code: '22023', message: /^Cần ghi rõ lý do thay đổi hoa hồng/, description: COMMISSION_REASON_MESSAGE },
      { code: '22023', message: 'Ngày chuyển phải sau lần chuyển phòng gần nhất', description: 'Chọn một ngày sau lần chuyển gần nhất trong lịch sử hợp đồng.' },
      { code: '22023', message: 'Ngày chuyển không được trước ngày bắt đầu hợp đồng', description: 'Ngày chuyển phải từ ngày bắt đầu hợp đồng trở đi.' },
      { code: '22023', message: 'Ngày chuyển không được ở tương lai', description: 'Chọn ngày khách thực tế chuyển phòng, từ hôm nay trở về trước.' },
    ],
  });
}
