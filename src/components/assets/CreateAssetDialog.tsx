import {useState,useRef} from 'react';
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { CurrencyInput } from "@/components/ui/currency-input";
import { NumberInput } from "@/components/ui/number-input";
import { DateInput } from "@/components/ui/date-input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useCreateAsset } from "@/hooks/useAssets";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { getSessionUser } from "@/lib/authSession";
import { useBuildings } from "@/hooks/useBuildings";
import { useRooms } from "@/hooks/useRooms";
import { focusFirstError } from "@/lib/formErrors";
import {recordWriteBlocked,recordWriteMessage} from "@/lib/recordWriteOutcome";

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
  const [failure,setFailure]=useState<unknown>();
  const [blocked,setBlocked]=useState(false);
  const draftKey=useRef<string|null>(null);
  const createAsset = useCreateAsset();
  const buildingsQuery=useBuildings({ enabled: open });
  const {data:buildings=[]}=buildingsQuery;
  const roomsQuery=useRooms(undefined, { enabled: open });
  const {data:rooms=[]}=roomsQuery;

  const categoriesQuery = useQuery({
    queryKey: ["asset-categories"],
    queryFn: async () => {
      const { data, error } = await supabase.from("asset_categories").select("*").order("name");
      if (error) throw error;
      if(!Array.isArray(data))throw new Error('Chưa xác nhận được danh mục tài sản. Tải lại trước khi lưu.');
      return data;
    },
    enabled: open,
  });

  const suppliersQuery = useQuery({
    queryKey: ["suppliers"],
    queryFn: async () => {
      const { data, error } = await supabase.from("suppliers").select("*").order("name");
      if (error) throw error;
      if(!Array.isArray(data))throw new Error('Chưa xác nhận được danh mục tài sản. Tải lại trước khi lưu.');
      return data;
    },
    enabled: open,
  });

  const {data:categories=[]}=categoriesQuery;const {data:suppliers=[]}=suppliersQuery;
  const sources=[buildingsQuery,roomsQuery,categoriesQuery,suppliersQuery];
  const sourceBlocked=sources.some(query=>query.isError||query.isLoading);

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
    if(blocked||sourceBlocked)return;
    form.clearErrors('root.server');
    form.clearErrors('root.server');
    try {
      const user = await getSessionUser();
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
      setFailure(error);setBlocked(recordWriteBlocked(error));
      console.error("Failed to create asset:", error);
      form.setError('root.server', { type: 'server', message: recordWriteMessage(error,'tạo tài sản') });
    }
  };

  return (
    <Dialog open={open} onOpenChange={value=>{if(!form.formState.isSubmitting)onOpenChange(value);}}>
      <DialogContent aria-describedby={undefined} className="max-w-2xl max-h-[90vh]">
        <DialogHeader>
          <DialogTitle>Tạo tài sản mới</DialogTitle>
          <DialogDescription>Thêm tài sản vào kho</DialogDescription>
        </DialogHeader>
        <ScrollArea className="max-h-[calc(90vh-120px)] pr-4">
          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit, errors => { void focusFirstError(errors); })} className="space-y-4">
              {form.formState.errors.root?.server?.message && <p role="alert" className="text-sm text-destructive">{form.formState.errors.root.server.message}</p>}
              {sourceBlocked && <div role="alert" className="rounded border border-destructive p-3 text-sm">Chưa tải đủ dữ liệu tài sản. Tải lại trước khi lưu.<Button type="button" variant="outline" onClick={()=>{for(const query of sources)void query.refetch();}}>Tải lại dữ liệu</Button></div>}
            <fieldset disabled={blocked || sourceBlocked || form.formState.isSubmitting} className="space-y-4">
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
                  <FormItem><FormLabel>Số lượng *</FormLabel><FormControl><NumberInput min={1} value={field.value} onChange={(v) => field.onChange(v || 1)} onBlur={field.onBlur} name={field.name} /></FormControl><FormMessage /></FormItem>
                )} />
                <FormField control={form.control} name="condition" render={({ field }) => (
                  <FormItem><FormLabel>Tình trạng *</FormLabel><Select onValueChange={field.onChange} value={field.value}><FormControl><SelectTrigger><SelectValue /></SelectTrigger></FormControl><SelectContent><SelectItem value="NEW">Mới</SelectItem><SelectItem value="GOOD">Tốt</SelectItem><SelectItem value="FAIR">Khá</SelectItem><SelectItem value="POOR">Kém</SelectItem><SelectItem value="BROKEN">Hỏng</SelectItem></SelectContent></Select><FormMessage /></FormItem>
                )} />
                <FormField control={form.control} name="purchase_price" render={({ field }) => (
                  <FormItem><FormLabel>Giá mua *</FormLabel><FormControl><CurrencyInput value={field.value} onChange={field.onChange} onBlur={field.onBlur} name={field.name} /></FormControl><FormMessage /></FormItem>
                )} />
              </div>
              <FormField control={form.control} name="purchase_date" render={({ field }) => (
                <FormItem><FormLabel>Ngày mua</FormLabel><FormControl><DateInput value={field.value || ''} onChange={field.onChange} onBlur={field.onBlur} name={field.name} /></FormControl><FormMessage /></FormItem>
              )} />
              <div className="grid grid-cols-2 gap-4">
                <FormField control={form.control} name="building_id" render={({ field }) => (
                  <FormItem><FormLabel>Tòa nhà</FormLabel><Select onValueChange={field.onChange} value={field.value}><FormControl><SelectTrigger><SelectValue placeholder="Chọn tòa nhà" /></SelectTrigger></FormControl><SelectContent>{buildings.map((b) => (<SelectItem key={b.id} value={b.id}>{b.name}</SelectItem>))}</SelectContent></Select><FormMessage /></FormItem>
                )} />
                <FormField control={form.control} name="room_id" render={({ field }) => (
                  <FormItem><FormLabel>Căn hộ</FormLabel><Select onValueChange={field.onChange} value={field.value}><FormControl><SelectTrigger><SelectValue placeholder="Chọn căn hộ" /></SelectTrigger></FormControl><SelectContent>{rooms.map((r) => (<SelectItem key={r.id} value={r.id}>{r.name}</SelectItem>))}</SelectContent></Select><FormMessage /></FormItem>
                )} />
              </div>
              <FormField control={form.control} name="description" render={({ field }) => (
                <FormItem><FormLabel>Mô tả</FormLabel><FormControl><Textarea {...field} className="min-h-[60px]" /></FormControl><FormMessage /></FormItem>
              )} />
              </fieldset>
            <div className="flex justify-end gap-3 pt-4">
                <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Hủy</Button>
                <Button type="submit" disabled={blocked || sourceBlocked || form.formState.isSubmitting || createAsset.isPending}>{createAsset.isPending ? "Đang tạo..." : "Tạo tài sản"}</Button>
              </div>
            </form>
          </Form>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}
