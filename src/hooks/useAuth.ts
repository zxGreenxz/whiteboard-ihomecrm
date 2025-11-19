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
  phone?: string;
}

export interface LoginData {
  email: string;
  password: string;
  rememberMe?: boolean;
}

export interface ForgotPasswordData {
  email: string;
}

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
      const { data: authData, error } = await supabase.auth.signUp({
        email: data.email,
        password: data.password,
        options: {
          data: {
            full_name: data.fullName,
            phone: data.phone,
          },
        },
      });

      if (error) throw error;
      return authData;
    },
    onSuccess: () => {
      toast({
        title: 'Đăng ký thành công!',
        description: 'Vui lòng kiểm tra email để xác nhận tài khoản.',
      });
      navigate('/login');
    },
    onError: (error: Error) => {
      toast({
        variant: 'destructive',
        title: 'Đăng ký thất bại',
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
      const { data: authData, error } = await supabase.auth.signInWithPassword({
        email: data.email,
        password: data.password,
      });

      if (error) throw error;
      return authData;
    },
    onSuccess: () => {
      // Invalidate and refetch user data
      queryClient.invalidateQueries({ queryKey: ['auth'] });

      toast({
        title: 'Đăng nhập thành công!',
        description: 'Chào mừng bạn trở lại.',
      });

      navigate('/');
    },
    onError: (error: Error) => {
      toast({
        variant: 'destructive',
        title: 'Đăng nhập thất bại',
        description: error.message === 'Invalid login credentials'
          ? 'Email hoặc mật khẩu không đúng'
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
        title: 'Đăng xuất thất bại',
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
        title: 'Đã gửi email!',
        description: 'Vui lòng kiểm tra email để đặt lại mật khẩu.',
      });
    },
    onError: (error: Error) => {
      toast({
        variant: 'destructive',
        title: 'Gửi email thất bại',
        description: error.message,
      });
    },
  });
};
