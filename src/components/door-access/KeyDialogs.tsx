import { useEffect, useMemo, useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Loader2 } from "lucide-react";

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
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { useDeleteKey, useLinkKey, useUnlinkKey } from "@/hooks/door-access/useDoorAccessMutations";
import { useDoorTenants } from "@/hooks/door-access/useDoorAccessQueries";
import type { DoorDevice } from "@/lib/door-access/dto";
import type { DoorAccessCaller } from "@/lib/door-access/edge";
import { doorErrorMessage, isDoorAccessError } from "@/lib/door-access/errors";
import { KEY_LABEL_MAX, linkKeyFormSchema, tenantOptions, type LinkKeyFormValues } from "@/lib/door-access/forms";
import { TENANCY_LABEL, unlockTypeLabel } from "@/lib/door-access/format";
import type { ReconcileRow } from "@/lib/door-access/reconcile";
import { linkDisplayName } from "@/lib/door-access/records";
import { rowOwner } from "@/lib/door-access/view";
import { focusFirstError } from "@/lib/formErrors";

import { ErrorPanel, Notice, type NoticeTone } from "./parts";

export type KeyActionDone = (notice: { tone: NoticeTone; text: string }) => void;

// ---------------------------------------------------------------------------------------------
// Gắn khách / nhãn

export function LinkKeyDialog({
  caller,
  device,
  row,
  onClose,
  onDone,
}: {
  caller: DoorAccessCaller;
  device: DoorDevice;
  row: ReconcileRow | null;
  onClose: () => void;
  onDone: KeyActionDone;
}) {
  const tenants = useDoorTenants(caller, device.id, row !== null);
  const link = useLinkKey(caller);
  const options = useMemo(() => tenantOptions(tenants.data ?? []), [tenants.data]);
  const form = useForm<LinkKeyFormValues>({
    resolver: zodResolver(linkKeyFormSchema),
    defaultValues: { mode: "customer", customerId: "", label: "" },
  });
  const { reset } = form;
  const resetMutation = link.reset;
  useEffect(() => {
    if (!row) return;
    reset({ mode: row.link?.label ? "label" : "customer", customerId: "", label: row.link?.label ?? "" });
    resetMutation();
  }, [row, reset, resetMutation]);
  const mode = form.watch("mode");

  if (!row) return null;
  const what = unlockTypeLabel(row.unlockType, row.sn);
  const busy = link.isPending;

  const submit = form.handleSubmit(
    (values) => {
      form.clearErrors("root.server");
      link.mutate(
        {
          deviceId: device.id,
          unlockType: row.unlockType,
          unlockSn: row.sn,
          tuyaUserId: row.tuyaUserId,
          deviceUserName: row.deviceUserName ?? row.keyName,
          customerId: values.mode === "customer" ? values.customerId : null,
          label: values.mode === "label" ? values.label.trim() : null,
        },
        {
          onSuccess: (saved) => {
            onDone({ tone: "success", text: `Đã gắn ${what} với ${linkDisplayName(saved)}.` });
            onClose();
          },
          onError: (error) =>
            form.setError("root.server", {
              message:
                isDoorAccessError(error) && error.outcomeUnknown
                  ? "Chưa rõ đã gắn chưa — tải lại danh sách trước khi thử lại."
                  : doorErrorMessage(error, "Chưa gắn được."),
            }),
        },
      );
    },
    (errors) => {
      void focusFirstError(errors);
    },
  );

  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent className="max-h-[92vh] max-w-[calc(100vw-1.5rem)] overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Gắn {what}</DialogTitle>
          <DialogDescription>
            Máy {device.display_name}
            {row.deviceUserName ? ` · trên máy: ${row.deviceUserName}` : ""}. Gắn vân tay cho khách thì số được điền vào ô “Mã vân tay
            cửa ra vào” của khách.
          </DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={(event) => void submit(event)} className="space-y-4" noValidate>
            <div role="radiogroup" aria-label="Gắn với" className="grid grid-cols-2 gap-1.5 rounded-lg bg-muted p-1">
              {(["customer", "label"] as const).map((value) => (
                <button
                  key={value}
                  type="button"
                  role="radio"
                  aria-checked={mode === value}
                  disabled={busy}
                  onClick={() => form.setValue("mode", value, { shouldValidate: false })}
                  className={`h-9 rounded-md text-sm font-medium ${mode === value ? "bg-background shadow-sm" : "text-muted-foreground"}`}
                >
                  {value === "customer" ? "Khách đang thuê" : "Nhãn (nhân viên…)"}
                </button>
              ))}
            </div>
            {mode === "customer" ? (
              tenants.isError ? (
                <ErrorPanel error={tenants.error} title="Chưa tải được khách đang thuê" onRetry={() => void tenants.refetch()} />
              ) : (
                <FormField
                  control={form.control}
                  name="customerId"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Khách</FormLabel>
                      <FormControl>
                        <SearchableSelect
                          modal
                          value={field.value}
                          onValueChange={field.onChange}
                          disabled={busy || tenants.isPending}
                          placeholder={tenants.isPending ? "…" : options.length === 0 ? "Tòa chưa có khách đang thuê" : "Chọn khách"}
                          searchPlaceholder="Tìm tên hoặc phòng"
                          emptyText="Không thấy khách phù hợp"
                          aria-label="Chọn khách"
                          options={options.map((option) => ({
                            value: option.customerId,
                            label: `${option.name}${option.rooms.length ? ` · ${option.rooms.join(", ")}` : ""}${option.representative ? " (đại diện)" : ""}`,
                            keywords: [option.name, ...option.rooms],
                          }))}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              )
            ) : (
              <FormField
                control={form.control}
                name="label"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Nhãn</FormLabel>
                    <FormControl>
                      <Input {...field} placeholder="Nhân viên bảo vệ" autoComplete="off" disabled={busy} />
                    </FormControl>
                    <p className="text-xs text-muted-foreground">Tối đa {KEY_LABEL_MAX} ký tự.</p>
                    <FormMessage />
                  </FormItem>
                )}
              />
            )}
            {form.formState.errors.root?.server?.message && <Notice tone="error">{form.formState.errors.root.server.message}</Notice>}
            <DialogFooter className="gap-2">
              <Button type="button" variant="outline" disabled={busy} onClick={onClose}>
                Huỷ
              </Button>
              <Button type="submit" disabled={busy}>
                {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />}
                Gắn
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------------------------
// Bỏ gắn

export function UnlinkKeyDialog({
  caller,
  device,
  row,
  onClose,
  onDone,
}: {
  caller: DoorAccessCaller;
  device: DoorDevice;
  row: ReconcileRow | null;
  onClose: () => void;
  onDone: KeyActionDone;
}) {
  const unlink = useUnlinkKey(caller);
  const link = row?.link ?? null;
  const what = row ? unlockTypeLabel(row.unlockType, row.sn) : "";
  const confirm = () => {
    if (!row || !link) return;
    unlink.mutate(
      { deviceId: device.id, linkId: link.id },
      {
        onSuccess: () => onDone({ tone: "success", text: `Đã bỏ gắn ${what} khỏi ${linkDisplayName(link)}.` }),
        onError: (error) =>
          onDone({
            tone: isDoorAccessError(error) && error.outcomeUnknown ? "warning" : "error",
            text:
              isDoorAccessError(error) && error.outcomeUnknown
                ? "Chưa rõ đã bỏ gắn chưa — tải lại danh sách trước khi thử lại."
                : doorErrorMessage(error, "Chưa bỏ gắn được."),
          }),
      },
    );
    onClose();
  };
  return (
    <AlertDialog open={row !== null && link !== null} onOpenChange={(open) => !open && onClose()}>
      <AlertDialogContent className="max-w-[calc(100vw-2rem)] sm:max-w-md">
        <AlertDialogHeader>
          <AlertDialogTitle>
            Bỏ gắn {what} khỏi {link ? linkDisplayName(link) : ""}?
          </AlertDialogTitle>
          <AlertDialogDescription>
            Chỉ bỏ liên kết trong CRM; số trên máy giữ nguyên. Ô “Mã vân tay cửa ra vào” của khách cập nhật theo.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Huỷ</AlertDialogCancel>
          <AlertDialogAction onClick={confirm}>Bỏ gắn</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

// ---------------------------------------------------------------------------------------------
// Xoá trên máy — hai bước, nêu đúng tên khách và số

export function DeleteKeyDialog({
  caller,
  device,
  row,
  onClose,
  onDone,
}: {
  caller: DoorAccessCaller;
  device: DoorDevice;
  row: ReconcileRow | null;
  onClose: () => void;
  onDone: KeyActionDone;
}) {
  const remove = useDeleteKey(caller);
  const [step, setStep] = useState<1 | 2>(1);
  const [problem, setProblem] = useState<{ tone: NoticeTone; text: string } | null>(null);
  const resetMutation = remove.reset;
  useEffect(() => {
    setStep(1);
    setProblem(null);
    resetMutation();
  }, [row, resetMutation]);

  if (!row) return null;
  const what = unlockTypeLabel(row.unlockType, row.sn);
  const owner = rowOwner(row);
  const busy = remove.isPending;
  const tuyaUserId = row.tuyaUserId;

  const confirm = () => {
    if (!tuyaUserId || busy) return;
    setProblem(null);
    remove.mutate(
      { deviceId: device.id, unlockType: row.unlockType, unlockNo: row.sn, tuyaUserId },
      {
        onSuccess: (data) => {
          if (data.deleted) {
            onDone({ tone: "success", text: `Đã xoá ${what} (${owner}) trên máy ${device.display_name}.` });
            onClose();
            return;
          }
          setProblem({ tone: "warning", text: "SmartLife chưa xác nhận đã xoá — tải lại danh sách để kiểm tra." });
        },
        onError: (error) =>
          setProblem(
            isDoorAccessError(error) && error.outcomeUnknown
              ? { tone: "warning", text: "Chưa rõ đã xoá chưa — tải lại danh sách và xem Nhật ký thao tác trước khi thử lại." }
              : { tone: "error", text: doorErrorMessage(error, "Chưa xoá được trên máy.") },
          ),
      },
    );
  };

  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent className="max-w-[calc(100vw-1.5rem)] sm:max-w-md">
        {step === 1 ? (
          <>
            <DialogHeader>
              <DialogTitle>
                Xoá {what} trên máy {device.display_name}?
              </DialogTitle>
              <DialogDescription>
                Số này đang gắn: <span className="font-medium text-foreground">{owner}</span>
                {row.link ? ` (${TENANCY_LABEL[row.link.tenancy]})` : ""}.
              </DialogDescription>
            </DialogHeader>
            <p className="text-sm">
              Sau khi xoá, {what} không mở được cửa nữa. Muốn thêm lại phải làm tại máy hoặc trong app SmartLife.
            </p>
            <DialogFooter className="gap-2">
              <Button type="button" variant="outline" onClick={onClose}>
                Huỷ
              </Button>
              <Button type="button" variant="destructive" onClick={() => setStep(2)}>
                Tiếp tục
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>Xác nhận lần cuối</DialogTitle>
              <DialogDescription>
                Xoá <span className="font-medium text-foreground">{what}</span> của{" "}
                <span className="font-medium text-foreground">{owner}</span> trên máy {device.display_name}. Không hoàn tác được.
              </DialogDescription>
            </DialogHeader>
            {problem && <Notice tone={problem.tone}>{problem.text}</Notice>}
            <DialogFooter className="gap-2">
              <Button type="button" variant="outline" disabled={busy} onClick={() => setStep(1)}>
                Quay lại
              </Button>
              <Button type="button" variant="destructive" disabled={busy || !tuyaUserId} onClick={confirm}>
                {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />}
                Xoá trên máy
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
