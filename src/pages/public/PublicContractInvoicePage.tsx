import { useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Receipt, AlertCircle, CheckCircle, Building2 } from 'lucide-react';
import { format } from 'date-fns';
import { vi } from 'date-fns/locale';

type Item = {
  id: string;
  type: string | null;
  description: string | null;
  unit_price: number | null;
  quantity: number | null;
  coefficient: number | null;
  amount: number | null;
  previous_reading: number | null;
  current_reading: number | null;
  from_date: string | null;
  to_date: string | null;
};

type PublicInvoice = {
  id: string;
  invoice_number: string | null;
  billing_month: string | null;
  issue_date: string | null;
  due_date: string | null;
  status: string;
  subtotal: number | null;
  discount_amount: number | null;
  tax_amount: number | null;
  total_amount: number | null;
  paid_amount: number | null;
  remaining_amount: number | null;
  previous_debt: number | null;
  items: Item[];
};

type PublicPayload = {
  invoice: PublicInvoice | null;
  room: { id: string; name: string; code: string | null } | null;
  building: { id: string; name: string } | null;
  bed?: { id: string; name: string } | null;
  customer?: { full_name: string; phone: string | null } | null;
};

const formatCurrency = (n: number | null | undefined) =>
  new Intl.NumberFormat('vi-VN', {
    style: 'currency',
    currency: 'VND',
  }).format(Number(n || 0));

const formatBillingMonth = (bm: string | null | undefined) => {
  if (!bm) return '';
  const [y, m] = bm.split('-');
  return m && y ? `${parseInt(m, 10)}/${y}` : bm;
};

const formatDate = (d: string | null | undefined) =>
  d ? format(new Date(d), 'dd/MM/yyyy', { locale: vi }) : '';

/** Tách phần "(...)" cuối description thành note để hiển thị xuống dòng dưới
 *  (vd "Tiền điện (8794 → 9200)" → title "Tiền điện", note "8794 → 9200"). */
const splitDescription = (desc: string | null | undefined): { title: string; note: string } => {
  if (!desc) return { title: '', note: '' };
  const m = desc.match(/^(.*?)\s*\(([^()]+)\)\s*$/);
  if (m) return { title: m[1].trim(), note: m[2].trim() };
  return { title: desc, note: '' };
};

const statusLabel = (s: string) => {
  switch (s) {
    case 'PAID':
      return { label: 'Đã thanh toán', variant: 'default' as const };
    case 'PARTIAL_PAID':
      return { label: 'Trả 1 phần', variant: 'secondary' as const };
    case 'OVERDUE':
      return { label: 'Quá hạn', variant: 'destructive' as const };
    case 'APPROVED':
      return { label: 'Chờ thanh toán', variant: 'outline' as const };
    default:
      return { label: s, variant: 'outline' as const };
  }
};

export default function PublicContractInvoicePage() {
  const { contractId } = useParams<{ contractId: string }>();

  const { data, isLoading, error } = useQuery({
    queryKey: ['public-contract-invoice', contractId],
    enabled: !!contractId,
    queryFn: async (): Promise<PublicPayload | null> => {
      const { data, error } = await (supabase as any).rpc(
        'get_public_latest_invoice_by_contract',
        { p_contract_id: contractId },
      );
      if (error) throw error;
      return data as PublicPayload | null;
    },
  });

  if (isLoading) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
        <div className="text-gray-500">Đang tải hoá đơn...</div>
      </div>
    );
  }

  // RPC trả NULL khi hợp đồng không tồn tại / bị xoá / đã thanh lý.
  if (error || !data) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
        <Card className="max-w-md w-full">
          <CardContent className="pt-6 text-center space-y-2">
            <AlertCircle className="h-10 w-10 text-red-500 mx-auto" />
            <div className="font-medium">Mã QR không khả dụng</div>
            <p className="text-sm text-gray-600">
              Hợp đồng đã thanh lý hoặc không còn tồn tại.
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  const { invoice, room, building, bed, customer } = data;

  const apartmentLabel = [building?.name, room?.name + (bed ? ` · ${bed.name}` : '')]
    .filter((s) => s && s.trim())
    .join(' - ');

  if (!invoice) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
        <Card className="max-w-md w-full">
          <CardHeader>
            <div className="flex items-center gap-2">
              <Building2 className="h-5 w-5 text-gray-500" />
              <CardTitle className="text-lg">
                {apartmentLabel || 'Phòng'}
              </CardTitle>
            </div>
          </CardHeader>
          <CardContent className="text-center space-y-2">
            <p className="text-sm text-gray-600">
              Phòng này chưa có hoá đơn nào được phát hành.
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  const billingLabel = formatBillingMonth(invoice.billing_month);
  const stat = statusLabel(invoice.status);
  const isOverdue =
    invoice.status !== 'PAID' &&
    invoice.due_date &&
    new Date(invoice.due_date) < new Date();
  const outstanding =
    (invoice.total_amount || 0) - (invoice.paid_amount || 0);

  return (
    <div className="min-h-screen bg-gray-50 py-4 px-3 sm:py-8 sm:px-4">
      <div className="max-w-2xl mx-auto space-y-4">
        {/* Header */}
        <div className="flex items-center gap-2 text-emerald-700">
          <Receipt className="h-6 w-6" />
          <h1 className="text-xl font-bold">
            {apartmentLabel} - {billingLabel}
          </h1>
        </div>
        {/* Invoice info */}
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <CardTitle className="text-base">Thông tin hoá đơn</CardTitle>
              <Badge variant={stat.variant}>{stat.label}</Badge>
            </div>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 gap-3 text-sm">
              {customer?.full_name && (
                <>
                  <div>
                    <div className="text-gray-500 text-xs">Khách hàng</div>
                    <div className="font-medium">{customer.full_name}</div>
                  </div>
                  <div>
                    <div className="text-gray-500 text-xs">Số điện thoại</div>
                    <div className="font-medium">
                      {customer.phone || 'N/A'}
                    </div>
                  </div>
                </>
              )}
              <div>
                <div className="text-pink-600 text-xs">Căn hộ</div>
                <div className="font-medium">{apartmentLabel || 'N/A'}</div>
              </div>
              <div>
                <div className="text-blue-600 text-xs">Kỳ thanh toán</div>
                <div className="font-medium">{billingLabel || 'N/A'}</div>
              </div>
              <div>
                <div className="text-pink-600 text-xs">Ngày phát hành</div>
                <div className="font-medium">
                  {formatDate(invoice.issue_date)}
                </div>
              </div>
              <div>
                <div className="text-blue-600 text-xs">Hạn thanh toán</div>
                <div
                  className={`font-medium ${isOverdue ? 'text-red-600' : ''}`}
                >
                  {formatDate(invoice.due_date)}
                  {isOverdue && (
                    <span className="ml-2 text-xs">(Quá hạn)</span>
                  )}
                </div>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Items */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Chi tiết các khoản thu</CardTitle>
          </CardHeader>
          <CardContent className="px-0 sm:px-6">
            {/* Desktop header */}
            <div className="hidden sm:grid grid-cols-12 text-xs font-medium text-gray-500 px-4 pb-2 border-b">
              <div className="col-span-5">Mô tả</div>
              <div className="col-span-2 text-right">Số lượng</div>
              <div className="col-span-2 text-right">Đơn giá</div>
              <div className="col-span-3 text-right">Thành tiền</div>
            </div>
            <div className="divide-y">
              {invoice.items.length === 0 && (
                <div className="px-4 py-6 text-center text-sm text-gray-500">
                  Không có khoản thu nào
                </div>
              )}
              {invoice.items.map((it) => {
                const qty = Number(it.quantity || 0);
                const unitPrice = Number(it.unit_price || 0);
                const parsed = splitDescription(it.description);
                // Item type=RENT luôn hiển thị "Tiền phòng" — số phòng đã có ở
                // header, "(MM/YYYY)" đã trở thành note.
                const title = it.type === 'RENT' ? 'Tiền phòng' : parsed.title;
                const note = parsed.note;
                return (
                  <div key={it.id} className="px-4 py-3 text-sm">
                    {/* Mobile: 3 cột — [Mô tả+ghi chú] [SL×Đơn giá] [Thành tiền] */}
                    <div className="sm:hidden flex items-start gap-3">
                      <div className="min-w-0 flex-1">
                        <div className="font-medium leading-snug break-words">
                          {title}
                        </div>
                        {note && (
                          <div className="text-xs text-gray-500 mt-0.5">
                            {note}
                          </div>
                        )}
                      </div>
                      <div className="text-xs text-gray-500 text-right tabular-nums shrink-0 whitespace-nowrap pt-0.5">
                        {qty} × {formatCurrency(unitPrice)}
                      </div>
                      <div className="text-right font-semibold tabular-nums shrink-0 whitespace-nowrap">
                        {formatCurrency(it.amount)}
                      </div>
                    </div>

                    {/* Desktop: 4 cột grid */}
                    <div className="hidden sm:grid grid-cols-12 gap-2 items-start">
                      <div className="col-span-5">
                        <div className="font-medium leading-snug">{title}</div>
                        {note && (
                          <div className="text-xs text-gray-500 mt-0.5">
                            {note}
                          </div>
                        )}
                      </div>
                      <div className="col-span-2 text-right tabular-nums">
                        {qty}
                      </div>
                      <div className="col-span-2 text-right tabular-nums">
                        {formatCurrency(unitPrice)}
                      </div>
                      <div className="col-span-3 text-right font-medium tabular-nums">
                        {formatCurrency(it.amount)}
                      </div>
                    </div>
                  </div>
                );
              })}
              <div className="px-4 py-3 bg-gray-50 font-bold text-sm">
                {/* Mobile: 2 cột flex */}
                <div className="sm:hidden flex items-center justify-between">
                  <span>Tổng cộng</span>
                  <span className="tabular-nums">
                    {formatCurrency(invoice.total_amount)}
                  </span>
                </div>
                {/* Desktop: grid */}
                <div className="hidden sm:grid grid-cols-12 gap-2">
                  <div className="col-span-9 text-right">Tổng cộng</div>
                  <div className="col-span-3 text-right tabular-nums">
                    {formatCurrency(invoice.total_amount)}
                  </div>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Summary */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Tóm tắt thanh toán</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <div className="flex justify-between">
              <span className="text-gray-600">Tổng tiền hoá đơn:</span>
              <span className="font-bold tabular-nums">
                {formatCurrency(invoice.total_amount)}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-600">Đã thanh toán:</span>
              <span className="font-medium text-green-700 tabular-nums">
                {formatCurrency(invoice.paid_amount)}
              </span>
            </div>
            <div className="flex justify-between border-t pt-2">
              <span className="text-gray-900 font-medium">Còn lại:</span>
              <span
                className={`font-bold text-lg tabular-nums ${
                  outstanding > 0 ? 'text-orange-600' : 'text-gray-500'
                }`}
              >
                {formatCurrency(outstanding)}
              </span>
            </div>

            {invoice.status === 'PAID' && (
              <Alert className="bg-green-50 border-green-200 mt-2">
                <CheckCircle className="h-4 w-4 text-green-600" />
                <AlertDescription className="text-green-800 text-sm">
                  Hoá đơn đã thanh toán đầy đủ
                </AlertDescription>
              </Alert>
            )}

            {isOverdue && outstanding > 0 && (
              <Alert className="bg-red-50 border-red-200 mt-2">
                <AlertCircle className="h-4 w-4 text-red-600" />
                <AlertDescription className="text-red-800 text-sm">
                  Hoá đơn đã quá hạn thanh toán
                </AlertDescription>
              </Alert>
            )}
          </CardContent>
        </Card>

      </div>
    </div>
  );
}
