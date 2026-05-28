import { useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { materialFormSchema, type MaterialFormValues } from '@/lib/materialValidation';
import { useCreateMaterial, useUpdateMaterial } from '@/hooks/useMaterials';
import { useMaterialCategories } from '@/hooks/useMaterialCategories';
import type { Material } from '@/types/material';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  editing: Material | null;
}

const UNCATEGORIZED = '__none__';

export default function MaterialFormDialog({ open, onOpenChange, editing }: Props) {
  const createMut = useCreateMaterial();
  const updateMut = useUpdateMaterial();
  const { data: categories = [] } = useMaterialCategories();
  const isEditing = !!editing;

  const form = useForm<MaterialFormValues>({
    resolver: zodResolver(materialFormSchema),
    defaultValues: {
      code: '',
      name: '',
      category_id: null,
      unit: 'cái',
      image_url: '',
      description: '',
      reorder_level: 0,
    },
  });

  useEffect(() => {
    if (open) {
      form.reset({
        code: editing?.code ?? '',
        name: editing?.name ?? '',
        category_id: editing?.category_id ?? null,
        unit: editing?.unit ?? 'cái',
        image_url: editing?.image_url ?? '',
        description: editing?.description ?? '',
        reorder_level: Number(editing?.reorder_level ?? 0),
      });
    }
  }, [open, editing, form]);

  const onSubmit = async (data: MaterialFormValues) => {
    try {
      const payload: MaterialFormValues = {
        ...data,
        category_id: data.category_id === UNCATEGORIZED ? null : data.category_id,
      };
      if (isEditing && editing) {
        await updateMut.mutateAsync({ id: editing.id, updates: payload });
      } else {
        await createMut.mutateAsync(payload);
      }
      onOpenChange(false);
    } catch {
      /* toast in hook */
    }
  };

  const isSubmitting = createMut.isPending || updateMut.isPending;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[560px] max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{isEditing ? 'Sửa vật tư' : 'Thêm vật tư'}</DialogTitle>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-3.5">
            <div className="grid grid-cols-2 gap-3">
              <FormField
                control={form.control}
                name="code"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Mã (tuỳ chọn)</FormLabel>
                    <FormControl>
                      <Input placeholder="Ví dụ: BD-LED-9W" {...field} value={field.value ?? ''} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="unit"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Đơn vị *</FormLabel>
                    <FormControl>
                      <Input placeholder="cái, m, kg…" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            <FormField
              control={form.control}
              name="name"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Tên vật tư *</FormLabel>
                  <FormControl>
                    <Input placeholder="Ví dụ: Bóng đèn LED 9W vàng" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <div className="grid grid-cols-2 gap-3">
              <FormField
                control={form.control}
                name="category_id"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Danh mục</FormLabel>
                    <Select
                      value={field.value ?? UNCATEGORIZED}
                      onValueChange={(v) => field.onChange(v === UNCATEGORIZED ? null : v)}
                    >
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder="Không phân loại" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        <SelectItem value={UNCATEGORIZED}>— Không phân loại —</SelectItem>
                        {categories.map((c) => (
                          <SelectItem key={c.id} value={c.id}>
                            {c.name}
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
                name="reorder_level"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Ngưỡng cảnh báo</FormLabel>
                    <FormControl>
                      <Input
                        type="number"
                        min={0}
                        step={1}
                        placeholder="0"
                        {...field}
                        value={field.value ?? 0}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            <FormField
              control={form.control}
              name="image_url"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>URL hình ảnh (tuỳ chọn)</FormLabel>
                  <FormControl>
                    <Input placeholder="https://..." {...field} value={field.value ?? ''} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="description"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Mô tả</FormLabel>
                  <FormControl>
                    <Textarea rows={2} placeholder="Tuỳ chọn" {...field} value={field.value ?? ''} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={isSubmitting}>
                Huỷ
              </Button>
              <Button type="submit" disabled={isSubmitting}>
                {isSubmitting ? 'Đang lưu…' : isEditing ? 'Cập nhật' : 'Tạo mới'}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
