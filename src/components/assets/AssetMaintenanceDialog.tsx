import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { useCreateAssetMaintenance } from "@/hooks/useAssets";
import { useAssets } from "@/hooks/useAssets";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

const maintenanceSchema = z.object({
  asset_id: z.string().min(1, "Phải chọn tài sản"),
  issue_description: z.string().min(1, "Mô tả sự cố là bắt buộc"),
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
  const createMaintenance = useCreateAssetMaintenance();
  const { data: assets = [] } = useAssets();

  // Fetch staff/profiles for assignment
  const { data: profiles = [] } = useQuery({
    queryKey: ["profiles"],
    queryFn: async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not authenticated');

      const { data, error } = await supabase
        .from("profiles")
        .select("id, full_name")
        .eq('user_id', user.id);

      if (error) throw error;
      return data || [];
    },
  });

  const form = useForm<MaintenanceFormValues>({
    resolver: zodResolver(maintenanceSchema),
    defaultValues: {
      asset_id: "",
      issue_description: "",
      maintenance_date: new Date().toISOString().split('T')[0],
      cost: 0,
      assigned_to: undefined,
      status: "PENDING",
      notes: "",
    },
  });

  const onSubmit = async (data: MaintenanceFormValues) => {
    try {
      const { data: { user } } = await supabase.auth.getUser();
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
      console.error("Failed to create maintenance:", error);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Tạo phiếu bảo trì</DialogTitle>
          <DialogDescription>Ghi nhận yêu cầu bảo trì/sửa chữa tài sản</DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
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
                  <FormLabel>Mô tả sự cố *</FormLabel>
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
                      <Input type="date" {...field} />
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
                      <Input
                        type="number"
                        {...field}
                        onChange={(e) => field.onChange(parseFloat(e.target.value) || 0)}
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

            <div className="flex justify-end gap-3 pt-4">
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                Hủy
              </Button>
              <Button type="submit" disabled={createMaintenance.isPending}>
                {createMaintenance.isPending ? "Đang tạo..." : "Tạo phiếu bảo trì"}
              </Button>
            </div>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
