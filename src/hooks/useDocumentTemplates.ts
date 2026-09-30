import { requireAccountWriteReceipt } from "@/lib/accountSettingsWriteReceipt";
import { requireReadRows, requireReadRow, templateRow } from "@/lib/accountProfitReadModels";
import { hasUnconfirmedResponse } from "@/lib/operationOutcome";
import { notifyActionError } from '@/lib/actionFeedback';
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { getSessionUser } from "@/lib/authSession";
import { toast } from "sonner";
import { useOrganization } from "@/contexts/OrganizationContext";
import { withOrg } from "@/lib/orgPayload";
import type { Json } from "@/integrations/supabase/types";

// Cột `variables` là jsonb. Khai `Record<string, unknown>[]` không gán được vào
// `Json` vì `unknown` không phải giá trị JSON — và trước 11/08/2026 chỗ này lọt
// qua chỉ nhờ supabase-js cũ không kiểm. `Record<string, Json>[]` mô tả đúng
// thứ thật sự lưu được, và `DEFAULT_TEMPLATE_VARIABLES` vẫn khớp.

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
  organization_id?: string | null;
  user_id: string;
  code: string;
  name: string;
  category: TemplateCategory;
  type?: TemplateType;
  content?: string;
  variables?: Record<string, Json>[] | null;
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

  if (!Array.isArray(data)) throw new TypeError('Malformed template code source');
  if (data.length === 0) return 1;
  const code = data[0]?.code;
  const lastNumber = typeof code === 'string' && /^MHD\d+$/.test(code) ? Number(code.slice(3)) : NaN;
  if (!Number.isSafeInteger(lastNumber) || lastNumber < 0 || lastNumber >= Number.MAX_SAFE_INTEGER) throw new TypeError('Malformed template code source');
  return lastNumber + 1;
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
        throw error;
      }

      return requireReadRows<DocumentTemplate>(data, templateRow);
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
        throw error;
      }

      return requireReadRows<DocumentTemplate>(data, templateRow);
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
        throw error;
      }

      return requireReadRow<DocumentTemplate>(data, row => row.id === id && templateRow(row));
    },
    enabled: !!id,
  });
};

// 3. CREATE TEMPLATE
export const useCreateDocumentTemplate = () => {
  const queryClient = useQueryClient();
  const { selectedOrganizationId } = useOrganization();

  return useMutation({
    mutationFn: async (payload: {
      name: string;
      category: TemplateCategory;
      description?: string;
      file: File;
      is_default: boolean;
      type?: TemplateType;
      variables?: Record<string, Json>[] | null;
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
      try {
      const startNumber = await getNextTemplateNumber(user.id).catch(error => { throw new TemplateSaveUnknownError(urlData.publicUrl, error); });
      let data: DocumentTemplate | null = null;
      let lastError: { code?: string } | null = null;

      for (let attempt = 0; attempt < 25; attempt++) {
        const code = formatTemplateCode(startNumber + attempt);
        const submitted = withOrg({
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
          }, selectedOrganizationId);
        const res = await supabase
          .from("document_templates")
          .insert(withOrg(submitted, selectedOrganizationId))
          .select()
          .single();

        if (!res.error) {
          try {
            data = requireAccountWriteReceipt(res.data, submitted) as DocumentTemplate;
          } catch (cause) {
            throw new TemplateSaveUnknownError(urlData.publicUrl, cause, res.data && typeof res.data.id === 'string' ? res.data.id : undefined);
          }
          break;
        }

        lastError = res.error;
        // Only a duplicate-code error is retryable; anything else is fatal.
        if (res.error.code !== "23505") break;
      }

      if (!data) {
        // A response failure does not prove the insert was rolled back. Keep the uploaded file.
        throw new TemplateSaveUnknownError(urlData.publicUrl, lastError);
      }

      return data;
      } catch (error) {
        if (error instanceof TemplateSaveUnknownError) throw error;
        throw new TemplateSaveUnknownError(urlData.publicUrl, error);
      }
    },
    onSuccess: (template) => {
      queryClient.invalidateQueries({ queryKey: ["document-templates"] });
      toast.success(`Đã tạo mẫu “${template.name}” (${template.code}).`);
    },
    onError: (error) => {
      if (error instanceof TemplateSaveUnknownError) toast.warning(error.message);
      else notifyActionError(error, "Chưa xác nhận được kết quả tạo mẫu tài liệu");
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
      variables?: Record<string, Json>[] | null;
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

      let oldPathToRemove: string | null = null;
      let uploadedUrl: string | null = null;
      // If new file uploaded
      if (payload.file) {
        // Get old template info
        const { data: oldTemplate, error: oldTemplateError } = await supabase
          .from("document_templates")
          .select("file_url")
          .eq("id", payload.id)
          .single();

        if (oldTemplateError) throw oldTemplateError;
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
            throw uploadError;
        }

        // Get new public URL
        const { data: urlData } = supabase.storage
          .from("document-templates")
          .getPublicUrl(filePath);

        uploadedUrl = urlData.publicUrl;
        updateData.file_url = urlData.publicUrl;
        updateData.file_name = payload.file.name;
        updateData.file_size = payload.file.size;
        updateData.file_type = fileExt;

        if (oldTemplate?.file_url) oldPathToRemove = extractTemplatePath(oldTemplate.file_url);
      }

      // Update database record
      const { data, error } = await supabase
        .from("document_templates")
        .update(updateData)
        .eq("id", payload.id)
        .select()
        .single().then(result => result, cause => { if (uploadedUrl) throw new TemplateSaveUnknownError(uploadedUrl, cause, payload.id); throw cause; });

      if (error) {
        if (uploadedUrl) throw new TemplateSaveUnknownError(uploadedUrl, error, payload.id);
        throw error;
      }
      try { requireAccountWriteReceipt(data, { ...updateData, id: payload.id }); }
      catch (cause) {
        if (uploadedUrl) throw new TemplateSaveUnknownError(uploadedUrl, cause, payload.id);
        throw new TemplateMutationReceiptError(payload.id);
      }
      if (!data || data.id !== payload.id || typeof data.name !== 'string' || !data.name || typeof data.code !== 'string' || !data.code
        || (uploadedUrl && data.file_url !== uploadedUrl)) {
        const cause = new TemplateMutationReceiptError(payload.id);
        if (uploadedUrl) throw new TemplateSaveUnknownError(uploadedUrl, cause, payload.id);
        throw cause;
      }
      if (oldPathToRemove) {
        try {
          const cleanup = await supabase.storage.from("document-templates").remove([oldPathToRemove]);
          if (cleanup.error) console.warn('Template saved; old file cleanup pending', cleanup.error);
        } catch (cleanupError) { console.warn('Template saved; old file cleanup pending', cleanupError); }
      }

      return data;
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["document-templates"] });
      queryClient.invalidateQueries({
        queryKey: ["document-template", data.id],
      });
      toast.success(`Đã lưu mẫu “${data.name}” (${data.code}).`);
    },
    onError: (error) => {
      if (error instanceof TemplateSaveUnknownError) toast.warning(error.message);
      else notifyActionError(error, "Chưa xác nhận được kết quả lưu mẫu tài liệu");
    },
  });
};

// 5. DELETE TEMPLATE (Soft delete)
export const useDeleteDocumentTemplate = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (id: string) => {
      const deletedAt = new Date().toISOString();
      const { data, error } = await supabase
        .from("document_templates")
        .update({ deleted_at: deletedAt })
        .eq("id", id)
        .select('id, deleted_at')
        .single();
      if (error) throw error;
      if (!data || data.id !== id || typeof data.deleted_at !== 'string' || Date.parse(data.deleted_at) !== Date.parse(deletedAt)) {
        throw new TemplateMutationReceiptError(id);
      }
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["document-templates"] });
      toast.success("Mẫu đã được xóa thành công");
    },
    onError: (error) => {
      if (error instanceof TemplateSaveUnknownError) toast.warning(error.message);
      else notifyActionError(error, "Chưa xác nhận được kết quả xóa mẫu tài liệu");
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
      if (error instanceof TemplateSaveUnknownError) toast.warning(error.message);
      else notifyActionError(error, "Chưa xác nhận được kết quả mở mẫu tài liệu");
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
      toast.success("Đã chuẩn bị tệp mẫu để tải xuống.");
    },
    onError: (error) => {
      if (error instanceof TemplateSaveUnknownError) toast.warning(error.message);
      else notifyActionError(error, "Chưa xác nhận được kết quả chuẩn bị tệp mẫu tài liệu");
    },
  });
};

export class TemplateSaveUnknownError extends Error {
  constructor(readonly uploadedUrl: string, readonly cause: unknown, readonly templateId?: string) {
    super(`Tệp mẫu đã tải lên nhưng chưa xác nhận được kết quả lưu mẫu${templateId ? ` ${templateId}` : ''}. Kiểm tra danh sách mẫu trước khi thao tác tiếp để tránh tạo trùng.`);
    this.name = 'TemplateSaveUnknownError';
  }
}

export class TemplateMutationReceiptError extends TypeError {
  constructor(readonly templateId: string) {
    super('Chưa xác nhận được mẫu tài liệu đã thay đổi. Giữ mẫu đang chọn và đọc lại trạng thái trước khi thực hiện tiếp.');
    this.name = 'TemplateMutationReceiptError';
  }
}
export function templateWriteOutcomeUnknown(error: unknown): boolean {
  return error instanceof TemplateSaveUnknownError || error instanceof TemplateMutationReceiptError || hasUnconfirmedResponse(error);
}
