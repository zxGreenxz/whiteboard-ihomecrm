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

      const data = buildContractTemplateData({ contract, vehicles });
      const blob = await renderContractDocx(selected.file_url, data);
      const safeName = `${selected.name}_${
        contract.contract_number ?? contract.id.slice(0, 8)
      }`.replace(/[\\/:*?"<>|]+/g, "_");
      downloadDocxBlob(blob, safeName);
      toast.success("Đã tạo file hợp đồng");
      onOpenChange(false);
    } catch (err) {
      console.error("Render contract template failed", err);
      const msg = err instanceof Error ? err.message : "Lỗi không xác định";
      toast.error(`Không thể tạo file: ${msg}`);
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
