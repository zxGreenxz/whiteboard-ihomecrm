import { useEffect, useRef, useState } from 'react';
import {recordWriteBlocked,recordWriteMessage} from '@/lib/recordWriteOutcome';
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
import { focusFirstError } from '@/lib/formErrors';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  editing: MaterialCategory | null;
}

export default function MaterialCategoryFormDialog({ open, onOpenChange, editing }: Props) {
  const createMut = useCreateMaterialCategory();
  const updateMut = useUpdateMaterialCategory();
  const isEditing = !!editing;
  const [blocked,setBlocked]=useState(false);const busy=useRef(false);const draftKey=useRef<string|null>(null);

  const form = useForm<MaterialCategoryFormValues>({
    resolver: zodResolver(materialCategoryFormSchema),
    defaultValues: { name: '', description: '' },
  });

  useEffect(() => {
    if (open) {
      const key=editing?.id??'new';
      if(draftKey.current===key&&(blocked||form.formState.isDirty||form.formState.errors.root?.server))return;
      draftKey.current=key;setBlocked(false);
      form.reset({
        name: editing?.name ?? '',
        description: editing?.description ?? '',
      });
    }
  }, [open, editing, form]);

  const onSubmit = async (data: MaterialCategoryFormValues) => {
    if(busy.current||blocked)return;
    busy.current=true;
    form.clearErrors('root.server');
    try {
      if (isEditing && editing) {
        await updateMut.mutateAsync({
          id: editing.id,
          updates: { name: data.name, description: data.description?.trim() || null },
        });
      } else {
        await createMut.mutateAsync({ name: data.name, description: data.description?.trim() || null });
      }
      draftKey.current=null;onOpenChange(false);
    } catch (error) {
      setBlocked(recordWriteBlocked(error));
      form.setError('root.server', { type: 'server', message: recordWriteMessage(error,'lưu danh mục vật tư') });
    }finally{busy.current=false;}
  };

  const isSubmitting = createMut.isPending || updateMut.isPending;

  return (
    <Dialog open={open} onOpenChange={value=>{if(!busy.current)onOpenChange(value);}}>
      <DialogContent aria-describedby={undefined} className="sm:max-w-[480px]">
        <DialogHeader>
          <DialogTitle>{isEditing ? 'Sửa danh mục vật tư' : 'Thêm danh mục vật tư'}</DialogTitle>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit, errors => { void focusFirstError(errors); })} className="space-y-4">
            {form.formState.errors.root?.server?.message && <p role="alert" className="text-sm text-destructive">{form.formState.errors.root.server.message}</p>}
            <fieldset disabled={isSubmitting || blocked} className="space-y-4">
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
              <Button type="submit" disabled={isSubmitting || blocked}>
                {isSubmitting ? 'Đang lưu…' : isEditing ? 'Cập nhật' : 'Tạo mới'}
              </Button>
            </DialogFooter>
            </fieldset>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
