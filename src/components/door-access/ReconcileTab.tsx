import { useMemo, useState } from "react";
import { CircleX, Pencil, Plus, RefreshCw, Trash2 } from "lucide-react";

import { LoadingState, RefreshBar } from "@/components/loading/LoadingState";
import { Button } from "@/components/ui/button";
import { useDoorKeyLinks, useDoorKeys } from "@/hooks/door-access/useDoorAccessQueries";
import type { DoorDevice, DoorTenancy } from "@/lib/door-access/dto";
import type { DoorAccessCaller } from "@/lib/door-access/edge";
import { TENANCY_LABEL, formatDateVn, unlockTypeLabel } from "@/lib/door-access/format";
import { reconcileKeys, type ReconcileRow } from "@/lib/door-access/reconcile";
import { linkDisplayName } from "@/lib/door-access/records";
import { deleteBlockedReason } from "@/lib/door-access/view";
import { cn } from "@/lib/utils";

import { DeleteKeyDialog, LinkKeyDialog, UnlinkKeyDialog, type KeyActionDone } from "./KeyDialogs";
import { ErrorPanel, GuardedButton, Notice, Pill, SectionTitle, type NoticeTone } from "./parts";

const TENANCY_TONE: Record<DoorTenancy, "green" | "red" | "amber" | "blue"> = {
  CURRENT: "green",
  MOVED_OUT: "red",
  NO_CONTRACT: "amber",
  STAFF: "blue",
};

export function ReconcileTab({ caller, device, writable }: { caller: DoorAccessCaller; device: DoorDevice; writable: boolean }) {
  const keys = useDoorKeys(caller, device.id);
  const links = useDoorKeyLinks(caller, device.id);
  const result = useMemo(() => (keys.data && links.data ? reconcileKeys(keys.data, links.data) : null), [keys.data, links.data]);
  const canManage = device.can.manage_devices;

  const [linkRow, setLinkRow] = useState<ReconcileRow | null>(null);
  const [unlinkRow, setUnlinkRow] = useState<ReconcileRow | null>(null);
  const [deleteRow, setDeleteRow] = useState<ReconcileRow | null>(null);
  const [notice, setNotice] = useState<{ tone: NoticeTone; text: string } | null>(null);
  const done: KeyActionDone = (next) => setNotice(next);

  const refresh = () => {
    void keys.refetch();
    void links.refetch();
  };
  const fetching = keys.isFetching || links.isFetching;

  const actions = (row: ReconcileRow) => {
    if (!canManage) return null;
    const blocked = deleteBlockedReason(row, writable);
    return (
      <div className="flex flex-wrap gap-1.5">
        {row.onDevice && (
          <Button type="button" size="sm" variant="outline" onClick={() => setLinkRow(row)}>
            {row.link ? <Pencil className="mr-1 h-4 w-4" aria-hidden="true" /> : <Plus className="mr-1 h-4 w-4" aria-hidden="true" />}
            {row.link ? "Đổi" : "Gắn"}
          </Button>
        )}
        {row.link && (
          <Button type="button" size="sm" variant="outline" onClick={() => setUnlinkRow(row)}>
            <CircleX className="mr-1 h-4 w-4" aria-hidden="true" />
            Bỏ gắn
          </Button>
        )}
        {row.onDevice && (
          <GuardedButton
            type="button"
            size="sm"
            variant="outline"
            className="text-destructive hover:text-destructive"
            disabledReason={blocked}
            onClick={() => setDeleteRow(row)}
          >
            <Trash2 className="mr-1 h-4 w-4" aria-hidden="true" />
            Xoá trên máy
          </GuardedButton>
        )}
      </div>
    );
  };

  const loading = keys.data === undefined || links.data === undefined;

  return (
    <div className="space-y-3">
      <SectionTitle
        action={
          <Button type="button" size="sm" variant="ghost" disabled={fetching} onClick={refresh}>
            <RefreshCw className={cn("mr-1.5 h-4 w-4", fetching && "animate-spin")} aria-hidden="true" />
            Làm mới
          </Button>
        }
      >
        Số trên máy ↔ khách
      </SectionTitle>
      <p className="text-xs text-muted-foreground">
        Thêm vân tay/thẻ mới vẫn làm tại máy hoặc app SmartLife; ở đây chỉ gắn số với khách và dọn số của khách đã trả phòng.
      </p>
      {notice && <Notice tone={notice.tone}>{notice.text}</Notice>}

      {keys.isError && keys.data === undefined && (
        <ErrorPanel error={keys.error} title="Chưa đọc được danh sách trên máy" onRetry={() => void keys.refetch()} />
      )}
      {links.isError && links.data === undefined && (
        <ErrorPanel error={links.error} title="Chưa tải được danh sách đã gắn" onRetry={() => void links.refetch()} />
      )}
      {loading && !keys.isError && !links.isError && <LoadingState label="đối chiếu vân tay" variant="list" rows={4} />}

      {result && (
        <div className="relative space-y-3">
          <RefreshBar active={fetching} />
          {result.partial && (
            <Notice tone="warning">
              Máy trả danh sách chưa đầy đủ — mục “Chưa thấy trên máy” có thể chưa chính xác. Làm mới sau ít phút.
            </Notice>
          )}
          {(keys.isRefetchError || links.isRefetchError) && (
            <Notice tone="warning">Chưa làm mới được — đang hiện dữ liệu lần trước.</Notice>
          )}
          <p className="text-sm text-muted-foreground">
            {result.rows.filter((row) => row.onDevice).length} số trên máy · {result.unlinked} chưa gắn · {result.needsDelete.length} cần
            xoá
          </p>

          {result.needsDelete.length > 0 && (
            <section aria-labelledby="door-needs-delete" className="rounded-xl border border-red-300 bg-red-50 p-3 dark:border-red-900 dark:bg-red-950/30">
              <h3 id="door-needs-delete" className="font-semibold text-red-900 dark:text-red-100">
                Cần xoá ({result.needsDelete.length})
              </h3>
              <p className="mt-0.5 text-sm text-red-900/80 dark:text-red-100/80">
                Khách đã trả phòng nhưng số vẫn còn trên máy. CRM không tự xoá — người quản lý xoá từng số.
              </p>
              <ul className="mt-2 space-y-2">
                {result.needsDelete.map((row) => (
                  <li key={row.key} className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-background/80 px-3 py-2">
                    <div className="min-w-0 text-sm">
                      <span className="font-medium">{unlockTypeLabel(row.unlockType, row.sn)}</span>
                      {row.link && (
                        <>
                          {" "}
                          — {linkDisplayName(row.link)}
                          {row.link.room_name ? ` · ${row.link.room_name}` : ""}
                          {row.link.contract_end_date ? ` · HĐ hết ${formatDateVn(row.link.contract_end_date)}` : ""}
                        </>
                      )}
                    </div>
                    {canManage && (
                      <GuardedButton
                        type="button"
                        size="sm"
                        variant="destructive"
                        disabledReason={deleteBlockedReason(row, writable)}
                        onClick={() => setDeleteRow(row)}
                      >
                        <Trash2 className="mr-1 h-4 w-4" aria-hidden="true" />
                        Xoá trên máy
                      </GuardedButton>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          )}

          {result.rows.length === 0 ? (
            <p className="rounded-xl border border-dashed px-4 py-10 text-center text-sm text-muted-foreground">
              Máy chưa có vân tay, thẻ hay mật khẩu nào.
            </p>
          ) : (
            <ul className="divide-y rounded-xl border bg-card" aria-label="Đối chiếu vân tay">
              {result.rows.map((row) => (
                <li key={row.key} className="space-y-1.5 px-3 py-3">
                  <div className="flex flex-wrap items-baseline gap-x-2">
                    <span className="font-medium">{unlockTypeLabel(row.unlockType, row.sn)}</span>
                    {(row.keyName || row.deviceUserName) && (
                      <span className="text-xs text-muted-foreground">
                        trên máy: {[row.deviceUserName, row.keyName].filter(Boolean).join(" · ")}
                      </span>
                    )}
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5 text-sm">
                    {row.link ? (
                      <span>
                        {linkDisplayName(row.link)}
                        {row.link.room_name && <span className="text-muted-foreground"> · {row.link.room_name}</span>}
                      </span>
                    ) : (
                      <span className="text-muted-foreground">Chưa gắn</span>
                    )}
                    {row.link && <Pill tone={TENANCY_TONE[row.link.tenancy]}>{TENANCY_LABEL[row.link.tenancy]}</Pill>}
                    {row.needsDelete && <Pill tone="red">Cần xoá</Pill>}
                    {row.goneFromDevice && <Pill tone="amber">{result.partial ? "Chưa thấy trên máy" : "Không còn trên máy"}</Pill>}
                  </div>
                  {row.goneFromDevice && canManage && (
                    <p className="text-xs text-muted-foreground">Số không còn trên máy — nên bỏ gắn.</p>
                  )}
                  {actions(row)}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <LinkKeyDialog caller={caller} device={device} row={linkRow} onClose={() => setLinkRow(null)} onDone={done} />
      <UnlinkKeyDialog caller={caller} device={device} row={unlinkRow} onClose={() => setUnlinkRow(null)} onDone={done} />
      <DeleteKeyDialog caller={caller} device={device} row={deleteRow} onClose={() => setDeleteRow(null)} onDone={done} />
    </div>
  );
}
