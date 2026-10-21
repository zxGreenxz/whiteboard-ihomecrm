import { useMemo, useState } from "react";
import { KeyRound, Plus, RefreshCw, Trash2 } from "lucide-react";

import { LoadingState, RefreshBar } from "@/components/loading/LoadingState";
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
import { Button } from "@/components/ui/button";
import { useDeleteTempPassword } from "@/hooks/door-access/useDoorAccessMutations";
import { useDoorTempPasswordLogs, useDoorTempPasswords } from "@/hooks/door-access/useDoorAccessQueries";
import type { CreatedTempPassword, DoorDevice, DoorTempPassword } from "@/lib/door-access/dto";
import type { DoorAccessCaller } from "@/lib/door-access/edge";
import { doorErrorMessage, isDoorAccessError } from "@/lib/door-access/errors";
import { deliveryHint, purposeLabel } from "@/lib/door-access/format";
import { indexTempPasswordLogs, validityText } from "@/lib/door-access/tempPassword";
import { READ_ONLY_REASON } from "@/lib/door-access/view";
import { cn } from "@/lib/utils";

import { ErrorPanel, GuardedButton, Notice, Pill, SectionTitle, type NoticeTone } from "./parts";
import { CreateTempPasswordDialog, TempPasswordResultDialog } from "./TempPasswordDialogs";

const passwordName = (item: DoorTempPassword) => item.name ?? `Mật khẩu #${item.id}`;

export function TempPasswordTab({ caller, device, writable }: { caller: DoorAccessCaller; device: DoorDevice; writable: boolean }) {
  const list = useDoorTempPasswords(caller, device.id);
  const logs = useDoorTempPasswordLogs(caller, device.id);
  const createdBy = useMemo(() => indexTempPasswordLogs(logs.data?.logs ?? []), [logs.data]);
  const remove = useDeleteTempPassword(caller);

  const [createOpen, setCreateOpen] = useState(false);
  // Mã vừa tạo CHỈ nằm ở đây, và bị xoá khi đóng hộp kết quả.
  const [created, setCreated] = useState<CreatedTempPassword | null>(null);
  const [toDelete, setToDelete] = useState<DoorTempPassword | null>(null);
  const [notice, setNotice] = useState<{ tone: NoticeTone; text: string } | null>(null);
  const readOnly = writable ? null : READ_ONLY_REASON;

  const confirmDelete = () => {
    const target = toDelete;
    setToDelete(null);
    if (!target || remove.isPending) return;
    setNotice(null);
    remove.mutate(
      { deviceId: device.id, passwordId: target.id },
      {
        onSuccess: (data) =>
          setNotice(
            data.deleted
              ? { tone: "success", text: `Đã gửi lệnh xoá mật khẩu tạm “${passwordName(target)}”.` }
              : { tone: "warning", text: "SmartLife chưa xác nhận đã xoá — tải lại danh sách để kiểm tra." },
          ),
        onError: (error) =>
          setNotice(
            isDoorAccessError(error) && error.outcomeUnknown
              ? { tone: "warning", text: "Chưa rõ đã xoá chưa — tải lại danh sách và xem Nhật ký thao tác trước khi thử lại." }
              : { tone: "error", text: doorErrorMessage(error, "Chưa xoá được mật khẩu tạm.") },
          ),
      },
    );
  };

  const passwords = list.data?.passwords ?? [];

  return (
    <div className="space-y-3">
      <SectionTitle
        action={
          <div className="flex items-center gap-2">
            <Button type="button" size="sm" variant="ghost" disabled={list.isFetching} onClick={() => void list.refetch()}>
              <RefreshCw className={cn("mr-1.5 h-4 w-4", list.isFetching && "animate-spin")} aria-hidden="true" />
              Làm mới
            </Button>
            <GuardedButton type="button" size="sm" disabledReason={readOnly} onClick={() => setCreateOpen(true)}>
              <Plus className="mr-1.5 h-4 w-4" aria-hidden="true" />
              Tạo mật khẩu tạm
            </GuardedButton>
          </div>
        }
      >
        Mật khẩu tạm còn hiệu lực
      </SectionTitle>
      {readOnly && <p className="text-xs text-muted-foreground">{readOnly}.</p>}
      {notice && <Notice tone={notice.tone}>{notice.text}</Notice>}
      {logs.isError && (
        <Notice tone="warning">
          Chưa tải được nhật ký tạo mật khẩu — chưa hiện được người tạo.{" "}
          <button type="button" className="font-medium underline" onClick={() => void logs.refetch()}>
            Tải lại
          </button>
        </Notice>
      )}

      {list.data === undefined && list.isPending && <LoadingState label="mật khẩu tạm" variant="list" rows={3} />}
      {list.data === undefined && list.isError && (
        <ErrorPanel error={list.error} title="Chưa tải được mật khẩu tạm" onRetry={() => void list.refetch()} />
      )}
      {list.data !== undefined && passwords.length === 0 && (
        <p className="rounded-xl border border-dashed px-4 py-10 text-center text-sm text-muted-foreground">
          Máy này chưa có mật khẩu tạm nào còn hiệu lực.
        </p>
      )}
      {list.data !== undefined && passwords.length > 0 && (
        <div className="relative">
          <RefreshBar active={list.isFetching} />
          <ul className="divide-y rounded-xl border bg-card" aria-label="Mật khẩu tạm">
            {passwords.map((item) => {
              const log = createdBy.get(String(item.id));
              const purpose = log ? purposeLabel(log.detail?.purpose) : null;
              const hint = deliveryHint(item.deliveryStatus);
              return (
                <li key={item.id} className="flex items-start gap-3 px-3 py-3">
                  <KeyRound className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" aria-hidden="true" />
                  <div className="min-w-0 flex-1">
                    <p className="font-medium">{passwordName(item)}</p>
                    {item.effectiveSec !== null && item.invalidSec !== null && (
                      <p className="text-sm text-muted-foreground">Hiệu lực {validityText(item.effectiveSec, item.invalidSec)}</p>
                    )}
                    {log && (
                      <p className="text-xs text-muted-foreground">
                        Tạo bởi {log.actor_name ?? "không rõ"}
                        {purpose ? ` · ${purpose}` : ""}
                      </p>
                    )}
                    {hint && (
                      <div className="mt-1">
                        <Pill tone={item.deliveryStatus === 1 ? "amber" : "muted"}>{hint}</Pill>
                      </div>
                    )}
                  </div>
                  <GuardedButton
                    type="button"
                    size="sm"
                    variant="ghost"
                    className="text-destructive hover:text-destructive"
                    disabledReason={readOnly}
                    disabled={remove.isPending}
                    aria-label={`Xoá mật khẩu tạm ${passwordName(item)}`}
                    onClick={() => setToDelete(item)}
                  >
                    <Trash2 className="h-4 w-4" aria-hidden="true" />
                    <span className="ml-1.5 hidden sm:inline">Xoá</span>
                  </GuardedButton>
                </li>
              );
            })}
          </ul>
          {list.data.hasMore && (
            <p className="mt-2 text-xs text-muted-foreground">SmartLife còn mật khẩu tạm chưa liệt kê hết.</p>
          )}
        </div>
      )}
      {list.data !== undefined && list.isRefetchError && (
        <Notice tone="warning">Chưa làm mới được — đang hiện danh sách lần trước.</Notice>
      )}

      <CreateTempPasswordDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        caller={caller}
        device={device}
        onCreated={(result) => {
          setNotice(null);
          setCreated(result);
        }}
      />
      <TempPasswordResultDialog result={created} deviceName={device.display_name} onClose={() => setCreated(null)} />

      <AlertDialog open={toDelete !== null} onOpenChange={(open) => !open && setToDelete(null)}>
        <AlertDialogContent className="max-w-[calc(100vw-2rem)] sm:max-w-md">
          <AlertDialogHeader>
            <AlertDialogTitle>Xoá mật khẩu tạm “{toDelete ? passwordName(toDelete) : ""}”?</AlertDialogTitle>
            <AlertDialogDescription>
              Mã sẽ không mở được cửa {device.display_name} nữa khi máy nhận lệnh. Thao tác được ghi vào Nhật ký thao tác.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Huỷ</AlertDialogCancel>
            <AlertDialogAction className="bg-destructive text-destructive-foreground hover:bg-destructive/90" onClick={confirmDelete}>
              Xoá mật khẩu
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
