import { useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { useIncomeExpenseDetail } from "@/hooks/income-expenses/detailRead";
import { hasCompleteVoucherDetail } from "@/lib/incomeExpenseDetailRead";
import { format } from "date-fns";
import { formatVND } from "@/lib/utils";
import { getVoucherDisplayAttachments } from '@/lib/incomeExpenseSupplement';
import { StorageImage } from '@/components/ui/storage-image';
import { InlineSkeleton, LoadingState } from '@/components/loading/LoadingState';
import {
  VoucherNote,
  coGhiChuHeThong,
} from "@/components/income-expenses/VoucherNote";


const IncomeExpensePrintPage = () => {
  const { id } = useParams<{ id: string }>();
  const detail = useIncomeExpenseDetail(id);
  const fresh = detail.isSuccess && detail.isFetchedAfterMount && !detail.isFetching && hasCompleteVoucherDetail(detail.data);
  const voucher = fresh ? detail.data : null;
  const [loadedImages, setLoadedImages] = useState<Set<string>>(() => new Set());
  const printedVoucher = useRef<string | null>(null);
  const attachments = getVoucherDisplayAttachments(voucher ?? {});
  const imagesReady = attachments.filter(url => !/\.pdf(?:$|[?#])/i.test(url)).every(url => loadedImages.has(url));

  useEffect(() => {
    if (voucher && imagesReady && printedVoucher.current !== voucher.id) {
      const t = setTimeout(() => {
        printedVoucher.current = voucher.id;
        window.print();
      }, 500);
      return () => clearTimeout(t);
    }
  }, [voucher, imagesReady]);

  if (detail.isLoading || detail.isFetching || !detail.isFetchedAfterMount) {
    // Chờ: khối xám trên màn, KHÔNG in ra giấy (print:hidden); hộp in chỉ tự mở khi phiếu + ảnh đã đủ.
    return <div className="mx-auto max-w-[720px] p-8 print:hidden"><LoadingState label="phiếu để in" variant="detail" rows={8} onRetry={() => void detail.refetch()} /></div>;
  }
  if (!voucher) {
    return <div className="p-8 text-center text-red-600">Không tải được đầy đủ chi tiết phiếu hoặc bạn không còn quyền xem. <button onClick={() => detail.refetch()}>Thử lại</button></div>;
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
        {/* Thanh này không in (no-print). Ảnh chứng từ chưa về: vạch xám thay chữ chờ. */}
        <span className="ml-auto text-xs text-zinc-500">
          {imagesReady ? '(Trang sẽ tự động mở hộp thoại in.)' : <InlineSkeleton label="chứng từ để in" width="9rem" />}
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
            <b>Tài khoản:</b> {voucher.account_name || "—"}
          </span>
        </div>
        <div className="info-row">
          <span>
            <b>{isIncome ? "Người nộp:" : "Người nhận:"}</b>{" "}
            {voucher.payer_name || "—"}
          </span>
          <span>
            <b>Tòa nhà:</b>{" "}
            {voucher.building_name
              ? `${voucher.building_name}${
                  voucher.room_name ? " / " + voucher.room_name : ""
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

        {voucher.items.length === 0 && <p>Phiếu này không có hạng mục (dữ liệu cũ hoặc phiếu hệ thống).</p>}
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
                  {it.type_name || "—"}
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

        {attachments.length > 0 && <div style={{ marginTop: 12 }}>
          <b>Chứng từ đính kèm:</b>
          <div className="flex flex-wrap gap-2 mt-2">{attachments.map((url, index) =>
            /\.pdf(?:$|[?#])/i.test(url) ? <span key={url}>Chứng từ PDF {index + 1}</span> :
              <StorageImage key={url} value={url} alt={`Chứng từ ${index + 1}`} loading="eager"
                onLoad={() => setLoadedImages(previous => new Set(previous).add(url))}
                className="h-36 max-w-48 object-contain" />)}</div>
        </div>}
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
