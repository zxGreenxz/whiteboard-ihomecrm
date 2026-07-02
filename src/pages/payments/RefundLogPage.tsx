// Trang "Sổ ghi nhận tiền thối" — view riêng cho các sổ X Thối (Hiển Thối / Hiệp Thối).
// Khác trang Thu chi thông thường: stat = SUM(change_amount) + số phiếu; list hiển thị
// CỘT TIỀN THỐI (change_amount) thay vì total_amount; filter theo tháng / custom date.

import { useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import MainLayout from "@/components/layout/MainLayout";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { DateInput } from "@/components/ui/date-input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { ArrowLeft, Receipt, RotateCcw, FileText } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useQuery } from "@tanstack/react-query";
import { format, startOfMonth, endOfMonth, subMonths } from "date-fns";
import { useIsMobile } from "@/hooks/use-mobile";
import { usePersistedState } from "@/hooks/usePersistedState";

interface RefundRow {
  id: string;
  voucher_date: string;
  code: string;
  invoice_id: string | null;
  invoice_number: string | null;
  building_name: string | null;
  room_name: string | null;
  payer_name: string | null;
  change_amount: number;
  total_amount: number;
  notes: string | null;
}

const formatVND = (n: number) => `${n.toLocaleString("vi-VN")} đ`;

type LedgerMode = "refund" | "rounding";

const ROUNDING_ACCOUNT_NAME = "Làm tròn tiền thiếu";

function detectMode(name: string | null | undefined): LedgerMode {
  return (name ?? "").trim() === ROUNDING_ACCOUNT_NAME ? "rounding" : "refund";
}

function useRefundLog(accountId: string | null, start: string, end: string) {
  return useQuery({
    queryKey: ["refund-log", accountId, start, end],
    enabled: !!accountId,
    queryFn: async (): Promise<{
      rows: RefundRow[];
      total: number;
      count: number;
      accountName: string | null;
      mode: LedgerMode;
    }> => {
      if (!accountId)
        return { rows: [], total: 0, count: 0, accountName: null, mode: "refund" };

      const { data: acc } = await supabase
        .from("accounts")
        .select("id, name")
        .eq("id", accountId)
        .maybeSingle();
      const mode = detectMode(acc?.name);
      const filterColumn =
        mode === "rounding" ? "rounding_account_id" : "change_account_id";
      const amountColumn = mode === "rounding" ? "rounding_amount" : "change_amount";

      const { data, error } = await supabase
        .from("income_expenses" as any)
        .select(
          `id, voucher_date, code, invoice_id, payer_name, change_amount, rounding_amount, total_amount, notes,
           building:buildings!income_expenses_building_id_fkey ( name ),
           room:rooms!income_expenses_room_id_fkey ( name ),
           invoice:invoices!income_expenses_invoice_id_fkey ( invoice_number )`
        )
        .eq(filterColumn, accountId)
        .eq("approval_status", "APPROVED")
        .is("deleted_at", null)
        .gte("voucher_date", start)
        .lte("voucher_date", end)
        .order("voucher_date", { ascending: false });

      if (error) {
        console.error("useRefundLog error:", error);
        return { rows: [], total: 0, count: 0, accountName: acc?.name ?? null, mode };
      }

      const rows: RefundRow[] = ((data ?? []) as any[]).map((v) => ({
        id: v.id,
        voucher_date: v.voucher_date,
        code: v.code,
        invoice_id: v.invoice_id,
        invoice_number: v.invoice?.invoice_number ?? null,
        building_name: v.building?.name ?? null,
        room_name: v.room?.name ?? null,
        payer_name: v.payer_name,
        change_amount: Number(v[amountColumn] ?? 0),
        total_amount: Number(v.total_amount ?? 0),
        notes: v.notes,
      }));
      const total = rows.reduce((s, r) => s + r.change_amount, 0);
      return { rows, total, count: rows.length, accountName: acc?.name ?? null, mode };
    },
  });
}

type Period = "this-month" | "last-month" | "this-year" | "custom";

const RefundLogPage = () => {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const isMobile = useIsMobile();
  const accountId = searchParams.get("account_id");

  // Giữ qua F5 (sessionStorage). Default custom range = tháng hiện tại — đặt
  // ngay trong initializer (thay vì effect set vô điều kiện như trước) để
  // KHÔNG đè khoảng ngày user đã chọn khi khôi phục.
  const [period, setPeriod] = usePersistedState<Period>("flt:refund-log:period", "this-month");
  const [customStart, setCustomStart] = usePersistedState<string>(
    "flt:refund-log:customStart",
    () => format(startOfMonth(new Date()), "yyyy-MM-dd"),
  );
  const [customEnd, setCustomEnd] = usePersistedState<string>(
    "flt:refund-log:customEnd",
    () => format(endOfMonth(new Date()), "yyyy-MM-dd"),
  );

  const { start, end } = useMemo(() => {
    const now = new Date();
    if (period === "this-month") {
      return { start: format(startOfMonth(now), "yyyy-MM-dd"), end: format(endOfMonth(now), "yyyy-MM-dd") };
    }
    if (period === "last-month") {
      const lm = subMonths(now, 1);
      return { start: format(startOfMonth(lm), "yyyy-MM-dd"), end: format(endOfMonth(lm), "yyyy-MM-dd") };
    }
    if (period === "this-year") {
      return { start: `${now.getFullYear()}-01-01`, end: `${now.getFullYear()}-12-31` };
    }
    return { start: customStart || "1970-01-01", end: customEnd || "2999-12-31" };
  }, [period, customStart, customEnd]);

  const { data, isLoading } = useRefundLog(accountId, start, end);
  const mode: LedgerMode = data?.mode ?? "refund";
  const isRounding = mode === "rounding";
  const accountName = data?.accountName ?? (isRounding ? "Sổ làm tròn" : "Sổ tiền thối");
  const total = data?.total ?? 0;
  const count = data?.count ?? 0;
  const rows = data?.rows ?? [];

  const labels = isRounding
    ? {
        subtitle: "Tài chính → Sổ quỹ → Làm tròn tiền thiếu",
        totalCard: "Tổng làm tròn",
        amountCol: "Tiền làm tròn",
        emptyMsg: "Chưa có phiếu làm tròn nào trong kỳ này",
      }
    : {
        subtitle: "Tài chính → Sổ quỹ → Tiền thối",
        totalCard: "Tổng tiền thối",
        amountCol: "Tiền thối",
        emptyMsg: "Chưa có phiếu thối nào trong kỳ này",
      };

  return (
    <MainLayout
      title={accountName}
      subtitle={labels.subtitle}
      icon={RotateCcw}
    >
      <div className="space-y-4">
        <div className="flex items-center gap-2">
          <Button variant="outline" onClick={() => navigate("/finance/cashbooks")}>
            <ArrowLeft className="h-4 w-4 mr-2" />
            Quay lại sổ quỹ
          </Button>
        </div>

        {/* Period selector */}
        <div className="flex flex-wrap items-end gap-2">
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground">Kỳ</label>
            <Select value={period} onValueChange={(v) => setPeriod(v as Period)}>
              <SelectTrigger className="w-[180px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="this-month">Tháng này</SelectItem>
                <SelectItem value="last-month">Tháng trước</SelectItem>
                <SelectItem value="this-year">Năm nay</SelectItem>
                <SelectItem value="custom">Tùy chỉnh</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {period === "custom" && (
            <>
              <div className="space-y-1">
                <label className="text-xs text-muted-foreground">Từ ngày</label>
                <DateInput value={customStart} onChange={setCustomStart} />
              </div>
              <div className="space-y-1">
                <label className="text-xs text-muted-foreground">Đến ngày</label>
                <DateInput value={customEnd} onChange={setCustomEnd} />
              </div>
            </>
          )}
        </div>

        {/* Stat cards */}
        <div className={isMobile ? "grid grid-cols-1 gap-3" : "grid grid-cols-3 gap-3"}>
          <Card className="p-4 flex items-center gap-3 border-l-4 border-l-orange-500">
            <RotateCcw className="h-8 w-8 text-orange-500" />
            <div>
              <div className="text-xs uppercase text-muted-foreground">{labels.totalCard}</div>
              <div className="text-2xl font-bold text-orange-600">{formatVND(total)}</div>
            </div>
          </Card>
          <Card className="p-4 flex items-center gap-3 border-l-4 border-l-blue-500">
            <FileText className="h-8 w-8 text-blue-500" />
            <div>
              <div className="text-xs uppercase text-muted-foreground">Số phiếu</div>
              <div className="text-2xl font-bold text-blue-600">{count}</div>
            </div>
          </Card>
          <Card className="p-4 flex items-center gap-3 border-l-4 border-l-emerald-500">
            <Receipt className="h-8 w-8 text-emerald-500" />
            <div>
              <div className="text-xs uppercase text-muted-foreground">Trung bình / phiếu</div>
              <div className="text-2xl font-bold text-emerald-600">
                {formatVND(count > 0 ? Math.round(total / count) : 0)}
              </div>
            </div>
          </Card>
        </div>

        {/* List */}
        {isLoading ? (
          <div className="space-y-2">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-12 w-full" />
            ))}
          </div>
        ) : isMobile ? (
          <div className="space-y-2">
            {rows.length === 0 && (
              <Card className="p-6 text-center text-muted-foreground">{labels.emptyMsg}</Card>
            )}
            {rows.map((r) => (
              <Card key={r.id} className="p-3">
                <div className="flex items-baseline justify-between gap-2">
                  <div className="font-medium text-sm">{r.code}</div>
                  <div className="text-orange-600 font-bold">{formatVND(r.change_amount)}</div>
                </div>
                <div className="text-xs text-muted-foreground mt-1">
                  {format(new Date(r.voucher_date), "dd/MM/yyyy")} • {r.building_name ?? "—"}
                  {r.room_name ? ` / ${r.room_name}` : ""}
                </div>
                {r.invoice_number && (
                  <div className="text-xs text-muted-foreground">HĐ: {r.invoice_number}</div>
                )}
                {r.notes && (
                  <div className="text-xs italic text-muted-foreground mt-1">{r.notes}</div>
                )}
              </Card>
            ))}
          </div>
        ) : (
          <Card>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Mã phiếu</TableHead>
                  <TableHead>Ngày</TableHead>
                  <TableHead>Hóa đơn</TableHead>
                  <TableHead>Tòa nhà</TableHead>
                  <TableHead>Phòng</TableHead>
                  <TableHead className="text-right">{labels.amountCol}</TableHead>
                  <TableHead>Ghi chú</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={7} className="text-center text-muted-foreground py-8">
                      {labels.emptyMsg}
                    </TableCell>
                  </TableRow>
                )}
                {rows.map((r) => (
                  <TableRow key={r.id}>
                    <TableCell className="font-medium">{r.code}</TableCell>
                    <TableCell>{format(new Date(r.voucher_date), "dd/MM/yyyy")}</TableCell>
                    <TableCell>
                      {r.invoice_id ? (
                        <button
                          className="text-blue-600 hover:underline"
                          onClick={() => navigate(`/invoices/${r.invoice_id}`)}
                        >
                          {r.invoice_number ?? "—"}
                        </button>
                      ) : (
                        "—"
                      )}
                    </TableCell>
                    <TableCell>{r.building_name ?? "—"}</TableCell>
                    <TableCell>{r.room_name || "—"}</TableCell>
                    <TableCell className="text-right font-bold text-orange-600">
                      {formatVND(r.change_amount)}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground max-w-xs truncate">
                      {r.notes ?? "—"}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Card>
        )}
      </div>
    </MainLayout>
  );
};

export default RefundLogPage;
