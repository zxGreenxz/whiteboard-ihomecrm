import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/lib/supabase';
import { useAuth } from './useAuth';
import { toast } from 'sonner';

// =============================================
// TYPES
// =============================================

export type TemplateType = 'CONTRACT' | 'INVOICE' | 'RECEIPT' | 'OTHER';

export interface Template {
  id: string;
  user_id: string;
  name: string;
  type: TemplateType;
  file_url: string;
  file_name: string;
  file_size: number;
  description: string | null;
  variables: string[]; // Template variables like {tenant_name}, {room_name}, etc.
  is_default: boolean;
  created_at: string;
  updated_at: string;
}

// =============================================
// HOOKS
// =============================================

/**
 * useTemplates - Get all templates for current user
 */
export const useTemplates = (type?: TemplateType) => {
  const { data: user } = useAuth();

  return useQuery({
    queryKey: ['templates', user?.id, type],
    queryFn: async () => {
      if (!user?.id) return [];

      let query = supabase
        .from('templates')
        .select('*')
        .eq('user_id', user.id)
        .order('created_at', { ascending: false });

      if (type) {
        query = query.eq('type', type);
      }

      const { data, error } = await query;

      if (error) throw error;

      return (data || []) as Template[];
    },
    enabled: !!user?.id,
  });
};

/**
 * useTemplate - Get a single template by ID
 */
export const useTemplate = (templateId: string) => {
  const { data: user } = useAuth();

  return useQuery({
    queryKey: ['template', templateId],
    queryFn: async () => {
      if (!templateId) return null;

      const { data, error } = await supabase
        .from('templates')
        .select('*')
        .eq('id', templateId)
        .single();

      if (error) throw error;

      return data as Template;
    },
    enabled: !!templateId && !!user?.id,
  });
};

/**
 * useUploadTemplate - Upload a new template file
 */
export const useUploadTemplate = () => {
  const queryClient = useQueryClient();
  const { data: user } = useAuth();

  return useMutation({
    mutationFn: async ({
      file,
      name,
      type,
      description,
      variables,
      isDefault,
    }: {
      file: File;
      name: string;
      type: TemplateType;
      description?: string;
      variables?: string[];
      isDefault?: boolean;
    }) => {
      if (!user?.id) throw new Error('User not authenticated');

      // Upload file to Supabase Storage
      const fileExt = file.name.split('.').pop();
      const fileName = `${Date.now()}-${Math.random().toString(36).substring(7)}.${fileExt}`;
      const filePath = `templates/${user.id}/${fileName}`;

      const { error: uploadError } = await supabase.storage
        .from('documents')
        .upload(filePath, file);

      if (uploadError) throw uploadError;

      // Get public URL
      const {
        data: { publicUrl },
      } = supabase.storage.from('documents').getPublicUrl(filePath);

      // Create template record
      const { data, error } = await supabase
        .from('templates')
        .insert({
          user_id: user.id,
          name,
          type,
          file_url: publicUrl,
          file_name: file.name,
          file_size: file.size,
          description,
          variables: variables || [],
          is_default: isDefault || false,
        })
        .select()
        .single();

      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['templates', user?.id] });
      toast.success('Mẫu biểu đã được tải lên');
    },
    onError: (error) => {
      console.error('Error uploading template:', error);
      toast.error('Không thể tải lên mẫu biểu');
    },
  });
};

/**
 * useUpdateTemplate - Update template metadata
 */
export const useUpdateTemplate = () => {
  const queryClient = useQueryClient();
  const { data: user } = useAuth();

  return useMutation({
    mutationFn: async ({
      id,
      ...updates
    }: Partial<Template> & { id: string }) => {
      const { data, error } = await supabase
        .from('templates')
        .update({
          ...updates,
          updated_at: new Date().toISOString(),
        })
        .eq('id', id)
        .select()
        .single();

      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['templates', user?.id] });
      toast.success('Mẫu biểu đã được cập nhật');
    },
    onError: (error) => {
      console.error('Error updating template:', error);
      toast.error('Không thể cập nhật mẫu biểu');
    },
  });
};

/**
 * useDeleteTemplate - Delete a template
 */
export const useDeleteTemplate = () => {
  const queryClient = useQueryClient();
  const { data: user } = useAuth();

  return useMutation({
    mutationFn: async (templateId: string) => {
      // Get template to delete file from storage
      const { data: template } = await supabase
        .from('templates')
        .select('file_url')
        .eq('id', templateId)
        .single();

      if (template?.file_url) {
        // Extract file path from URL
        const url = new URL(template.file_url);
        const filePath = url.pathname.split('/').slice(-3).join('/'); // templates/user_id/filename

        // Delete from storage
        await supabase.storage.from('documents').remove([filePath]);
      }

      // Delete template record
      const { error } = await supabase
        .from('templates')
        .delete()
        .eq('id', templateId);

      if (error) throw error;

      return templateId;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['templates', user?.id] });
      toast.success('Mẫu biểu đã được xóa');
    },
    onError: (error) => {
      console.error('Error deleting template:', error);
      toast.error('Không thể xóa mẫu biểu');
    },
  });
};

/**
 * useSetDefaultTemplate - Set a template as default for its type
 */
export const useSetDefaultTemplate = () => {
  const queryClient = useQueryClient();
  const { data: user } = useAuth();

  return useMutation({
    mutationFn: async ({ templateId, type }: { templateId: string; type: TemplateType }) => {
      if (!user?.id) throw new Error('User not authenticated');

      // First, unset all defaults for this type
      await supabase
        .from('templates')
        .update({ is_default: false })
        .eq('user_id', user.id)
        .eq('type', type);

      // Then set this one as default
      const { data, error } = await supabase
        .from('templates')
        .update({ is_default: true })
        .eq('id', templateId)
        .select()
        .single();

      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['templates', user?.id] });
      toast.success('Mẫu biểu mặc định đã được đặt');
    },
    onError: (error) => {
      console.error('Error setting default template:', error);
      toast.error('Không thể đặt mẫu biểu mặc định');
    },
  });
};

// =============================================
// HELPER FUNCTIONS
// =============================================

/**
 * Get template type label in Vietnamese
 */
export const getTemplateTypeLabel = (type: TemplateType): string => {
  const labels: Record<TemplateType, string> = {
    CONTRACT: 'Hợp đồng',
    INVOICE: 'Hóa đơn',
    RECEIPT: 'Phiếu thu',
    OTHER: 'Khác',
  };
  return labels[type] || type;
};

/**
 * Get template type color
 */
export const getTemplateTypeColor = (type: TemplateType): string => {
  const colors: Record<TemplateType, string> = {
    CONTRACT: 'bg-blue-100 text-blue-800 border-blue-200',
    INVOICE: 'bg-green-100 text-green-800 border-green-200',
    RECEIPT: 'bg-purple-100 text-purple-800 border-purple-200',
    OTHER: 'bg-gray-100 text-gray-800 border-gray-200',
  };
  return colors[type] || colors.OTHER;
};

/**
 * Format file size
 */
export const formatFileSize = (bytes: number): string => {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + ' ' + sizes[i];
};

/**
 * Get available template variables
 */
export const getAvailableVariables = (type: TemplateType): string[] => {
  const commonVariables = [
    '{company_name}',
    '{company_address}',
    '{company_phone}',
    '{company_email}',
    '{today}',
    '{current_date}',
    '{current_year}',
  ];

  const contractVariables = [
    ...commonVariables,
    '{contract_number}',
    '{contract_date}',
    '{start_date}',
    '{end_date}',
    '{tenant_name}',
    '{tenant_phone}',
    '{tenant_email}',
    '{tenant_id_number}',
    '{tenant_address}',
    '{room_name}',
    '{room_address}',
    '{building_name}',
    '{rent_price}',
    '{deposit_amount}',
    '{payment_cycle}',
    '{services_list}',
  ];

  const invoiceVariables = [
    ...commonVariables,
    '{invoice_number}',
    '{invoice_date}',
    '{due_date}',
    '{billing_period}',
    '{tenant_name}',
    '{tenant_phone}',
    '{room_name}',
    '{rent_amount}',
    '{services_amount}',
    '{total_amount}',
    '{amount_paid}',
    '{amount_remaining}',
    '{invoice_items}',
  ];

  const receiptVariables = [
    ...commonVariables,
    '{receipt_number}',
    '{receipt_date}',
    '{tenant_name}',
    '{amount}',
    '{amount_in_words}',
    '{payment_method}',
    '{invoice_number}',
    '{description}',
  ];

  switch (type) {
    case 'CONTRACT':
      return contractVariables;
    case 'INVOICE':
      return invoiceVariables;
    case 'RECEIPT':
      return receiptVariables;
    default:
      return commonVariables;
  }
};
