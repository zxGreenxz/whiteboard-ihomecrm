import { useState, useEffect, useMemo } from "react";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Loader2, Printer } from "lucide-react";
import { toast } from "sonner";

import type { ContractWithRelations } from "@/types/contract";
import {
  useDocumentTemplatesByType,
  type DocumentTemplate,
} from "@/hooks/useDocumentTemplates";
import {
  buildContractTemplateData,
  renderContractDocx,
  downloadDocxBlob,
} from "@/lib/contractTemplateEngine";
import { supabase } from "@/integrations/supabase/client";
import { ContractTemplatePicker } from './ContractTemplatePicker';
import { friendlyError } from '@/lib/friendlyError';
import { useContractRentSupport } from '@/hooks/useContractRentSupport';
import { useMyPermissions } from '@/hooks/useMyPermissions';
import { canUse } from '@/lib/permissionPages';
import { Checkbox } from '@/components/ui/checkbox';
import { CT01InputError, downloadWordBlob } from '@/lib/ct01Document';
import { buildCT01RoomBundle, type CT01RoomBundle } from '@/lib/ct01RoomBundle';

const VEHICLE_TYPE_LABELS: Record<string, string> = {
  MOTORBIKE: "Xe máy",
  CAR: "Ô tô",
  BICYCLE: "Xe đạp",
  ELECTRIC_BIKE: "Xe điện",
  OTHER: "Khác",
};

interface PrintContractDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  contract: ContractWithRelations | null;
}

export function PrintContractDialog({
  open,
  onOpenChange,
  contract,
}: PrintContractDialogProps) {
  const needsSupport = (contract?.discounts as unknown as { version?: number })?.version === 2;
  const support = useContractRentSupport({ contractIds: contract ? [contract.id] : [], enabled: open && !!contract && needsSupport });
  // For now we surface contract templates (lease_contract). Later this could
  // branch by action — termination/extension/transfer — but the dialog stays
  // simple and works off the contract type the user is most likely to print.
  // enabled: open — dialog mounted sẵn, chỉ fetch templates khi mở.
  const { data: templates = [], isLoading } = useDocumentTemplatesByType(
    "lease_contract",
    { enabled: open },
  );

  const [selectedId, setSelectedId] = useState<string>("");
  const [isRendering, setIsRendering] = useState(false);
  // Kèm một tệp CT01 + HĐ ở nhờ của mọi khách trong phòng để in ký cùng lúc.
  const { data: permissions } = useMyPermissions();
  const buildingId = contract?.room?.building_id ?? contract?.room?.building?.id ?? null;
  const roomMembers = (contract?.contract_customers ?? []).filter((cc) => cc.customer_id);
  const canPrintResidence =
    canUse(permissions, "customers", "print", buildingId ?? undefined) && roomMembers.length > 0;
  const [withResidence, setWithResidence] = useState(true);
  const [residenceMonths, setResidenceMonths] = useState<12 | 24>(24);

  // Pre-select the default template (or first available) on open.
  useEffect(() => {
    if (!open || templates.length === 0) return;
    const def =
      templates.find((t) => t.is_default)?.id ?? templates[0]?.id ?? "";
    setSelectedId((prev) => prev || def);
  }, [open, templates]);

  const selected = useMemo<DocumentTemplate | undefined>(
    () => templates.find((t) => t.id === selectedId),
    [templates, selectedId],
  );

  const handlePrint = async () => {
    if (!contract || !selected) return;
    setIsRendering(true);
    try {
      // Fetch vehicles linked to this contract's customers so VEHICLES_TABLE
      // in the template (Danh sách xe Bên B đăng ký) gets populated.
      const customerIds = (contract.contract_customers ?? [])
        .map((cc) => cc.customer_id)
        .filter(Boolean);

      let vehicles: Array<{
        name?: string;
        license_plate?: string;
        type?: string;
        color?: string;
        brand?: string;
        model?: string;
        owner_name?: string;
      }> = [];

      if (customerIds.length > 0) {
        const { data: rows, error } = await supabase
          .from("vehicles")
          .select(
            "vehicle_type, vehicle_name, brand, model, license_plate, color, customer_id"
          )
          .in("customer_id", customerIds)
          .is("deleted_at", null);
        if (error) throw error;

        const customerNameById = new Map<string, string>();
        (contract.contract_customers ?? []).forEach((cc) => {
          const fullName = (cc.customer as { full_name?: string } | undefined)
            ?.full_name;
          if (cc.customer_id && fullName) {
            customerNameById.set(cc.customer_id, fullName);
          }
        });

        vehicles = (rows ?? []).map((r: Record<string, unknown>) => ({
          name: (r.vehicle_name as string) ?? "",
          license_plate: (r.license_plate as string) ?? "",
          type:
            VEHICLE_TYPE_LABELS[(r.vehicle_type as string) ?? ""] ??
            ((r.vehicle_type as string) ?? ""),
          color: (r.color as string) ?? "",
          brand: (r.brand as string) ?? "",
          model: (r.model as string) ?? "",
          owner_name:
            customerNameById.get((r.customer_id as string) ?? "") ?? "",
        }));
      }

      if (needsSupport && (support.isPending || support.isError)) throw new Error('Chưa đọc được lịch hỗ trợ. Thử lại sau khi tải dữ liệu.');
      const row = support.data?.rows.find(row => row.contract_id === contract.id);
      if (needsSupport && !row?.schedule) throw new Error('Chưa xác minh được lịch hỗ trợ của hợp đồng.');
      const data = buildContractTemplateData({ contract, vehicles, rentSupport: row?.schedule ?? undefined });
      const blob = await renderContractDocx(selected.file_url, data);
      const contractCode = contract.contract_number ?? contract.id.slice(0, 8);
      const fileName = (prefix: string) => `${prefix}_${contractCode}`.replace(/[\\/:*?"<>|]+/g, "_");
      const safeName = fileName(selected.name);

      // Tệp CT01 lỗi không được chặn hợp đồng: dựng trước, tải hợp đồng, rồi báo riêng.
      let residence: CT01RoomBundle | null = null;
      let residenceError: unknown = null;
      if (canPrintResidence && withResidence) {
        try {
          residence = await buildCT01RoomBundle({
            buildingId,
            roomNumber: contract.room?.name,
            durationMonths: residenceMonths,
            members: roomMembers.map((cc) => ({
              customerId: cc.customer_id,
              isRepresentative: cc.is_representative,
              fallbackName: cc.customer?.full_name,
            })),
          });
        } catch (err) {
          residenceError = err;
        }
      }

      downloadDocxBlob(blob, safeName);
      if (residence?.blob) {
        downloadWordBlob(residence.blob, `${fileName("CT01 + HĐ ở nhờ")}.docx`);
        toast.success(`Đã tải hợp đồng và tệp CT01 + HĐ ở nhờ của ${residence.included.length} khách`);
      } else {
        toast.success("Đã chuẩn bị file hợp đồng để tải");
      }
      if (residence && residence.skipped.length > 0) {
        toast.warning(
          residence.blob
            ? `Tệp CT01 còn thiếu ${residence.skipped.length} khách`
            : "Chưa tạo được tệp CT01 cho khách nào",
          { description: residence.skipped.map((s) => `${s.name}: ${s.reason}`).join(" · "), duration: 12_000 },
        );
      }
      if (residenceError) {
        console.error("Render CT01 room bundle failed", residenceError);
        toast.warning("Đã tải hợp đồng, chưa tạo được tệp CT01", {
          description:
            residenceError instanceof CT01InputError
              ? residenceError.message
              : friendlyError(residenceError, "Chưa tạo được tệp CT01", { operation: "tạo tệp CT01" }).description,
          duration: 12_000,
        });
      }
      onOpenChange(false);
    } catch (err) {
      console.error("Render contract template failed", err);
      const feedback = friendlyError(err, 'Không thể tạo file hợp đồng', { operation: 'in hợp đồng' });
      toast.error(feedback.title, { description: feedback.description });
    } finally {
      setIsRendering(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Printer className="h-5 w-5 text-green-600" />
            In hợp đồng
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-3">
          {contract && (
            <div className="rounded-md bg-muted/50 px-3 py-2 text-sm">
              <div className="font-medium">
                {contract.contract_number ?? "(chưa có mã)"}
              </div>
              <div className="text-muted-foreground text-xs">
                {contract.room?.building?.name ?? ""}
                {contract.room?.name ? ` · ${contract.room.name}` : ""}
              </div>
            </div>
          )}

          <ContractTemplatePicker templates={templates} selectedId={selectedId} onSelect={setSelectedId} isLoading={isLoading} />

          {canPrintResidence && (
            <div className="rounded-md border px-3 py-2.5 space-y-2">
              <label className="flex items-start gap-2.5 text-sm cursor-pointer">
                <Checkbox
                  className="mt-0.5"
                  checked={withResidence}
                  disabled={isRendering}
                  onCheckedChange={(checked) => setWithResidence(checked === true)}
                />
                <span>
                  Kèm tệp CT01 + HĐ ở nhờ cho {roomMembers.length} khách trong phòng
                  <span className="block text-xs text-muted-foreground">
                    Một tệp Word, mỗi khách một bộ — in một lần cho cả phòng ký.
                  </span>
                </span>
              </label>
              {withResidence && (
                <label className="flex items-center gap-2 pl-6 text-sm text-muted-foreground">
                  Thời hạn tạm trú
                  <select
                    aria-label="Thời hạn tạm trú"
                    value={residenceMonths}
                    disabled={isRendering}
                    onChange={(event) => setResidenceMonths(event.target.value === "12" ? 12 : 24)}
                    className="h-8 rounded-md border border-input bg-background px-2 text-sm text-foreground disabled:opacity-50"
                  >
                    <option value="12">12 tháng</option>
                    <option value="24">24 tháng</option>
                  </select>
                </label>
              )}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={isRendering}
          >
            Hủy
          </Button>
          <Button
            onClick={handlePrint}
            disabled={!selected || isRendering}
            className="bg-green-600 hover:bg-green-700"
          >
            {isRendering && (
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            )}
            Tải xuống .docx
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
