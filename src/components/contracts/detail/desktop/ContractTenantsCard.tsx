// Thẻ "KHÁCH THUÊ" — cột trái, thẻ 2.
//
// Bản cũ dàn mỗi khách thành lưới 2 cột nhãn-trên-giá-trị (Số điện thoại /
// Email / CCCD), tốn 4 dòng cho một người và phải cuộn khi HĐ có 3 khách. Ở đây
// mỗi khách gói trong MỘT dòng meta ngăn bằng dấu ·: icon đã nói rõ đó là số
// gì, nhãn chữ chỉ là chỗ chiếm giấy.

import { CreditCard, Eye, Mail, Phone, User, Bike } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import type { ContractWithRelations } from '@/hooks/useContracts';
import type { ContractVehicle } from '@/components/contracts/detail/types';
import { ChipXanh, DauThe, NutTron, The } from './ui';

/** "Trần Hữu Khánh" → "TK". Lấy chữ đầu của hai từ cuối (tên + đệm). */
function vietTat(ten: string): string {
  const tu = ten.trim().split(/\s+/).filter(Boolean);
  if (tu.length === 0) return '?';
  if (tu.length === 1) return tu[0]!.slice(0, 2).toUpperCase();
  return (tu[tu.length - 2]![0]! + tu[tu.length - 1]![0]!).toUpperCase();
}

function MucMeta({
  icon: Icon,
  children,
  nhat = false,
}: {
  icon: typeof Phone;
  children: React.ReactNode;
  nhat?: boolean;
}) {
  return (
    <span className={`inline-flex items-center gap-1.5 ${nhat ? 'text-gray-500' : ''}`}>
      <Icon className="h-[15px] w-[15px] shrink-0 text-[#67737E]" strokeWidth={2} />
      {children}
    </span>
  );
}

interface Props {
  contract: ContractWithRelations;
  customers: NonNullable<ContractWithRelations['contract_customers']>;
  vehiclesByCustomer: Map<string, ContractVehicle[]>;
}

export function ContractTenantsCard({ customers, vehiclesByCustomer }: Props) {
  const navigate = useNavigate();

  return (
    <The id="s-khachhang" className="scroll-mt-[150px]">
      <DauThe icon={User} nhan="Khách thuê">
        {customers.length > 0 && <ChipXanh>{customers.length} người</ChipXanh>}
      </DauThe>

      {customers.length === 0 ? (
        <div className="px-[var(--px)] py-8 text-center text-[length:var(--fs)] text-[#67737E]">
          Hợp đồng chưa có khách hàng nào.
        </div>
      ) : (
        customers.map((cc, i) => {
          const ten = cc.customer?.full_name || 'Chưa có tên';
          const xe = vehiclesByCustomer.get(cc.customer_id) ?? [];
          const bienSo = xe
            .map((v) => v.license_plate)
            .filter((b): b is string => !!b)
            .join(', ');
          return (
            <div
              key={cc.id}
              className={`grid grid-cols-[40px_minmax(0,1fr)_30px] items-center gap-3.5 px-[var(--px)] py-3 ${
                i < customers.length - 1 ? 'border-b border-[#f2f4f6]' : ''
              }`}
            >
              <div
                className={`flex h-[40px] w-[40px] items-center justify-center rounded-full text-[14px] font-bold ${
                  cc.is_representative
                    ? 'bg-[#eef7f2] text-[#12764a]'
                    : 'bg-[#f1f3f5] text-[#5a6862]'
                }`}
              >
                {vietTat(ten)}
              </div>

              <div className="min-w-0">
                <div className="flex items-center gap-1.5">
                  <span className="text-[15.5px] font-semibold">{ten}</span>
                  {cc.is_representative && (
                    <span className="inline-flex rounded border border-[#cfe7db] bg-[#eef7f2] px-2 py-0.5 text-[11px] font-bold tracking-[.03em] text-[#12764a]">
                      ĐẠI DIỆN
                    </span>
                  )}
                </div>

                <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[length:var(--fs-sm)] tabular-nums text-[#4a5a52]">
                  <MucMeta icon={Phone} nhat={!cc.customer?.phone}>
                    {cc.customer?.phone || 'Chưa có'}
                  </MucMeta>
                  <span className="text-[#c9d0d4]">·</span>
                  <MucMeta icon={CreditCard} nhat={!cc.customer?.id_number}>
                    {cc.customer?.id_number || 'Chưa có'}
                  </MucMeta>
                  <span className="text-[#c9d0d4]">·</span>
                  <MucMeta icon={Bike} nhat={!bienSo}>
                    {bienSo || 'Không'}
                  </MucMeta>
                  <span className="text-[#c9d0d4]">·</span>
                  <MucMeta icon={Mail} nhat={!cc.customer?.email}>
                    {cc.customer?.email || 'Chưa có'}
                  </MucMeta>
                </div>

                {cc.notes && (
                  <div className="mt-2 whitespace-pre-wrap rounded border border-amber-200 bg-amber-50 px-2.5 py-1.5 text-[length:var(--fs-sm)] text-amber-900">
                    {cc.notes}
                  </div>
                )}
              </div>

              <NutTron
                title="Xem chi tiết khách thuê"
                onClick={() => navigate(`/customers/${cc.customer_id}`)}
              >
                <Eye className="h-4 w-4" strokeWidth={2} />
              </NutTron>
            </div>
          );
        })
      )}
    </The>
  );
}
