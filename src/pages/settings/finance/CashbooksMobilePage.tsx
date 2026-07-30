import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowLeft, Plus, Wallet, Lock, X, Pencil, ArrowLeftRight, ReceiptText, FileText } from "lucide-react";
import "@/styles/mobileApp.css";
import "@/styles/financeMobile.css";
import "@/styles/estateMobile.css";
import { useAccountsWithBalance, type AccountWithBalance } from "@/hooks/useAccounts";
import CashbookForm from "@/components/cashbooks/CashbookForm";
import CloseCashbookDialog from "@/components/cashbooks/CloseCashbookDialog";
import CashbookClosingInbox, { closureRecordPath } from "@/components/cashbooks/CashbookClosingInbox";
import { useCashbookCloseConfirmers, useCashbookClosings } from "@/hooks/useCashbookClosing";
import { useCashbookVisibilityV2 } from "@/hooks/income-expenses/financeV2Mutations";

const compact = (n: number) => {
  const a = Math.abs(n);
  if (a >= 1e9) return (n / 1e9).toFixed(1).replace(/\.0$/, "") + "tỷ";
  if (a >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, "") + "tr";
  if (a >= 1e3) return (n / 1e3).toFixed(0) + "k";
  return n.toLocaleString("vi-VN");
};
const fmtVnd = (n: number | null | undefined) => (n == null ? "—" : n.toLocaleString("vi-VN") + " đ");

/**
 * Sổ quỹ — màn hình app full-screen mobile (web-app). Dựng theo handoff Claude
 * Design (iHomeCRM Mobile.dc.html · 1e). Nối dữ liệu thật: useAccountsWithBalance.
 * "Giao dịch gần đây" nối sang Thu chi lọc theo sổ (/income-expense?account_id).
 * Tạo sổ dùng lại CashbookForm (desktop). Scope .cm-stage/.cm-app, ngoài MainLayout.
 *
 * ĐỢT 6 — nghi thức chốt sổ & bàn giao có mặt Ở ĐÂY, không chỉ trên desktop.
 * CashbooksPage rẽ nhánh bằng usePhoneViewport (≤767px) sang trang này, nên
 * nhánh `isMobile` bên trong CashbooksDesktop (useIsMobile, cùng ngưỡng 768px)
 * KHÔNG BAO GIỜ chạy trên điện thoại — hộp thư chờ ký đặt ở đó là đặt vào chỗ
 * chết. Người quản lý nộp tiền bằng điện thoại, nên thiếu cửa này là thiếu cả
 * nghi thức.
 *
 * Hộp thoại đề nghị/xác nhận dùng LẠI bản desktop (Radix Dialog portal ra
 * document.body, nằm trên .cm-stage vốn z-index 0) — cố ý không viết lại bản
 * mobile riêng: mọi chốt chặn an toàn (rào chặn, phát hiện sổ trôi, gõ "CHOT
 * SO", đối chiếu số đếm) chỉ nên tồn tại một bản.
 */
export default function CashbooksMobilePage() {
  const navigate = useNavigate();
  const { data, isLoading } = useAccountsWithBalance({ page: 1, pageSize: 100 });
  const funds = (data?.data ?? []) as AccountWithBalance[];

  const [detail, setDetail] = useState<AccountWithBalance | null>(null);
  const [fabOpen, setFabOpen] = useState(false);
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<AccountWithBalance | null>(null);
  // Đợt 6 — đề nghị chốt & bàn giao (thay cho khoá/mở khoá tay).
  const [closeOpen, setCloseOpen] = useState(false);
  const [closeTarget, setCloseTarget] = useState<AccountWithBalance | null>(null);

  const { data: confirmers } = useCashbookCloseConfirmers(closeTarget?.id ?? null);
  const { data: closingData } = useCashbookClosings();
  const pendingForMe = (closingData?.pending ?? []).filter((p) => p.is_mine_to_confirm).length;

  // Cờ server per-sổ (parity desktop): RPC lỗi → null → giữ hành vi cũ (cho hiện).
  const { data: visibility } = useCashbookVisibilityV2();
  const visById = useMemo(
    () => new Map((visibility ?? []).map((v) => [v.cashbook_id, v])),
    [visibility],
  );

  // M1 (thống nhất tài chính 04/07): tách sổ TIỀN THẬT vs sổ THEO DÕI (ảo).
  // TỔNG TỒN QUỸ chỉ cộng sổ thật — sổ bút toán (CỌC, Cấn trừ, Thối, Làm tròn)
  // không phải tiền trong két, cộng vào chỉ gây nhiễu.
  const realFunds = useMemo(() => funds.filter((f) => !f.is_virtual), [funds]);
  const virtualFunds = useMemo(() => funds.filter((f) => !!f.is_virtual), [funds]);

  const stats = useMemo(() => {
    const count = realFunds.length;
    const locked = realFunds.filter((f) => !!f.lock_date).length;
    const total = realFunds.reduce((s, f) => s + (f.current_amount || 0), 0);
    return { count, locked, total };
  }, [realFunds]);

  const openCreate = () => {
    setEditing(null);
    setFabOpen(false);
    setFormOpen(true);
  };

  // Biên bản đã ký của ĐÚNG sổ đang mở — hiện ngay trong bottom sheet chi tiết,
  // vì trên điện thoại không có cột thao tác nào khác để treo đường link.
  const detailClosures = useMemo(
    () => (closingData?.closures ?? []).filter((c) => c.cashbook_id === detail?.id).slice(0, 3),
    [closingData, detail],
  );

  const detailVis = detail ? visById.get(detail.id) : undefined;
  const detailCanManage = detailVis ? detailVis.can_manage : true;
  const detailCanClose = !!detail && detailCanManage && !detail.lock_date;

  return (
    <div className="cm-stage">
      {/*
        Hộp thoại chốt sổ dài hơn màn hình điện thoại (3 bước, có bảng số liệu
        + cảnh báo khoá vĩnh viễn). DialogContent gốc không có max-height nên
        phần cuối — kể cả nút bấm — bị cắt khỏi viewport và người dùng KHÔNG
        cuộn tới được. Chặn ngưỡng ngay tại trang app điện thoại thay vì sửa
        DialogContent dùng chung.
      */}
      <style>{`
        @media (max-width: 767px) {
          div[role="dialog"][data-state="open"] {
            max-height: 88dvh;
            overflow-y: auto;
            width: calc(100vw - 20px);
          }
        }
      `}</style>
      <div className="cm-app">
        <div className="route route-anim">
          <div className="mtop">
            <button className="mback" onClick={() => navigate("/")} aria-label="Về trang chủ">
              <ArrowLeft />
            </button>
            <div className="mtitle">
              <h1>Sổ quỹ</h1>
              <p>
                {stats.count} sổ · tồn {compact(stats.total)}
                {pendingForMe > 0 ? ` · ${pendingForMe} chờ bạn ký` : ""}
              </p>
            </div>
          </div>

          <div className="mbody">
            {/* Đợt 6 — hộp thư chờ ký + đường ra biên bản. Tự ẩn khi rỗng. */}
            <CashbookClosingInbox variant="mobile" />

            <div className="iestats">
              <div className="iestat">
                <span className="iestat-l"><Wallet />SỐ SỔ QUỸ</span>
                <span className="iestat-v">{stats.count}</span>
              </div>
              <div className="iestat">
                <span className="iestat-l"><Lock />ĐANG KHOÁ</span>
                <span className="iestat-v">{stats.locked}</span>
              </div>
              <div className="iediff pos">
                <span className="iediff-l">TỔNG TỒN QUỸ</span>
                <span className="iediff-v" style={{ color: stats.total >= 0 ? "#10b981" : "#ef4444" }}>
                  {compact(stats.total)}
                  <small>₫</small>
                </span>
              </div>
            </div>

            <div className="msub">
              <span className="msub-t">Sổ tiền thật</span>
              <span className="msub-n">{stats.count}</span>
            </div>

            {isLoading ? (
              <div className="stub"><p>Đang tải sổ quỹ…</p></div>
            ) : funds.length === 0 ? (
              <div className="stub"><p>Chưa có sổ quỹ nào. Tạo sổ mới qua nút (+).</p></div>
            ) : (
              <div className="rowlist">
                {realFunds.map((f) => {
                  const locked = !!f.lock_date;
                  const neg = (f.current_amount || 0) < 0;
                  return (
                    <div className={"fund" + (locked ? " locked" : "")} key={f.id} onClick={() => setDetail(f)}>
                      <div className="fund-top">
                        <div className="fund-l">
                          <span className="fund-ic"><Wallet /></span>
                          <div style={{ minWidth: 0 }}>
                            <div className="fund-nm">
                              <b>{f.name}</b>
                              {locked && (
                                <span className="fund-lock"><Lock />Khoá</span>
                              )}
                            </div>
                            <div className="fund-sub">{[f.code, f.owner_name].filter(Boolean).join(" · ")}</div>
                          </div>
                        </div>
                        <div className="fund-r">
                          <div className="cap">Tồn quỹ</div>
                          <div className={"fund-bal " + (neg ? "neg" : "pos")}>{fmtVnd(f.current_amount)}</div>
                        </div>
                      </div>
                      <div className="fund-foot">
                        <span>Đầu kỳ: <span className="v">{fmtVnd(f.initial_amount)}</span></span>
                        <span>{f.owner_name || ""}</span>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            {/* Sổ theo dõi (ảo) — chỉ chứa bút toán, không phải tiền trong két,
                KHÔNG cộng vào Tổng tồn quỹ. */}
            {!isLoading && virtualFunds.length > 0 && (
              <>
                <div className="msub" style={{ marginTop: 14 }}>
                  <span className="msub-t">Sổ theo dõi (bút toán — không phải tiền thật)</span>
                  <span className="msub-n">{virtualFunds.length}</span>
                </div>
                <div className="rowlist" style={{ opacity: 0.75 }}>
                  {virtualFunds.map((f) => {
                    const locked = !!f.lock_date;
                    return (
                      <div className={"fund" + (locked ? " locked" : "")} key={f.id} onClick={() => setDetail(f)}>
                        <div className="fund-top">
                          <div className="fund-l">
                            <span className="fund-ic"><Wallet /></span>
                            <div style={{ minWidth: 0 }}>
                              <div className="fund-nm">
                                <b>{f.name}</b>
                                <span className="fund-lock">Sổ ảo</span>
                                {locked && (
                                  <span className="fund-lock"><Lock />Khoá</span>
                                )}
                              </div>
                              <div className="fund-sub">{[f.code, f.owner_name].filter(Boolean).join(" · ")}</div>
                            </div>
                          </div>
                          <div className="fund-r">
                            <div className="cap">Số dư bút toán</div>
                            <div className="fund-bal" style={{ color: "#64748b" }}>{fmtVnd(f.current_amount)}</div>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </>
            )}
          </div>

          <button className={"fab" + (fabOpen ? " open" : "")} onClick={() => setFabOpen((o) => !o)} aria-label="Tạo mới">
            <Plus />
          </button>

          {/* Chi tiết sổ quỹ — bottom sheet */}
          {detail && (
            <div className="sheet-ov" onClick={() => setDetail(null)}>
              <div className="sheet" onClick={(e) => e.stopPropagation()}>
                <div className="sheet-grab" />
                <div className="vd-hd">
                  <div className="vd-hd-t">SỔ QUỸ · {detail.code}</div>
                  <button className="sheet-x" onClick={() => setDetail(null)} aria-label="Đóng">
                    <X size={18} />
                  </button>
                </div>

                <div className="cdh" style={{ marginTop: 14 }}>
                  <div className="cdh-av"><Wallet /></div>
                  <div className="cdh-body">
                    <div className="cdh-name">{detail.name}</div>
                    <div className="cdh-sub">
                      {detail.lock_date && <span className="fund-lock"><Lock />Đang khoá</span>}
                      <span className="cdh-phone">Phụ trách: {detail.owner_name || "—"}</span>
                    </div>
                  </div>
                </div>

                <div className="vd-table">
                  <div className="vd-row"><div className="vd-row-l">Tồn quỹ</div><div className="vd-row-v"><b>{fmtVnd(detail.current_amount)}</b></div></div>
                  <div className="vd-row"><div className="vd-row-l">Số dư đầu kỳ</div><div className="vd-row-v">{fmtVnd(detail.initial_amount)}</div></div>
                  <div className="vd-row"><div className="vd-row-l">Mã sổ</div><div className="vd-row-v">{detail.code}</div></div>
                  {detail.lock_date && (
                    <div className="vd-row"><div className="vd-row-l">Đã chốt tới</div><div className="vd-row-v">{detail.lock_date}</div></div>
                  )}
                  {detail.is_default && (
                    <div className="vd-row"><div className="vd-row-l">Mặc định</div><div className="vd-row-v">Sổ quỹ mặc định</div></div>
                  )}
                </div>

                {/* Biên bản đã ký của sổ này — cửa vào trang in được. */}
                {detailClosures.length > 0 && (
                  <div className="vd-table" style={{ marginTop: 10 }}>
                    {detailClosures.map((c) => (
                      <div className="vd-row" key={c.closure_id}>
                        <div className="vd-row-l">Biên bản #{c.closure_id} · {c.closed_through}</div>
                        <div className="vd-row-v">
                          <button
                            type="button"
                            style={{
                              background: "none", border: 0, padding: 0,
                              color: "#2563eb", fontWeight: 600, textDecoration: "underline",
                            }}
                            onClick={() => navigate(closureRecordPath(c.closure_id))}
                          >
                            Xem biên bản
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                <div className="sheet-acts">
                  <button className="ghost" onClick={() => navigate(`/income-expense?account_id=${detail.id}`)}>
                    <ReceiptText />
                    Xem thu chi
                  </button>
                  <button
                    className="primary"
                    onClick={() => {
                      setEditing(detail);
                      setDetail(null);
                      setFormOpen(true);
                    }}
                  >
                    <Pencil />
                    Sửa sổ
                  </button>
                </div>

                {/* Nghi thức chốt sổ đứng RIÊNG một hàng, dưới các thao tác
                    thường ngày: nó là hành động một chiều, không nên nằm cạnh
                    "Sửa sổ" để ngón tay bấm nhầm. */}
                {detailCanClose && (
                  <div className="sheet-acts" style={{ marginTop: 8 }}>
                    <button
                      className="primary"
                      style={{ background: "#b91c1c", width: "100%" }}
                      onClick={() => {
                        setCloseTarget(detail);
                        setDetail(null);
                        setCloseOpen(true);
                      }}
                    >
                      <Lock />
                      Chốt sổ &amp; bàn giao quỹ
                    </button>
                  </div>
                )}
                {!!detail.lock_date && (
                  <p style={{ margin: "10px 2px 0", fontSize: 12, color: "#8d8678", display: "flex", gap: 6 }}>
                    <FileText size={14} />
                    Sổ đã chốt tới {detail.lock_date} — kỳ đó khoá vĩnh viễn, không mở lại được.
                  </p>
                )}
              </div>
            </div>
          )}

          {/* FAB menu — bottom sheet */}
          {fabOpen && (
            <div className="sheet-ov" onClick={() => setFabOpen(false)}>
              <div className="sheet" onClick={(e) => e.stopPropagation()}>
                <div className="sheet-grab" />
                <div className="cmenu-hd">
                  <span className="cmenu-hd-t">Tạo mới</span>
                  <button className="sheet-x" style={{ marginLeft: "auto" }} onClick={() => setFabOpen(false)} aria-label="Đóng">
                    <X size={18} />
                  </button>
                </div>
                <div className="cmenu">
                  <button className="cmenu-opt" onClick={openCreate}>
                    <span className="cmenu-ic" style={{ background: "#e8f3ec", color: "#1f7a52" }}><Wallet size={19} /></span>
                    <span className="cmenu-tx">
                      <span className="cmenu-t">Sổ quỹ mới</span>
                      <span className="cmenu-s">Thêm tài khoản / quỹ tiền mặt</span>
                    </span>
                  </button>
                  <button
                    className="cmenu-opt"
                    onClick={() => {
                      setFabOpen(false);
                      navigate("/income-expense");
                    }}
                  >
                    <span className="cmenu-ic" style={{ background: "#e7eefc", color: "#2563eb" }}><ArrowLeftRight size={19} /></span>
                    <span className="cmenu-tx">
                      <span className="cmenu-t">Ghi thu / chi nhanh</span>
                      <span className="cmenu-s">Tạo phiếu ghi vào sổ quỹ</span>
                    </span>
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Thêm / sửa sổ quỹ — dùng lại dialog desktop */}
      <CashbookForm
        open={formOpen}
        onOpenChange={(o) => {
          setFormOpen(o);
          if (!o) setEditing(null);
        }}
        account={editing}
      />

      {/* Đợt 6 — đề nghị chốt & bàn giao, dùng lại dialog desktop */}
      <CloseCashbookDialog
        open={closeOpen}
        onOpenChange={(o) => {
          setCloseOpen(o);
          if (!o) setCloseTarget(null);
        }}
        cashbookId={closeTarget?.id ?? null}
        cashbookName={closeTarget?.name ?? null}
        candidates={confirmers ?? []}
      />
    </div>
  );
}
