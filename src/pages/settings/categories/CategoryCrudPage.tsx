import { useState } from "react";
import MainLayout from "@/components/layout/MainLayout";
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
  onCreate: (values: Record<string, unknown>) => void;
  onUpdate: (id: string, values: Record<string, unknown>) => void;
  onDelete: (id: string) => void;
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
}: CategoryCrudPageProps<T>) {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [editingItem, setEditingItem] = useState<T | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [formValues, setFormValues] = useState<Record<string, unknown>>({});

  const openCreate = () => {
    setEditingItem(null);
    setFormValues({});
    setDialogOpen(true);
  };

  const openEdit = (item: T) => {
    setEditingItem(item);
    setFormValues(getFormValues ? getFormValues(item) : (item as Record<string, unknown>));
    setDialogOpen(true);
  };

  const openDelete = (id: string) => {
    setDeletingId(id);
    setDeleteDialogOpen(true);
  };

  const handleSubmit = () => {
    if (editingItem) {
      onUpdate(getId(editingItem), formValues);
    } else {
      onCreate(formValues);
    }
    setDialogOpen(false);
    setFormValues({});
    setEditingItem(null);
  };

  const handleDelete = () => {
    if (deletingId) {
      onDelete(deletingId);
    }
    setDeleteDialogOpen(false);
    setDeletingId(null);
  };

  const updateField = (key: string, value: unknown) => {
    setFormValues((prev) => ({ ...prev, [key]: value }));
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
          <Button onClick={openCreate} size="sm">
            <Plus className="h-4 w-4 mr-1" />
            Thêm mới
          </Button>
        </div>

        <Card>
          <CardContent className="p-0">
            {isLoading ? (
              <div className="p-8 text-center text-muted-foreground">Đang tải...</div>
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
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editingItem ? "Cập nhật" : "Thêm mới"}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            {fields.map((field) => (
              <div key={field.key} className="space-y-2">
                <Label htmlFor={field.key}>
                  {field.label}
                  {field.required && <span className="text-destructive"> *</span>}
                </Label>
                {field.type === "select" ? (
                  <select
                    id={field.key}
                    className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
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
                    id={field.key}
                    className="flex min-h-[80px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                    placeholder={field.placeholder}
                    value={String(formValues[field.key] ?? "")}
                    onChange={(e) => updateField(field.key, e.target.value)}
                  />
                ) : field.type === "checkbox" ? (
                  <div className="flex items-center gap-2">
                    <input
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
                    id={field.key}
                    type={field.type || "text"}
                    placeholder={field.placeholder}
                    value={String(formValues[field.key] ?? "")}
                    onChange={(e) =>
                      updateField(
                        field.key,
                        field.type === "number" ? Number(e.target.value) : e.target.value
                      )
                    }
                  />
                )}
              </div>
            ))}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>
              Hủy
            </Button>
            <Button onClick={handleSubmit} disabled={isCreating || isUpdating}>
              {editingItem ? "Cập nhật" : "Thêm mới"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation */}
      <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Xác nhận xóa</AlertDialogTitle>
            <AlertDialogDescription>
              Bạn có chắc chắn muốn xóa không? Hành động này không thể hoàn tác.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Hủy</AlertDialogCancel>
            <AlertDialogAction onClick={handleDelete} disabled={isDeleting}>
              Xóa
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </MainLayout>
  );
}
