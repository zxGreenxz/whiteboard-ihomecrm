import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { DateInput } from "@/components/ui/date-input";
import { useCreateAssetHandover } from "@/hooks/useAssets";
import { useContracts } from "@/hooks/useContracts";
import { supabase } from "@/integrations/supabase/client";
import { getSessionUser } from "@/lib/authSession";
import { todayISO } from '@/lib/collect';

const handoverSchema = z.object({
  contract_id: z.string().min(1, "Phải chọn hợp đồng"),
  handover_type: z.enum(["CHECK_IN", "CHECK_OUT"]),
  handover_date: z.string().min(1, "Ngày bàn giao là bắt buộc"),
  items: z.string().min(1, "Danh sách tài sản là bắt buộc"),
});

type HandoverFormValues = z.infer<typeof handoverSchema>;

interface AssetHandoverDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function AssetHandoverDialog({ open, onOpenChange }: AssetHandoverDialogProps) {
  const createHandover = useCreateAssetHandover();
  // Bàn giao tài sản (nhận/trả) thao tác trên HĐ đang hiệu lực → chỉ kéo
  // HĐ ACTIVE server-side thay vì full bảng.
  // enabled: open — dialog mounted sẵn (đóng) không fetch, đỡ kéo cả bảng HĐ
  // full-PII mỗi lần tải trang.
  const { data: contractsData } = useContracts({ statuses: ["ACTIVE"], enabled: open });
  const contracts = contractsData ?? [];

  const form = useForm<HandoverFormValues>({
    resolver: zodResolver(handoverSchema),
    defaultValues: {
      contract_id: "",
      handover_type: "CHECK_IN",
      handover_date: todayISO(),
      items: "",
    },
  });

  const onSubmit = async (data: HandoverFormValues) => {
    try {
      const user = await getSessionUser();
      if (!user) throw new Error('Not authenticated');

      await createHandover.mutateAsync({
        contract_id: data.contract_id,
        type: data.handover_type,
        handover_date: data.handover_date,
        items: data.items as any,
        user_id: user.id,
      });
      form.reset();
      onOpenChange(false);
    } catch (error) {
      console.error("Failed:", error);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader><DialogTitle>Biên bản bàn giao tài sản</DialogTitle></DialogHeader>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            <FormField control={form.control} name="contract_id" render={({ field }) => (
              <FormItem><FormLabel>Hợp đồng *</FormLabel><Select onValueChange={field.onChange} value={field.value}><FormControl><SelectTrigger><SelectValue placeholder="Chọn hợp đồng" /></SelectTrigger></FormControl><SelectContent>{contracts.map((c) => (<SelectItem key={c.id} value={c.id}>{c.contract_number}</SelectItem>))}</SelectContent></Select><FormMessage /></FormItem>
            )} />
            <div className="grid grid-cols-2 gap-4">
              <FormField control={form.control} name="handover_type" render={({ field }) => (
                <FormItem><FormLabel>Loại *</FormLabel><Select onValueChange={field.onChange} value={field.value}><FormControl><SelectTrigger><SelectValue /></SelectTrigger></FormControl><SelectContent><SelectItem value="CHECK_IN">Nhận căn hộ</SelectItem><SelectItem value="CHECK_OUT">Trả căn hộ</SelectItem></SelectContent></Select><FormMessage /></FormItem>
              )} />
              <FormField control={form.control} name="handover_date" render={({ field }) => (
                <FormItem><FormLabel>Ngày *</FormLabel><FormControl><DateInput value={field.value || ''} onChange={field.onChange} onBlur={field.onBlur} name={field.name} /></FormControl><FormMessage /></FormItem>
              )} />
            </div>
            <FormField control={form.control} name="items" render={({ field }) => (
              <FormItem><FormLabel>Danh sách tài sản (JSON) *</FormLabel><FormControl><Input {...field} placeholder='{"items":[]}' /></FormControl><FormMessage /></FormItem>
            )} />
            <div className="flex justify-end gap-3 pt-4">
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Hủy</Button>
              <Button type="submit" disabled={createHandover.isPending}>{createHandover.isPending ? "Đang tạo..." : "Tạo biên bản"}</Button>
            </div>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
