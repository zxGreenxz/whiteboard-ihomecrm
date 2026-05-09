import { useState, useEffect } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Upload } from "lucide-react";
import {
  useUpdateDocumentTemplate,
  DocumentTemplate,
  TemplateCategory,
  CATEGORY_LABELS,
  CATEGORY_TO_TYPE,
} from "@/hooks/useDocumentTemplates";

const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5MB

const formSchema = z.object({
  name: z.string().min(1, "Tên không được để trống"),
  category: z.enum([
    "CONTRACT_NEW",
    "CONTRACT_TERMINATION",
    "CONTRACT_EXTENSION",
    "CONTRACT_TRANSFER",
    "INVOICE",
    "RECEIPT",
    "HANDOVER",
  ] as const),
  description: z.string().optional(),
  file: z
    .instanceof(FileList)
    .optional()
    .refine(
      (files) => !files || files.length === 0 || files[0]?.size <= MAX_FILE_SIZE,
      "File không được vượt quá 5MB"
    )
    .refine(
      (files) => !files || files.length === 0 || files[0]?.name.endsWith(".docx"),
      "Chỉ chấp nhận file .docx"
    ),
  is_default: z.boolean().default(false),
});

type FormValues = z.infer<typeof formSchema>;

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  template: DocumentTemplate | null;
}

export function EditTemplateDialog({ open, onOpenChange, template }: Props) {
  const [selectedFileName, setSelectedFileName] = useState<string>("");
  const updateMutation = useUpdateDocumentTemplate();

  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      name: "",
      category: "CONTRACT_NEW",
      description: "",
      is_default: false,
    },
  });

  // Pre-fill form when template changes
  useEffect(() => {
    if (template) {
      form.reset({
        name: template.name,
        category: template.category as TemplateCategory,
        description: template.description || "",
        is_default: template.is_default,
      });
      setSelectedFileName("");
    }
  }, [template, form]);

  const onSubmit = async (values: FormValues) => {
    if (!template) return;

    try {
      await updateMutation.mutateAsync({
        id: template.id,
        name: values.name,
        category: values.category,
        description: values.description,
        file: values.file?.[0],
        is_default: values.is_default,
        type: CATEGORY_TO_TYPE[values.category],
      });

      form.reset();
      setSelectedFileName("");
      onOpenChange(false);
    } catch (error) {
      // Error is handled by the mutation
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="text-xl text-green-600">
            SỬA MẪU HỢP ĐỒNG
          </DialogTitle>
        </DialogHeader>

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            {/* Name */}
            <FormField
              control={form.control}
              name="name"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>
                    Tên <span className="text-red-500">*</span>
                  </FormLabel>
                  <FormControl>
                    <Input placeholder="Nhập tên mẫu" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            {/* Category */}
            <FormField
              control={form.control}
              name="category"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>
                    Loại biên bản bàn giao <span className="text-red-500">*</span>
                  </FormLabel>
                  <Select
                    onValueChange={field.onChange}
                    value={field.value}
                  >
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue placeholder="Chọn loại" />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {Object.entries(CATEGORY_LABELS).map(([value, label]) => (
                        <SelectItem key={value} value={value}>
                          {label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />

            {/* Description */}
            <FormField
              control={form.control}
              name="description"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Mô tả</FormLabel>
                  <FormControl>
                    <Textarea
                      placeholder="Nhập mô tả"
                      rows={3}
                      {...field}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            {/* Current File Info */}
            {template && !selectedFileName && (
              <div className="text-sm text-gray-600">
                <span className="font-medium">File hiện tại:</span>{" "}
                {template.file_name}
              </div>
            )}

            {/* File Upload (Optional for edit) */}
            <FormField
              control={form.control}
              name="file"
              render={({ field: { onChange, value, ...field } }) => (
                <FormItem>
                  <FormLabel>
                    File mẫu mới (tùy chọn)
                  </FormLabel>
                  <FormControl>
                    <div className="border-2 border-dashed border-gray-300 rounded-lg p-8 text-center hover:border-green-400 transition-colors cursor-pointer">
                      <label htmlFor="file-upload-edit" className="cursor-pointer block">
                        <Upload className="h-10 w-10 mx-auto text-gray-400 mb-2" />
                        <p className="text-sm text-gray-600">
                          {selectedFileName || "Click để tải file mới"}
                        </p>
                        <p className="text-xs text-gray-400 mt-1">
                          Chỉ chấp nhận file .docx
                        </p>
                      </label>
                      <input
                        id="file-upload-edit"
                        type="file"
                        accept=".docx"
                        className="hidden"
                        onChange={(e) => {
                          onChange(e.target.files);
                          setSelectedFileName(
                            e.target.files?.[0]?.name || ""
                          );
                        }}
                        {...field}
                      />
                    </div>
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            {/* Is Default */}
            <FormField
              control={form.control}
              name="is_default"
              render={({ field }) => (
                <FormItem className="flex items-center justify-between rounded-lg border p-3">
                  <div>
                    <FormLabel>Mặc định</FormLabel>
                  </div>
                  <FormControl>
                    <Switch
                      checked={field.value}
                      onCheckedChange={field.onChange}
                    />
                  </FormControl>
                </FormItem>
              )}
            />

            {/* Actions */}
            <div className="flex justify-end gap-2 pt-4">
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  form.reset();
                  setSelectedFileName("");
                  onOpenChange(false);
                }}
              >
                Hủy
              </Button>
              <Button
                type="submit"
                className="bg-green-600 hover:bg-green-700"
                disabled={updateMutation.isPending}
              >
                {updateMutation.isPending ? "Đang lưu..." : "Lưu"}
              </Button>
            </div>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
