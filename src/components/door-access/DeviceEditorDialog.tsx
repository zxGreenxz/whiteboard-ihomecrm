import { useEffect, useMemo } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useSaveDevice } from "@/hooks/door-access/useDoorAccessMutations";
import type { BuildingCandidate } from "@/lib/door-access/buildingMatch";
import { DEVICE_KINDS, type DiscoveredDevice, type DoorDevice } from "@/lib/door-access/dto";
import type { DoorAccessCaller } from "@/lib/door-access/edge";
import { doorErrorMessage, isDoorAccessError } from "@/lib/door-access/errors";
import { DEVICE_KIND_LABEL } from "@/lib/door-access/format";
import { DEVICE_NAME_MAX, deviceFormSchema, type DeviceFormValues } from "@/lib/door-access/forms";
import { focusFirstError } from "@/lib/formErrors";

import { Notice, type NoticeTone } from "./parts";

export type DeviceEditorTarget =
  | { mode: "new"; discovered: DiscoveredDevice; suggestedBuildingId: string | null }
  | { mode: "edit"; device: DoorDevice };

function defaults(target: DeviceEditorTarget): DeviceFormValues {
  if (target.mode === "edit") {
    return {
      buildingId: target.device.building_id,
      displayName: target.device.display_name,
      deviceKind: target.device.device_kind,
      channelId: String(target.device.channel_id),
      passwordLength: String(target.device.password_length),
    };
  }
  return {
    buildingId: target.suggestedBuildingId ?? "",
    displayName: (target.discovered.name ?? "").slice(0, DEVICE_NAME_MAX),
    deviceKind: target.discovered.kind ?? "access_control",
    channelId: "1",
    passwordLength: "7",
  };
}

export function DeviceEditorDialog({
  caller,
  target,
  buildings,
  onClose,
  onSaved,
}: {
  caller: DoorAccessCaller;
  target: DeviceEditorTarget | null;
  buildings: readonly BuildingCandidate[];
  onClose: () => void;
  onSaved: (notice: { tone: NoticeTone; text: string }) => void;
}) {
  const save = useSaveDevice(caller);
  const form = useForm<DeviceFormValues>({
    resolver: zodResolver(deviceFormSchema),
    defaultValues: { buildingId: "", displayName: "", deviceKind: "access_control", channelId: "1", passwordLength: "7" },
  });
  const { reset } = form;
  const resetMutation = save.reset;
  useEffect(() => {
    if (!target) return;
    reset(defaults(target));
    resetMutation();
  }, [target, reset, resetMutation]);

  const buildingOptions = useMemo(
    () =>
      [...buildings]
        .sort((a, b) => a.name.localeCompare(b.name, "vi"))
        .map((building) => ({
          value: building.id,
          label: building.name,
          keywords: [building.name, building.code ?? "", building.street_address ?? ""].filter(Boolean),
        })),
    [buildings],
  );

  if (!target) return null;
  const busy = save.isPending;
  const discovered = target.mode === "new" ? target.discovered : null;
  const tuyaDeviceId = target.mode === "new" ? target.discovered.tuyaDeviceId : target.device.tuya_device_id;
  const tuyaCategory = target.mode === "new" ? target.discovered.category : target.device.tuya_category;
  const tuyaProductName = target.mode === "new" ? target.discovered.productName : target.device.tuya_product_name;
  const reactivating = target.mode === "edit" && !target.device.is_active;

  const submit = form.handleSubmit(
    (values) => {
      form.clearErrors("root.server");
      save.mutate(
        {
          tuyaDeviceId,
          buildingId: values.buildingId,
          displayName: values.displayName.trim(),
          deviceKind: values.deviceKind,
          tuyaCategory,
          tuyaProductName,
          channelId: Number(values.channelId),
          passwordLength: Number(values.passwordLength),
        },
        {
          onSuccess: (device) => {
            onSaved({ tone: "success", text: `Đã lưu máy ${device.display_name} (${device.building_name ?? "tòa đã chọn"}).` });
            onClose();
          },
          onError: (error) =>
            form.setError("root.server", {
              message:
                isDoorAccessError(error) && error.outcomeUnknown
                  ? "Chưa rõ đã lưu chưa — tải lại danh sách máy trước khi thử lại."
                  : doorErrorMessage(error, "Chưa lưu được máy."),
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
          <DialogTitle>{target.mode === "new" ? "Gắn máy vào tòa" : reactivating ? "Bật lại máy" : "Sửa máy"}</DialogTitle>
          <DialogDescription>
            {discovered
              ? `${discovered.name ?? discovered.tuyaDeviceId}${discovered.productName ? ` · ${discovered.productName}` : ""}`
              : `Mã SmartLife ${tuyaDeviceId}`}
          </DialogDescription>
        </DialogHeader>
        {discovered && discovered.kind === null && (
          <Notice tone="warning">SmartLife không nhận ra đây là máy cửa. Chỉ gắn khi chắc chắn đây là khoá hoặc máy kiểm soát ra vào.</Notice>
        )}
        {reactivating && <Notice tone="info">Máy đang tắt khỏi CRM. Lưu để bật lại.</Notice>}
        <Form {...form}>
          <form onSubmit={(event) => void submit(event)} className="space-y-4" noValidate>
            <FormField
              control={form.control}
              name="buildingId"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Tòa</FormLabel>
                  <FormControl>
                    <SearchableSelect
                      modal
                      value={field.value}
                      onValueChange={field.onChange}
                      options={buildingOptions}
                      disabled={busy}
                      placeholder={buildingOptions.length === 0 ? "Chưa có tòa nào" : "Chọn tòa"}
                      searchPlaceholder="Tìm tên, mã hoặc địa chỉ"
                      emptyText="Không thấy tòa phù hợp"
                      aria-label="Chọn tòa"
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="displayName"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Tên hiển thị</FormLabel>
                  <FormControl>
                    <Input {...field} placeholder="Cửa chính Tòa A" autoComplete="off" disabled={busy} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="deviceKind"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Loại máy</FormLabel>
                  <Select value={field.value} onValueChange={field.onChange} disabled={busy}>
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {DEVICE_KINDS.map((kind) => (
                        <SelectItem key={kind} value={kind}>
                          {DEVICE_KIND_LABEL[kind]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />
            <div className="grid grid-cols-2 gap-3">
              <FormField
                control={form.control}
                name="channelId"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Kênh mở cửa</FormLabel>
                    <FormControl>
                      <Input {...field} type="number" inputMode="numeric" min={1} max={64} disabled={busy} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="passwordLength"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Độ dài mật khẩu tạm</FormLabel>
                    <FormControl>
                      <Input {...field} type="number" inputMode="numeric" min={6} max={10} disabled={busy} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>
            {form.formState.errors.root?.server?.message && <Notice tone="error">{form.formState.errors.root.server.message}</Notice>}
            <DialogFooter className="gap-2">
              <Button type="button" variant="outline" disabled={busy} onClick={onClose}>
                Huỷ
              </Button>
              <Button type="submit" disabled={busy}>
                {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />}
                Lưu máy
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
