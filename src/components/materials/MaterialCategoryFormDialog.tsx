import { useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import { materialCategoryFormSchema, type MaterialCategoryFormValues } from '@/lib/materialValidation';
import { useCreateMaterialCategory, useUpdateMaterialCategory } from '@/hooks/useMaterialCategories';
import type { MaterialCategory } from '@/types/material';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  editing: MaterialCategory | null;
}

export default function MaterialCategoryFormDialog({ open, onOpenChange, editing }: Props) {
  const createMut = useCreateMaterialCategory();
  const updateMut = useUpdateMaterialCategory();
  const isEditing = !!editing;

  const form = useForm<MaterialCategoryFormValues>({
    resolver: zodResolver(materialCategoryFormSchema),
    defaultValues: { name: '', description: '' },
  });

  useEffect(() => {
    if (open) {
      form.reset({
        name: editing?.name ?? '',
        description: editing?.description ?? '',
      });
    }
  }, [open, editing, form]);

  const onSubmit = async (data: MaterialCategoryFormValues) => {
    try {
      if (isEditing && editing) {
        await updateMut.mutateAsync({
          id: editing.id,
          updates: { name: data.name, description: data.description?.trim() || null },
        });
      } else {
        await createMut.mutateAsync({ name: data.name, description: data.description?.trim() || null });
      }
      onOpenChange(false);
    } catch {
      /* toast in hook */
    }
  };

  const isSubmitting = createMut.isPending || updateMut.isPending;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[480px]">
        <DialogHeader>
          <DialogTitle>{isEditing ? 'Sửa danh mục vật tư' : 'Thêm danh mục vật tư'}</DialogTitle>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            <FormField
              control={form.control}
              name="name"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Tên danh mục *</FormLabel>
                  <FormControl>
                    <Input placeholder="Ví dụ: Đèn, Vòi nước, Ống nước…" {...field} />
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
                    <Textarea rows={3} placeholder="Tuỳ chọn" {...field} value={field.value ?? ''} />
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
