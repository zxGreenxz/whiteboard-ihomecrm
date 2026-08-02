import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  DollarSign,
  Clock,
  AlertCircle,
  CheckCircle,
  Receipt,
} from 'lucide-react';
import { format } from 'date-fns';
import type { ContractWithRelations } from '@/hooks/useContracts';
import type { InvoiceWithRelations } from '@/hooks/useInvoices';
import type { ContractTerminationInfo } from '@/hooks/contracts/useContractDetailData';
import type { ContractDepositVoucher } from '@/components/contracts/detail/types';
import { formatCurrency } from './formatCurrency';

interface ContractSummaryProps {
  contract: ContractWithRelations;
  /** Quyết toán thanh lý (audit contract_terminations) — chỉ có khi TERMINATED. */
  terminationInfo: ContractTerminationInfo | null | undefined;
  pendingForfeitCount: number;
  pendingRefundCount: number;
  depositVouchers: ContractDepositVoucher[];
  invoices: InvoiceWithRelations[] | undefined;
  totalInvoiced: number;
  totalPaid: number;
  outstandingAmount: number;
  totalDays: number;
  daysElapsed: number;
  daysRemaining: number;
}

/** Cột phải tab "Thông tin chung" — quyết toán thanh lý / tiền cọc / tóm tắt
 *  hoá đơn / thời gian. Tách nguyên văn từ ContractDetailView (Phase 10D). */
export function ContractSummary({
  contract,
  terminationInfo,
  pendingForfeitCount,
  pendingRefundCount,
  depositVouchers,
  invoices,
  totalInvoiced,
  totalPaid,
  outstandingAmount,
  totalDays,
  daysElapsed,
  daysRemaining,
}: ContractSummaryProps) {
  return (
    <div className="space-y-6">
      {/* Quyết toán thanh lý — trả lời "thanh lý gồm những gì" tại 1 chỗ.
          Nguồn: contract_terminations (audit); chi tiết đầy đủ trong
          Ghi chú hợp đồng + phiếu "Trả khách thanh lý". */}
      {contract.status === 'TERMINATED' && terminationInfo && (
        <Card className="border-rose-200">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-rose-800">
              <DollarSign className="h-5 w-5" />
              Quyết toán thanh lý
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <div className="flex justify-between">
              <span className="text-gray-600">Hình thức:</span>
              <span className="font-medium">
                {terminationInfo.termination_type === 'FORFEIT'
                  ? 'Khách bỏ cọc'
                  : 'Khách rời phòng'}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-600">Ngày thanh lý:</span>
              <span>
                {terminationInfo.actual_move_out_date
                  ? format(new Date(terminationInfo.actual_move_out_date), 'dd/MM/yyyy')
                  : '—'}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-600">Cọc tính quyết toán:</span>
              <span className="font-medium">
                {formatCurrency(Number(terminationInfo.total_deposit || 0))}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-600">Công nợ cấn trừ:</span>
              <span>{formatCurrency(Number(terminationInfo.outstanding_debt || 0))}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-600">Phí phạt + thu thêm:</span>
              <span>{formatCurrency(Number(terminationInfo.early_termination_fee || 0))}</span>
            </div>
            {/* HAI SỐ, HAI NGHĨA — đừng gộp lại (Slice −1 · §−1.7, §A0.R2):
                · "Net quyết toán" = cột GENERATED `refund_amount` của hồ sơ
                  thanh lý = cọc-ghi-trên-HĐ − khấu trừ-ghi-trên-hồ-sơ. Là số
                  LỊCH SỬ, KHÔNG phải khoản phải trả khách. Ca HĐ 69cdb5dc:
                  2.428.500 = 3.500.000 cọc *chưa bao giờ thu* − 1.071.500 cấn
                  cọc *chưa bao giờ vào sổ* (phiếu PC2607118 đã CANCELLED nhưng
                  `early_termination_fee` vẫn nuôi công thức GENERATED).
                · "Đã hoàn thực tế" = Σ phiếu chi hoàn cọc đã DUYỆT và đã VÀO SỔ
                  — số duy nhất chứng minh tiền ra khỏi két. Cùng HĐ đó chỉ có
                  1.450.000 (PC2607119), lệch −978.500 so với net hồ sơ. */}
            <div className="border-t pt-2 flex justify-between">
              <span className="text-gray-900 font-medium">
                {terminationInfo.termination_type === 'FORFEIT'
                  ? 'Cọc giữ làm doanh thu:'
                  : 'Net quyết toán (hồ sơ, lịch sử):'}
              </span>
              <span className="font-bold text-rose-700">
                {formatCurrency(
                  terminationInfo.termination_type === 'FORFEIT'
                    ? Number(terminationInfo.early_termination_fee || 0)
                    : Number(terminationInfo.refund_amount || 0),
                )}
              </span>
            </div>
            {terminationInfo.termination_type !== 'FORFEIT' && (
              <div className="flex justify-between">
                <span className="text-gray-600">Đã hoàn thực tế (phiếu đã vào sổ):</span>
                {terminationInfo.posted_refund_count > 0 ? (
                  <span className="font-medium text-green-700">
                    {formatCurrency(terminationInfo.posted_refund)}
                  </span>
                ) : (
                  <span className="font-medium text-orange-600">
                    Chưa có phiếu hoàn
                  </span>
                )}
              </div>
            )}
            {terminationInfo.termination_type !== 'FORFEIT' &&
              terminationInfo.posted_refund_codes.length > 0 && (
                <p className="text-xs text-muted-foreground">
                  Phiếu hoàn đã vào sổ:{' '}
                  <span className="font-mono">
                    {terminationInfo.posted_refund_codes.join(', ')}
                  </span>
                </p>
              )}
            {terminationInfo.termination_type !== 'FORFEIT' &&
              Number(terminationInfo.refund_amount || 0) > 0 &&
              Number(terminationInfo.refund_amount || 0) !==
                terminationInfo.posted_refund && (
                <p className="text-xs text-amber-700">
                  Hồ sơ và phiếu đã vào sổ lệch nhau{' '}
                  {formatCurrency(
                    Number(terminationInfo.refund_amount || 0) -
                      terminationInfo.posted_refund,
                  )}
                  {' '}— cần rà tay, <b>không</b> tự sửa số.
                </p>
              )}
            {terminationInfo.termination_type !== 'FORFEIT' &&
              Number(terminationInfo.refund_amount || 0) < 0 && (
                <div className="flex justify-between">
                  <span className="text-gray-600">Khách còn phải trả:</span>
                  <span className="font-medium text-red-600">
                    {formatCurrency(Math.abs(Number(terminationInfo.refund_amount || 0)))}
                  </span>
                </div>
              )}
            <p className="text-xs text-muted-foreground pt-1">
              Bản quyết toán chi tiết từng khoản nằm trong <b>Ghi chú</b>{' '}
              hợp đồng và ghi chú phiếu "Trả khách thanh lý" / hoá đơn
              thanh lý (mục "QUYẾT TOÁN THANH LÝ").
            </p>
          </CardContent>
        </Card>
      )}

      {/* Deposit Summary Card */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <DollarSign className="h-5 w-5" />
            Tiền cọc
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* B1: nhắc phiếu thanh lý còn treo (duyệt cọc bỏ / chọn sổ hoàn khách) */}
          {(pendingForfeitCount > 0 || pendingRefundCount > 0) && (
            <Alert className="bg-amber-50 border-amber-300">
              <AlertCircle className="h-4 w-4 text-amber-600" />
              <AlertDescription className="text-amber-900 text-sm space-y-1">
                <p className="font-medium">
                  Phiếu thanh lý chờ xử lý (
                  {pendingForfeitCount + pendingRefundCount} phiếu)
                </p>
                {pendingForfeitCount > 0 && (
                  <p className="text-xs">
                    Vào <a href="/income-expense" className="underline font-medium">Thu chi</a>{' '}
                    bấm <b>Duyệt</b> phiếu "Doanh thu bỏ cọc" thì cọc mới
                    vào doanh thu và hoá đơn thanh lý mới tất toán.
                  </p>
                )}
                {pendingRefundCount > 0 && (
                  <p className="text-xs">
                    Phiếu chi <b>"Trả khách thanh lý"</b> đang chờ: vào{' '}
                    <a href="/income-expense" className="underline font-medium">Thu chi</a>{' '}
                    → Sửa phiếu → <b>chọn sổ quỹ chi tiền</b> → Duyệt
                    (chưa chọn sổ sẽ không duyệt được).
                  </p>
                )}
              </AlertDescription>
            </Alert>
          )}
          <div className="space-y-2 text-sm">
            <div className="flex justify-between">
              <span className="text-gray-600">Tổng tiền cọc:</span>
              <span className="font-bold">{formatCurrency(contract.total_deposit || 0)}</span>
            </div>
            {/* VÌ SAO "Đã thu" CÓ THỂ BẰNG 0 DÙ HĐ ĐÃ TỪNG CÓ CỌC — đừng "sửa"
                lại thành total_deposit (Slice −1 · §−1.7 / §A0.R2):
                `contracts.deposit_paid` KHÔNG phải số nhập tay (trigger
                `guard_contract_deposit_paid_derived` chặn sửa tay). Nó do
                `contract_deposit_paid_derived()` tính:
                  GREATEST(0, Σ (INCOME +1 / EXPENSE −1) × item.amount)
                trên các item `accounting_class='DEPOSIT'` của phiếu APPROVED còn
                sống, gắn HĐ qua `income_expenses.contract_id` hoặc
                `contract_deposit_links`.
                ⇒ Nó là "cọc CÒN ĐANG GIỮ", không phải "cọc đã từng thu".
                Ca HĐ 69cdb5dc (417LVT/L04): cọc duy nhất từng ghi là phiếu ẢO
                đầu kỳ PT2607060 1.450.000 (`system_source='contract.deposit'`,
                APPROVED nhưng `posting_status='NOT_APPLICABLE'` — tiền khách
                đóng TRƯỚC khi dùng phần mềm nên không chạy qua sổ quỹ), rồi phiếu
                hoàn PC2607119 1.450.000 (EXPENSE, POSTED) trừ hết ⇒ derived = 0.
                Nên "Đã thu 0đ" ở đây nghĩa là "đã trả hết lại khách", KHÔNG phải
                "chưa bao giờ thu". `contracts.total_deposit` (3.500.000) là mức
                cọc THEO HĐ, chưa bao giờ thu đủ. */}
            <div className="flex justify-between">
              <span className="text-gray-600">Đã thu (còn đang giữ):</span>
              <span className="font-medium text-green-600">
                {formatCurrency(contract.deposit_paid || 0)}
              </span>
            </div>
            {(contract.deposit_paid || 0) === 0 && depositVouchers.length > 0 && (
              <p className="text-xs text-muted-foreground">
                Có {depositVouchers.length} phiếu cọc trong hồ sơ nhưng số cọc đang
                giữ bằng 0 — cọc đã được hoàn/cấn hết. Xem danh sách phiếu bên dưới.
              </p>
            )}
            <div className="border-t pt-2 flex justify-between">
              <span className="text-gray-900 font-medium">Còn lại:</span>
              <span className={`font-bold ${(contract.deposit_remaining || 0) > 0 ? 'text-orange-600' : 'text-gray-500'}`}>
                {formatCurrency(contract.deposit_remaining || 0)}
              </span>
            </div>
          </div>

          {(contract.deposit_remaining || 0) <= 0 ? (
            <Alert className="bg-green-50 border-green-200">
              <CheckCircle className="h-4 w-4 text-green-600" />
              <AlertDescription className="text-green-800 text-sm">
                Đã thu đủ tiền cọc
              </AlertDescription>
            </Alert>
          ) : (contract as any).deposit_debt_mode === 'FIRST_INVOICE' ? (
            <Alert className="bg-blue-50 border-blue-200">
              <AlertCircle className="h-4 w-4 text-blue-600" />
              <AlertDescription className="text-blue-800 text-sm space-y-1">
                <p className="font-medium">
                  Còn {formatCurrency(contract.deposit_remaining || 0)} cọc — thu trong hoá đơn đầu
                </p>
                <p className="text-xs">
                  Khách thanh toán đủ cọc trong hoá đơn cọc + tháng đầu (không nhắc bổ sung).
                </p>
              </AlertDescription>
            </Alert>
          ) : (
            <Alert className="bg-orange-50 border-orange-200">
              <AlertCircle className="h-4 w-4 text-orange-600" />
              <AlertDescription className="text-orange-800 text-sm space-y-1">
                <p className="font-medium">
                  Còn thiếu {formatCurrency(contract.deposit_remaining || 0)} tiền cọc
                </p>
                {(contract as any).deposit_debt_reason && (
                  <p className="text-xs">
                    Lý do cho nợ: {(contract as any).deposit_debt_reason}
                  </p>
                )}
                {(contract as any).deposit_topup_due_date && (
                  <p className="text-xs">
                    Hẹn bổ sung:{' '}
                    {format(
                      new Date((contract as any).deposit_topup_due_date),
                      'dd/MM/yyyy',
                    )}
                  </p>
                )}
              </AlertDescription>
            </Alert>
          )}

          {/* Danh sách phiếu cọc đã link — minh bạch nguồn gốc của
              contracts.deposit_paid. Mỗi phiếu là 1 row IE INCOME có
              item is_deposit. */}
          {depositVouchers.length > 0 && (
            <div className="pt-3 border-t">
              <p className="text-xs font-medium text-gray-600 mb-2">
                Phiếu thu cọc đã ghi nhận
              </p>
              <div className="space-y-1.5">
                {depositVouchers.map((v: any) => (
                  <div
                    key={v.id}
                    className="flex justify-between items-start text-xs gap-2"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="font-mono text-gray-500">{v.code}</p>
                      <p className="text-gray-700 truncate">
                        {format(new Date(v.voucher_date), 'dd/MM/yyyy')}
                        {v.account?.name ? ` · ${v.account.name}` : ''}
                        {v.approval_status !== 'APPROVED'
                          ? ` · ${v.approval_status}`
                          : ''}
                        {/* Phiếu cọc đầu kỳ: lên sổ ảo, KHÔNG qua sổ quỹ. Nói rõ
                            để không ai đi tìm dòng tiền tương ứng trong két. */}
                        {v.posting_status === 'NOT_APPLICABLE'
                          ? ' · cọc đầu kỳ (không vào sổ quỹ)'
                          : ''}
                      </p>
                    </div>
                    <span className="font-medium text-green-700 whitespace-nowrap">
                      {formatCurrency(Number(v.total_amount) || 0)}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Invoice Summary Card */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Receipt className="h-5 w-5" />
            Tóm tắt hóa đơn
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2 text-sm">
            <div className="flex justify-between">
              <span className="text-gray-600">Tổng hóa đơn:</span>
              <span className="font-medium">{invoices?.length || 0}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-600">Tổng phát sinh:</span>
              <span className="font-bold">{formatCurrency(totalInvoiced)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-600">Đã thanh toán:</span>
              <span className="font-medium text-green-600">{formatCurrency(totalPaid)}</span>
            </div>
            <div className="border-t pt-2 flex justify-between">
              <span className="text-gray-900 font-medium">Công nợ:</span>
              <span className={`font-bold text-lg ${outstandingAmount > 0 ? 'text-red-600' : 'text-gray-500'}`}>
                {formatCurrency(outstandingAmount)}
              </span>
            </div>
          </div>

          {outstandingAmount <= 0 && invoices && invoices.length > 0 && (
            <Alert className="bg-green-50 border-green-200">
              <CheckCircle className="h-4 w-4 text-green-600" />
              <AlertDescription className="text-green-800 text-sm">
                Không có công nợ
              </AlertDescription>
            </Alert>
          )}

          {outstandingAmount > 0 && (
            <Alert className="bg-red-50 border-red-200">
              <AlertCircle className="h-4 w-4 text-red-600" />
              <AlertDescription className="text-red-800 text-sm">
                Còn công nợ cần thu
              </AlertDescription>
            </Alert>
          )}
        </CardContent>
      </Card>

      {/* Quick Stats */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Clock className="h-5 w-5" />
            Thời gian
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          <div className="flex justify-between">
            <span className="text-gray-600">Tổng thời hạn:</span>
            <span className="font-medium">{totalDays} ngày</span>
          </div>
          <div className="flex justify-between">
            <span className="text-gray-600">Đã thuê:</span>
            <span className="font-medium">{Math.max(daysElapsed, 0)} ngày</span>
          </div>
          <div className="flex justify-between">
            <span className="text-gray-600">Còn lại:</span>
            <span className={`font-medium ${daysRemaining < 0 ? 'text-red-600' : daysRemaining <= 30 ? 'text-orange-600' : ''}`}>
              {daysRemaining < 0 ? `Quá hạn ${Math.abs(daysRemaining)} ngày` : `${daysRemaining} ngày`}
            </span>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
