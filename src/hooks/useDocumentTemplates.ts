import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { getSessionUser } from "@/lib/authSession";
import { toast } from "sonner";

export type TemplateCategory =
  | "CONTRACT_NEW"
  | "CONTRACT_TERMINATION"
  | "CONTRACT_EXTENSION"
  | "CONTRACT_TRANSFER"
  | "INVOICE"
  | "RECEIPT"
  | "HANDOVER";

export type TemplateType =
  | "signature"
  | "deposit_contract"
  | "lease_contract"
  | "handover_report"
  | "invoice"
  | "receipt"
  | "other";

export interface DocumentTemplate {
  id: string;
  user_id: string;
  code: string;
  name: string;
  category: TemplateCategory;
  type?: TemplateType;
  content?: string;
  variables?: Record<string, unknown>[] | null;
  description?: string;
  file_url: string;
  file_name: string;
  file_size?: number;
  file_type: string;
  is_default: boolean;
  is_active: boolean;
  created_at: string;
  updated_at: string;
  deleted_at?: string;
}

export const CATEGORY_LABELS: Record<TemplateCategory, string> = {
  CONTRACT_NEW: "Hợp đồng ký mới",
  CONTRACT_TERMINATION: "Biên bản thanh lý hợp đồng",
  CONTRACT_EXTENSION: "Biên bản gia hạn hợp đồng",
  CONTRACT_TRANSFER: "Biên bản chuyển nhượng hợp đồng",
  INVOICE: "Hóa đơn",
  RECEIPT: "Biên lai",
  HANDOVER: "Biên bản bàn giao tài sản",
};

export const TEMPLATE_TYPE_LABELS: Record<TemplateType, string> = {
  signature: "Mẫu chữ ký",
  deposit_contract: "HĐ đặt cọc",
  lease_contract: "HĐ thuê",
  handover_report: "BB bàn giao",
  invoice: "Mẫu hóa đơn",
  receipt: "Mẫu thu chi",
  other: "Biểu mẫu khác",
};

export const TEMPLATE_TYPES: TemplateType[] = [
  "signature",
  "deposit_contract",
  "lease_contract",
  "handover_report",
  "invoice",
  "receipt",
  "other",
];

// Map TemplateCategory -> TemplateType.
// CreateTemplateDialog only collects `category`, but TemplatesPage filters by `type`.
// Without this mapping new templates are invisible in every tab.
export const CATEGORY_TO_TYPE: Record<TemplateCategory, TemplateType> = {
  CONTRACT_NEW: "lease_contract",
  CONTRACT_TERMINATION: "other",
  CONTRACT_EXTENSION: "other",
  CONTRACT_TRANSFER: "other",
  INVOICE: "invoice",
  RECEIPT: "receipt",
  HANDOVER: "handover_report",
};

// Default template variables for each type
export const DEFAULT_TEMPLATE_VARIABLES: Record<TemplateType, Record<string, string>[]> = {
  signature: [
    { key: "owner_name", label: "Tên chủ nhà" },
    { key: "owner_phone", label: "SĐT chủ nhà" },
  ],
  deposit_contract: [
    { key: "tenant_name", label: "Tên khách hàng" },
    { key: "room_name", label: "Tên căn hộ" },
    { key: "deposit_amount", label: "Số tiền cọc" },
    { key: "deposit_date", label: "Ngày cọc" },
  ],
  lease_contract: [
    { key: "tenant_name", label: "Tên khách hàng" },
    { key: "room_name", label: "Tên căn hộ" },
    { key: "rent_price", label: "Giá thuê" },
    { key: "start_date", label: "Ngày bắt đầu" },
    { key: "end_date", label: "Ngày kết thúc" },
  ],
  handover_report: [
    { key: "tenant_name", label: "Tên khách hàng" },
    { key: "room_name", label: "Tên căn hộ" },
    { key: "handover_date", label: "Ngày bàn giao" },
  ],
  invoice: [
    { key: "tenant_name", label: "Tên khách hàng" },
    { key: "room_name", label: "Tên căn hộ" },
    { key: "total_amount", label: "Tổng tiền" },
    { key: "due_date", label: "Hạn thanh toán" },
  ],
  receipt: [
    { key: "tenant_name", label: "Tên khách hàng" },
    { key: "amount", label: "Số tiền" },
    { key: "payment_method", label: "Phương thức thanh toán" },
  ],
  other: [],
};

// Sanitize a filename for use as a Supabase Storage object key.
// Storage object keys reject Vietnamese diacritics, spaces, and most punctuation —
// uploads silently fail with "Invalid key" otherwise. Strip diacritics, replace
// whitespace with `_`, drop unsupported chars. Original filename is still kept
// in the `file_name` column for display/download.
function sanitizeStorageFileName(name: string): string {
  const lastDot = name.lastIndexOf(".");
  const base = lastDot > 0 ? name.slice(0, lastDot) : name;
  const ext = lastDot > 0 ? name.slice(lastDot + 1).toLowerCase() : "";
  const safeBase =
    base
      .normalize("NFD")
      .replace(/\p{M}+/gu, "")
      .replace(/đ/g, "d")
      .replace(/Đ/g, "D")
      .replace(/[^a-zA-Z0-9._-]+/g, "_")
      .replace(/_+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 80) || "file";
  return ext ? `${safeBase}.${ext}` : safeBase;
}

// Compute the next template code number.
// IMPORTANT: the `code` column has a GLOBAL UNIQUE constraint that also covers
// soft-deleted rows (deleted_at != null). So the max must be taken across ALL
// rows — NOT just `deleted_at IS NULL`. Otherwise deleting the most-recent
// template and re-uploading regenerates its exact code and collides with the
// lingering soft-deleted row (Postgres 23505). Order by `code` (zero-padded →
// lexicographic == numeric) rather than created_at so out-of-order timestamps
// or gaps can never lower the max.
async function getNextTemplateNumber(userId: string): Promise<number> {
  const { data, error } = await supabase
    .from("document_templates")
    .select("code")
    .eq("user_id", userId)
    .order("code", { ascending: false })
    .limit(1);

  if (error) {
    console.error("Error reading template codes:", error);
    throw error;
  }

  if (!data || data.length === 0) {
    return 1;
  }

  const lastNumber = parseInt(data[0].code.replace("MHD", ""), 10);
  return Number.isFinite(lastNumber) ? lastNumber + 1 : 1;
}

const formatTemplateCode = (n: number): string => `MHD${n.toString().padStart(6, "0")}`;

// 1. FETCH ALL TEMPLATES
export const useDocumentTemplates = (category?: TemplateCategory) => {
  return useQuery({
    queryKey: ["document-templates", category],
    queryFn: async () => {
      const user = await getSessionUser();

      if (!user) {
        throw new Error("User not authenticated");
      }

      let query = supabase
        .from("document_templates")
        .select("*")
        .is("deleted_at", null)
        .order("created_at", { ascending: false });

      if (category) {
        query = query.eq("category", category);
      }

      const { data, error } = await query;

      if (error) {
        toast.error("Không thể tải danh sách mẫu");
        throw error;
      }

      return data as DocumentTemplate[];
    },
  });
};

// 1b. FETCH TEMPLATES BY TYPE
// options.enabled: dialog mounted-sẵn (vd PrintContractDialog) gate fetch khi
// đóng (default true).
export const useDocumentTemplatesByType = (
  type?: TemplateType,
  options?: { enabled?: boolean }
) => {
  return useQuery({
    enabled: options?.enabled ?? true,
    queryKey: ["document-templates", "by-type", type],
    queryFn: async () => {
      const user = await getSessionUser();

      if (!user) {
        throw new Error("User not authenticated");
      }

      let query = supabase
        .from("document_templates")
        .select("*")
        .is("deleted_at", null)
        .order("created_at", { ascending: false });

      if (type) {
        query = query.eq("type", type);
      }

      const { data, error } = await query;

      if (error) {
        toast.error("Không thể tải danh sách mẫu");
        throw error;
      }

      return data as DocumentTemplate[];
    },
  });
};

// 2. FETCH SINGLE TEMPLATE
export const useDocumentTemplate = (id: string) => {
  return useQuery({
    queryKey: ["document-template", id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("document_templates")
        .select("*")
        .eq("id", id)
        .is("deleted_at", null)
        .single();

      if (error) {
        toast.error("Không thể tải thông tin mẫu");
        throw error;
      }

      return data as DocumentTemplate;
    },
    enabled: !!id,
  });
};

// 3. CREATE TEMPLATE
export const useCreateDocumentTemplate = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (payload: {
      name: string;
      category: TemplateCategory;
      description?: string;
      file: File;
      is_default: boolean;
      type?: TemplateType;
      variables?: Record<string, unknown>[] | null;
      content?: string;
    }) => {
      const user = await getSessionUser();

      if (!user) {
        throw new Error("User not authenticated");
      }

      // 1. Upload file to storage (sanitize name — Storage rejects diacritics/spaces)
      const fileExt = payload.file.name.split(".").pop();
      const safeName = sanitizeStorageFileName(payload.file.name);
      const fileName = `${Date.now()}_${safeName}`;
      const filePath = `${user.id}/${fileName}`;

      const { error: uploadError } = await supabase.storage
        .from("document-templates")
        .upload(filePath, payload.file, {
          cacheControl: "3600",
          upsert: false,
          contentType: payload.file.type || undefined,
        });

      if (uploadError) {
        toast.error(`Không thể tải file lên: ${uploadError.message}`);
        throw uploadError;
      }

      // 2. Get public URL
      const { data: urlData } = supabase.storage
        .from("document-templates")
        .getPublicUrl(filePath);

      // 3. Insert record with collision-retry. The `code` UNIQUE constraint also
      // covers soft-deleted rows, so a freshly computed code can still collide
      // (e.g. re-uploading a previously deleted template). On 23505 bump the
      // number and retry; this self-heals even if several codes are taken.
      const startNumber = await getNextTemplateNumber(user.id);
      let data: DocumentTemplate | null = null;
      let lastError: { code?: string } | null = null;

      for (let attempt = 0; attempt < 25; attempt++) {
        const code = formatTemplateCode(startNumber + attempt);
        const res = await supabase
          .from("document_templates")
          .insert({
            user_id: user.id,
            code,
            name: payload.name,
            category: payload.category,
            description: payload.description,
            file_url: urlData.publicUrl,
            file_name: payload.file.name,
            file_size: payload.file.size,
            file_type: fileExt,
            is_default: payload.is_default,
            type: payload.type,
            variables: payload.variables,
            content: payload.content,
          })
          .select()
          .single();

        if (!res.error) {
          data = res.data as DocumentTemplate;
          break;
        }

        lastError = res.error;
        // Only a duplicate-code error is retryable; anything else is fatal.
        if (res.error.code !== "23505") break;
      }

      if (!data) {
        // Cleanup: delete uploaded file if database insert never succeeded
        await supabase.storage.from("document-templates").remove([filePath]);

        if (lastError?.code === "23505") {
          toast.error("Mã mẫu đã tồn tại");
        } else {
          toast.error("Không thể tạo mẫu");
        }
        throw lastError ?? new Error("Không thể tạo mẫu");
      }

      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["document-templates"] });
      toast.success("Mẫu đã được tạo thành công");
    },
    onError: (error) => {
      console.error("Error creating template:", error);
    },
  });
};

// 4. UPDATE TEMPLATE
export const useUpdateDocumentTemplate = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (payload: {
      id: string;
      name?: string;
      category?: TemplateCategory;
      description?: string;
      file?: File;
      is_default?: boolean;
      type?: TemplateType;
      variables?: Record<string, unknown>[] | null;
      content?: string;
    }) => {
      const user = await getSessionUser();

      if (!user) {
        throw new Error("User not authenticated");
      }

      const updateData: any = {
        name: payload.name,
        category: payload.category,
        description: payload.description,
        is_default: payload.is_default,
        type: payload.type,
        variables: payload.variables,
        content: payload.content,
      };

      // If new file uploaded
      if (payload.file) {
        // Get old template info
        const { data: oldTemplate } = await supabase
          .from("document_templates")
          .select("file_url")
          .eq("id", payload.id)
          .single();

        // Upload new file (sanitize name — Storage rejects diacritics/spaces)
        const fileExt = payload.file.name.split(".").pop();
        const safeName = sanitizeStorageFileName(payload.file.name);
        const fileName = `${Date.now()}_${safeName}`;
        const filePath = `${user.id}/${fileName}`;

        const { error: uploadError } = await supabase.storage
          .from("document-templates")
          .upload(filePath, payload.file, {
            cacheControl: "3600",
            upsert: false,
            contentType: payload.file.type || undefined,
          });

        if (uploadError) {
          toast.error(`Không thể tải file lên: ${uploadError.message}`);
          throw uploadError;
        }

        // Get new public URL
        const { data: urlData } = supabase.storage
          .from("document-templates")
          .getPublicUrl(filePath);

        updateData.file_url = urlData.publicUrl;
        updateData.file_name = payload.file.name;
        updateData.file_size = payload.file.size;
        updateData.file_type = fileExt;

        // Delete old file after successful upload
        if (oldTemplate?.file_url) {
          try {
            const oldPath = oldTemplate.file_url.split("/").slice(-2).join("/");
            await supabase.storage
              .from("document-templates")
              .remove([oldPath]);
          } catch (error) {
            console.error("Error deleting old file:", error);
            // Don't throw - file deletion is not critical
          }
        }
      }

      // Update database record
      const { data, error } = await supabase
        .from("document_templates")
        .update(updateData)
        .eq("id", payload.id)
        .select()
        .single();

      if (error) {
        if (error.code === "23505") {
          toast.error("Mã mẫu đã tồn tại");
        } else {
          toast.error("Không thể cập nhật mẫu");
        }
        throw error;
      }

      return data;
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["document-templates"] });
      queryClient.invalidateQueries({
        queryKey: ["document-template", data.id],
      });
      toast.success("Mẫu đã được cập nhật thành công");
    },
    onError: (error) => {
      console.error("Error updating template:", error);
    },
  });
};

// 5. DELETE TEMPLATE (Soft delete)
export const useDeleteDocumentTemplate = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase
        .from("document_templates")
        .update({ deleted_at: new Date().toISOString() })
        .eq("id", id);

      if (error) {
        toast.error("Không thể xóa mẫu");
        throw error;
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["document-templates"] });
      toast.success("Mẫu đã được xóa thành công");
    },
    onError: (error) => {
      console.error("Error deleting template:", error);
    },
  });
};

// Extract storage object path from a Supabase Storage URL.
//   ".../object/public/document-templates/<user>/<file>" → "<user>/<file>"
//   ".../object/sign/document-templates/<user>/<file>"  → "<user>/<file>"
function extractTemplatePath(url: string): string | null {
  const m = url.match(
    /\/object\/(?:public|sign|authenticated)\/document-templates\/(.+?)(?:\?|$)/,
  );
  return m ? decodeURIComponent(m[1]) : null;
}

// Open a template file in a new tab. Bucket is private, so a public URL
// returns 400 — generate a short-lived signed URL instead.
export const useViewTemplate = () => {
  return useMutation({
    mutationFn: async (template: { file_url: string }) => {
      const path = extractTemplatePath(template.file_url);
      if (!path) {
        window.open(template.file_url, "_blank");
        return;
      }
      const { data, error } = await supabase.storage
        .from("document-templates")
        .createSignedUrl(path, 60); // 1-minute view link
      if (error || !data?.signedUrl) {
        throw new Error(error?.message ?? "no signed url");
      }
      window.open(data.signedUrl, "_blank");
    },
    onError: (error) => {
      console.error("Error viewing template:", error);
      toast.error("Không thể mở file");
    },
  });
};

// 6. DOWNLOAD TEMPLATE — go through the SDK so the user session can
// authenticate against the private bucket.
export const useDownloadTemplate = () => {
  return useMutation({
    mutationFn: async ({
      fileUrl,
      fileName,
    }: {
      fileUrl: string;
      fileName: string;
    }) => {
      const path = extractTemplatePath(fileUrl);
      let blob: Blob;
      if (path) {
        const { data, error } = await supabase.storage
          .from("document-templates")
          .download(path);
        if (error || !data) {
          throw new Error(error?.message ?? "download failed");
        }
        blob = data;
      } else {
        const response = await fetch(fileUrl);
        if (!response.ok) {
          throw new Error(`Failed to download file (${response.status})`);
        }
        blob = await response.blob();
      }

      const url = window.URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);
    },
    onSuccess: () => {
      toast.success("Tải xuống thành công");
    },
    onError: (error) => {
      console.error("Error downloading template:", error);
      toast.error("Có lỗi xảy ra khi tải file");
    },
  });
};
