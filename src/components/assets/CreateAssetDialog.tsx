import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useCreateAsset } from "@/hooks/useAssets";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useBuildings } from "@/hooks/useBuildings";
import { useRooms } from "@/hooks/useRooms";

const assetSchema = z.object({
  code: z.string().optional(),
  name: z.string().min(1, "Tên tài sản là bắt buộc"),
  category_id: z.string().min(1, "Phải chọn loại tài sản"),
  supplier_id: z.string().optional(),
  quantity: z.number().min(1, "Số lượng phải >= 1"),
  condition: z.enum(["NEW", "GOOD", "FAIR", "POOR", "BROKEN"]),
  purchase_date: z.string().optional(),
  purchase_price: z.number().min(0, "Giá mua phải >= 0"),
  building_id: z.string().optional(),
  room_id: z.string().optional(),
  description: z.string().optional(),
});

type AssetFormValues = z.infer<typeof assetSchema>;

interface CreateAssetDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function CreateAssetDialog({ open, onOpenChange }: CreateAssetDialogProps) {
  const createAsset = useCreateAsset();
  const { data: buildings = [] } = useBuildings();
  const { data: rooms = [] } = useRooms();

  const { data: categories = [] } = useQuery({
    queryKey: ["asset-categories"],
    queryFn: async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not authenticated');
      const { data, error } = await supabase.from("asset_categories").select("*").eq('user_id', user.id).order("name");
      if (error) throw error;
      return data || [];
    },
  });

  const { data: suppliers = [] } = useQuery({
    queryKey: ["suppliers"],
    queryFn: async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not authenticated');
      const { data, error } = await supabase.from("suppliers").select("*").eq('user_id', user.id).order("name");
      if (error) throw error;
      return data || [];
    },
  });

  const form = useForm<AssetFormValues>({
    resolver: zodResolver(assetSchema),
    defaultValues: {
      code: "",
      name: "",
      category_id: "",
      supplier_id: undefined,
      quantity: 1,
      condition: "GOOD",
      purchase_date: "",
      purchase_price: 0,
      building_id: undefined,
      room_id: undefined,
      description: "",
    },
  });

  const onSubmit = async (data: AssetFormValues) => {
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not authenticated');

      await createAsset.mutateAsync({
        name: data.name,
        code: data.code || null,
        category_id: data.category_id,
        supplier_id: data.supplier_id || null,
        quantity: data.quantity,
        condition: data.condition,
        purchase_date: data.purchase_date || null,
        purchase_price: data.purchase_price,
        building_id: data.building_id || null,
        room_id: data.room_id || null,
        description: data.description || null,
        user_id: user.id,
      });
      form.reset();
      onOpenChange(false);
    } catch (error) {
      console.error("Failed to create asset:", error);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[90vh]">
        <DialogHeader>
          <DialogTitle>Tạo tài sản mới</DialogTitle>
          <DialogDescription>Thêm tài sản vào kho</DialogDescription>
        </DialogHeader>
        <ScrollArea className="max-h-[calc(90vh-120px)] pr-4">
          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <FormField control={form.control} name="code" render={({ field }) => (
                  <FormItem><FormLabel>Mã tài sản</FormLabel><FormControl><Input {...field} /></FormControl><FormMessage /></FormItem>
                )} />
                <FormField control={form.control} name="name" render={({ field }) => (
                  <FormItem><FormLabel>Tên tài sản *</FormLabel><FormControl><Input {...field} /></FormControl><FormMessage /></FormItem>
                )} />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <FormField control={form.control} name="category_id" render={({ field }) => (
                  <FormItem><FormLabel>Loại tài sản *</FormLabel><Select onValueChange={field.onChange} value={field.value}><FormControl><SelectTrigger><SelectValue placeholder="Chọn loại" /></SelectTrigger></FormControl><SelectContent>{categories.map((cat) => (<SelectItem key={cat.id} value={cat.id}>{cat.name}</SelectItem>))}</SelectContent></Select><FormMessage /></FormItem>
                )} />
                <FormField control={form.control} name="supplier_id" render={({ field }) => (
                  <FormItem><FormLabel>Nhà cung cấp</FormLabel><Select onValueChange={field.onChange} value={field.value}><FormControl><SelectTrigger><SelectValue placeholder="Chọn NCC" /></SelectTrigger></FormControl><SelectContent>{suppliers.map((sup) => (<SelectItem key={sup.id} value={sup.id}>{sup.name}</SelectItem>))}</SelectContent></Select><FormMessage /></FormItem>
                )} />
              </div>
              <div className="grid grid-cols-3 gap-4">
                <FormField control={form.control} name="quantity" render={({ field }) => (
                  <FormItem><FormLabel>Số lượng *</FormLabel><FormControl><Input type="number" {...field} onChange={(e) => field.onChange(parseInt(e.target.value) || 1)} /></FormControl><FormMessage /></FormItem>
                )} />
                <FormField control={form.control} name="condition" render={({ field }) => (
                  <FormItem><FormLabel>Tình trạng *</FormLabel><Select onValueChange={field.onChange} value={field.value}><FormControl><SelectTrigger><SelectValue /></SelectTrigger></FormControl><SelectContent><SelectItem value="NEW">Mới</SelectItem><SelectItem value="GOOD">Tốt</SelectItem><SelectItem value="FAIR">Khá</SelectItem><SelectItem value="POOR">Kém</SelectItem><SelectItem value="BROKEN">Hỏng</SelectItem></SelectContent></Select><FormMessage /></FormItem>
                )} />
                <FormField control={form.control} name="purchase_price" render={({ field }) => (
                  <FormItem><FormLabel>Giá mua *</FormLabel><FormControl><Input type="number" {...field} onChange={(e) => field.onChange(parseFloat(e.target.value) || 0)} /></FormControl><FormMessage /></FormItem>
                )} />
              </div>
              <FormField control={form.control} name="purchase_date" render={({ field }) => (
                <FormItem><FormLabel>Ngày mua</FormLabel><FormControl><Input type="date" {...field} /></FormControl><FormMessage /></FormItem>
              )} />
              <div className="grid grid-cols-2 gap-4">
                <FormField control={form.control} name="building_id" render={({ field }) => (
                  <FormItem><FormLabel>Tòa nhà</FormLabel><Select onValueChange={field.onChange} value={field.value}><FormControl><SelectTrigger><SelectValue placeholder="Chọn tòa nhà" /></SelectTrigger></FormControl><SelectContent>{buildings.map((b) => (<SelectItem key={b.id} value={b.id}>{b.name}</SelectItem>))}</SelectContent></Select><FormMessage /></FormItem>
                )} />
                <FormField control={form.control} name="room_id" render={({ field }) => (
                  <FormItem><FormLabel>Phòng</FormLabel><Select onValueChange={field.onChange} value={field.value}><FormControl><SelectTrigger><SelectValue placeholder="Chọn phòng" /></SelectTrigger></FormControl><SelectContent>{rooms.map((r) => (<SelectItem key={r.id} value={r.id}>{r.name}</SelectItem>))}</SelectContent></Select><FormMessage /></FormItem>
                )} />
              </div>
              <FormField control={form.control} name="description" render={({ field }) => (
                <FormItem><FormLabel>Mô tả</FormLabel><FormControl><Textarea {...field} className="min-h-[60px]" /></FormControl><FormMessage /></FormItem>
              )} />
              <div className="flex justify-end gap-3 pt-4">
                <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Hủy</Button>
                <Button type="submit" disabled={createAsset.isPending}>{createAsset.isPending ? "Đang tạo..." : "Tạo tài sản"}</Button>
              </div>
            </form>
          </Form>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}
