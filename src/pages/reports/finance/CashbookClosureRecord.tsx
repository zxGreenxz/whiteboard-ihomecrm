// Đợt 6 — BIÊN BẢN chốt sổ & bàn giao quỹ (bản in được, ký tay).
//
// Vì sao cần trang riêng: chữ ký điện tử của nghi thức nằm trong
// app_private.cashbook_closures, người ngoài hệ thống (chủ nhà, kiểm toán, công
// an khu vực khi hỏi sổ) không mở app được. Kỳ đã khoá VĨNH VIỄN nên tờ giấy
// này là bằng chứng duy nhất còn lưu hành được ngoài đời — nó phải in ra khớp
// từng con số với bản ghi trong máy.
//
// Dữ liệu lấy từ list_cashbook_closings_v1 (RPC đã lọc theo membership). RPC đó
// KHÔNG trả phiếu chênh lệch — confirm_cashbook_closing_v1 chỉ trả
// difference_voucher_id một lần lúc ký rồi thôi, và bảng closures không có cột
// neo. Nên phiếu lệch được dò lại theo đúng dấu vết hàm ghi ra:
// system_source = 'cashbook.closing.diff' + account_id + voucher_date.
// Dò hụt (hoặc bị RLS chặn) thì in "—", KHÔNG bịa.

import { useEffect, useMemo } from "react";
import { useParams, useNavigate, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { format } from "date-fns";
import { supabase } from "@/integrations/supabase/client";
import { useCashbookClosings, type ConfirmedClosure } from "@/hooks/useCashbookClosing";

const fmtVND = (n: number | string | null | undefined) => {
  if (n === null || n === undefined) return "—";
  const num = Number(n);
  if (!Number.isFinite(num)) return "—";
  return new Intl.NumberFormat("vi-VN").format(num) + " đ";
};

const fmtDate = (d: string | null | undefined) => {
  if (!d) return "—";
  const dt = new Date(d);
  return Number.isNaN(dt.getTime()) ? "—" : format(dt, "dd/MM/yyyy");
};

const fmtDateTime = (d: string | null | undefined) => {
  if (!d) return "—";
  const dt = new Date(d);
  return Number.isNaN(dt.getTime()) ? "—" : format(dt, "HH:mm 'ngày' dd/MM/yyyy");
};

/** Cơ sở tính số dư đã đóng băng — dịch mã kỹ thuật ra tiếng người. */
const BASIS_LABEL: Record<string, string> = {
  POSTING_TRUTH_BY_POSTED_ON:
    "Số dư theo bút toán ĐÃ GHI SỔ, cắt theo ngày ghi sổ (posted_on)",
};

interface ClosureExtras {
  cashbook_code: string | null;
  organization_name: string | null;
  diff_voucher:
    | { id: string; code: string | null; type: string | null; total_amount: number | null }
    | null;
}

/**
 * Phần dữ liệu KHÔNG có trong list_cashbook_closings_v1: mã sổ, tên tổ chức và
 * phiếu chênh lệch. Mỗi mảnh hỏng độc lập — hỏng mảnh nào thì mảnh đó về null,
 * biên bản vẫn in được phần đã ký.
 */
const useClosureExtras = (closure: ConfirmedClosure | null | undefined) =>
  useQuery({
    queryKey: [
      "cashbook-closure-extras",
      closure?.closure_id ?? null,
      closure?.cashbook_id ?? null,
    ],
    enabled: !!closure,
    staleTime: 5 * 60_000,
    queryFn: async (): Promise<ClosureExtras> => {
      const out: ClosureExtras = {
        cashbook_code: null,
        organization_name: null,
        diff_voucher: null,
      };
      if (!closure) return out;

      const { data: acc } = await supabase
        .from("accounts")
        .select("id, code, organization_id")
        .eq("id", closure.cashbook_id)
        .maybeSingle();
      out.cashbook_code = (acc as { code?: string | null } | null)?.code ?? null;

      const orgId = (acc as { organization_id?: string | null } | null)?.organization_id ?? null;
      if (orgId) {
        const { data: org } = await supabase
          .from("organizations")
          .select("name")
          .eq("id", orgId)
          .maybeSingle();
        out.organization_name = (org as { name?: string | null } | null)?.name ?? null;
      }

      // Chỉ đi tìm khi biên bản THỰC SỰ có chênh lệch — lệch 0 thì hàm ký
      // không lập phiếu nào cả, hỏi thêm chỉ tổ dựng phiếu của kỳ khác lên.
      if (Number(closure.difference) !== 0) {
        const { data: ie } = await supabase
          .from("income_expenses")
          .select("id, code, type, total_amount")
          .eq("account_id", closure.cashbook_id)
          .eq("voucher_date", closure.closed_through)
          .eq("system_source", "cashbook.closing.diff")
          .limit(1);
        const row = (ie ?? [])[0] as
          | { id: string; code: string | null; type: string | null; total_amount: number | null }
          | undefined;
        out.diff_voucher = row ?? null;
      }
      return out;
    },
  });

export default function CashbookClosureRecord() {
  const { closureId } = useParams<{ closureId: string }>();
  const navigate = useNavigate();
  const [search] = useSearchParams();
  const { data, isLoading, isError, error } = useCashbookClosings();

  const closure = useMemo(() => {
    const all = data?.closures ?? [];
    return all.find((c) => String(c.closure_id) === String(closureId)) ?? null;
  }, [data, closureId]);

  const { data: extras } = useClosureExtras(closure);

  // Chỉ tự bung hộp thoại in khi được gọi kèm ?print=1 (nút "In" ở danh sách).
  // Mở thẳng URL để ĐỌC mà máy in nhảy ra là phiền, và người ta sẽ in nhầm.
  const autoPrint = search.get("print") === "1";
  useEffect(() => {
    if (closure && autoPrint) {
      const t = setTimeout(() => window.print(), 400);
      return () => clearTimeout(t);
    }
  }, [closure, autoPrint]);

  if (isLoading) {
    return <div className="p-8 text-center">Đang tải biên bản…</div>;
  }
  if (isError) {
    return (
      <div className="p-8 text-center text-red-600">
        Không đọc được danh sách biên bản chốt sổ.
        {error instanceof Error ? ` (${error.message})` : ""}
      </div>
    );
  }
  if (!closure) {
    return (
      <div className="p-8 text-center">
        <p className="text-red-600">
          Không tìm thấy biên bản chốt sổ #{closureId} — hoặc bạn không thuộc tổ chức giữ sổ này.
        </p>
        <button
          onClick={() => navigate("/finance/cashbooks")}
          className="mt-3 px-3 py-1.5 border rounded text-sm"
        >
          Về trang Sổ quỹ
        </button>
      </div>
    );
  }

  const diff = Number(closure.difference);
  const diffLabel =
    diff === 0 ? "Khớp sổ" : diff > 0 ? "Thừa quỹ" : "Thiếu quỹ";

  return (
    <div className="bg-white text-black min-h-screen">
      <style>{`
        @media print {
          @page { size: A4; margin: 15mm; }
          body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
          .no-print { display: none !important; }
          .cbr-page { padding: 0 !important; max-width: none !important; }
          .cbr-sign { page-break-inside: avoid; }
        }
        .cbr-page {
          font-family: "Times New Roman", Times, serif;
          max-width: 780px;
          margin: 0 auto;
          padding: 28px 24px 48px;
          color: #000;
        }
        .cbr-org { text-align: center; font-size: 14px; text-transform: uppercase; font-weight: 700; }
        .cbr-page h1 {
          text-align: center; font-size: 23px; font-weight: 700;
          letter-spacing: .04em; margin: 18px 0 4px;
        }
        .cbr-sub { text-align: center; font-size: 13px; margin: 0 0 22px; }
        .cbr-lead { font-size: 14px; line-height: 1.7; margin: 0 0 14px; }
        table.cbr-t { width: 100%; border-collapse: collapse; font-size: 14px; }
        table.cbr-t th, table.cbr-t td { border: 1px solid #555; padding: 7px 9px; vertical-align: top; }
        table.cbr-t th { background: #f0f0f0; text-align: left; width: 42%; font-weight: 700; }
        table.cbr-t td.num { text-align: right; font-variant-numeric: tabular-nums; }
        .cbr-strong td { font-weight: 700; background: #f7f7f7; }
        .cbr-note { font-size: 13px; line-height: 1.65; margin-top: 16px; }
        .cbr-note ul { margin: 6px 0 0; padding-left: 20px; }
        .cbr-sign {
          display: grid; grid-template-columns: 1fr 1fr; gap: 28px;
          margin-top: 40px; font-size: 13.5px; text-align: center;
        }
        .cbr-sign b { display: block; text-transform: uppercase; }
        .cbr-sign i { display: block; font-size: 12.5px; font-style: italic; margin-top: 2px; }
        .cbr-sign .cbr-name { display: block; margin-top: 74px; font-weight: 700; }
      `}</style>

      <div className="no-print p-3 bg-zinc-100 border-b flex flex-wrap items-center gap-2">
        <button
          onClick={() => window.print()}
          className="px-3 py-1.5 bg-blue-600 text-white rounded text-sm"
        >
          In biên bản
        </button>
        <button
          onClick={() => navigate("/finance/cashbooks")}
          className="px-3 py-1.5 border rounded text-sm bg-white"
        >
          Về Sổ quỹ
        </button>
        <span className="ml-auto text-xs text-zinc-500">
          Biên bản #{closure.closure_id} · kỳ đã khoá vĩnh viễn, nội dung không sửa được.
        </span>
      </div>

      <div className="cbr-page">
        <div className="cbr-org">{extras?.organization_name ?? " "}</div>
        <h1>BIÊN BẢN CHỐT SỔ &amp; BÀN GIAO QUỸ</h1>
        <p className="cbr-sub">
          Số: <b>{closure.closure_id}</b> · Lập lúc {fmtDateTime(closure.confirmed_at)}
        </p>

        <p className="cbr-lead">
          Hôm nay, {fmtDateTime(closure.confirmed_at)}, hai bên cùng kiểm quỹ và thống nhất
          chốt sổ quỹ <b>{closure.cashbook_name}</b>
          {extras?.cashbook_code ? ` (mã ${extras.cashbook_code})` : ""} tới hết ngày{" "}
          <b>{fmtDate(closure.closed_through)}</b> với các số liệu dưới đây.
        </p>

        <table className="cbr-t">
          <tbody>
            <tr>
              <th>Sổ quỹ</th>
              <td>
                {closure.cashbook_name}
                {extras?.cashbook_code ? ` (${extras.cashbook_code})` : ""}
              </td>
            </tr>
            <tr>
              <th>Chốt tới hết ngày</th>
              <td>{fmtDate(closure.closed_through)}</td>
            </tr>
            <tr>
              <th>Số dư theo sổ (hệ thống)</th>
              <td className="num">{fmtVND(closure.system_balance)}</td>
            </tr>
            <tr>
              <th>Số tiền thực đếm</th>
              <td className="num">{fmtVND(closure.counted_balance)}</td>
            </tr>
            <tr className="cbr-strong">
              <td>Chênh lệch ({diffLabel})</td>
              <td className="num">{fmtVND(diff)}</td>
            </tr>
            <tr>
              <th>Phiếu điều chỉnh chênh lệch</th>
              <td>
                {diff === 0
                  ? "Không có (số đếm khớp sổ)"
                  : extras?.diff_voucher
                    ? `${extras.diff_voucher.code ?? extras.diff_voucher.id} · ${
                        extras.diff_voucher.type === "INCOME" ? "Phiếu thu" : "Phiếu chi"
                      } ${fmtVND(extras.diff_voucher.total_amount)}`
                    : "—"}
              </td>
            </tr>
            <tr>
              <th>Cơ sở tính số dư</th>
              <td>{BASIS_LABEL[closure.basis] ?? closure.basis}</td>
            </tr>
            <tr>
              <th>Bên giao (đề nghị chốt)</th>
              <td>{closure.proposed_by_name ?? "—"}</td>
            </tr>
            <tr>
              <th>Bên nhận (xác nhận &amp; khoá kỳ)</th>
              <td>{closure.confirmed_by_name ?? "—"}</td>
            </tr>
            <tr>
              <th>Thời điểm ký</th>
              <td>{fmtDateTime(closure.confirmed_at)}</td>
            </tr>
          </tbody>
        </table>

        <div className="cbr-note">
          <b>Hai bên xác nhận:</b>
          <ul>
            <li>
              Bên nhận đã đếm đủ {fmtVND(closure.counted_balance)} và chịu trách nhiệm về số
              tiền này kể từ thời điểm ký.
            </li>
            <li>
              Mọi phiếu thu / chi có ngày phát sinh đến hết {fmtDate(closure.closed_through)} đã
              được khoá vĩnh viễn: không sửa, không huỷ, không xoá và không ai mở lại được —
              kể cả chủ tổ chức.
            </li>
            <li>
              Sai sót phát hiện sau ngày chốt được xử lý bằng phiếu điều chỉnh ở kỳ hiện tại,
              không sửa ngược vào kỳ đã khoá.
            </li>
          </ul>
        </div>

        <div className="cbr-sign">
          <div>
            <b>Bên giao</b>
            <i>(Ký, ghi rõ họ tên)</i>
            <span className="cbr-name">{closure.proposed_by_name ?? ""}</span>
          </div>
          <div>
            <b>Bên nhận</b>
            <i>(Ký, ghi rõ họ tên)</i>
            <span className="cbr-name">{closure.confirmed_by_name ?? ""}</span>
          </div>
        </div>
      </div>
    </div>
  );
}
