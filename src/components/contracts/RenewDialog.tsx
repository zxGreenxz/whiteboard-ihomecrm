import { useEffect,useRef,useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
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
import { CurrencyInput } from "@/components/ui/currency-input";
import { DateInput } from "@/components/ui/date-input";
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
  const [noticeChoice,setNoticeChoice]=useState<''|'KEEP'|'CANCEL'>('');
  const noticeRequest=useRef<{intent:string;id:string}|null>(null);

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
      setNoticeChoice(contract.expected_move_out_date?'':'KEEP');
      noticeRequest.current=null;
      form.reset({
        new_end_date: "",
        new_rent_price: contract.rent_price,
        new_deposit: contract.total_deposit,
        notes: "",
      });
    }
  }, [open, contract, form]);

  const onSubmit = (data: RenewFormData) => {
    if(!noticeChoice) return;
    const params={contractId:contract.id,expectedUpdatedAt:contract.updated_at,newEndDate:data.new_end_date,
      newRentPrice:data.new_rent_price,newDeposit:data.new_deposit,notes:data.notes,noticeChoice,
      noticeReason:data.notes?.trim()||(noticeChoice==='KEEP'?'Giữ báo dọn khi gia hạn hợp đồng':'Hủy báo dọn khi gia hạn hợp đồng')};
    const intent=JSON.stringify(params);if(noticeRequest.current?.intent!==intent)noticeRequest.current={intent,id:crypto.randomUUID()};
    renewContract.mutate(
      {...params,requestId:noticeRequest.current!.id},
      {
        onSuccess: () => {
          onOpenChange(false);
        },
      }
    );
  };

  // Format current end date for display
  const currentEndDate = contract.end_date
    ? new Date(contract.end_date).toLocaleDateString("vi-VN", { day: "2-digit", month: "2-digit", year: "numeric" })
    : "—";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Gia hạn hợp đồng</DialogTitle>
          <DialogDescription>Kiểm tra hạn hợp đồng và báo dọn trước khi gia hạn.</DialogDescription>
        </DialogHeader>

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            {contract.expected_move_out_date&&<div className="space-y-2 rounded border p-3 text-sm">
              <p>Đã báo dọn ngày {contract.expected_move_out_date.split('-').reverse().join('/')}.</p>
              <label className="space-y-1"><span>Khi gia hạn, bạn muốn giữ hay hủy báo dọn?</span><select aria-label="Giữ hoặc hủy báo dọn khi gia hạn" className="flex h-10 w-full rounded-md border bg-background px-3" value={noticeChoice} disabled={renewContract.isPending} onChange={event=>setNoticeChoice(event.target.value as typeof noticeChoice)}><option value="">Chọn cách xử lý báo dọn</option><option value="KEEP">Giữ ngày báo dọn hiện tại</option><option value="CANCEL">Hủy báo dọn · Khách tiếp tục ở</option></select></label>
            </div>}
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
              <Button type="submit" disabled={renewContract.isPending||!noticeChoice}>
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
