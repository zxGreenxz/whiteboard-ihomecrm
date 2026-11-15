// Lối tắt "Tạm ứng lợi nhuận" ở trang Lương của tôi → tab "Tạm ứng LN" của trang Báo cáo Lợi Nhuận.
// Chỉ hiện với người đang đăng nhập là cổ đông VÀ được chủ cấp riêng quyền tạm ứng
// (shareholder_profit.advance_own_cashbook). Chỉ trang "Lương của tôi" gắn lối tắt này — màn quản trị
// xem lương người khác không gắn, nên không bao giờ hiện lối tắt của người khác.
// Quyền / hồ sơ cổ đông chưa tải được thì KHÔNG hiện lối tắt (đây chỉ là đường tắt, không phải số liệu;
// trang đích tự báo lỗi của nó).

import { Link } from 'react-router-dom';
import { HandCoins } from 'lucide-react';
import { useMyPermissions } from '@/hooks/useMyPermissions';
import { useMyShareholder } from '@/hooks/useShareholders';
import { canUse } from '@/lib/permissionPages';

export const SELF_ADVANCE_HREF = '/reports/finance/profit-distribution?tab=my-advance';

export default function SelfAdvanceLink() {
  const { data: perms } = useMyPermissions();
  const { data: me } = useMyShareholder();
  if (!me || !canUse(perms, 'shareholder_profit', 'advance_own_cashbook')) return null;
  return (
    <Link
      to={SELF_ADVANCE_HREF}
      className="inline-flex min-h-[44px] items-center gap-2 self-start rounded-[10px] border bg-card px-3.5 text-[13.5px] font-bold"
    >
      <HandCoins size={18} aria-hidden="true" />Tạm ứng lợi nhuận
    </Link>
  );
}
