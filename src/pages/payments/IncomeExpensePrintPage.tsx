import { useEffect } from "react";
import { useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { format } from "date-fns";
import { formatVND } from "@/lib/utils";
import {
  VoucherNote,
  coGhiChuHeThong,
} from "@/components/income-expenses/VoucherNote";


interface VoucherRow {
  id: string;
  code: string;
  type: "INCOME" | "EXPENSE";
  name: string;
  total_amount: number;
  voucher_date: string;
  payer_name: string | null;
  receive_bank_name: string | null;
  receive_bank_account: string | null;
  notes: string | null;
  commission_kind?: "broker" | "sale" | null;
  contract_id?: string | null;
  system_source?: string | null;
  approval_status: string;
  business_result_accounting: boolean | null;
  creator_name: string | null;
  created_at: string;
  building?: { id: string; name: string } | null;
  room?: { id: string; name: string } | null;
  account?: { id: string; name: string } | null;
  items?: Array<{
    id: string;
    description: string | null;
    quantity: number;
    unit_price: number;
    amount: number;
    income_expense_type?: { id: string; name: string } | null;
  }>;
}

const useVoucherForPrint = (id: string | undefined) =>
  useQuery({
    queryKey: ["income-expense", "print", id],
    enabled: !!id,
    queryFn: async (): Promise<VoucherRow | null> => {
      const { data, error } = await (supabase
        .from("income_expenses" as any)
        .select(
          `
          *,
          building:buildings!income_expenses_building_id_fkey ( id, name ),
          room:rooms!income_expenses_room_id_fkey ( id, name ),
          account:accounts!income_expenses_account_id_fkey ( id, name ),
          items:income_expense_items (
            id, description, quantity, unit_price, amount,
            income_expense_type:income_expense_types!income_expense_items_income_expense_type_id_fkey ( id, name )
          )
        `
        )
        .eq("id", id)
        .single() as any);
      if (error) {
        console.error(error);
        return null;
      }
      return data as VoucherRow;
    },
  });

const IncomeExpensePrintPage = () => {
  const { id } = useParams<{ id: string }>();
  const { data: voucher, isLoading } = useVoucherForPrint(id);

  useEffect(() => {
    if (voucher) {
      const t = setTimeout(() => window.print(), 500);
      return () => clearTimeout(t);
    }
  }, [voucher]);

  if (isLoading) {
    return <div className="p-8 text-center">Đang tải...</div>;
  }
  if (!voucher) {
    return <div className="p-8 text-center text-red-600">Không tìm thấy phiếu</div>;
  }

  const isIncome = voucher.type === "INCOME";

  return (
    <div className="bg-white text-black min-h-screen">
      <style>{`
        @media print {
          @page { size: A5; margin: 12mm; }
          body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
          .no-print { display: none !important; }
        }
        .print-page {
          font-family: "Times New Roman", Times, serif;
          max-width: 720px;
          margin: 0 auto;
          padding: 24px;
        }
        .print-page h1 {
          text-align: center;
          font-size: 24px;
          margin: 0 0 4px;
          font-weight: 700;
          letter-spacing: 0.05em;
        }
        .print-page h2 {
          text-align: center;
          font-size: 14px;
          margin: 0 0 24px;
          font-weight: 400;
        }
        .info-row {
          display: flex;
          justify-content: space-between;
          margin-bottom: 6px;
          font-size: 14px;
        }
        .info-row b { min-width: 130px; display: inline-block; }
        table.items {
          width: 100%;
          border-collapse: collapse;
          margin-top: 16px;
          font-size: 13px;
        }
        table.items th, table.items td {
          border: 1px solid #555;
          padding: 6px 8px;
          text-align: left;
        }
        table.items th { background: #f0f0f0; }
        .total-row {
          font-weight: 700;
          background: #f7f7f7;
        }
        .signatures {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 32px;
          margin-top: 56px;
          font-size: 13px;
        }
        .signatures div {
          text-align: center;
        }
        .signatures b {
          display: block;
          margin-bottom: 64px;
        }
      `}</style>

      <div className="no-print p-3 bg-zinc-100 border-b flex items-center gap-2">
        <button
          onClick={() => window.print()}
          className="px-3 py-1.5 bg-blue-600 text-white rounded text-sm"
        >
          In phiếu
        </button>
        <button
          onClick={() => window.close()}
          className="px-3 py-1.5 border rounded text-sm"
        >
          Đóng
        </button>
        <span className="ml-auto text-xs text-zinc-500">
          (Trang sẽ tự động mở hộp thoại in.)
        </span>
      </div>

      <div className="print-page">
        <h1>{isIncome ? "PHIẾU THU" : "PHIẾU CHI"}</h1>
        <h2>
          Mã: <b>{voucher.code}</b> · Ngày:{" "}
          {voucher.voucher_date
            ? format(new Date(voucher.voucher_date), "dd/MM/yyyy")
            : "—"}
        </h2>

        <div className="info-row">
          <span>
            <b>Tên phiếu:</b> {voucher.name}
          </span>
          <span>
            <b>Tài khoản:</b> {voucher.account?.name || "—"}
          </span>
        </div>
        <div className="info-row">
          <span>
            <b>{isIncome ? "Người nộp:" : "Người nhận:"}</b>{" "}
            {voucher.payer_name || "—"}
          </span>
          <span>
            <b>Tòa nhà:</b>{" "}
            {voucher.building?.name
              ? `${voucher.building.name}${
                  voucher.room?.name ? " / " + voucher.room.name : ""
                }`
              : "—"}
          </span>
        </div>
        {!isIncome && (voucher.receive_bank_name || voucher.receive_bank_account) && (
          <div className="info-row">
            <span>
              <b>Ngân hàng nhận:</b> {voucher.receive_bank_name || "—"}
            </span>
            <span>
              <b>Số TK nhận:</b> {voucher.receive_bank_account || "—"}
            </span>
          </div>
        )}

        <table className="items">
          <thead>
            <tr>
              <th style={{ width: 36 }}>#</th>
              <th>Hạng mục</th>
              <th style={{ width: 80, textAlign: "right" }}>SL</th>
              <th style={{ width: 130, textAlign: "right" }}>Đơn giá</th>
              <th style={{ width: 140, textAlign: "right" }}>Thành tiền</th>
            </tr>
          </thead>
          <tbody>
            {(voucher.items || []).map((it, i) => (
              <tr key={it.id}>
                <td>{i + 1}</td>
                <td>
                  {it.income_expense_type?.name || "—"}
                  {it.description ? ` — ${it.description}` : ""}
                </td>
                <td style={{ textAlign: "right" }}>{it.quantity}</td>
                <td style={{ textAlign: "right" }}>{formatVND(Number(it.unit_price))}</td>
                <td style={{ textAlign: "right" }}>{formatVND(Number(it.amount))}</td>
              </tr>
            ))}
            <tr className="total-row">
              <td colSpan={4} style={{ textAlign: "right" }}>Tổng cộng</td>
              <td style={{ textAlign: "right" }}>
                {formatVND(Number(voucher.total_amount))}
              </td>
            </tr>
          </tbody>
        </table>

        {(voucher.notes || coGhiChuHeThong(voucher)) && (
          <div style={{ marginTop: 12, fontSize: 13 }}>
            <b>Ghi chú:</b>
            <VoucherNote voucher={voucher} fallbackNotes={voucher.notes} />
          </div>
        )}

        <div className="signatures">
          <div>
            <b>{isIncome ? "Người nộp" : "Người nhận"}</b>
            <div>(Ký, ghi rõ họ tên)</div>
          </div>
          <div>
            <b>Người lập phiếu</b>
            <div>{voucher.creator_name || "(Ký, ghi rõ họ tên)"}</div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default IncomeExpensePrintPage;
