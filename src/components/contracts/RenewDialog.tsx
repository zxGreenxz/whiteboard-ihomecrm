import { useEffect } from "react";
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
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { Loader2 } from "lucide-react";

import { renewFormSchema } from "@/lib/contractValidation";
import type { RenewFormData } from "@/lib/contractValidation";
import type { ContractWithRelations } from "@/types/contract";
import { useRenewContract } from "@/hooks/useContractOperations";

interface RenewDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  contract: ContractWithRelations;
}

export function RenewDialog({ open, onOpenChange, contract }: RenewDialogProps) {
  const renewContract = useRenewContract();

  const form = useForm<RenewFormData>({
    resolver: zodResolver(renewFormSchema),
    defaultValues: {
      new_end_date: "",
      new_rent_price: contract.rent_price,
      new_deposit: contract.total_deposit,
      notes: "",
    },
  });

  // Reset form when dialog opens or contract changes
  useEffect(() => {
    if (open) {
      form.reset({
        new_end_date: "",
        new_rent_price: contract.rent_price,
        new_deposit: contract.total_deposit,
        notes: "",
      });
    }
  }, [open, contract, form]);

  const onSubmit = (data: RenewFormData) => {
    renewContract.mutate(
      {
        contractId: contract.id,
        newEndDate: data.new_end_date,
        newRentPrice: data.new_rent_price,
        newDeposit: data.new_deposit,
        notes: data.notes,
      },
      {
        onSuccess: () => {
          onOpenChange(false);
        },
      }
    );
  };

  // Format current end date for display
  const currentEndDate = contract.end_date
    ? new Date(contract.end_date).toLocaleDateString("vi-VN")
    : "—";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Gia hạn hợp đồng</DialogTitle>
        </DialogHeader>

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            {/* Current end date (readonly) */}
            <div className="space-y-2">
              <label className="text-sm font-medium">Ngày kết thúc hiện tại</label>
              <Input value={currentEndDate} readOnly disabled className="bg-muted" />
            </div>

            {/* New end date */}
            <FormField
              control={form.control}
              name="new_end_date"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>
                    Ngày kết thúc mới <span className="text-red-500">*</span>
                  </FormLabel>
                  <FormControl>
                    <Input type="date" {...field} />
                  </FormControl>
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
                    <Input
                      type="number"
                      min={0}
                      placeholder="Giữ nguyên nếu không thay đổi"
                      {...field}
                      value={field.value ?? ""}
                      onChange={(e) =>
                        field.onChange(
                          e.target.value === "" ? undefined : Number(e.target.value)
                        )
                      }
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
                    <Input
                      type="number"
                      min={0}
                      placeholder="Giữ nguyên nếu không thay đổi"
                      {...field}
                      value={field.value ?? ""}
                      onChange={(e) =>
                        field.onChange(
                          e.target.value === "" ? undefined : Number(e.target.value)
                        )
                      }
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
                      placeholder="Ghi chú gia hạn..."
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
              <Button type="submit" disabled={renewContract.isPending}>
                {renewContract.isPending && (
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                )}
                Gia hạn
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
