import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowLeft, Plus, Wallet, Lock, X, Pencil, ArrowLeftRight, ReceiptText } from "lucide-react";
import "@/styles/mobileApp.css";
import "@/styles/financeMobile.css";
import "@/styles/estateMobile.css";
import { useAccountsWithBalance, type AccountWithBalance } from "@/hooks/useAccounts";
import CashbookForm from "@/components/cashbooks/CashbookForm";

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
 */
export default function CashbooksMobilePage() {
  const navigate = useNavigate();
  const { data, isLoading } = useAccountsWithBalance({ page: 1, pageSize: 100 });
  const funds = (data?.data ?? []) as AccountWithBalance[];

  const [detail, setDetail] = useState<AccountWithBalance | null>(null);
  const [fabOpen, setFabOpen] = useState(false);
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<AccountWithBalance | null>(null);

  const stats = useMemo(() => {
    const count = funds.length;
    const locked = funds.filter((f) => !!f.lock_date).length;
    const total = funds.reduce((s, f) => s + (f.current_amount || 0), 0);
    return { count, locked, total };
  }, [funds]);

  const openCreate = () => {
    setEditing(null);
    setFabOpen(false);
    setFormOpen(true);
  };

  return (
    <div className="cm-stage">
      <div className="cm-app">
        <div className="route route-anim">
          <div className="mtop">
            <button className="mback" onClick={() => navigate("/")} aria-label="Về trang chủ">
              <ArrowLeft />
            </button>
            <div className="mtitle">
              <h1>Sổ quỹ</h1>
              <p>{stats.count} sổ · tồn {compact(stats.total)}</p>
            </div>
          </div>

          <div className="mbody">
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
              <span className="msub-t">Danh sách sổ quỹ</span>
              <span className="msub-n">{stats.count}</span>
            </div>

            {isLoading ? (
              <div className="stub"><p>Đang tải sổ quỹ…</p></div>
            ) : funds.length === 0 ? (
              <div className="stub"><p>Chưa có sổ quỹ nào. Tạo sổ mới qua nút (+).</p></div>
            ) : (
              <div className="rowlist">
                {funds.map((f) => {
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
                  {detail.is_default && (
                    <div className="vd-row"><div className="vd-row-l">Mặc định</div><div className="vd-row-v">Sổ quỹ mặc định</div></div>
                  )}
                </div>

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
    </div>
  );
}
