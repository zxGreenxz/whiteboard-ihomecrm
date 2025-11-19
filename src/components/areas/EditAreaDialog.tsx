import { useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import * as z from 'zod';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { useUpdateArea, Area } from '@/hooks/useAreas';

const formSchema = z.object({
  code: z
    .string()
    .min(1, 'Mã khu vực là bắt buộc')
    .max(10, 'Mã khu vực tối đa 10 ký tự')
    .regex(/^[A-Z0-9-]+$/, 'Mã chỉ chứa chữ in hoa, số và dấu gạch ngang'),
  name: z
    .string()
    .min(1, 'Tên khu vực là bắt buộc')
    .max(100, 'Tên khu vực tối đa 100 ký tự'),
  description: z.string().max(500, 'Mô tả tối đa 500 ký tự').optional(),
  status: z.enum(['active', 'inactive']),
});

type FormData = z.infer<typeof formSchema>;

interface EditAreaDialogProps {
  area: Area | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const EditAreaDialog = ({ area, open, onOpenChange }: EditAreaDialogProps) => {
  const updateAreaMutation = useUpdateArea();

  const form = useForm<FormData>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      code: '',
      name: '',
      description: '',
      status: 'active',
    },
  });

  // Reset form when area changes
  useEffect(() => {
    if (area) {
      form.reset({
        code: area.code,
        name: area.name,
        description: area.description || '',
        status: area.status,
      });
    }
  }, [area, form]);

  const onSubmit = async (data: FormData) => {
    if (!area) return;

    try {
      await updateAreaMutation.mutateAsync({
        id: area.id,
        data,
      });
      onOpenChange(false);
    } catch (error) {
      // Error is handled by the mutation
    }
  };

  const handleOpenChange = (newOpen: boolean) => {
    if (!newOpen) {
      form.reset();
    }
    onOpenChange(newOpen);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle>Chỉnh sửa khu vực</DialogTitle>
          <DialogDescription>
            Cập nhật thông tin khu vực. Nhấn lưu để cập nhật.
          </DialogDescription>
        </DialogHeader>

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            <FormField
              control={form.control}
              name="code"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Mã khu vực *</FormLabel>
                  <FormControl>
                    <Input
                      placeholder="VD: KV-01"
                      {...field}
                      onChange={(e) => field.onChange(e.target.value.toUpperCase())}
                    />
                  </FormControl>
                  <FormDescription>
                    Mã định danh duy nhất cho khu vực (chữ in hoa, số, dấu gạch ngang)
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="name"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Tên khu vực *</FormLabel>
                  <FormControl>
                    <Input placeholder="VD: Khu vực trung tâm" {...field} />
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
                      placeholder="Mô tả chi tiết về khu vực..."
                      className="resize-none"
                      rows={3}
                      {...field}
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
                        <SelectValue placeholder="Chọn trạng thái" />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      <SelectItem value="active">Hoạt động</SelectItem>
                      <SelectItem value="inactive">Không hoạt động</SelectItem>
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />

            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => handleOpenChange(false)}
              >
                Hủy
              </Button>
              <Button type="submit" disabled={updateAreaMutation.isPending}>
                {updateAreaMutation.isPending ? 'Đang lưu...' : 'Lưu'}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
};

export default EditAreaDialog;
