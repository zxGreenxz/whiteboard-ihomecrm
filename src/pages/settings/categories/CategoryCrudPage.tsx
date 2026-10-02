import { useState, useRef } from "react";
import { useForm } from 'react-hook-form';
import { friendlyError, type OperationErrorRule } from '@/lib/friendlyError';
import { applyFeedbackToForm, focusFirstError } from '@/lib/formErrors';
import MainLayout from "@/components/layout/MainLayout";
import { LoadingState } from "@/components/loading/LoadingState";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Plus, Pencil, Trash2, ArrowLeft } from "lucide-react";
import { Link } from "react-router-dom";
import { LucideIcon } from "lucide-react";

export interface ColumnDef<T> {
  key: string;
  header: string;
  render?: (item: T) => React.ReactNode;
}

export interface FieldDef {
  key: string;
  label: string;
  type?: "text" | "number" | "select" | "textarea" | "checkbox";
  placeholder?: string;
  required?: boolean;
  options?: { value: string; label: string }[];
}

interface CategoryCrudPageProps<T> {
  title: string;
  subtitle: string;
  icon: LucideIcon;
  data: T[] | undefined;
  isLoading: boolean;
  columns: ColumnDef<T>[];
  fields: FieldDef[];
  onCreate: (values: Record<string, unknown>) => Promise<unknown>;
  onUpdate: (id: string, values: Record<string, unknown>) => Promise<unknown>;
  onDelete: (id: string) => Promise<unknown>;
  error?: unknown;
  errorRules?: readonly OperationErrorRule[];
  onRetry?: () => unknown;
  isCreating?: boolean;
  isUpdating?: boolean;
  isDeleting?: boolean;
  getId: (item: T) => string;
  getFormValues?: (item: T) => Record<string, unknown>;
}

export default function CategoryCrudPage<T>({
  title,
  subtitle,
  icon,
  data,
  isLoading,
  columns,
  fields,
  onCreate,
  onUpdate,
  onDelete,
  isCreating,
  isUpdating,
  isDeleting,
  getId,
  getFormValues,
  error,
  errorRules,
  onRetry,
}: CategoryCrudPageProps<T>) {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [editingItem, setEditingItem] = useState<T | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const form = useForm<Record<string, unknown>>({ defaultValues: {} });
  const formValues = form.watch();
  const formRoot = useRef<HTMLFormElement>(null);
  const busy = useRef(false);
  const [saving, setSaving] = useState(false);
  const [deleteError, setDeleteError] = useState('');

  const openCreate = () => {
    setEditingItem(null);
    form.reset({});
    setDialogOpen(true);
  };

  const openEdit = (item: T) => {
    setEditingItem(item);
    form.reset(getFormValues ? getFormValues(item) : (item as Record<string, unknown>));
    setDialogOpen(true);
  };

  const openDelete = (id: string) => {
    setDeletingId(id);
    setDeleteError('');
    setDeleteDialogOpen(true);
  };

  const handleSubmit = form.handleSubmit(async (values) => {
    if (busy.current) return;
    busy.current = true;
    setSaving(true);
    form.clearErrors('root');
    try {
      if (editingItem) await onUpdate(getId(editingItem), values);
      else await onCreate(values);
      setDialogOpen(false);
      form.reset({});
      setEditingItem(null);
    } catch (cause) {
      const feedback = friendlyError(cause, `Chưa lưu được ${title.toLocaleLowerCase('vi')}`, {operation: `lưu ${title.toLocaleLowerCase('vi')}`, rules:errorRules});
      await applyFeedbackToForm(form, {...feedback, description: `${feedback.title}. ${feedback.description}`}, {root:formRoot.current, order:fields.map(field => field.key)});
    } finally {
      busy.current = false;
      setSaving(false);
    }
  }, errors => { void focusFirstError(errors, { root: formRoot.current, order: fields.map(field => field.key) }); });

  const handleDelete = async () => {
    if (!deletingId || busy.current) return;
    busy.current = true;
    setSaving(true);
    setDeleteError('');
    try {
      await onDelete(deletingId);
      setDeleteDialogOpen(false);
      setDeletingId(null);
    } catch (cause) {
      const feedback = friendlyError(cause, `Chưa xóa được ${title.toLocaleLowerCase('vi')}`);
      setDeleteError(`${feedback.title}. ${feedback.description}`);
    } finally { busy.current = false; setSaving(false); }
  };

  const updateField = (key: string, value: unknown) => {
    form.setValue(key, value, { shouldValidate: form.formState.isSubmitted });
  };

  return (
    <MainLayout title={title} subtitle={subtitle} icon={icon}>
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <Link
            to="/settings/categories"
            className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors"
          >
            <ArrowLeft className="h-4 w-4" />
            Quay lại Danh mục khác
          </Link>
          <Button onClick={openCreate} size="sm" disabled={!!error}>
            <Plus className="h-4 w-4 mr-1" />
            Thêm mới
          </Button>
        </div>

        <Card>
          <CardContent className="p-0">
            {error ? <div role="alert" className="p-4 text-destructive">
              <p>Chưa tải được {title.toLocaleLowerCase('vi')}.</p>
              {onRetry && <Button variant="outline" onClick={() => void onRetry()}>Tải lại</Button>}
            </div> : isLoading ? (
              <LoadingState label={title.toLocaleLowerCase('vi')} variant="table" rows={6} className="px-4" onRetry={onRetry ? () => void onRetry() : undefined} />
            ) : !data || data.length === 0 ? (
              <div className="p-8 text-center text-muted-foreground">
                Chưa có dữ liệu. Hãy thêm mới.
              </div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    {columns.map((col) => (
                      <TableHead key={col.key}>{col.header}</TableHead>
                    ))}
                    <TableHead className="w-[100px]">Thao tác</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.map((item) => (
                    <TableRow key={getId(item)}>
                      {columns.map((col) => (
                        <TableCell key={col.key}>
                          {col.render
                            ? col.render(item)
                            : String((item as Record<string, unknown>)[col.key] ?? "")}
                        </TableCell>
                      ))}
                      <TableCell>
                        <div className="flex items-center gap-1">
                          <Button variant="ghost" size="icon" onClick={() => openEdit(item)}>
                            <Pencil className="h-4 w-4" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => openDelete(getId(item))}
                          >
                            <Trash2 className="h-4 w-4 text-destructive" />
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Create/Edit Dialog */}
      <Dialog open={dialogOpen} onOpenChange={(open) => { if (!saving) setDialogOpen(open); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editingItem ? "Cập nhật" : "Thêm mới"}</DialogTitle>
            <DialogDescription>Nhập thông tin {title.toLocaleLowerCase('vi')}. Các mục có dấu * cần được điền.</DialogDescription>
          </DialogHeader>
          <form id="category-edit-form" ref={formRoot} onSubmit={handleSubmit} className="space-y-4 py-2" noValidate>
            {form.formState.errors.root?.server?.message && <p role="alert" className="text-sm text-destructive">{form.formState.errors.root.server.message}</p>}
            {fields.map((field) => (
              <div key={field.key} data-field-name={field.key} className="space-y-2">
                <Label htmlFor={field.key}>
                  {field.label}
                  {field.required && <span className="text-destructive"> *</span>}
                </Label>
                {field.type === "select" ? (
                  <select
                    {...form.register(field.key, { required: field.required ? `Chọn ${field.label.toLocaleLowerCase('vi')}.` : false })}
                    aria-invalid={!!form.formState.errors[field.key]}
                    aria-describedby={form.formState.errors[field.key] ? `${field.key}-error` : undefined}
                    id={field.key}
                    className="flex h-10 w-full rounded-md border border-input aria-[invalid=true]:border-destructive bg-background px-3 py-2 text-sm"
                    value={String(formValues[field.key] ?? "")}
                    onChange={(e) => updateField(field.key, e.target.value)}
                  >
                    <option value="">-- Chọn --</option>
                    {field.options?.map((opt) => (
                      <option key={opt.value} value={opt.value}>
                        {opt.label}
                      </option>
                    ))}
                  </select>
                ) : field.type === "textarea" ? (
                  <textarea
                    {...form.register(field.key, { required: field.required ? `Nhập ${field.label.toLocaleLowerCase('vi')}.` : false })}
                    aria-invalid={!!form.formState.errors[field.key]}
                    aria-describedby={form.formState.errors[field.key] ? `${field.key}-error` : undefined}
                    id={field.key}
                    className="flex min-h-[80px] w-full rounded-md border border-input aria-[invalid=true]:border-destructive bg-background px-3 py-2 text-sm"
                    placeholder={field.placeholder}
                    value={String(formValues[field.key] ?? "")}
                    onChange={(e) => updateField(field.key, e.target.value)}
                  />
                ) : field.type === "checkbox" ? (
                  <div className="flex items-center gap-2">
                    <input
                      {...form.register(field.key)}
                      id={field.key}
                      type="checkbox"
                      className="h-4 w-4"
                      checked={Boolean(formValues[field.key])}
                      onChange={(e) => updateField(field.key, e.target.checked)}
                    />
                    <Label htmlFor={field.key} className="font-normal">
                      {field.placeholder}
                    </Label>
                  </div>
                ) : (
                  <Input
                    {...form.register(field.key, { required: field.required ? `Nhập ${field.label.toLocaleLowerCase('vi')}.` : false })}
                    aria-invalid={!!form.formState.errors[field.key]}
                    aria-describedby={form.formState.errors[field.key] ? `${field.key}-error` : undefined}
                    id={field.key}
                    type={field.type || "text"}
                    placeholder={field.placeholder}
                    value={String(formValues[field.key] ?? "")}
                    onChange={(e) =>
                      updateField(
                        field.key,
                        field.type === "number" && e.target.value !== '' ? Number(e.target.value) : e.target.value
                      )
                    }
                  />
                )}
                {form.formState.errors[field.key] && <p id={`${field.key}-error`} role="alert" className="text-sm text-destructive">{String(form.formState.errors[field.key]?.message ?? '')}</p>}
              </div>
            ))}
          </form>
          <DialogFooter>
            <Button variant="outline" disabled={saving} onClick={() => setDialogOpen(false)}>
              Hủy
            </Button>
            <Button type="submit" form="category-edit-form" disabled={saving || isCreating || isUpdating}>
              {editingItem ? "Cập nhật" : "Thêm mới"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation */}
      <AlertDialog open={deleteDialogOpen} onOpenChange={(open) => { if (!saving) setDeleteDialogOpen(open); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Xác nhận xóa</AlertDialogTitle>
            <AlertDialogDescription>
              Bạn có chắc chắn muốn xóa không? Hành động này không thể hoàn tác.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {deleteError && <p role="alert" className="text-sm text-destructive">{deleteError}</p>}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={saving}>Hủy</AlertDialogCancel>
            <AlertDialogAction onClick={(event) => { event.preventDefault(); void handleDelete(); }} disabled={saving || isDeleting}>
              Xóa
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </MainLayout>
  );
}
