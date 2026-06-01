import { useEffect } from "react";
import { useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { format } from "date-fns";

const formatVND = (n: number) => `${Number(n || 0).toLocaleString("vi-VN")} đ`;

const useInvoiceForPrint = (id: string | undefined) =>
  useQuery({
    queryKey: ["invoice", "print", id],
    enabled: !!id,
    queryFn: async () => {
      const { data, error } = await (supabase
        .from("invoices")
        .select(
          `
          *,
          contract:contracts!invoices_contract_id_fkey (
            id, contract_number,
            tenant:tenants!contracts_tenant_id_fkey ( id, full_name, phone )
          ),
          building:buildings!invoices_building_id_fkey ( id, name, address ),
          room:rooms!invoices_room_id_fkey ( id, name ),
          invoice_items ( id, type, description, unit_price, quantity, amount, sort_order ),
          payments ( id, amount, payment_date, payment_method )
        `
        )
        .eq("id", id)
        .single() as any);
      if (error) {
        console.error(error);
        return null;
      }
      return data as any;
    },
  });

const InvoicePrintPage = () => {
  const { id } = useParams<{ id: string }>();
  const { data: inv, isLoading } = useInvoiceForPrint(id);

  useEffect(() => {
    if (inv) {
      const t = setTimeout(() => window.print(), 500);
      return () => clearTimeout(t);
    }
  }, [inv]);

  if (isLoading) return <div className="p-8 text-center">Đang tải...</div>;
  if (!inv) return <div className="p-8 text-center text-red-600">Không tìm thấy hoá đơn</div>;

  const items = (inv.invoice_items || []).slice().sort(
    (a: any, b: any) => (a.sort_order ?? 0) - (b.sort_order ?? 0)
  );
  const tenant = inv.contract?.tenant;
  const remaining = (inv.total_amount || 0) - (inv.paid_amount || 0);

  return (
    <div className="bg-white text-black min-h-screen">
      <style>{`
        @media print {
          @page { size: A4; margin: 14mm; }
          body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
          .no-print { display: none !important; }
        }
        .print-page {
          font-family: "Times New Roman", Times, serif;
          max-width: 800px;
          margin: 0 auto;
          padding: 24px;
        }
        .print-page h1 {
          text-align: center;
          font-size: 26px;
          margin: 0 0 4px;
          font-weight: 700;
          letter-spacing: 0.05em;
        }
        .print-page h2 {
          text-align: center;
          font-size: 14px;
          margin: 0 0 24px;
        }
        .info-grid {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 4px 24px;
          font-size: 14px;
          margin-bottom: 14px;
        }
        .info-grid b { display: inline-block; min-width: 130px; }
        table.items {
          width: 100%;
          border-collapse: collapse;
          margin-top: 12px;
          font-size: 13px;
        }
        table.items th, table.items td {
          border: 1px solid #555;
          padding: 6px 8px;
        }
        table.items th { background: #eee; text-align: left; }
        .num { text-align: right; }
        .summary {
          margin-top: 14px;
          font-size: 14px;
        }
        .summary > div {
          display: flex;
          justify-content: space-between;
          padding: 4px 0;
        }
        .summary .total {
          font-weight: 700;
          border-top: 1px solid #555;
          padding-top: 8px;
          margin-top: 6px;
          font-size: 15px;
        }
        .signatures {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 32px;
          margin-top: 56px;
          font-size: 13px;
          text-align: center;
        }
        .signatures b { display: block; margin-bottom: 56px; }
      `}</style>

      <div className="no-print p-3 bg-zinc-100 border-b flex items-center gap-2">
        <button onClick={() => window.print()} className="px-3 py-1.5 bg-blue-600 text-white rounded text-sm">
          In hoá đơn
        </button>
        <button onClick={() => window.close()} className="px-3 py-1.5 border rounded text-sm">
          Đóng
        </button>
      </div>

      <div className="print-page">
        <h1>HOÁ ĐƠN</h1>
        <h2>
          Số: <b>{inv.invoice_number || inv.id?.slice(0, 8)}</b>{" "}
          {inv.billing_month ? `· Kỳ ${inv.billing_month}` : ""}
        </h2>

        <div className="info-grid">
          <div><b>Khách hàng:</b> {tenant?.full_name || "—"}</div>
          <div><b>Số điện thoại:</b> {tenant?.phone || "—"}</div>
          <div><b>Địa chỉ:</b> {[inv.building?.name, inv.room?.name].filter(Boolean).join(" / ")}</div>
          <div><b>Hợp đồng:</b> {inv.contract?.contract_number || "—"}</div>
          <div><b>Ngày phát hành:</b> {inv.issue_date ? format(new Date(inv.issue_date), "dd/MM/yyyy") : "—"}</div>
          <div><b>Hạn thanh toán:</b> {inv.due_date ? format(new Date(inv.due_date), "dd/MM/yyyy") : "—"}</div>
        </div>

        <table className="items">
          <thead>
            <tr>
              <th style={{ width: 36 }}>#</th>
              <th>Diễn giải</th>
              <th className="num" style={{ width: 70 }}>SL</th>
              <th className="num" style={{ width: 130 }}>Đơn giá</th>
              <th className="num" style={{ width: 140 }}>Thành tiền</th>
            </tr>
          </thead>
          <tbody>
            {items.length === 0 ? (
              <tr><td colSpan={5} style={{ textAlign: "center" }}>—</td></tr>
            ) : items.map((it: any, i: number) => (
              <tr key={it.id}>
                <td>{i + 1}</td>
                <td>{it.description || it.type}</td>
                <td className="num">{Number(it.quantity ?? 1)}</td>
                <td className="num">{formatVND(it.unit_price)}</td>
                <td className="num">{formatVND(it.amount)}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <div className="summary">
          <div><span>Tạm tính:</span><span>{formatVND(inv.subtotal)}</span></div>
          {Number(inv.discount_amount || 0) > 0 && (
            <div><span>Giảm giá:</span><span>− {formatVND(inv.discount_amount)}</span></div>
          )}
          {Number(inv.previous_debt || 0) !== 0 && (
            <div><span>Nợ kỳ trước:</span><span>{formatVND(inv.previous_debt)}</span></div>
          )}
          <div className="total"><span>TỔNG CỘNG:</span><span>{formatVND(inv.total_amount)}</span></div>
          <div><span>Đã thanh toán:</span><span>{formatVND(inv.paid_amount)}</span></div>
          <div className="total"><span>CÒN PHẢI THU:</span><span>{formatVND(remaining)}</span></div>
        </div>

        <div className="signatures">
          <div>
            <b>Khách hàng</b>
            <div>(Ký, ghi rõ họ tên)</div>
          </div>
          <div>
            <b>Người lập hoá đơn</b>
            <div>{inv.creator_name || "(Ký, ghi rõ họ tên)"}</div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default InvoicePrintPage;
