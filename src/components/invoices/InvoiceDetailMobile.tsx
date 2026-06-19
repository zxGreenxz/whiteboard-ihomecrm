import { useRef, useState } from "react";
import {
  ArrowLeft,
  DollarSign,
  QrCode,
  Pencil,
  XCircle,
  RotateCcw,
  Receipt,
  Coins,
  Wallet,
  CheckCircle,
  AlertCircle,
  Image as ImageIcon,
  X,
  Loader2,
} from "lucide-react";
import { format } from "date-fns";
import { vi } from "date-fns/locale";
import "@/styles/mobileApp.css";
import "@/styles/financeMobile.css";
import { createSignedUrlFromStored } from "@/lib/storage";
import { useDragScroll } from "@/components/contracts/detail/useDragScroll";
import type { InvoiceWithRelations } from "@/types/invoice";

interface RelatedVoucher {
  id: string;
  code: string;
  type: "INCOME" | "EXPENSE";
  name?: string | null;
  voucher_date?: string | null;
  items?: { unit_price?: number | null; quantity?: number | null }[];
}

interface Props {
  invoice: InvoiceWithRelations;
  relatedVouchers: RelatedVoucher[];
  onBack: () => void;
  showPay: boolean;
  payIsRefund: boolean;
  onRecordPayment: () => void;
  showEdit: boolean;
  onEdit: () => void;
  showCancel: boolean;
  onCancel: () => void;
  showRestore: boolean;
  onRestore: () => void;
  showQR: boolean;
  onShowQR: () => void;
}

const fmtNum = (n: number) => new Intl.NumberFormat("vi-VN").format(n || 0);
const fmtDate = (s: string | null | undefined) =>
  s ? format(new Date(s), "dd/MM/yyyy", { locale: vi }) : "—";
const fmtBillingMonth = (m: string | null | undefined) => {
  if (!m) return "";
  const [y, mo] = m.split("-");
  return mo && y ? `${parseInt(mo, 10)}/${y}` : m;
};

const STATUS: Record<string, { label: string; c: string; bg: string; line: string }> = {
  PAID: { label: "Đã thanh toán", c: "#1f9d57", bg: "#e6f5ec", line: "#bfe6cd" },
  PARTIAL_PAID: { label: "Trả 1 phần", c: "#2563eb", bg: "#e7eefc", line: "#c9dafa" },
  OVERDUE: { label: "Quá hạn", c: "#d6453f", bg: "#fcebe9", line: "#f2c8c4" },
  DRAFT: { label: "Nháp", c: "#8a8377", bg: "#efece6", line: "#ddd8cd" },
  CANCELLED: { label: "Đã huỷ", c: "#8a8377", bg: "#efece6", line: "#ddd8cd" },
};

const PAYMENT_METHOD: Record<string, string> = {
  TM: "Tiền mặt",
  TK: "Chuyển khoản",
  TT: "Thanh toán",
  CT: "Cấn trừ",
};

const voucherAmount = (v: RelatedVoucher): number =>
  (v.items ?? []).reduce(
    (s, it) => s + Number(it.unit_price || 0) * Number(it.quantity || 0),
    0,
  );

/**
 * Chi tiết hoá đơn — màn hình app full-screen trên mobile (web-app). Dựng theo
 * handoff Claude Design (ui_kits/mobile-app: InvoiceDetailScreen) nối DỮ LIỆU
 * THẬT (InvoiceWithRelations + phiếu thu/chi liên quan). Nhận data + handler qua
 * props (dialog/mutation do page giữ). Scope .cm-stage/.cm-app, ngoài MainLayout.
 */
export function InvoiceDetailMobile({
  invoice,
  relatedVouchers,
  onBack,
  showPay,
  payIsRefund,
  onRecordPayment,
  showEdit,
  onEdit,
  showCancel,
  onCancel,
  showRestore,
  onRestore,
  showQR,
  onShowQR,
}: Props) {
  const actsRef = useRef<HTMLDivElement>(null);
  useDragScroll(actsRef);

  // Xem ảnh đính kèm khoản thu ngay trên trang (overlay), không mở tab mới.
  const [receiptOpen, setReceiptOpen] = useState(false);
  const [receiptUrl, setReceiptUrl] = useState<string | null>(null);

  const showReceipt = async (stored: string) => {
    setReceiptUrl(null);
    setReceiptOpen(true);
    setReceiptUrl(await createSignedUrlFromStored(stored));
  };
  const closeReceipt = () => {
    setReceiptOpen(false);
    setReceiptUrl(null);
  };

  const st = STATUS[invoice.status] ?? STATUS.DRAFT;
  const showStatusBadge = invoice.status !== "APPROVED";
  const isOverdue =
    invoice.status !== "PAID" &&
    !!invoice.due_date &&
    new Date(invoice.due_date) < new Date();

  const bld = (invoice as { building?: { name?: string } }).building?.name?.trim() || "";
  const room = (invoice as { room?: { name?: string } }).room?.name?.trim() || "";
  const apt = [bld, room].filter(Boolean).join(" - ") || "—";
  const billing = fmtBillingMonth(invoice.billing_month);
  const titleParts = [bld, room, billing].filter((s) => s && s.trim());
  const title = titleParts.length ? titleParts.join(" - ") : invoice.invoice_number || "Hoá đơn";

  const contractCustomers = invoice.contract?.contract_customers ?? [];
  const representative =
    contractCustomers.find((cc) => cc.is_representative)?.customer ??
    contractCustomers[0]?.customer ??
    null;

  const total = invoice.total_amount || 0;
  const paid = invoice.paid_amount || 0;
  const outstanding = total - paid;
  const totalReceived = relatedVouchers
    .filter((v) => v.type === "INCOME")
    .reduce((s, v) => s + voucherAmount(v), 0);
  const totalRefunded = relatedVouchers
    .filter((v) => v.type === "EXPENSE")
    .reduce((s, v) => s + voucherAmount(v), 0);

  return (
    <div className="cm-stage">
      <div className="cm-app">
        <div className="route route-anim">
          <div className="mtop">
            <button className="mback" onClick={onBack} aria-label="Quay lại">
              <ArrowLeft />
            </button>
            <div className="mtitle">
              <h1>{title}</h1>
              <p>
                {invoice.invoice_number
                  ? `Hoá đơn ${invoice.invoice_number}`
                  : "Chi tiết hoá đơn"}
              </p>
            </div>
          </div>

          <div className="mbody">
            {/* Hàng nút thao tác */}
            <div className="cd-acts inv" ref={actsRef}>
              {showPay && (
                <button
                  className={"invbtn " + (payIsRefund ? "warn" : "primary")}
                  onClick={onRecordPayment}
                >
                  <DollarSign size={16} />
                  {payIsRefund ? "Hoàn trả khách" : "Ghi nhận thanh toán"}
                </button>
              )}
              {showQR && (
                <button className="invbtn" onClick={onShowQR}>
                  <QrCode size={16} />
                  QR hợp đồng
                </button>
              )}
              {showEdit && (
                <button className="invbtn" onClick={onEdit}>
                  <Pencil size={16} />
                  Sửa
                </button>
              )}
              {showCancel && (
                <button className="invbtn danger" onClick={onCancel}>
                  <XCircle size={16} />
                  Huỷ
                </button>
              )}
              {showRestore && (
                <button className="invbtn" onClick={onRestore}>
                  <RotateCcw size={16} />
                  Phục hồi
                </button>
              )}
            </div>

            {/* Thông tin hoá đơn */}
            <div className="cd-card">
              <div className="cd-card-h">
                <span className="cd-card-t">
                  <Receipt size={16} />
                  Thông tin hoá đơn
                </span>
                {showStatusBadge && (
                  <span
                    className="pill"
                    style={{ color: st.c, background: st.bg, borderColor: st.line }}
                  >
                    <span className="bd" style={{ background: st.c }} />
                    {st.label}
                  </span>
                )}
              </div>
              <div className="cd-grid">
                <div className="cd-kv">
                  <span className="cd-kv-l">Số hoá đơn</span>
                  <span className="cd-kv-v" style={{ fontFamily: "var(--mono)", fontSize: 13 }}>
                    {invoice.invoice_number || "—"}
                  </span>
                </div>
                <div className="cd-kv">
                  <span className="cd-kv-l">Hợp đồng</span>
                  <span className="cd-kv-v" style={{ fontFamily: "var(--mono)", fontSize: 13 }}>
                    {invoice.contract?.contract_number || "—"}
                  </span>
                </div>
                <div className="cd-kv">
                  <span className="cd-kv-l">Khách hàng</span>
                  <span className="cd-kv-v">{representative?.full_name || "—"}</span>
                </div>
                <div className="cd-kv">
                  <span className="cd-kv-l">Số điện thoại</span>
                  <span className="cd-kv-v" style={{ fontFamily: "var(--mono)", fontSize: 13 }}>
                    {representative?.phone || "—"}
                  </span>
                </div>
                <div className="cd-kv">
                  <span className="cd-kv-l">Căn hộ</span>
                  <span className="cd-kv-v">{apt}</span>
                </div>
                <div className="cd-kv">
                  <span className="cd-kv-l">Kỳ thanh toán</span>
                  <span className="cd-kv-v">{billing || "—"}</span>
                </div>
                <div className="cd-kv">
                  <span className="cd-kv-l">Ngày phát hành</span>
                  <span className="cd-kv-v" style={{ fontFamily: "var(--mono)", fontSize: 13 }}>
                    {fmtDate(invoice.issue_date)}
                  </span>
                </div>
                <div className="cd-kv">
                  <span className="cd-kv-l">Hạn thanh toán</span>
                  <span
                    className="cd-kv-v"
                    style={{ fontFamily: "var(--mono)", fontSize: 13, color: isOverdue ? "#d6453f" : undefined }}
                  >
                    {fmtDate(invoice.due_date)}
                    {isOverdue && (
                      <small style={{ fontFamily: "var(--font)", fontWeight: 600, marginLeft: 5 }}>
                        (Quá hạn)
                      </small>
                    )}
                  </span>
                </div>
              </div>
              {invoice.notes && (
                <div className="inv-note">
                  <div className="inv-note-l">Ghi chú</div>
                  <div className="inv-note-box">{invoice.notes}</div>
                </div>
              )}
            </div>

            {/* Chi tiết các khoản thu */}
            <div className="cd-card">
              <div className="cd-card-h">
                <span className="cd-card-t">
                  <Coins size={16} />
                  Chi tiết các khoản thu
                </span>
              </div>
              <div className="invitems">
                <div className="invitem-h">
                  <span>Mô tả</span>
                  <span className="r">SL</span>
                  <span className="r">Đơn giá</span>
                  <span className="r">Thành tiền</span>
                </div>
                {invoice.invoice_items && invoice.invoice_items.length > 0 ? (
                  invoice.invoice_items.map((it) => (
                    <div className="invitem" key={it.id}>
                      <span className="invitem-desc">
                        <b>{it.description}</b>
                        {it.type ? <small>{it.type.toLowerCase()}</small> : null}
                      </span>
                      <span className="r mono">{it.quantity}</span>
                      <span className="r mono">{fmtNum(it.unit_price)}</span>
                      <span className="r mono bold">{fmtNum(it.amount)}</span>
                    </div>
                  ))
                ) : (
                  <div className="invitem">
                    <span style={{ gridColumn: "1 / -1", color: "var(--ink-3)" }}>
                      Không có khoản thu nào
                    </span>
                  </div>
                )}
                {invoice.discount_amount > 0 && (
                  <div className="invitem">
                    <span className="invitem-desc">
                      <b>Giảm trừ</b>
                    </span>
                    <span className="r" />
                    <span className="r" />
                    <span className="r mono bold" style={{ color: "#1f9d57" }}>
                      −{fmtNum(invoice.discount_amount)}
                    </span>
                  </div>
                )}
                {invoice.previous_debt > 0 && (
                  <div className="invitem">
                    <span className="invitem-desc">
                      <b style={{ color: "#b06d08" }}>Nợ cũ kỳ trước</b>
                      {invoice.previous_debt_sources?.length > 0 && (
                        <small>
                          {invoice.previous_debt_sources
                            .map((s) => s.label)
                            .filter(Boolean)
                            .join(" · ")}
                        </small>
                      )}
                    </span>
                    <span className="r" />
                    <span className="r" />
                    <span className="r mono bold" style={{ color: "#b06d08" }}>
                      {fmtNum(invoice.previous_debt)}
                    </span>
                  </div>
                )}
                <div className="invitem total">
                  <span>Tổng cộng</span>
                  <span className="r mono">
                    {fmtNum(total)}
                    <small>đ</small>
                  </span>
                </div>
              </div>
            </div>

            {/* Tóm tắt thanh toán */}
            <div className="cd-card">
              <div className="cd-card-h">
                <span className="cd-card-t">
                  <Wallet size={16} />
                  Tóm tắt thanh toán
                </span>
              </div>
              <div className="invsum">
                <div className="invsum-row">
                  <span>Tổng tiền hoá đơn:</span>
                  <b>
                    {fmtNum(total)}
                    <small>đ</small>
                  </b>
                </div>

                {relatedVouchers.length > 0 && (
                  <div className="invsum-vch">
                    {relatedVouchers.map((v) => {
                      const inc = v.type === "INCOME";
                      return (
                        <div className="invsum-vchrow" key={v.id}>
                          <div className="l">
                            <div className="code">{v.code}</div>
                            <div className="sub">
                              {inc ? "Phiếu thu" : "Phiếu chi tiền thối"}
                              {v.voucher_date ? ` · ${fmtDate(v.voucher_date)}` : ""}
                            </div>
                          </div>
                          <span
                            className="amt"
                            style={{ color: inc ? "#1f9d57" : "#d6453f" }}
                          >
                            {inc ? "+" : "−"}
                            {fmtNum(voucherAmount(v))}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                )}

                {totalReceived > 0 && (
                  <div className="invsum-row">
                    <span>Tổng thu (+):</span>
                    <b style={{ color: "#1f9d57" }}>{fmtNum(totalReceived)}<small>đ</small></b>
                  </div>
                )}
                {totalRefunded > 0 && (
                  <div className="invsum-row">
                    <span>Tổng thối (−):</span>
                    <b style={{ color: "#d6453f" }}>{fmtNum(totalRefunded)}<small>đ</small></b>
                  </div>
                )}
                <div className="invsum-row">
                  <span>Đã thanh toán net:</span>
                  <b style={{ color: "#1f9d57" }}>
                    {fmtNum(paid)}
                    <small>đ</small>
                  </b>
                </div>
                <div className="invsum-row total">
                  <span>Còn lại:</span>
                  <b style={{ color: outstanding > 0 ? "#e0691f" : "var(--ink-3)" }}>
                    {fmtNum(outstanding)}
                    <small>đ</small>
                  </b>
                </div>
              </div>

              {invoice.status === "PAID" && (
                <div className="inv-alert ok">
                  <CheckCircle size={15} />
                  Hoá đơn đã được thanh toán đầy đủ
                </div>
              )}
              {isOverdue && outstanding > 0 && (
                <div className="inv-alert bad">
                  <AlertCircle size={15} />
                  Hoá đơn đã quá hạn thanh toán
                </div>
              )}
            </div>

            {/* Lịch sử thanh toán */}
            {invoice.payments && invoice.payments.length > 0 && (
              <div className="cd-card" style={{ marginBottom: 4 }}>
                <div className="cd-card-h">
                  <span className="cd-card-t">
                    <Wallet size={16} />
                    Lịch sử thanh toán
                  </span>
                  <span className="cd-count">{invoice.payments.length}</span>
                </div>
                <div className="cd-pay-list">
                  {invoice.payments.map((p) => (
                    <div className="cd-pay" key={p.id}>
                      <span className="cd-pay-ic">
                        <Coins size={16} />
                      </span>
                      <div className="cd-pay-body">
                        <div className="cd-pay-note">
                          {PAYMENT_METHOD[p.payment_method] || p.payment_method}
                          {p.receipt_image_url ? (
                            <button
                              type="button"
                              className="cd-pay-link"
                              style={{ marginLeft: 8, border: 0, background: "transparent", padding: 0, font: "inherit" }}
                              onClick={() => showReceipt(p.receipt_image_url!)}
                            >
                              <ImageIcon size={13} style={{ verticalAlign: "-2px" }} /> Xem ảnh
                            </button>
                          ) : null}
                        </div>
                        <div className="cd-pay-sub">
                          {format(new Date(p.payment_date), "dd/MM/yyyy HH:mm", { locale: vi })}
                        </div>
                      </div>
                      <span className="cd-pay-amt">+{fmtNum(p.amount)}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>

        {receiptOpen && (
          <div
            className="rcpt-ov"
            onClick={closeReceipt}
            role="dialog"
            aria-modal="true"
            aria-label="Ảnh đính kèm khoản thu"
          >
            <button className="rcpt-x" onClick={closeReceipt} aria-label="Đóng">
              <X size={20} />
            </button>
            {receiptUrl ? (
              <img
                className="rcpt-img"
                src={receiptUrl}
                alt="Ảnh đính kèm khoản thu"
                onClick={(e) => e.stopPropagation()}
              />
            ) : (
              <Loader2 className="rcpt-spin" size={32} />
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export default InvoiceDetailMobile;
