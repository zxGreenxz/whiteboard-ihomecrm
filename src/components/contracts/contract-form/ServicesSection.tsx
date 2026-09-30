import {flattenFieldErrors} from '@/lib/formErrors';
import { CurrencyInput } from "@/components/ui/currency-input";
import { NumberInput } from "@/components/ui/number-input";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Plus, Trash2 } from "lucide-react";

import { formatVND } from "./types";
import type { ContractFormState } from "./useContractFormState";

type ServicesSectionProps = Pick<
  ContractFormState,
  | "form"
  | "useCustomServices"
  | "handleToggleCustomServices"
  | "setServiceDialogOpen"
  | "buildingActiveServices"
  | "buildingServicesAsSelected"
  | "selectedBuildingId"
  | "selectedServices"
  | "handleServiceFieldChange"
  | "handleRemoveService"
  | "sourceIssues"
>;

/** ===== Section 4: Tiền phí dịch vụ ===== (JSX chuyển NGUYÊN VĂN) */
export function ServicesSection({
  form,
  useCustomServices,
  handleToggleCustomServices,
  setServiceDialogOpen,
  buildingServicesAsSelected,
  selectedBuildingId,
  selectedServices,
  handleServiceFieldChange,
  handleRemoveService,
  sourceIssues,
}: ServicesSectionProps) {
  const rowErrors=flattenFieldErrors(form.formState.errors);
  const defaultServicesUnavailable = sourceIssues.some(issue => issue.key === 'buildingServices');
  return (
    <div className="space-y-4" data-field-name="services">
      <div className="flex items-center justify-between border-b pb-2 gap-3">
        <h3 className="text-sm font-semibold text-foreground shrink-0">
          Tiền phí dịch vụ
        </h3>
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2">
            <Switch
              id="use-custom-services"
              checked={useCustomServices}
              onCheckedChange={handleToggleCustomServices}
            />
            <Label
              htmlFor="use-custom-services"
              className="text-xs font-normal cursor-pointer text-muted-foreground"
            >
              Dùng dịch vụ riêng cho HĐ
            </Label>
          </div>
          {useCustomServices && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setServiceDialogOpen(true)}
            >
              <Plus className="h-4 w-4 mr-1" />
              Thêm dịch vụ
            </Button>
          )}
        </div>
      </div>
      {(form.formState.errors as Record<string, { message?: string }>).services?.message && (
        <p role="alert" className="text-sm font-medium text-destructive">{(form.formState.errors as Record<string, { message?: string }>).services?.message}</p>
      )}

      {!useCustomServices ? (
        /* OFF: dùng dịch vụ mặc định của toà — hiển thị mờ, chỉ xem.
           Hoá đơn sẽ tự lấy đơn giá toà cho HĐ này. */
        defaultServicesUnavailable ? <p role="alert" className="text-sm text-destructive py-4 text-center">Chưa tải được dịch vụ mặc định của tòa. Tải lại nguồn trước khi kiểm tra phí dịch vụ.</p>
        : buildingServicesAsSelected.length === 0 ? (
          <p className="text-sm text-muted-foreground py-4 text-center">
            {selectedBuildingId
              ? "Toà chưa cấu hình dịch vụ mặc định. Bật \"Dùng dịch vụ riêng\" để thêm dịch vụ cho HĐ."
              : "Chọn toà nhà để xem dịch vụ mặc định."}
          </p>
        ) : (
          <div className="space-y-2">
            <div className="border rounded-md overflow-x-auto opacity-60 pointer-events-none select-none">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-muted/50">
                    <th className="text-left px-3 py-2 font-medium">
                      Tên dịch vụ
                    </th>
                    <th className="text-left px-3 py-2 font-medium">
                      Đơn vị
                    </th>
                    <th className="text-right px-3 py-2 font-medium">
                      Đơn giá (toà)
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {buildingServicesAsSelected.map((s) => (
                    <tr key={s.id}>
                      <td className="px-3 py-2">{s.name}</td>
                      <td className="px-3 py-2 text-muted-foreground">
                        {s.unit ?? "—"}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {formatVND(s.unit_price)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="text-[11px] text-muted-foreground">
              HĐ đang dùng dịch vụ mặc định theo toà. Bật{" "}
              <span className="font-medium">"Dùng dịch vụ riêng cho HĐ"</span>{" "}
              để chỉnh đơn giá/loại điện riêng cho hợp đồng này.
            </p>
          </div>
        )
      ) : selectedServices.length === 0 ? (
        <p className="text-sm text-muted-foreground py-4 text-center">
          Chưa chọn dịch vụ nào — bấm "Thêm dịch vụ" để chọn.
        </p>
      ) : (
        <div className="border rounded-md overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-muted/50">
                <th className="text-left px-3 py-2 font-medium">
                  Tên dịch vụ
                </th>
                <th className="text-left px-3 py-2 font-medium">
                  Đồng hồ
                </th>
                <th className="text-right px-3 py-2 font-medium">
                  Chỉ số đầu
                </th>
                <th className="text-right px-3 py-2 font-medium">
                  Số lượng
                </th>
                <th className="text-right px-3 py-2 font-medium">
                  Đơn giá
                </th>
                <th className="w-10"></th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {selectedServices.map((service) => (
                <tr key={service.id}>
                  <td className="px-3 py-2">{service.name}</td>
                  <td className="px-3 py-2 text-muted-foreground">
                    {service.pricing_type === "METERED" ? "Có" : "—"}
                  </td>
                  <td className="px-3 py-2">
                    <NumberInput
                      allowDecimal
                      min={0}
                      className="w-24 h-8 text-right ml-auto"
                      name={`services.${service.id}.initial_reading`}
                      aria-label={`${service.name}: chỉ số đầu`}
                      aria-invalid={!!rowErrors[`services.${service.id}.initial_reading`]}
                      aria-describedby={rowErrors[`services.${service.id}.initial_reading`]?`service-${service.id}-initial_reading-error`:undefined}
                      value={service.initial_reading}
                      onChange={(v) =>
                        handleServiceFieldChange(
                          service.id,
                          "initial_reading",
                          v
                        )
                      }
                    />
                    {rowErrors[`services.${service.id}.initial_reading`]&&<p id={`service-${service.id}-initial_reading-error`} role="alert" className="mt-1 text-sm text-destructive">{rowErrors[`services.${service.id}.initial_reading`]}</p>}
                  </td>
                  <td className="px-3 py-2">
                    <NumberInput
                      min={1}
                      className="w-20 h-8 text-right ml-auto"
                      name={`services.${service.id}.quantity`}
                      aria-label={`${service.name}: số lượng`}
                      aria-invalid={!!rowErrors[`services.${service.id}.quantity`]}
                      aria-describedby={rowErrors[`services.${service.id}.quantity`]?`service-${service.id}-quantity-error`:undefined}
                      value={service.quantity}
                      onChange={(v) =>
                        handleServiceFieldChange(
                          service.id,
                          "quantity",
                          v
                        )
                      }
                    />
                    {rowErrors[`services.${service.id}.quantity`]&&<p id={`service-${service.id}-quantity-error`} role="alert" className="mt-1 text-sm text-destructive">{rowErrors[`services.${service.id}.quantity`]}</p>}
                  </td>
                  <td className="px-3 py-2">
                    <CurrencyInput
                      suffix={false}
                      className="w-32 h-8 text-right ml-auto"
                      name={`services.${service.id}.unit_price`}
                      aria-label={`${service.name}: đơn giá`}
                      aria-invalid={!!rowErrors[`services.${service.id}.unit_price`]}
                      aria-describedby={rowErrors[`services.${service.id}.unit_price`]?`service-${service.id}-unit_price-error`:undefined}
                      value={service.unit_price}
                      onChange={(v) =>
                        handleServiceFieldChange(
                          service.id,
                          "unit_price",
                          v
                        )
                      }
                    />
                    {rowErrors[`services.${service.id}.unit_price`]&&<p id={`service-${service.id}-unit_price-error`} role="alert" className="mt-1 text-sm text-destructive">{rowErrors[`services.${service.id}.unit_price`]}</p>}
                  </td>
                  <td className="px-3 py-2">
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 text-destructive hover:text-destructive"
                      onClick={() => handleRemoveService(service.id)}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
