import {useState,useRef} from 'react';
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
import { focusFirstError } from "@/lib/formErrors";
import {recordWriteBlocked,recordWriteMessage} from "@/lib/recordWriteOutcome";

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
  const [failure,setFailure]=useState<unknown>();
  const [blocked,setBlocked]=useState(false);
  const draftKey=useRef<string|null>(null);
  const createHandover = useCreateAssetHandover();
  // Bàn giao tài sản (nhận/trả) thao tác trên HĐ đang hiệu lực → chỉ kéo
  // HĐ ACTIVE server-side thay vì full bảng.
  // enabled: open — dialog mounted sẵn (đóng) không fetch, đỡ kéo cả bảng HĐ
  // full-PII mỗi lần tải trang.
  const contractsQuery = useContracts({ statuses: ["ACTIVE"], enabled: open });
  const contracts=contractsQuery.data??[];
  const sources=[contractsQuery];
  const sourceBlocked=sources.some(query=>query.isError||query.isLoading);

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
    if(blocked||sourceBlocked)return;
    form.clearErrors('root.server');
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
      setFailure(error);setBlocked(recordWriteBlocked(error));
      console.error("Failed:", error);
      form.setError('root.server', { type: 'server', message: recordWriteMessage(error,'tạo biên bản bàn giao') });
    }
  };

  return (
    <Dialog open={open} onOpenChange={value=>{if(!form.formState.isSubmitting)onOpenChange(value);}}>
      <DialogContent aria-describedby={undefined} className="max-w-2xl">
        <DialogHeader><DialogTitle>Biên bản bàn giao tài sản</DialogTitle></DialogHeader>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit, errors => { void focusFirstError(errors); })} className="space-y-4">
            {form.formState.errors.root?.server?.message && <p role="alert" className="text-sm text-destructive">{form.formState.errors.root.server.message}</p>}
            {sourceBlocked && <div role="alert" className="rounded border border-destructive p-3 text-sm">Chưa tải đủ dữ liệu tài sản. Tải lại trước khi lưu.<Button type="button" variant="outline" onClick={()=>{for(const query of sources)void query.refetch();}}>Tải lại dữ liệu</Button></div>}
            <fieldset disabled={blocked || sourceBlocked || form.formState.isSubmitting} className="space-y-4">
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
            </fieldset>
            <div className="flex justify-end gap-3 pt-4">
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Hủy</Button>
              <Button type="submit" disabled={blocked || sourceBlocked || form.formState.isSubmitting || createHandover.isPending}>{createHandover.isPending ? "Đang tạo..." : "Tạo biên bản"}</Button>
            </div>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
