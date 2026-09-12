// Thẻ "HỢP ĐỒNG & DỊCH VỤ" + khối "LỊCH SỬ HỢP ĐỒNG" — cột trái, thẻ 1.
//
// Gộp ba thứ bản cũ để rời: thẻ Thông tin hợp đồng, tab Dịch vụ, tab Lịch sử.
// Hai cột con nằm trong lưới gap 1px trên nền #eef0f3 — khe lưới CHÍNH LÀ đường
// kẻ, nên không cần border riêng và không bị kẻ đôi khi xuống một cột.

import { Droplets, ExternalLink, FileText, Settings, Zap } from 'lucide-react';
import type { ContractWithRelations } from '@/hooks/useContracts';
import type { ContractServiceItem, ContractHistoryItem } from '@/components/contracts/detail/types';
import { formatAmount } from '@/components/contracts/detail/formatCurrency';
import { dungDongLichSu } from './contractHistoryLines';
import { DauThe, DongKV, NhanMuc, The } from './ui';

const CHU_KY: Record<string, string> = {
  MONTHLY: 'Hàng tháng',
  QUARTERLY: 'Hàng quý',
  SEMI_ANNUAL: '6 tháng',
  ANNUAL: 'Hàng năm',
};

const LOAI_DICH_VU: Record<string, string> = {
  FIXED: 'Cố định',
  PER_PERSON: 'Theo người',
  PER_ROOM: 'Theo căn hộ',
  METER_READING: 'Theo công tơ',
};

const ngayVn = (gt: string | null | undefined): string => {
  if (!gt) return '—';
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(gt);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : gt;
};

interface Props {
  contract: ContractWithRelations;
  services: ContractServiceItem[];
  servicesLoading: boolean;
  history: ContractHistoryItem[];
  historyLoading: boolean;
}

export function ContractTermsCard({
  contract,
  services,
  servicesLoading,
  history,
  historyLoading,
}: Props) {
  const dongLichSu = dungDongLichSu({ contract, history });

  return (
    <The id="s-hopdong" className="scroll-mt-[150px]">
      <DauThe icon={FileText} nhan="Hợp đồng &amp; dịch vụ" />

      <div className="grid gap-px bg-[#eef0f3] [grid-template-columns:repeat(auto-fit,minmax(340px,1fr))]">
        {/* ── Cột con: Hợp đồng ───────────────────────────────── */}
        <div className="min-w-0 bg-white">
          <NhanMuc>Hợp đồng</NhanMuc>
          <DongKV nhan="Số hợp đồng">{contract.contract_number || '—'}</DongKV>
          <DongKV nhan="Ngày ký">{ngayVn(contract.signed_date)}</DongKV>
          <DongKV nhan="Bắt đầu">{ngayVn(contract.start_date)}</DongKV>
          <DongKV nhan="Kết thúc">{ngayVn(contract.end_date)}</DongKV>
          <DongKV nhan="Giá thuê" className="font-semibold text-[#12764a]">
            {formatAmount(contract.rent_price ?? 0)} /{' '}
            {(CHU_KY[contract.payment_cycle ?? ''] ?? 'kỳ').toLowerCase()}
          </DongKV>
          <DongKV nhan="Chu kỳ">{CHU_KY[contract.payment_cycle ?? ''] ?? '—'}</DongKV>
          <DongKV nhan="Tiền cọc">{formatAmount(contract.total_deposit ?? 0)}</DongKV>
          {contract.contract_file_url && (
            <DongKV nhan="File hợp đồng">
              <a
                href={contract.contract_file_url}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 text-[#12764a] hover:underline"
              >
                Xem bản scan
                <ExternalLink className="h-3 w-3" strokeWidth={2} />
              </a>
            </DongKV>
          )}
        </div>

        {/* ── Cột con: Dịch vụ ────────────────────────────────── */}
        <div className="min-w-0 bg-white">
          <NhanMuc>Dịch vụ</NhanMuc>

          <div className="flex flex-wrap items-center gap-x-6 gap-y-2 border-t border-[#f2f4f6] px-[var(--px)] py-[var(--rp)] text-[length:var(--fs)] tabular-nums">
            <span className="text-[length:var(--fs-sm)] text-[#67737E]">Chỉ số đầu</span>
            <span className="inline-flex items-center gap-1.5">
              <Zap className="h-[15px] w-[15px] text-[#eab308]" strokeWidth={2} />
              <span className="font-medium">
                {contract.initial_electricity_reading ?? '—'}
              </span>
              <span className="text-[length:var(--fs-sm)] text-[#67737E]">kWh</span>
            </span>
            <span className="inline-flex items-center gap-1.5">
              <Droplets className="h-[15px] w-[15px] text-[#3b82f6]" strokeWidth={2} />
              <span className="font-medium">{contract.initial_water_reading ?? '—'}</span>
              <span className="text-[length:var(--fs-sm)] text-[#67737E]">m³</span>
            </span>
          </div>

          {servicesLoading ? (
            <div className="border-t border-[#f2f4f6] px-[var(--px)] py-[var(--rp)] text-[length:var(--fs-sm)] text-[#67737E]">
              Đang tải dịch vụ…
            </div>
          ) : services.length === 0 ? (
            <div className="border-t border-[#f2f4f6] px-[var(--px)] py-[var(--rp)] text-[length:var(--fs-sm)] text-[#67737E]">
              Hợp đồng chưa đăng ký dịch vụ nào.
            </div>
          ) : (
            <table className="w-full border-collapse">
              <tbody>
                {services.map((cs) => (
                  <tr key={cs.id}>
                    <td className="border-t border-[#f2f4f6] px-[var(--px)] py-[var(--rp)] text-[length:var(--fs)] font-medium">
                      <span className="inline-flex items-center gap-1.5">
                        {cs.service.type === 'METER_READING' ? (
                          <Zap className="h-[15px] w-[15px] text-[#eab308]" strokeWidth={2} />
                        ) : (
                          <Settings className="h-[15px] w-[15px] text-[#9ca3af]" strokeWidth={2} />
                        )}
                        {cs.service.name}
                      </span>
                    </td>
                    <td className="border-t border-[#f2f4f6] px-2 py-[var(--rp)] text-[length:var(--fs-sm)] text-[#67737E]">
                      {LOAI_DICH_VU[cs.service.type] ?? cs.service.type}
                    </td>
                    <td className="border-t border-[#f2f4f6] px-[var(--px)] py-[var(--rp)] text-right text-[length:var(--fs)] font-medium tabular-nums">
                      {formatAmount(cs.unit_price)}
                      {cs.service.unit && (
                        <span className="text-[length:var(--fs-sm)] font-normal text-[#67737E]">
                          {' '}
                          /{cs.service.unit}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {/* Ghi chú đứng RIÊNG một khối rộng cả thẻ, không nhét vào cột giá trị
          của lưới key-value: ghi chú thanh lý thật dài cả chục dòng (bản quyết
          toán từng khoản nằm ở đây), nhồi vào cột hẹp thì thẻ cao ngoằng mà chữ
          vẫn khó đọc. */}
      {contract.notes && (
        <div className="border-t border-[#eef0f3]">
          <NhanMuc>Ghi chú</NhanMuc>
          <div className="whitespace-pre-wrap border-t border-[#f2f4f6] px-[var(--px)] py-[var(--rp)] text-[length:var(--fs-sm)] leading-[1.6] text-[#4a5a52]">
            {contract.notes}
          </div>
        </div>
      )}

      {/* ── Lịch sử ───────────────────────────────────────────── */}
      <div className="border-t border-[#eef0f3]">
        <NhanMuc>Lịch sử hợp đồng</NhanMuc>
        {historyLoading ? (
          <div className="border-t border-[#f2f4f6] px-[var(--px)] py-[var(--rp)] text-[length:var(--fs-sm)] text-[#67737E]">
            Đang tải lịch sử…
          </div>
        ) : (
          dongLichSu.map((d) => (
            <div
              key={d.id}
              className="grid grid-cols-[100px_minmax(0,1fr)_120px] items-baseline gap-3 border-t border-[#f2f4f6] px-[var(--px)] py-[var(--rp)] text-[length:var(--fs)]"
            >
              <span className="text-[length:var(--fs-sm)] tabular-nums text-[#67737E]">{d.ngay}</span>
              <span>
                <span className="font-medium">{d.tieuDe}</span>
                {d.moTa && <span className="text-[length:var(--fs-sm)] text-[#67737E]"> — {d.moTa}</span>}
              </span>
              <span
                className={`justify-self-end whitespace-nowrap rounded border px-2 py-0.5 text-[11px] font-bold tracking-[.03em] ${d.lopNhan}`}
              >
                {d.nhan}
              </span>
            </div>
          ))
        )}
      </div>
    </The>
  );
}
