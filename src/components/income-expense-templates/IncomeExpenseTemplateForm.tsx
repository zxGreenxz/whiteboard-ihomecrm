import { useEffect, useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { Button } from '@/components/ui/button';
import {
  incomeExpenseTemplateFormSchema,
  type IncomeExpenseTemplateFormValues,
} from '@/lib/incomeExpenseValidation';
import {
  useCreateIncomeExpenseTemplate,
  useUpdateIncomeExpenseTemplate,
  type IncomeExpenseTemplate,
} from '@/hooks/useIncomeExpenseTemplates';
import { focusFirstError } from '@/lib/formErrors';
import { recordWriteBlocked, recordWriteMessage } from '@/lib/recordWriteOutcome';

interface IncomeExpenseTemplateFormProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  template?: IncomeExpenseTemplate | null;
}

const IncomeExpenseTemplateForm = ({ open, onOpenChange, template }: IncomeExpenseTemplateFormProps) => {
  const isEditing = !!template;
  const [blocked,setBlocked]=useState(false);
  const busy=useRef(false);
  const draftKey=useRef<string|null>(null);
  const createTemplate = useCreateIncomeExpenseTemplate();
  const updateTemplate = useUpdateIncomeExpenseTemplate();

  const form = useForm<IncomeExpenseTemplateFormValues>({
    resolver: zodResolver(incomeExpenseTemplateFormSchema),
    defaultValues: {
      name: '',
      description: '',
      template_file_url: '',
      is_default: false,
      is_income_template: false,
    },
  });

  // Populate form when editing, reset when adding
  useEffect(() => {
    if(!open) return;
    const key=template?.id ?? 'new';
    if(draftKey.current===key && (form.formState.isDirty || form.formState.errors.root?.server || blocked)) return;
    draftKey.current=key;setBlocked(false);
    if (template && open) {
      form.reset({
        name: template.name,
        description: template.description ?? '',
        template_file_url: template.template_file_url ?? '',
        is_default: template.is_default ?? false,
        is_income_template: template.is_income_template ?? false,
      });
    } else if (!template && open) {
      form.reset({
        name: '',
        description: '',
        template_file_url: '',
        is_default: false,
        is_income_template: false,
      });
    }
  }, [template, open, form]);

  const onSubmit = async (data: IncomeExpenseTemplateFormValues) => {
    if(blocked || busy.current || createTemplate.isPending || updateTemplate.isPending) return;
    busy.current=true;
    form.clearErrors('root.server');
    try {
      if (isEditing) {
        await updateTemplate.mutateAsync({
          id: template.id,
          updates: {
            name: data.name,
            description: data.description || null,
            template_file_url: data.template_file_url || null,
            is_default: data.is_default ?? false,
            is_income_template: data.is_income_template ?? false,
          },
        });
      } else {
        await createTemplate.mutateAsync({
          name: data.name,
          description: data.description || null,
          template_file_url: data.template_file_url || null,
          is_default: data.is_default ?? false,
          is_income_template: data.is_income_template ?? false,
        });
      }
      draftKey.current=null;
      form.reset();
      onOpenChange(false);
    } catch (error) {
      setBlocked(recordWriteBlocked(error));
      form.setError('root.server', { type: 'server', message: recordWriteMessage(error,'lưu mẫu in thu chi') });
    } finally {busy.current=false;}
  };

  const isPending = createTemplate.isPending || updateTemplate.isPending;

  return (
    <Dialog open={open} onOpenChange={next=>{if(!isPending && !busy.current) onOpenChange(next);}}>
      <DialogContent aria-describedby={undefined} className="sm:max-w-[480px]">
        <DialogHeader>
          <DialogTitle>
            {isEditing ? 'Sửa mẫu in thu chi' : 'Thêm mẫu in thu chi'}
          </DialogTitle>
        </DialogHeader>

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit, errors => { void focusFirstError(errors); })} className="space-y-4">
            {form.formState.errors.root?.server?.message && <p role="alert" className="text-sm text-destructive">{form.formState.errors.root.server.message}</p>}
            <fieldset disabled={isPending || blocked} className="space-y-4">
            <FormField
              control={form.control}
              name="name"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Tên mẫu *</FormLabel>
                  <FormControl>
                    <Input placeholder="VD: Mẫu biên lai thu tiền" {...field} />
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
                    <Textarea
                      placeholder="Mô tả mẫu in..."
                      {...field}
                      value={field.value ?? ''}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="template_file_url"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>File mẫu in (PDF URL)</FormLabel>
                  <FormControl>
                    <Input
                      placeholder="https://example.com/template.pdf"
                      {...field}
                      value={field.value ?? ''}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="is_default"
              render={({ field }) => (
                <FormItem className="flex items-center justify-between rounded-lg border p-3">
                  <FormLabel className="cursor-pointer">Mặc định</FormLabel>
                  <FormControl>
                    <Switch
                      checked={field.value}
                      onCheckedChange={field.onChange}
                    />
                  </FormControl>
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="is_income_template"
              render={({ field }) => (
                <FormItem className="flex items-center justify-between rounded-lg border p-3">
                  <FormLabel className="cursor-pointer">Là mẫu biên lai thu?</FormLabel>
                  <FormControl>
                    <Switch
                      checked={field.value}
                      onCheckedChange={field.onChange}
                    />
                  </FormControl>
                </FormItem>
              )}
            />

            <div className="flex justify-end gap-3 pt-4">
              <Button
                type="button"
                variant="outline"
                onClick={() => onOpenChange(false)}
              >
                Hủy
              </Button>
              <Button type="submit" disabled={isPending || blocked}>
                {isPending ? 'Đang lưu...' : 'Lưu'}
              </Button>
            </div>
            </fieldset>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
};

export default IncomeExpenseTemplateForm;
