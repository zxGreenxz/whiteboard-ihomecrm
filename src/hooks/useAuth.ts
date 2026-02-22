import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { User, Session } from '@supabase/supabase-js';
import { useNavigate } from 'react-router-dom';
import { useToast } from '@/hooks/use-toast';

// =============================================
// Types
// =============================================

export interface RegisterData {
  email: string;
  password: string;
  fullName: string;
  phone: string; // Required
}

export interface LoginData {
  identifier: string; // Can be phone or email
  password: string;
  rememberMe?: boolean;
}

export interface ForgotPasswordData {
  email: string;
}

// =============================================
// Helper Functions
// =============================================

/**
 * Checks if input is a phone number (10-11 digits)
 */
const isPhoneNumber = (input: string): boolean => {
  return /^[0-9]{10,11}$/.test(input.trim());
};

/**
 * Converts phone number to email format for Supabase Auth
 * Example: 0901234567 → 0901234567@phone.ihomecrm.local
 */
const phoneToEmail = (phone: string): string => {
  return `${phone.trim()}@phone.ihomecrm.local`;
};

/**
 * Normalizes identifier (phone or email) to email format
 */
const normalizeIdentifier = (identifier: string): string => {
  if (isPhoneNumber(identifier)) {
    return phoneToEmail(identifier);
  }
  return identifier.trim();
};

// =============================================
// Get Current User
// =============================================

export const useAuth = () => {
  return useQuery({
    queryKey: ['auth', 'user'],
    queryFn: async (): Promise<User | null> => {
      const { data: { user }, error } = await supabase.auth.getUser();
      if (error) throw error;
      return user;
    },
    retry: 1,
  });
};

// =============================================
// Get Session
// =============================================

export const useSession = () => {
  return useQuery({
    queryKey: ['auth', 'session'],
    queryFn: async (): Promise<Session | null> => {
      const { data: { session }, error } = await supabase.auth.getSession();
      if (error) throw error;
      return session;
    },
    retry: 1,
  });
};

// =============================================
// Register
// =============================================

export const useRegister = () => {
  const navigate = useNavigate();
  const { toast } = useToast();

  return useMutation({
    mutationFn: async (data: RegisterData) => {
      // Convert phone to email format if user registers with phone
      const authEmail = data.email ? data.email : phoneToEmail(data.phone);

      const { data: authData, error } = await supabase.auth.signUp({
        email: authEmail,
        password: data.password,
        options: {
          data: {
            full_name: data.fullName,
            phone: data.phone,
            email: data.email || null, // Store actual email if provided
          },
        },
      });

      if (error) throw error;
      return authData;
    },
    onSuccess: () => {
      toast({
        title: 'Đăng ký thành công',
        description: 'Bạn đã tạo tài khoản thành công. Đăng nhập để bắt đầu.',
      });
      navigate('/login');
    },
    onError: (error: Error) => {
      toast({
        variant: 'destructive',
        title: 'Có lỗi xảy ra khi đăng ký',
        description: error.message,
      });
    },
  });
};

// =============================================
// Login
// =============================================

export const useLogin = () => {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  return useMutation({
    mutationFn: async (data: LoginData) => {
      // Normalize identifier (phone → email format, or keep email as-is)
      const email = normalizeIdentifier(data.identifier);

      const { data: authData, error } = await supabase.auth.signInWithPassword({
        email,
        password: data.password,
      });

      if (error) throw error;
      return authData;
    },
    onSuccess: () => {
      // Invalidate and refetch user data
      queryClient.invalidateQueries({ queryKey: ['auth'] });

      toast({
        title: 'Đăng nhập thành công',
        description: 'Chào mừng bạn trở lại.',
      });

      navigate('/');
    },
    onError: (error: Error) => {
      toast({
        variant: 'destructive',
        title: 'Có lỗi xảy ra khi đăng nhập',
        description: error.message === 'Invalid login credentials'
          ? 'Số điện thoại/Email hoặc mật khẩu không đúng'
          : error.message,
      });
    },
  });
};

// =============================================
// Logout
// =============================================

export const useLogout = () => {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  return useMutation({
    mutationFn: async () => {
      const { error } = await supabase.auth.signOut();
      if (error) throw error;
    },
    onSuccess: () => {
      // Clear all queries
      queryClient.clear();

      toast({
        title: 'Đăng xuất thành công',
        description: 'Hẹn gặp lại bạn!',
      });

      navigate('/login');
    },
    onError: (error: Error) => {
      toast({
        variant: 'destructive',
        title: 'Có lỗi xảy ra khi đăng xuất',
        description: error.message,
      });
    },
  });
};

// =============================================
// Forgot Password
// =============================================

export const useForgotPassword = () => {
  const { toast } = useToast();

  return useMutation({
    mutationFn: async (data: ForgotPasswordData) => {
      const { error } = await supabase.auth.resetPasswordForEmail(data.email, {
        redirectTo: `${window.location.origin}/reset-password`,
      });

      if (error) throw error;
    },
    onSuccess: () => {
      toast({
        title: 'Email đã được gửi thành công',
        description: 'Vui lòng kiểm tra email để đặt lại mật khẩu.',
      });
    },
    onError: (error: Error) => {
      toast({
        variant: 'destructive',
        title: 'Có lỗi xảy ra khi gửi email',
        description: error.message,
      });
    },
  });
};

// =============================================
// Reset Password (Update Password)
// =============================================

export interface ResetPasswordData {
  password: string;
}

export const useResetPassword = () => {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (data: ResetPasswordData) => {
      const { error } = await supabase.auth.updateUser({
        password: data.password,
      });

      if (error) throw error;
    },
    onSuccess: () => {
      // Clear auth cache
      queryClient.invalidateQueries({ queryKey: ['auth'] });

      toast({
        title: 'Mật khẩu đã được đổi thành công',
        description: 'Bạn có thể đăng nhập với mật khẩu mới.',
      });
    },
    onError: (error: Error) => {
      toast({
        variant: 'destructive',
        title: 'Có lỗi xảy ra khi đổi mật khẩu',
        description: error.message,
      });
    },
  });
};
