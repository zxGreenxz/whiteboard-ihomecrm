import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { ProfitHubSlot } from "@/pages/reports/finance/ProfitHubShell";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Pencil, Trash2, KeyRound, AlertTriangle } from "lucide-react";
import { formatCurrency } from "@/lib/utils";
import { useBuildings } from "@/hooks/useBuildings";
import { useAdminUsers } from "@/hooks/useAdminUsers";
import {
  useShareholders,
  useBuildingShareholders,
  useDeleteShareholder,
  type Shareholder,
} from "@/hooks/useShareholders";
import {
  useProfitManagers,
  useManagerSalaries,
  useDeleteProfitManager,
  type ProfitManager,
} from "@/hooks/useProfitManagers";
import ShareholderForm from "./ShareholderForm";
import ProfitManagerForm from "./ProfitManagerForm";

export default function ShareConfigTab() {
  const { data: shareholders = [] } = useShareholders();
  const { data: buildings = [] } = useBuildings();
  const { data: shares = [] } = useBuildingShareholders();
  const { data: users = [] } = useAdminUsers();
  const deleteSh = useDeleteShareholder();

  const { data: managers = [] } = useProfitManagers();
  const { data: salaryRules = [] } = useManagerSalaries();
  const deleteMgr = useDeleteProfitManager();

  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<Shareholder | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);

  const [mgrFormOpen, setMgrFormOpen] = useState(false);
  const [editingMgr, setEditingMgr] = useState<ProfitManager | null>(null);
  const [deleteMgrId, setDeleteMgrId] = useState<string | null>(null);

  const buildingName = (id: string) => buildings.find((b: any) => b.id === id)?.name ?? "—";
  const userEmail = (uid: string | null) =>
    uid ? users.find((u) => u.id === uid)?.email ?? users.find((u) => u.id === uid)?.full_name ?? "—" : null;

  const sharesByShareholder = useMemo(() => {
    const m = new Map<string, { building_id: string; percent: number }[]>();
    for (const s of shares) {
      const arr = m.get(s.shareholder_id) ?? [];
      arr.push({ building_id: s.building_id, percent: s.percent });
      m.set(s.shareholder_id, arr);
    }
    return m;
  }, [shares]);

  const rulesByManager = useMemo(() => {
    const m = new Map<string, typeof salaryRules>();
    for (const r of salaryRules) {
      const arr = m.get(r.manager_id) ?? [];
      arr.push(r);
      m.set(r.manager_id, arr);
    }
    return m;
  }, [salaryRules]);

  // Mô tả gọn 1 quy tắc lương: hình thức + cơ sở + giá trị + số nhà.
  const ruleLabel = (r: (typeof salaryRules)[number]): string => {
    const basis = r.basis === "PER_BUILDING" ? "mỗi nhà" : "tổng nhóm";
    const value = r.form === "FIXED" ? formatCurrency(r.amount) : `${r.percent}% LN`;
    return `${value} · ${basis} · ${r.building_ids.length} nhà`;
  };

  // KPI hero: đếm cổ đông/quản lý + toà đã gán đủ 100% (cảnh báo toà còn hở).
  const linkedShareholders = shareholders.filter((s) => s.auth_user_id).length;
  const buildingsWithShare = useMemo(() => {
    const m = new Map<string, number>();
    for (const s of shares) m.set(s.building_id, (m.get(s.building_id) ?? 0) + s.percent);
    return m;
  }, [shares]);
  const fullyAssigned = [...buildingsWithShare.values()].filter((p) => Math.abs(p - 100) < 0.005).length;
  // Tòa lệch 100%: thiếu → "còn X% chưa gán", dư → "vượt X%" (đừng in số âm).
  const partial = [...buildingsWithShare.entries()]
    .filter(([, p]) => Math.abs(p - 100) >= 0.005)
    .map(([bid, p]) => {
      const gap = Math.round(Math.abs(100 - p) * 100) / 100;
      return `${buildingName(bid)} ${p}% — ${p < 100 ? `còn ${gap}% chưa gán` : `vượt ${gap}%`}`;
    });

  return (
    <>
      <ProfitHubSlot name="kpis">
        <div className="ph-kpi">
          <div className="ph-kpi__label">Cổ đông</div>
          <div className="ph-kpi__value">{shareholders.length}</div>
          <div className="ph-kpi__sub">{linkedShareholders} đã gán user đăng nhập</div>
        </div>
        <div className="ph-kpi__div" />
        <div className="ph-kpi">
          <div className="ph-kpi__label">Quản lý điều hành</div>
          <div className="ph-kpi__value">{managers.length}</div>
          <div className="ph-kpi__sub">{salaryRules.length} quy tắc lương đang áp dụng</div>
        </div>
        <div className="ph-kpi__div" />
        <div className="ph-kpi">
          <div className="ph-kpi__label">Tòa nhà</div>
          <div className="ph-kpi__value">{buildings.length}</div>
          <div className="ph-kpi__sub">{buildingsWithShare.size} tòa đã gán cổ đông</div>
        </div>
        <div className="ph-kpi__div" />
        <div className="ph-kpi">
          <div className="ph-kpi__label">Tỷ lệ gán đủ 100%</div>
          <div className="ph-kpi__value ph-kpi__value--mint">
            {fullyAssigned}/{buildingsWithShare.size} tòa
          </div>
          {partial.length > 0 ? (
            <div className="ph-kpi__sub ph-kpi__sub--gold" title={partial.join(" · ")}>
              {partial[0]}
              {partial.length > 1 ? ` (+${partial.length - 1})` : ""}
            </div>
          ) : (
            <div className="ph-kpi__sub ph-kpi__sub--mint">Mọi tòa đã gán đủ</div>
          )}
        </div>
      </ProfitHubSlot>

      <div className="ph-stack">
      <div className="ph-card">
        <div className="ph-card__head">
          <div className="ph-card__title">Cổ đông &amp; tỷ lệ theo tòa</div>
          <div className="ph-card__push">
            <Button className="ph-btn-primary" onClick={() => { setEditing(null); setFormOpen(true); }}>
              ＋ Thêm cổ đông
            </Button>
          </div>
        </div>
        {shareholders.length === 0 ? (
          <div className="ph-empty">Chưa có cổ đông nào. Bấm "Thêm cổ đông" để gán user + chọn tòa.</div>
        ) : (
          <div className="ph-grid-2" style={{ padding: "0 18px 18px", gap: 12 }}>
            {shareholders.map((s) => {
              const rows = sharesByShareholder.get(s.id) ?? [];
              return (
                <div key={s.id} className="ph-person">
                  <div className="ph-person__top">
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div className="ph-person__name">{s.name}</div>
                      {s.auth_user_id ? (
                        <div className="ph-person__meta ph-person__meta--ok">
                          <KeyRound className="h-3 w-3" /> {userEmail(s.auth_user_id)}
                        </div>
                      ) : (
                        <div className="ph-person__meta ph-person__meta--warn">
                          <AlertTriangle className="h-3 w-3" /> Chưa gán user — cổ đông không đăng nhập được
                        </div>
                      )}
                    </div>
                    <div style={{ display: "flex", gap: 4 }}>
                      <Button
                        className="ph-iconbtn"
                        aria-label={`Sửa ${s.name}`}
                        onClick={() => { setEditing(s); setFormOpen(true); }}
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </Button>
                      <Button
                        className="ph-iconbtn ph-iconbtn--danger"
                        aria-label={`Xoá ${s.name}`}
                        onClick={() => setDeleteId(s.id)}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </div>

                  {rows.length === 0 ? (
                    <div className="ph-rule__meta" style={{ marginTop: 10 }}>Chưa gán tòa nào.</div>
                  ) : (
                    <div className="ph-chipset">
                      {rows.map((r) => (
                        <span key={r.building_id} className="ph-pct">
                          {buildingName(r.building_id)} <b>{r.percent}%</b>
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Lương điều hành — trừ khỏi LN từng nhà trước khi chia cổ đông */}
      <div className="ph-card">
        <div className="ph-card__head">
          <div>
            <div className="ph-card__title">Lương điều hành</div>
            <div className="ph-card__note">
              Trừ khỏi lợi nhuận từng nhà <b>trước</b> khi chia cho cổ đông.
            </div>
          </div>
          <div className="ph-card__push">
            <Button className="ph-btn-primary" onClick={() => { setEditingMgr(null); setMgrFormOpen(true); }}>
              ＋ Thêm quản lý
            </Button>
          </div>
        </div>
        {managers.length === 0 ? (
          <div className="ph-empty">Chưa có quản lý điều hành nào. Bấm "Thêm quản lý" để gán user + cấu hình lương.</div>
        ) : (
          <div className="ph-grid-2" style={{ padding: "0 18px 18px", gap: 12 }}>
            {managers.map((m) => {
              const rows = rulesByManager.get(m.id) ?? [];
              return (
                <div key={m.id} className="ph-person">
                  <div className="ph-person__top">
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div className="ph-person__name">{m.name}</div>
                      {m.auth_user_id ? (
                        <div className="ph-person__meta ph-person__meta--ok">
                          <KeyRound className="h-3 w-3" /> {userEmail(m.auth_user_id)}
                        </div>
                      ) : (
                        <div className="ph-person__meta ph-person__meta--warn">
                          <AlertTriangle className="h-3 w-3" /> Chưa gán user — quản lý không đăng nhập được
                        </div>
                      )}
                    </div>
                    <div style={{ display: "flex", gap: 4 }}>
                      <Button
                        className="ph-iconbtn"
                        aria-label={`Sửa ${m.name}`}
                        onClick={() => { setEditingMgr(m); setMgrFormOpen(true); }}
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </Button>
                      <Button
                        className="ph-iconbtn ph-iconbtn--danger"
                        aria-label={`Xoá ${m.name}`}
                        onClick={() => setDeleteMgrId(m.id)}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </div>

                  {rows.length === 0 ? (
                    <div className="ph-rule__meta" style={{ marginTop: 10 }}>Chưa có quy tắc lương.</div>
                  ) : (
                    rows.map((r) => (
                      <div key={r.id} className="ph-rule">
                        <div className="ph-rule__name">
                          {r.label || (r.form === "FIXED" ? "Tiền thực" : "Phần trăm")}
                        </div>
                        <div className="ph-rule__meta">{ruleLabel(r)}</div>
                        <div className="ph-rule__tags">
                          {r.building_ids.slice(0, 6).map((bid) => (
                            <span key={bid} className="ph-rule__tag">{buildingName(bid)}</span>
                          ))}
                          {r.building_ids.length > 6 && (
                            <span className="ph-rule__tag">+{r.building_ids.length - 6}</span>
                          )}
                        </div>
                      </div>
                    ))
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
      </div>

      <ShareholderForm open={formOpen} onOpenChange={(o) => { setFormOpen(o); if (!o) setEditing(null); }} shareholder={editing} />
      <ProfitManagerForm open={mgrFormOpen} onOpenChange={(o) => { setMgrFormOpen(o); if (!o) setEditingMgr(null); }} manager={editingMgr} />

      <AlertDialog open={!!deleteId} onOpenChange={(o) => { if (!o) setDeleteId(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Xoá cổ đông?</AlertDialogTitle>
            <AlertDialogDescription>
              Cổ đông sẽ bị ẩn. Dữ liệu lợi nhuận đã chốt và phiếu chi gắn cổ đông vẫn được giữ.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Huỷ</AlertDialogCancel>
            <AlertDialogAction
              className="bg-red-600 hover:bg-red-700"
              onClick={async () => { if (deleteId) await deleteSh.mutateAsync(deleteId); setDeleteId(null); }}
            >
              Xoá
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={!!deleteMgrId} onOpenChange={(o) => { if (!o) setDeleteMgrId(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Xoá quản lý điều hành?</AlertDialogTitle>
            <AlertDialogDescription>
              Quản lý sẽ bị ẩn và các quy tắc lương ngừng áp dụng cho lần chốt sau. Lương đã chốt
              và phiếu chi đã trả vẫn được giữ.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Huỷ</AlertDialogCancel>
            <AlertDialogAction
              className="bg-red-600 hover:bg-red-700"
              onClick={async () => { if (deleteMgrId) await deleteMgr.mutateAsync(deleteMgrId); setDeleteMgrId(null); }}
            >
              Xoá
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
