// Thẻ "TÀI CHÍNH" — cột phải. Một bảng trả lời trọn "khách này nợ gì, trả gì".
//
// Thay cho: thẻ Tiền cọc + thẻ Tóm tắt hoá đơn (cột phải cũ) + tab Hoá đơn +
// tab Thanh toán. Lịch sử từng lần trả tiền không mất — nó thành dòng con dưới
// đúng hoá đơn của nó, đọc được ngay mà không phải sang tab khác rồi tự ghép.
//
// Mọi số tiền in TRẦN, không ký hiệu ₫ (chủ chốt 12/09/2026).

import { Fragment } from 'react';
import { DollarSign, Eye } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import type { ContractWithRelations } from '@/hooks/useContracts';
import type { InvoiceWithRelations } from '@/hooks/useInvoices';
import type { ContractTerminationInfo } from '@/hooks/contracts/useContractDetailData';
import type { ContractDepositVoucher } from '@/components/contracts/detail/types';
import { formatAmount } from '@/components/contracts/detail/formatCurrency';
import { getInvoiceTitle } from '@/lib/invoiceUtils';
import {
  dungBangTaiChinh,
  type DongTien,
  type HoaDonChoBang,
  type PhieuCocChoBang,
} from './contractFinanceRows';
import { DauThe, NutTron, The } from './ui';

/** Ô tiền: null thì để trống hẳn, 0 thì in "0" màu nhạt. */
function OTien({
  gt,
  className = '',
  dongCon = false,
}: {
  gt: number | null;
  className?: string;
  dongCon?: boolean;
}) {
  if (gt === null) {
    return <td className="border-b border-[#f2f4f6] px-2.5 py-[var(--rp)]" />;
  }
  // Gộp -0 về 0: dòng "Công nợ cấn trừ" lấy giá trị `-outstanding_debt`, khi
  // không có nợ thì ra -0 và Intl in ra "-0" — một con số không ai đọc là số.
  const v = gt === 0 ? 0 : gt;
  return (
    <td
      className={`border-b border-[#f2f4f6] px-2.5 text-right tabular-nums ${
        dongCon ? 'pb-1.5 pt-1 text-[12px]' : 'py-[var(--rp)] text-[13px]'
      } ${className}`}
    >
      {v < 0 ? `− ${formatAmount(Math.abs(v))}` : formatAmount(v)}
    </td>
  );
}

function DongChinh({ d, onMo }: { d: DongTien; onMo: (id: string) => void }) {
  return (
    <tr className={d.daHuy ? 'text-gray-400' : undefined}>
      <td className="border-b border-[#f2f4f6] px-[14px] py-[var(--rp)] text-[13px] font-medium">
        <span className={d.daHuy ? 'line-through' : undefined}>{d.ten}</span>
        {d.daHuy && (
          <span className="ml-1.5 rounded border border-gray-200 bg-gray-50 px-1.5 py-px text-[10.5px] font-bold tracking-[.03em] text-gray-500">
            ĐÃ HUỶ
          </span>
        )}
      </td>
      <td className="border-b border-[#f2f4f6] px-2.5 py-[var(--rp)] text-[12.5px] tabular-nums text-[#67737E]">
        {d.ky}
      </td>
      <OTien gt={d.soTien} className="font-medium" />
      <OTien gt={d.daThu} className="font-medium text-[#12764a]" />
      <OTien
        gt={d.conNo}
        className={d.conNo && d.conNo > 0 ? 'font-semibold text-[#dc2626]' : 'text-gray-500'}
      />
      <td className="border-b border-[#f2f4f6] px-1.5 py-[var(--rp)] text-center">
        {d.moHoaDonId && (
          <NutTron size={24} title="Xem chi tiết hoá đơn" onClick={() => onMo(d.moHoaDonId!)}>
            <Eye className="h-[13px] w-[13px]" strokeWidth={2} />
          </NutTron>
        )}
      </td>
    </tr>
  );
}

function DongCon({ d }: { d: DongTien }) {
  return (
    <tr>
      <td className="border-b border-[#f2f4f6] py-1 pb-1.5 pl-[26px] pr-[14px] text-[12px] text-[#67737E]">
        {d.ma && <span className="font-mono text-[#4a5a52]">{d.ma}</span>}
        {d.ma && d.ten ? ' · ' : ''}
        {d.ten}
        {d.ghiChu && <span className="text-[#9ca3af]"> · {d.ghiChu}</span>}
      </td>
      <td className="border-b border-[#f2f4f6] px-2.5 py-1 pb-1.5 text-[12px] tabular-nums text-[#67737E]">
        {d.ky}
      </td>
      <OTien gt={d.soTien === null ? null : d.soTien} dongCon className="text-gray-500" />
      <OTien gt={d.daThu} dongCon className="text-[#12764a]" />
      <OTien gt={d.conNo} dongCon className="text-gray-500" />
      <td className="border-b border-[#f2f4f6]" />
    </tr>
  );
}

interface Props {
  contract: ContractWithRelations;
  depositVouchers: ContractDepositVoucher[];
  invoices: InvoiceWithRelations[] | undefined;
  invoicesLoading: boolean;
  terminationInfo: ContractTerminationInfo | null | undefined;
}

export function ContractFinanceCard({
  contract,
  depositVouchers,
  invoices,
  invoicesLoading,
  terminationInfo,
}: Props) {
  const navigate = useNavigate();
  const dsHoaDon = invoices ?? [];

  const { nhom, tong } = dungBangTaiChinh({
    contract,
    depositVouchers: depositVouchers as unknown as PhieuCocChoBang[],
    invoices: dsHoaDon as unknown as HoaDonChoBang[],
    terminationInfo,
    // Tên hoá đơn dùng đúng hàm cả app đang dùng, để tên ở đây khớp tên ở trang
    // Hoá đơn và trong ghi chú phiếu thu. `hd` chính là phần tử của dsHoaDon đi
    // qua lớp type hẹp của module thuần, nên ép kiểu ngược lại là an toàn —
    // không cần find() lại (vừa O(n²) vừa vỡ nếu không tìm thấy).
    tenHoaDon: (hd) => getInvoiceTitle(hd as unknown as InvoiceWithRelations),
  });

  return (
    <The id="s-taichinh" className="scroll-mt-[150px]">
      {/* MỖI CHIP MỘT CHIỀU TIỀN, KHÔNG GỘP.
          `tong.conNo` chỉ là hiệu số học của bảng, không phải một câu về nghĩa:
          trên HĐT-075854 nó bằng 3.700.000, nhưng 3.293.500 trong đó là tiền
          CHỦ NHÀ phải hoàn khách, chỉ 406.500 mới là tiền thu về. Gộp lại rồi
          dán một nhãn "còn phải thu" là nói sai chiều tiền. */}
      <DauThe icon={DollarSign} nhan="Tài chính">
        {tong.noHoaDon > 0 && (
          <span className="rounded-[5px] border border-red-200 bg-red-50 px-2 py-0.5 text-[12px] font-semibold tabular-nums text-[#dc2626]">
            Nợ hoá đơn {formatAmount(tong.noHoaDon)}
          </span>
        )}
        {tong.thieuCoc > 0 && (
          <span className="rounded-[5px] border border-orange-200 bg-orange-50 px-2 py-0.5 text-[12px] font-semibold tabular-nums text-orange-700">
            Thiếu cọc {formatAmount(tong.thieuCoc)}
          </span>
        )}
        {tong.chuaHoanKhach > 0 && (
          <span className="rounded-[5px] border border-[#f6e3e6] bg-[#fdf3f4] px-2 py-0.5 text-[12px] font-semibold tabular-nums text-[#9f1239]">
            Chưa hoàn khách {formatAmount(tong.chuaHoanKhach)}
          </span>
        )}
        {tong.noHoaDon === 0 && tong.thieuCoc === 0 && tong.chuaHoanKhach === 0 && (
          <span className="rounded-[5px] border border-[#cfe7db] bg-[#eef7f2] px-2 py-0.5 text-[12px] font-semibold text-[#12764a]">
            Không còn khoản nào treo
          </span>
        )}
      </DauThe>

      <div className="overflow-x-auto">
        <table className="w-full min-w-[640px] border-collapse">
          <thead>
            <tr className="bg-[#fafbfc]">
              <th className="border-b border-[#e2e5ea] px-[14px] py-[7px] text-left text-[10.5px] font-bold uppercase tracking-[.06em] text-[#67737E]">
                Khoản mục
              </th>
              <th className="w-[118px] border-b border-[#e2e5ea] px-2.5 py-[7px] text-left text-[10.5px] font-bold uppercase tracking-[.06em] text-[#67737E]">
                Kỳ / ngày
              </th>
              <th className="w-[98px] border-b border-[#e2e5ea] px-2.5 py-[7px] text-right text-[10.5px] font-bold uppercase tracking-[.06em] text-[#67737E]">
                Số tiền
              </th>
              <th className="w-[98px] border-b border-[#e2e5ea] px-2.5 py-[7px] text-right text-[10.5px] font-bold uppercase tracking-[.06em] text-[#67737E]">
                Đã thu
              </th>
              <th className="w-[98px] border-b border-[#e2e5ea] px-2.5 py-[7px] text-right text-[10.5px] font-bold uppercase tracking-[.06em] text-[#67737E]">
                Còn nợ
              </th>
              <th className="w-[34px] border-b border-[#e2e5ea]" />
            </tr>
          </thead>
          <tbody>
            {nhom.map((g) => (
              <Fragment key={g.khoa}>
                <tr>
                  <td
                    colSpan={6}
                    className={`px-[14px] py-[5px] text-[10.5px] font-bold uppercase tracking-[.08em] ${
                      g.toDo
                        ? 'border-y border-[#f6e3e6] bg-[#fdf3f4] text-[#9f1239]'
                        : 'border-y border-[#e6ece9] bg-[#f1f6f3] text-[#146e47]'
                    }`}
                  >
                    {g.tieuDe}
                  </td>
                </tr>

                {g.khoa === 'HOA_DON' && invoicesLoading && (
                  <tr>
                    <td colSpan={6} className="px-[14px] py-3 text-[12.5px] text-[#67737E]">
                      Đang tải hoá đơn…
                    </td>
                  </tr>
                )}
                {g.khoa === 'HOA_DON' && !invoicesLoading && g.dong.length === 0 && (
                  <tr>
                    <td colSpan={6} className="px-[14px] py-3 text-[12.5px] text-[#67737E]">
                      Hợp đồng chưa có hoá đơn nào.
                    </td>
                  </tr>
                )}

                {g.dong.map((d) =>
                  d.laDongCon ? (
                    <DongCon key={d.id} d={d} />
                  ) : (
                    <DongChinh key={d.id} d={d} onMo={(id) => navigate(`/invoices/${id}`)} />
                  ),
                )}

                {g.canhBao && (
                  <tr>
                    <td
                      colSpan={6}
                      className="border-b border-[#f2f4f6] bg-[#fffbfb] px-[14px] py-[7px] text-[12px] text-[#9f1239]"
                    >
                      {g.canhBao}
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
          <tfoot>
            <tr className="bg-[#f7f9f8]">
              <td className="border-t border-[#e2e5ea] px-[14px] py-[9px] text-[12.5px] font-bold uppercase tracking-[.04em] text-[#33443c]">
                Tổng cộng
              </td>
              <td className="border-t border-[#e2e5ea] px-2.5 py-[9px] text-[12px] text-[#67737E]">
                {tong.soHoaDon} hoá đơn
                {contract.status === 'TERMINATED' && terminationInfo ? ' · 1 quyết toán' : ''}
              </td>
              <td className="border-t border-[#e2e5ea] px-2.5 py-[9px] text-right text-[14px] font-bold tabular-nums">
                {formatAmount(tong.soTien)}
              </td>
              <td className="border-t border-[#e2e5ea] px-2.5 py-[9px] text-right text-[14px] font-bold tabular-nums text-[#12764a]">
                {formatAmount(tong.daThu)}
              </td>
              <td
                className={`border-t border-[#e2e5ea] px-2.5 py-[9px] text-right text-[14px] font-bold tabular-nums ${
                  tong.conNo > 0 ? 'text-[#dc2626]' : 'text-gray-500'
                }`}
              >
                {formatAmount(tong.conNo)}
              </td>
              <td className="border-t border-[#e2e5ea]" />
            </tr>
          </tfoot>
        </table>
      </div>
    </The>
  );
}
