import {useState,useRef} from 'react';
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { CurrencyInput } from "@/components/ui/currency-input";
import { DateInput } from "@/components/ui/date-input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { useCreateAssetMaintenance } from "@/hooks/useAssets";
import { useAssets } from "@/hooks/useAssets";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { getSessionUser } from "@/lib/authSession";
import { todayISO } from '@/lib/collect';
import { focusFirstError } from "@/lib/formErrors";
import {recordWriteBlocked,recordWriteMessage} from "@/lib/recordWriteOutcome";

const maintenanceSchema = z.object({
  asset_id: z.string().min(1, "Phải chọn tài sản"),
  issue_description: z.string().min(1, "Mô tả công việc là bắt buộc"),
  maintenance_date: z.string().min(1, "Ngày bảo trì là bắt buộc"),
  cost: z.number().min(0, "Chi phí phải >= 0").optional(),
  assigned_to: z.string().optional(),
  status: z.enum(["PENDING", "IN_PROGRESS", "COMPLETED"]),
  notes: z.string().optional(),
});

type MaintenanceFormValues = z.infer<typeof maintenanceSchema>;

interface AssetMaintenanceDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function AssetMaintenanceDialog({ open, onOpenChange }: AssetMaintenanceDialogProps) {
  const [failure,setFailure]=useState<unknown>();
  const [blocked,setBlocked]=useState(false);
  const draftKey=useRef<string|null>(null);
  const createMaintenance = useCreateAssetMaintenance();
  // CHƯA GATE: useAssets chưa nhận `enabled` (hook thuộc plan con E). Dialog
  // này mount sẵn nên danh sách tài sản vẫn được kéo lúc vào trang.
  const assetsQuery=useAssets();
  const {data:assets=[]}=assetsQuery;

  // Fetch staff/profiles for assignment.
  // Scope self-only (.eq id, user.id) → key phải scope-qualify ["profiles","self"]
  // để KHÔNG đụng cache với hook danh sách assignable ["profiles","assignable"].
  // Trước đây dùng chung ["profiles"] gây nhiễm chéo (self-only ↔ full list).
  const profilesQuery = useQuery({
    queryKey: ["profiles", "self"],
    queryFn: async () => {
      const user = await getSessionUser();
      if (!user) throw new Error('Not authenticated');

      const { data, error } = await supabase
        .from("profiles")
        .select("id, full_name")
        .eq('id', user.id);

      if (error) throw error;
      if(!Array.isArray(data))throw new Error('Chưa xác nhận được người xử lý tài sản. Tải lại trước khi lưu.');
      return data;
    },
    enabled: open,
  });

  const {data:profiles=[]}=profilesQuery;
  const sources=[assetsQuery,profilesQuery];
  const sourceBlocked=sources.some(query=>query.isError||query.isLoading);

  const form = useForm<MaintenanceFormValues>({
    resolver: zodResolver(maintenanceSchema),
    defaultValues: {
      asset_id: "",
      issue_description: "",
      maintenance_date: todayISO(),
      cost: 0,
      assigned_to: undefined,
      status: "PENDING",
      notes: "",
    },
  });

  const onSubmit = async (data: MaintenanceFormValues) => {
    if(blocked||sourceBlocked)return;
    form.clearErrors('root.server');
    try {
      const user = await getSessionUser();
      if (!user) throw new Error('Not authenticated');

      await createMaintenance.mutateAsync({
        asset_id: data.asset_id,
        issue_description: data.issue_description,
        maintenance_date: data.maintenance_date,
        status: data.status,
        cost: data.cost || null,
        assigned_to: data.assigned_to || null,
        notes: data.notes || null,
        user_id: user.id,
      });
      form.reset();
      onOpenChange(false);
    } catch (error) {
      setFailure(error);setBlocked(recordWriteBlocked(error));
      console.error("Failed to create maintenance:", error);
      form.setError('root.server', { type: 'server', message: recordWriteMessage(error,'tạo phiếu bảo trì') });
    }
  };

  return (
    <Dialog open={open} onOpenChange={value=>{if(!form.formState.isSubmitting)onOpenChange(value);}}>
      <DialogContent aria-describedby={undefined} className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Tạo phiếu bảo trì</DialogTitle>
          <DialogDescription>Ghi nhận yêu cầu bảo trì/sửa chữa tài sản</DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit, errors => { void focusFirstError(errors); })} className="space-y-4">
            {form.formState.errors.root?.server?.message && <p role="alert" className="text-sm text-destructive">{form.formState.errors.root.server.message}</p>}
            {sourceBlocked && <div role="alert" className="rounded border border-destructive p-3 text-sm">Chưa tải đủ dữ liệu tài sản. Tải lại trước khi lưu.<Button type="button" variant="outline" onClick={()=>{for(const query of sources)void query.refetch();}}>Tải lại dữ liệu</Button></div>}
            <fieldset disabled={blocked || sourceBlocked || form.formState.isSubmitting} className="space-y-4">
            <FormField
              control={form.control}
              name="asset_id"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Tài sản *</FormLabel>
                  <Select onValueChange={field.onChange} value={field.value}>
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue placeholder="Chọn tài sản" />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {assets.map((asset) => (
                        <SelectItem key={asset.id} value={asset.id}>
                          {asset.code ? `[${asset.code}] ` : ""}{asset.name}
                          {asset.room && ` - ${asset.room.name}`}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="issue_description"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Mô tả công việc *</FormLabel>
                  <FormControl>
                    <Textarea
                      {...field}
                      placeholder="Mô tả chi tiết vấn đề cần bảo trì/sửa chữa..."
                      className="min-h-[80px]"
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <div className="grid grid-cols-3 gap-4">
              <FormField
                control={form.control}
                name="maintenance_date"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Ngày bảo trì *</FormLabel>
                    <FormControl>
                      <DateInput
                        value={field.value || ''}
                        onChange={field.onChange}
                        onBlur={field.onBlur}
                        name={field.name}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="cost"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Chi phí (VNĐ)</FormLabel>
                    <FormControl>
                      <CurrencyInput
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

              <FormField
                control={form.control}
                name="status"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Trạng thái *</FormLabel>
                    <Select onValueChange={field.onChange} value={field.value}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        <SelectItem value="PENDING">Chờ xử lý</SelectItem>
                        <SelectItem value="IN_PROGRESS">Đang xử lý</SelectItem>
                        <SelectItem value="COMPLETED">Hoàn thành</SelectItem>
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            <FormField
              control={form.control}
              name="assigned_to"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Phân công cho</FormLabel>
                  <Select onValueChange={field.onChange} value={field.value}>
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue placeholder="Chọn người xử lý" />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {profiles.map((profile) => (
                        <SelectItem key={profile.id} value={profile.id}>
                          {profile.full_name || profile.id}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="notes"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Ghi chú</FormLabel>
                  <FormControl>
                    <Textarea {...field} placeholder="Ghi chú thêm..." className="min-h-[60px]" />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            </fieldset>
            <div className="flex justify-end gap-3 pt-4">
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                Hủy
              </Button>
              <Button type="submit" disabled={blocked || sourceBlocked || form.formState.isSubmitting || createMaintenance.isPending}>
                {createMaintenance.isPending ? "Đang tạo..." : "Tạo phiếu bảo trì"}
              </Button>
            </div>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
