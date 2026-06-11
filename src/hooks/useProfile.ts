import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { getSessionUserId } from '@/lib/authSession';
import { toast } from 'sonner';

// =============================================
// Types
// =============================================

export interface Profile {
  id: string;
  full_name: string;
  phone: string | null;
  email: string | null;
  avatar_url: string | null;
  company_name: string | null;
  address: string | null;
  default_payment_due_days: number;
  timezone: string;
  language: string;
  subscription_plan: string;
  subscription_expires_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface UpdateProfileData {
  full_name?: string;
  phone?: string;
  email?: string;
  avatar_url?: string;
  company_name?: string;
  address?: string;
  default_payment_due_days?: number;
  timezone?: string;
  language?: string;
}

// =============================================
// Get Profile
// =============================================

export const useProfile = () => {
  return useQuery({
    queryKey: ['profile'],
    queryFn: async (): Promise<Profile | null> => {
      const userId = await getSessionUserId();
      if (!userId) return null;

      const { data, error } = await supabase
        .from('profiles')
        .select('*')
        .eq('id', userId)
        .single();

      if (error) throw error;
      return data;
    },
    retry: 1,
  });
};

// =============================================
// Update Profile
// =============================================

export const useUpdateProfile = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (data: UpdateProfileData) => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not authenticated');

      const { data: profile, error } = await supabase
        .from('profiles')
        .update(data)
        .eq('id', user.id)
        .select()
        .single();

      if (error) throw error;
      return profile;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['profile'] });
      toast.success('Dữ liệu đã được CẬP NHẬT thành công');
    },
    onError: (error: Error) => {
      toast.error('Có lỗi xảy ra khi cập nhật thông tin: ' + error.message);
    },
  });
};

// =============================================
// Upload Avatar
// =============================================

export const useUploadAvatar = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (file: File) => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not authenticated');

      const fileExt = file.name.split('.').pop();
      const filePath = `${user.id}/avatar.${fileExt}`;

      const { error: uploadError } = await supabase.storage
        .from('avatars')
        .upload(filePath, file, { cacheControl: '3600', upsert: true });

      if (uploadError) throw uploadError;

      const { data: urlData } = supabase.storage
        .from('avatars')
        .getPublicUrl(filePath);

      const { error: updateError } = await supabase
        .from('profiles')
        .update({ avatar_url: urlData.publicUrl })
        .eq('id', user.id);

      if (updateError) throw updateError;
      return urlData.publicUrl;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['profile'] });
      toast.success('Ảnh đại diện đã được CẬP NHẬT thành công');
    },
    onError: (error: Error) => {
      toast.error('Có lỗi xảy ra khi tải ảnh: ' + error.message);
    },
  });
};

// =============================================
// Change Password
// =============================================

export const useChangePassword = () => {
  return useMutation({
    mutationFn: async (newPassword: string) => {
      const { error } = await supabase.auth.updateUser({
        password: newPassword,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success('Mật khẩu đã được đổi thành công');
    },
    onError: (error: Error) => {
      toast.error('Có lỗi xảy ra khi đổi mật khẩu: ' + error.message);
    },
  });
};
