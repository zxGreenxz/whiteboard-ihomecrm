import { useState, useEffect } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { CurrencyInput } from "@/components/ui/currency-input";
import { DateInput } from "@/components/ui/date-input";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { Loader2, UserPlus, X } from "lucide-react";

import { transferContractFormSchema } from "@/lib/contractValidation";
import type { TransferContractFormData } from "@/lib/contractValidation";
import type { ContractWithRelations } from "@/types/contract";
import { useTransferContract } from "@/hooks/useContractOperations";
import { todayISO } from '@/lib/collect';
import {
  CustomerSelectionDialog,
  type CustomerBasic,
} from "./CustomerSelectionDialog";

interface TransferContractDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  contract: ContractWithRelations;
}

export function TransferContractDialog({
  open,
  onOpenChange,
  contract,
}: TransferContractDialogProps) {
  const transferContract = useTransferContract();
  const [customerDialogOpen, setCustomerDialogOpen] = useState(false);
  const [selectedCustomer, setSelectedCustomer] = useState<CustomerBasic | null>(null);

  const form = useForm<TransferContractFormData>({
    resolver: zodResolver(transferContractFormSchema),
    defaultValues: {
      new_customer_id: "",
      new_rent_price: undefined,
      new_deposit: undefined,
      transfer_date: todayISO(),
      notes: "",
    },
  });

  // Reset form when dialog opens
  useEffect(() => {
    if (open) {
      form.reset({
        new_customer_id: "",
        new_rent_price: undefined,
        new_deposit: undefined,
        transfer_date: todayISO(),
        notes: "",
      });
      setSelectedCustomer(null);
    }
  }, [open, contract, form]);

  const handleCustomerSelect = (customers: CustomerBasic[]) => {
    // Single select mode — take first selected customer
    const customer = customers[0] ?? null;
    setSelectedCustomer(customer);
    form.setValue("new_customer_id", customer?.id ?? "", { shouldValidate: true });
  };

  const handleClearCustomer = () => {
    setSelectedCustomer(null);
    form.setValue("new_customer_id", "", { shouldValidate: true });
  };

  const onSubmit = (data: TransferContractFormData) => {
    transferContract.mutate(
      {
        contractId: contract.id,
        newCustomerId: data.new_customer_id,
        newRentPrice: data.new_rent_price,
        newDeposit: data.new_deposit,
        transferDate: data.transfer_date,
        notes: data.notes,
      },
      {
        onSuccess: () => {
          onOpenChange(false);
        },
      }
    );
  };

  // Current contract info
  const currentBuilding = contract.room?.building?.name || "—";
  const currentRoom = contract.room?.name || "—";
  const representativeCustomer = contract.contract_customers?.find(
    (cc) => cc.is_representative
  );
  const currentCustomer = representativeCustomer?.customer?.full_name || "—";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Nhượng hợp đồng</DialogTitle>
        </DialogHeader>

        {/* Current contract info */}
        <div className="rounded-md border p-3 bg-muted/50 space-y-1 text-sm">
          <p>
            <span className="font-medium">Khách hàng hiện tại:</span>{" "}
            {currentCustomer}
          </p>
          <p>
            <span className="font-medium">Phòng:</span> {currentBuilding} -{" "}
            {currentRoom}
          </p>
          <p>
            <span className="font-medium">Giá thuê hiện tại:</span>{" "}
            {contract.rent_price?.toLocaleString("vi-VN")} đ
          </p>
          <p>
            <span className="font-medium">Tiền cọc hiện tại:</span>{" "}
            {contract.total_deposit?.toLocaleString("vi-VN")} đ
          </p>
        </div>

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            {/* New customer selection */}
            <FormField
              control={form.control}
              name="new_customer_id"
              render={() => (
                <FormItem>
                  <FormLabel>
                    Khách hàng mới <span className="text-red-500">*</span>
                  </FormLabel>
                  {selectedCustomer ? (
                    <div className="flex items-center gap-2 rounded-md border p-2 bg-background">
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium truncate">
                          {selectedCustomer.full_name}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {selectedCustomer.phone}
                          {selectedCustomer.id_number &&
                            ` · ${selectedCustomer.id_number}`}
                        </p>
                      </div>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 shrink-0"
                        onClick={handleClearCustomer}
                      >
                        <X className="h-4 w-4" />
                      </Button>
                    </div>
                  ) : (
                    <Button
                      type="button"
                      variant="outline"
                      className="w-full justify-start text-muted-foreground"
                      onClick={() => setCustomerDialogOpen(true)}
                    >
                      <UserPlus className="h-4 w-4 mr-2" />
                      Chọn khách hàng mới
                    </Button>
                  )}
                  <FormMessage />
                </FormItem>
              )}
            />

            {/* New rent price */}
            <FormField
              control={form.control}
              name="new_rent_price"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Giá thuê mới</FormLabel>
                  <FormControl>
                    <CurrencyInput
                      placeholder="Giữ nguyên nếu không thay đổi"
                      value={field.value}
                      onChange={field.onChange}
                      onBlur={field.onBlur}
                      name={field.name}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            {/* New deposit */}
            <FormField
              control={form.control}
              name="new_deposit"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Tiền cọc mới</FormLabel>
                  <FormControl>
                    <CurrencyInput
                      placeholder="Giữ nguyên nếu không thay đổi"
                      value={field.value}
                      onChange={field.onChange}
                      onBlur={field.onBlur}
                      name={field.name}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            {/* Transfer date */}
            <FormField
              control={form.control}
              name="transfer_date"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>
                    Ngày nhượng <span className="text-red-500">*</span>
                  </FormLabel>
                  <FormControl>
                    <DateInput
                      value={field.value || ""}
                      onChange={field.onChange}
                      onBlur={field.onBlur}
                      name={field.name}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            {/* Notes */}
            <FormField
              control={form.control}
              name="notes"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Ghi chú</FormLabel>
                  <FormControl>
                    <Textarea
                      placeholder="Ghi chú nhượng hợp đồng..."
                      rows={3}
                      {...field}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => onOpenChange(false)}
              >
                Hủy
              </Button>
              <Button type="submit" disabled={transferContract.isPending}>
                {transferContract.isPending && (
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                )}
                Nhượng hợp đồng
              </Button>
            </DialogFooter>
          </form>
        </Form>

        {/* Customer Selection Dialog (single select) */}
        <CustomerSelectionDialog
          open={customerDialogOpen}
          onOpenChange={setCustomerDialogOpen}
          selectedCustomerIds={selectedCustomer ? [selectedCustomer.id] : []}
          onSelect={handleCustomerSelect}
        />
      </DialogContent>
    </Dialog>
  );
}
