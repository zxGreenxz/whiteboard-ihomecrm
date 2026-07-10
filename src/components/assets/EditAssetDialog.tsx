import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { CurrencyInput } from "@/components/ui/currency-input";
import { NumberInput } from "@/components/ui/number-input";
import { DateInput } from "@/components/ui/date-input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { useUpdateAsset, useDeleteAsset, type AssetWithRelations } from "@/hooks/useAssets";
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

interface EditAssetDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  asset: AssetWithRelations;
}

export function EditAssetDialog({ open, onOpenChange, asset }: EditAssetDialogProps) {
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const updateAsset = useUpdateAsset();
  const deleteAsset = useDeleteAsset();
  const { data: buildings = [] } = useBuildings();

  const buildingId = asset.building_id || undefined;
  const { data: rooms = [] } = useRooms(buildingId);

  const { data: categories = [] } = useQuery({
    queryKey: ["asset-categories"],
    queryFn: async () => {
      const { data, error } = await supabase.from("asset_categories").select("*").order("name");
      if (error) throw error;
      return data || [];
    },
    enabled: open,
  });

  const { data: suppliers = [] } = useQuery({
    queryKey: ["suppliers"],
    queryFn: async () => {
      const { data, error } = await supabase.from("suppliers").select("*").order("name");
      if (error) throw error;
      return data || [];
    },
    enabled: open,
  });

  const form = useForm<AssetFormValues>({
    resolver: zodResolver(assetSchema),
    defaultValues: {
      code: "",
      name: "",
      category_id: "",
      quantity: 1,
      condition: "GOOD",
      purchase_price: 0,
    },
  });

  useEffect(() => {
    if (asset) {
      form.reset({
        code: asset.code || "",
        name: asset.name || "",
        category_id: asset.category_id || "",
        supplier_id: asset.supplier_id || undefined,
        quantity: asset.quantity || 1,
        condition: asset.condition || "GOOD",
        purchase_date: asset.purchase_date || "",
        purchase_price: asset.purchase_price || 0,
        building_id: asset.building_id || undefined,
        room_id: asset.room_id || undefined,
        description: asset.description || "",
      });
    }
  }, [asset, form]);

  const onSubmit = async (data: AssetFormValues) => {
    try {
      await updateAsset.mutateAsync({
        id: asset.id,
        code: data.code || null,
        name: data.name,
        category_id: data.category_id,
        supplier_id: data.supplier_id || null,
        quantity: data.quantity,
        condition: data.condition,
        purchase_date: data.purchase_date || null,
        purchase_price: data.purchase_price,
        building_id: data.building_id || null,
        room_id: data.room_id || null,
        description: data.description || null,
      });
      onOpenChange(false);
    } catch (error) {
      console.error("Failed to update asset:", error);
    }
  };

  const handleDelete = async () => {
    try {
      await deleteAsset.mutateAsync(asset.id);
      setShowDeleteDialog(false);
      onOpenChange(false);
    } catch (error) {
      console.error("Failed to delete asset:", error);
    }
  };

  const selectedBuildingId = form.watch("building_id");

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-2xl max-h-[90vh]">
          <DialogHeader>
            <DialogTitle>Chỉnh sửa tài sản</DialogTitle>
          </DialogHeader>
          <ScrollArea className="max-h-[calc(90vh-120px)] pr-4">
            <Form {...form}>
              <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
                <div className="grid grid-cols-2 gap-4">
                  <FormField control={form.control} name="code" render={({ field }) => (
                    <FormItem>
                      <FormLabel>Mã tài sản</FormLabel>
                      <FormControl><Input placeholder="VD: TS-001" {...field} /></FormControl>
                      <FormMessage />
                    </FormItem>
                  )} />
                  <FormField control={form.control} name="name" render={({ field }) => (
                    <FormItem>
                      <FormLabel>Tên tài sản *</FormLabel>
                      <FormControl><Input placeholder="Nhập tên tài sản" {...field} /></FormControl>
                      <FormMessage />
                    </FormItem>
                  )} />
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <FormField control={form.control} name="category_id" render={({ field }) => (
                    <FormItem>
                      <FormLabel>Loại tài sản *</FormLabel>
                      <Select onValueChange={field.onChange} value={field.value}>
                        <FormControl><SelectTrigger><SelectValue placeholder="Chọn loại" /></SelectTrigger></FormControl>
                        <SelectContent>
                          {categories.map((cat) => (
                            <SelectItem key={cat.id} value={cat.id}>{cat.name}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )} />
                  <FormField control={form.control} name="supplier_id" render={({ field }) => (
                    <FormItem>
                      <FormLabel>Nhà cung cấp</FormLabel>
                      <Select onValueChange={field.onChange} value={field.value}>
                        <FormControl><SelectTrigger><SelectValue placeholder="Chọn NCC" /></SelectTrigger></FormControl>
                        <SelectContent>
                          {suppliers.map((sup) => (
                            <SelectItem key={sup.id} value={sup.id}>{sup.name}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )} />
                </div>

                <div className="grid grid-cols-3 gap-4">
                  <FormField control={form.control} name="quantity" render={({ field }) => (
                    <FormItem>
                      <FormLabel>Số lượng *</FormLabel>
                      <FormControl>
                        <NumberInput min={1} value={field.value} onChange={(v) => field.onChange(v || 1)} onBlur={field.onBlur} name={field.name} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )} />
                  <FormField control={form.control} name="condition" render={({ field }) => (
                    <FormItem>
                      <FormLabel>Tình trạng *</FormLabel>
                      <Select onValueChange={field.onChange} value={field.value}>
                        <FormControl><SelectTrigger><SelectValue /></SelectTrigger></FormControl>
                        <SelectContent>
                          <SelectItem value="NEW">Mới</SelectItem>
                          <SelectItem value="GOOD">Tốt</SelectItem>
                          <SelectItem value="FAIR">Khá</SelectItem>
                          <SelectItem value="POOR">Kém</SelectItem>
                          <SelectItem value="BROKEN">Hỏng</SelectItem>
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )} />
                  <FormField control={form.control} name="purchase_price" render={({ field }) => (
                    <FormItem>
                      <FormLabel>Giá trị (VNĐ) *</FormLabel>
                      <FormControl>
                        <CurrencyInput value={field.value} onChange={field.onChange} onBlur={field.onBlur} name={field.name} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )} />
                </div>

                <FormField control={form.control} name="purchase_date" render={({ field }) => (
                  <FormItem>
                    <FormLabel>Ngày mua</FormLabel>
                    <FormControl><DateInput value={field.value || ''} onChange={field.onChange} onBlur={field.onBlur} name={field.name} /></FormControl>
                    <FormMessage />
                  </FormItem>
                )} />

                <div className="grid grid-cols-2 gap-4">
                  <FormField control={form.control} name="building_id" render={({ field }) => (
                    <FormItem>
                      <FormLabel>Toà nhà</FormLabel>
                      <Select onValueChange={field.onChange} value={field.value}>
                        <FormControl><SelectTrigger><SelectValue placeholder="Chọn toà nhà" /></SelectTrigger></FormControl>
                        <SelectContent>
                          {buildings.map((b) => (
                            <SelectItem key={b.id} value={b.id}>{b.name}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )} />
                  <FormField control={form.control} name="room_id" render={({ field }) => (
                    <FormItem>
                      <FormLabel>Căn hộ</FormLabel>
                      <Select onValueChange={field.onChange} value={field.value}>
                        <FormControl><SelectTrigger><SelectValue placeholder="Chọn căn hộ" /></SelectTrigger></FormControl>
                        <SelectContent>
                          {rooms.map((r) => (
                            <SelectItem key={r.id} value={r.id}>{r.name}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )} />
                </div>

                <FormField control={form.control} name="description" render={({ field }) => (
                  <FormItem>
                    <FormLabel>Mô tả</FormLabel>
                    <FormControl><Textarea {...field} placeholder="Mô tả tài sản..." className="min-h-[60px]" /></FormControl>
                    <FormMessage />
                  </FormItem>
                )} />

                <div className="flex justify-between gap-3 pt-4">
                  <Button type="button" variant="destructive" onClick={() => setShowDeleteDialog(true)}>Xóa</Button>
                  <div className="flex gap-3">
                    <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Hủy</Button>
                    <Button type="submit" disabled={updateAsset.isPending}>
                      {updateAsset.isPending ? "Đang lưu..." : "Lưu thay đổi"}
                    </Button>
                  </div>
                </div>
              </form>
            </Form>
          </ScrollArea>
        </DialogContent>
      </Dialog>

      <AlertDialog open={showDeleteDialog} onOpenChange={setShowDeleteDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Xác nhận xóa</AlertDialogTitle>
            <AlertDialogDescription>Bạn có chắc chắn muốn xóa tài sản này?</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Hủy</AlertDialogCancel>
            <AlertDialogAction onClick={handleDelete} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
              Xóa
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
