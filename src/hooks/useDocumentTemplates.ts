import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";

export type TemplateCategory =
  | "CONTRACT_NEW"
  | "CONTRACT_TERMINATION"
  | "CONTRACT_EXTENSION"
  | "CONTRACT_TRANSFER"
  | "INVOICE"
  | "RECEIPT"
  | "HANDOVER";

export interface DocumentTemplate {
  id: string;
  user_id: string;
  code: string;
  name: string;
  category: TemplateCategory;
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

// Helper function to generate template code
async function generateTemplateCode(userId: string): Promise<string> {
  const { data, error } = await supabase
    .from("document_templates")
    .select("code")
    .eq("user_id", userId)
    .is("deleted_at", null)
    .order("created_at", { ascending: false })
    .limit(1);

  if (error) {
    console.error("Error generating code:", error);
    return "MHD000001";
  }

  if (!data || data.length === 0) {
    return "MHD000001";
  }

  const lastCode = data[0].code;
  const lastNumber = parseInt(lastCode.replace("MHD", ""));
  const newNumber = lastNumber + 1;
  return `MHD${newNumber.toString().padStart(6, "0")}`;
}

// 1. FETCH ALL TEMPLATES
export const useDocumentTemplates = (category?: TemplateCategory) => {
  return useQuery({
    queryKey: ["document-templates", category],
    queryFn: async () => {
      const {
        data: { user },
      } = await supabase.auth.getUser();

      if (!user) {
        throw new Error("User not authenticated");
      }

      let query = supabase
        .from("document_templates")
        .select("*")
        .eq("user_id", user.id)
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
    }) => {
      const {
        data: { user },
      } = await supabase.auth.getUser();

      if (!user) {
        throw new Error("User not authenticated");
      }

      // 1. Generate code
      const code = await generateTemplateCode(user.id);

      // 2. Upload file to storage
      const fileExt = payload.file.name.split(".").pop();
      const fileName = `${Date.now()}_${payload.file.name}`;
      const filePath = `${user.id}/${fileName}`;

      const { error: uploadError } = await supabase.storage
        .from("document-templates")
        .upload(filePath, payload.file, {
          cacheControl: "3600",
          upsert: false,
        });

      if (uploadError) {
        toast.error("Không thể tải file lên");
        throw uploadError;
      }

      // 3. Get public URL
      const { data: urlData } = supabase.storage
        .from("document-templates")
        .getPublicUrl(filePath);

      // 4. Insert record
      const { data, error } = await supabase
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
        })
        .select()
        .single();

      if (error) {
        // Cleanup: delete uploaded file if database insert fails
        await supabase.storage.from("document-templates").remove([filePath]);

        if (error.code === "23505") {
          toast.error("Mã mẫu đã tồn tại");
        } else {
          toast.error("Không thể tạo mẫu");
        }
        throw error;
      }

      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["document-templates"] });
      toast.success("Tạo mẫu thành công");
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
    }) => {
      const {
        data: { user },
      } = await supabase.auth.getUser();

      if (!user) {
        throw new Error("User not authenticated");
      }

      const updateData: any = {
        name: payload.name,
        category: payload.category,
        description: payload.description,
        is_default: payload.is_default,
      };

      // If new file uploaded
      if (payload.file) {
        // Get old template info
        const { data: oldTemplate } = await supabase
          .from("document_templates")
          .select("file_url")
          .eq("id", payload.id)
          .single();

        // Upload new file
        const fileExt = payload.file.name.split(".").pop();
        const fileName = `${Date.now()}_${payload.file.name}`;
        const filePath = `${user.id}/${fileName}`;

        const { error: uploadError } = await supabase.storage
          .from("document-templates")
          .upload(filePath, payload.file, {
            cacheControl: "3600",
            upsert: false,
          });

        if (uploadError) {
          toast.error("Không thể tải file lên");
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
      toast.success("Cập nhật mẫu thành công");
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
      const { data, error } = await supabase
        .from("document_templates")
        .update({ deleted_at: new Date().toISOString() })
        .eq("id", id)
        .select()
        .single();

      if (error) {
        toast.error("Không thể xóa mẫu");
        throw error;
      }

      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["document-templates"] });
      toast.success("Xóa mẫu thành công");
    },
    onError: (error) => {
      console.error("Error deleting template:", error);
    },
  });
};

// 6. DOWNLOAD TEMPLATE
export const useDownloadTemplate = () => {
  return useMutation({
    mutationFn: async ({
      fileUrl,
      fileName,
    }: {
      fileUrl: string;
      fileName: string;
    }) => {
      const response = await fetch(fileUrl);
      if (!response.ok) {
        throw new Error("Failed to download file");
      }

      const blob = await response.blob();
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
    onError: () => {
      toast.error("Lỗi khi tải file");
    },
  });
};
