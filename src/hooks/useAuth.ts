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
 * Checks if input looks like an email (RFC-light: contains "@" with chars on both sides)
 */
const isEmail = (input: string): boolean => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.trim());

/**
 * Converts phone number to synthetic email for Supabase Auth.
 */
const phoneToEmail = (phone: string): string => {
  return `${phone.trim()}@phone.ihomecrm.local`;
};

/**
 * Converts a free-form username to a synthetic email for Supabase Auth.
 * Lowercased, accents stripped, anything not [a-z0-9._-] becomes "-".
 */
const usernameToEmail = (raw: string): string => {
  const slug = raw
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `${slug || 'user'}@username.ihomecrm.local`;
};

/**
 * Normalizes identifier (email | phone | free-form username) → email format
 * for Supabase Auth.
 */
const normalizeIdentifier = (identifier: string): string => {
  const trimmed = identifier.trim();
  if (isEmail(trimmed)) return trimmed;
  if (isPhoneNumber(trimmed)) return phoneToEmail(trimmed);
  // Treat anything else as a username (allow Vietnamese, spaces, etc.).
  return usernameToEmail(trimmed);
};

// =============================================
// Get Current User
// =============================================

export const useAuth = () => {
  return useQuery({
    queryKey: ['auth', 'user'],
    // Đọc session LOCAL thay vì getUser() (round-trip mạng chặn first render).
    // Cache được giữ tươi bởi listener onAuthStateChange toàn cục trong App.tsx
    // (INITIAL_SESSION / SIGNED_IN / TOKEN_REFRESHED / SIGNED_OUT) nên
    // staleTime: Infinity an toàn. RLS vẫn kiểm server-side mọi request dữ liệu.
    queryFn: async (): Promise<User | null> => {
      const { data: { session }, error } = await supabase.auth.getSession();
      if (error) throw error;
      return session?.user ?? null;
    },
    staleTime: Infinity,
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
    staleTime: Infinity, // listener toàn cục trong App.tsx giữ cache tươi
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
          ? 'Tên đăng nhập / Số điện thoại / Email hoặc mật khẩu không đúng'
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
      // scope 'local': chỉ đăng xuất thiết bị này. Mặc định 'global' thu hồi
      // session ở MỌI thiết bị — 1 phiên (tab khác / máy khác / phiên test)
      // đăng xuất là các phiên còn lại chết theo, lần đăng xuất sau dính
      // 403 + "Auth session missing!".
      const { error } = await supabase.auth.signOut({ scope: 'local' });
      if (error) {
        // Session đã mất/bị thu hồi phía server → vẫn coi là đăng xuất
        // thành công, chỉ cần dọn state local. Không throw để user không
        // kẹt ở trạng thái nửa-đăng-nhập.
        console.warn('[logout] signOut error (bỏ qua, vẫn dọn local):', error.message);
      }
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
