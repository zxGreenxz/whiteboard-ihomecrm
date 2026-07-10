import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Label } from "@/components/ui/label";
import { Plus, X } from "lucide-react";

import type { ContractFormState } from "./useContractFormState";

type CustomersSectionProps = Pick<
  ContractFormState,
  | "selectedCustomers"
  | "setCustomerDialogOpen"
  | "handleRepresentativeChange"
  | "handleRemoveCustomer"
  | "handleCustomerNotesChange"
>;

/** ===== Section 2: Khách hàng ===== (JSX chuyển NGUYÊN VĂN) */
export function CustomersSection({
  selectedCustomers,
  setCustomerDialogOpen,
  handleRepresentativeChange,
  handleRemoveCustomer,
  handleCustomerNotesChange,
}: CustomersSectionProps) {
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between border-b pb-2">
        <h3 className="text-sm font-semibold text-foreground">
          Khách hàng
        </h3>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => setCustomerDialogOpen(true)}
        >
          <Plus className="h-4 w-4 mr-1" />
          Thêm khách hàng
        </Button>
      </div>

      {selectedCustomers.length === 0 ? (
        <p className="text-sm text-muted-foreground py-4 text-center">
          Chưa chọn khách hàng nào
        </p>
      ) : (
        <div className="border rounded-md divide-y">
          <RadioGroup
            value={
              selectedCustomers.find((c) => c.is_representative)?.id ?? ""
            }
            onValueChange={handleRepresentativeChange}
          >
            {selectedCustomers.map((customer) => (
              <div key={customer.id} className="px-4 py-3 space-y-2">
                <div className="flex items-center gap-3">
                  <RadioGroupItem
                    value={customer.id}
                    id={`rep-${customer.id}`}
                  />
                  <Label
                    htmlFor={`rep-${customer.id}`}
                    className="flex-1 cursor-pointer"
                  >
                    <span className="text-sm font-medium">
                      {customer.full_name}
                    </span>
                    <span className="text-xs text-muted-foreground ml-2">
                      {customer.phone}
                      {customer.id_number && ` · ${customer.id_number}`}
                    </span>
                    {customer.is_representative && (
                      <span className="ml-2 text-xs bg-blue-100 text-blue-800 px-1.5 py-0.5 rounded">
                        Đại diện
                      </span>
                    )}
                  </Label>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 text-destructive hover:text-destructive"
                    onClick={() => handleRemoveCustomer(customer.id)}
                  >
                    <X className="h-4 w-4" />
                  </Button>
                </div>
                <Textarea
                  placeholder={
                    customer.is_representative
                      ? "Ghi chú cho người đại diện..."
                      : "Ghi chú riêng cho khách này..."
                  }
                  value={customer.notes ?? ""}
                  onChange={(e) =>
                    handleCustomerNotesChange(customer.id, e.target.value)
                  }
                  rows={2}
                  className="text-sm"
                />
              </div>
            ))}
          </RadioGroup>
        </div>
      )}
    </div>
  );
}
