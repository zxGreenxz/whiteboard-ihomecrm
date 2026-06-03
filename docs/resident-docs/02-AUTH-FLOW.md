# AUTHENTICATION FLOW
## Đăng ký, Đăng nhập, Quên mật khẩu

---

## 📋 MỤC LỤC

1. [Tổng quan](#tổng-quan)
2. [Flow đăng ký](#flow-đăng-ký)
3. [Flow đăng nhập](#flow-đăng-nhập)
4. [Flow quên mật khẩu](#flow-quên-mật-khẩu)
5. [Supabase Auth Setup](#supabase-auth-setup)
6. [Implementation Guide](#implementation-guide)
7. [Testing](#testing)

---

## 🎯 TỔNG QUAN

### Mục tiêu
Xây dựng hệ thống xác thực an toàn và dễ sử dụng với Supabase Auth

### Tính năng
- ✅ Đăng ký với Email/SĐT + Password
- ✅ Đăng nhập với SĐT + Password
- ✅ Quên mật khẩu (OTP qua Zalo/SMS - Phase 2)
- ✅ Tự động tạo tài khoản dùng thử
- ✅ Auto redirect sau đăng ký/đăng nhập
- ✅ Protected routes
- ✅ Session management

### Tech Stack
- **Supabase Auth**: Authentication backend
- **React Hook Form**: Form handling
- **Zod**: Validation
- **React Router**: Navigation
- **TanStack Query**: Auth state management

---

## 📝 FLOW ĐĂNG KÝ

### User Journey

```
Vào trang đăng ký
      │
      ├─→ Nhập thông tin:
      │   ├─ Họ tên (*)
      │   ├─ Số điện thoại (*)
      │   ├─ Email (*)
      │   └─ Mật khẩu (*)
      │
      ├─→ Validate form
      │   ├─ Họ tên: Không rỗng
      │   ├─ SĐT: Format 10-11 số
      │   ├─ Email: Format email hợp lệ
      │   └─ Password: Min 6 ký tự
      │
      ├─→ Submit form
      │   ├─ Gọi Supabase signUp()
      │   ├─ Tạo user trong auth.users
      │   └─ Trigger tạo profile
      │
      ├─→ Tự động đăng nhập
      │   └─ Redirect → Dashboard
      │
      └─→ Hiển thị thông báo chào mừng
          └─ "Chào mừng bạn đến với crm!"
```

### Validation Rules

```typescript
// Zod schema
const registerSchema = z.object({
  full_name: z.string().min(1, 'Vui lòng nhập họ tên'),
  phone: z.string().regex(/^[0-9]{10,11}$/, 'Số điện thoại không hợp lệ'),
  email: z.string().email('Email không hợp lệ'),
  password: z.string().min(6, 'Mật khẩu phải có ít nhất 6 ký tự'),
  confirm_password: z.string()
}).refine((data) => data.password === data.confirm_password, {
  message: "Mật khẩu không khớp",
  path: ["confirm_password"],
});
```

### API Flow

```typescript
// 1. User submits form
const formData = {
  full_name: "Nguyễn Văn A",
  phone: "0901234567",
  email: "user@example.com",
  password: "password123"
};

// 2. Call Supabase signUp
const { data, error } = await supabase.auth.signUp({
  email: formData.email,
  password: formData.password,
  options: {
    data: {
      full_name: formData.full_name,
      phone: formData.phone,
    },
  },
});

// 3. Database trigger auto creates profile
// Trigger: create_profile_for_new_user()
// INSERT INTO profiles (id, full_name, email, phone)

// 4. Auto login (if email confirmation is disabled)
// User is automatically logged in

// 5. Redirect to dashboard
navigate('/dashboard');
```

### UI Components

**Register Page** (`/pages/auth/Register.tsx`)

```typescript
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useAuth } from '@/hooks/useAuth';

const registerSchema = z.object({
  full_name: z.string().min(1, 'Vui lòng nhập họ tên'),
  phone: z.string().regex(/^[0-9]{10,11}$/, 'SĐT không hợp lệ'),
  email: z.string().email('Email không hợp lệ'),
  password: z.string().min(6, 'Mật khẩu ít nhất 6 ký tự'),
  confirm_password: z.string()
}).refine((data) => data.password === data.confirm_password, {
  message: "Mật khẩu không khớp",
  path: ["confirm_password"],
});

type RegisterFormData = z.infer<typeof registerSchema>;

export function Register() {
  const { register: signUp, isLoading } = useAuth();
  const navigate = useNavigate();

  const {
    register,
    handleSubmit,
    formState: { errors }
  } = useForm<RegisterFormData>({
    resolver: zodResolver(registerSchema)
  });

  const onSubmit = async (data: RegisterFormData) => {
    try {
      await signUp(data);
      toast.success('Đăng ký thành công!');
      navigate('/dashboard');
    } catch (error) {
      toast.error(error.message);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50">
      <div className="max-w-md w-full bg-white rounded-lg shadow-lg p-8">
        <h1 className="text-2xl font-bold text-center mb-6">
          Đăng ký tài khoản
        </h1>

        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
          <div>
            <Label htmlFor="full_name">Họ tên *</Label>
            <Input
              id="full_name"
              {...register('full_name')}
              placeholder="Nguyễn Văn A"
            />
            {errors.full_name && (
              <p className="text-sm text-red-500 mt-1">
                {errors.full_name.message}
              </p>
            )}
          </div>

          <div>
            <Label htmlFor="phone">Số điện thoại *</Label>
            <Input
              id="phone"
              {...register('phone')}
              placeholder="0901234567"
            />
            {errors.phone && (
              <p className="text-sm text-red-500 mt-1">
                {errors.phone.message}
              </p>
            )}
          </div>

          <div>
            <Label htmlFor="email">Email *</Label>
            <Input
              id="email"
              type="email"
              {...register('email')}
              placeholder="user@example.com"
            />
            {errors.email && (
              <p className="text-sm text-red-500 mt-1">
                {errors.email.message}
              </p>
            )}
          </div>

          <div>
            <Label htmlFor="password">Mật khẩu *</Label>
            <Input
              id="password"
              type="password"
              {...register('password')}
              placeholder="Ít nhất 6 ký tự"
            />
            {errors.password && (
              <p className="text-sm text-red-500 mt-1">
                {errors.password.message}
              </p>
            )}
          </div>

          <div>
            <Label htmlFor="confirm_password">Xác nhận mật khẩu *</Label>
            <Input
              id="confirm_password"
              type="password"
              {...register('confirm_password')}
              placeholder="Nhập lại mật khẩu"
            />
            {errors.confirm_password && (
              <p className="text-sm text-red-500 mt-1">
                {errors.confirm_password.message}
              </p>
            )}
          </div>

          <Button
            type="submit"
            className="w-full"
            disabled={isLoading}
          >
            {isLoading ? 'Đang xử lý...' : 'Đăng ký'}
          </Button>
        </form>

        <div className="mt-4 text-center">
          <p className="text-sm text-gray-600">
            Đã có tài khoản?{' '}
            <Link to="/login" className="text-blue-600 hover:underline">
              Đăng nhập
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
}
```

---

## 🔐 FLOW ĐĂNG NHẬP

### User Journey

```
Vào trang đăng nhập
      │
      ├─→ Nhập thông tin:
      │   ├─ Số điện thoại hoặc Email
      │   └─ Mật khẩu
      │
      ├─→ Validate form
      │
      ├─→ Submit form
      │   ├─ Gọi Supabase signInWithPassword()
      │   └─ Xác thực credentials
      │
      ├─→ Thành công
      │   ├─ Lưu session
      │   └─ Redirect → Dashboard
      │
      └─→ Thất bại
          └─ Hiển thị lỗi "SĐT/Email hoặc mật khẩu không đúng"
```

### API Flow

```typescript
// 1. User submits login form
const formData = {
  identifier: "0901234567", // or email
  password: "password123"
};

// 2. Detect if identifier is email or phone
const isEmail = /\S+@\S+\.\S+/.test(formData.identifier);

// 3. If phone, lookup email from profiles table
let email = formData.identifier;
if (!isEmail) {
  const { data: profile } = await supabase
    .from('profiles')
    .select('email')
    .eq('phone', formData.identifier)
    .single();

  if (!profile) {
    throw new Error('Số điện thoại không tồn tại');
  }
  email = profile.email;
}

// 4. Sign in with email
const { data, error } = await supabase.auth.signInWithPassword({
  email,
  password: formData.password,
});

// 5. Redirect
navigate('/dashboard');
```

### UI Components

**Login Page** (`/pages/auth/Login.tsx`)

```typescript
const loginSchema = z.object({
  identifier: z.string().min(1, 'Vui lòng nhập SĐT hoặc Email'),
  password: z.string().min(1, 'Vui lòng nhập mật khẩu'),
});

type LoginFormData = z.infer<typeof loginSchema>;

export function Login() {
  const { login, isLoading } = useAuth();
  const navigate = useNavigate();

  const {
    register,
    handleSubmit,
    formState: { errors }
  } = useForm<LoginFormData>({
    resolver: zodResolver(loginSchema)
  });

  const onSubmit = async (data: LoginFormData) => {
    try {
      await login(data.identifier, data.password);
      toast.success('Đăng nhập thành công!');
      navigate('/dashboard');
    } catch (error) {
      toast.error('SĐT/Email hoặc mật khẩu không đúng');
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50">
      <div className="max-w-md w-full bg-white rounded-lg shadow-lg p-8">
        <h1 className="text-2xl font-bold text-center mb-6">
          Đăng nhập
        </h1>

        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
          <div>
            <Label htmlFor="identifier">Số điện thoại hoặc Email</Label>
            <Input
              id="identifier"
              {...register('identifier')}
              placeholder="0901234567 hoặc user@example.com"
            />
            {errors.identifier && (
              <p className="text-sm text-red-500 mt-1">
                {errors.identifier.message}
              </p>
            )}
          </div>

          <div>
            <Label htmlFor="password">Mật khẩu</Label>
            <Input
              id="password"
              type="password"
              {...register('password')}
              placeholder="Nhập mật khẩu"
            />
            {errors.password && (
              <p className="text-sm text-red-500 mt-1">
                {errors.password.message}
              </p>
            )}
          </div>

          <div className="flex items-center justify-between">
            <div className="flex items-center">
              <input
                id="remember"
                type="checkbox"
                className="h-4 w-4 text-blue-600"
              />
              <label htmlFor="remember" className="ml-2 text-sm text-gray-600">
                Ghi nhớ đăng nhập
              </label>
            </div>

            <Link
              to="/forgot-password"
              className="text-sm text-blue-600 hover:underline"
            >
              Quên mật khẩu?
            </Link>
          </div>

          <Button
            type="submit"
            className="w-full"
            disabled={isLoading}
          >
            {isLoading ? 'Đang xử lý...' : 'Đăng nhập'}
          </Button>
        </form>

        <div className="mt-4 text-center">
          <p className="text-sm text-gray-600">
            Chưa có tài khoản?{' '}
            <Link to="/register" className="text-blue-600 hover:underline">
              Đăng ký ngay
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
}
```

---

## 🔑 FLOW QUÊN MẬT KHẨU

### Phase 1: Basic Reset (Email)

```
Vào trang "Quên mật khẩu"
      │
      ├─→ Nhập Email
      │
      ├─→ Submit
      │   └─ Gọi Supabase resetPasswordForEmail()
      │
      ├─→ Supabase gửi email reset link
      │
      ├─→ User click link trong email
      │
      ├─→ Redirect đến trang đặt lại mật khẩu
      │
      ├─→ Nhập mật khẩu mới
      │
      └─→ Submit → Cập nhật mật khẩu
```

### Phase 2: OTP via Zalo/SMS (Future)

```
Vào trang "Quên mật khẩu"
      │
      ├─→ Nhập SĐT
      │
      ├─→ Submit
      │   ├─ Backend tạo OTP (6 số)
      │   ├─ Lưu OTP vào database (expire sau 5 phút)
      │   └─ Gửi OTP qua Zalo ZNS / SMS Brandname
      │
      ├─→ Nhập OTP
      │   └─ Validate OTP
      │
      ├─→ OTP đúng → Chuyển sang màn hình đặt mật khẩu mới
      │
      └─→ Nhập mật khẩu mới → Cập nhật
```

### UI Components

**Forgot Password Page** (`/pages/auth/ForgotPassword.tsx`)

```typescript
const forgotPasswordSchema = z.object({
  email: z.string().email('Email không hợp lệ'),
});

type ForgotPasswordFormData = z.infer<typeof forgotPasswordSchema>;

export function ForgotPassword() {
  const [emailSent, setEmailSent] = useState(false);
  const { resetPassword, isLoading } = useAuth();

  const {
    register,
    handleSubmit,
    formState: { errors }
  } = useForm<ForgotPasswordFormData>({
    resolver: zodResolver(forgotPasswordSchema)
  });

  const onSubmit = async (data: ForgotPasswordFormData) => {
    try {
      await resetPassword(data.email);
      setEmailSent(true);
      toast.success('Email đặt lại mật khẩu đã được gửi!');
    } catch (error) {
      toast.error('Có lỗi xảy ra. Vui lòng thử lại.');
    }
  };

  if (emailSent) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <div className="max-w-md w-full bg-white rounded-lg shadow-lg p-8 text-center">
          <div className="mb-4">
            <CheckCircle className="w-16 h-16 text-green-500 mx-auto" />
          </div>
          <h2 className="text-xl font-bold mb-2">
            Kiểm tra email của bạn
          </h2>
          <p className="text-gray-600 mb-4">
            Chúng tôi đã gửi link đặt lại mật khẩu đến email của bạn.
            Vui lòng kiểm tra hộp thư.
          </p>
          <Link to="/login">
            <Button>Quay lại đăng nhập</Button>
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50">
      <div className="max-w-md w-full bg-white rounded-lg shadow-lg p-8">
        <h1 className="text-2xl font-bold text-center mb-2">
          Quên mật khẩu
        </h1>
        <p className="text-gray-600 text-center mb-6">
          Nhập email của bạn để nhận link đặt lại mật khẩu
        </p>

        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
          <div>
            <Label htmlFor="email">Email</Label>
            <Input
              id="email"
              type="email"
              {...register('email')}
              placeholder="user@example.com"
            />
            {errors.email && (
              <p className="text-sm text-red-500 mt-1">
                {errors.email.message}
              </p>
            )}
          </div>

          <Button
            type="submit"
            className="w-full"
            disabled={isLoading}
          >
            {isLoading ? 'Đang xử lý...' : 'Gửi link đặt lại mật khẩu'}
          </Button>
        </form>

        <div className="mt-4 text-center">
          <Link
            to="/login"
            className="text-sm text-blue-600 hover:underline"
          >
            ← Quay lại đăng nhập
          </Link>
        </div>
      </div>
    </div>
  );
}
```

**Reset Password Page** (`/pages/auth/ResetPassword.tsx`)

```typescript
const resetPasswordSchema = z.object({
  password: z.string().min(6, 'Mật khẩu ít nhất 6 ký tự'),
  confirm_password: z.string()
}).refine((data) => data.password === data.confirm_password, {
  message: "Mật khẩu không khớp",
  path: ["confirm_password"],
});

export function ResetPassword() {
  const { updatePassword, isLoading } = useAuth();
  const navigate = useNavigate();

  const onSubmit = async (data) => {
    try {
      await updatePassword(data.password);
      toast.success('Đặt lại mật khẩu thành công!');
      navigate('/login');
    } catch (error) {
      toast.error('Có lỗi xảy ra. Vui lòng thử lại.');
    }
  };

  // Similar UI to Register password fields
}
```

---

## ⚙️ SUPABASE AUTH SETUP

### 1. Disable Email Confirmation (for faster development)

```
Supabase Dashboard
→ Authentication
→ Settings
→ Email Auth
→ Disable "Enable email confirmations"
```

### 2. Configure Redirect URLs

```
Supabase Dashboard
→ Authentication
→ Settings
→ Redirect URLs
→ Add: http://localhost:5173/auth/callback
→ Add: https://yourdomain.com/auth/callback
```

### 3. Email Templates (for password reset)

```
Supabase Dashboard
→ Authentication
→ Email Templates
→ Reset Password
→ Customize template
```

### 4. Create profile trigger

```sql
-- Auto create profile when user signs up
CREATE OR REPLACE FUNCTION create_profile_for_new_user()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO profiles (id, full_name, email, phone)
  VALUES (
    NEW.id,
    COALESCE(NEW.raw_user_meta_data->>'full_name', ''),
    NEW.email,
    COALESCE(NEW.raw_user_meta_data->>'phone', '')
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION create_profile_for_new_user();
```

---

## 💻 IMPLEMENTATION GUIDE

### 1. Setup Supabase Client

**File**: `src/lib/supabase.ts`

```typescript
import { createClient } from '@supabase/supabase-js';
import type { Database } from '@/types/database';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error('Missing Supabase environment variables');
}

export const supabase = createClient<Database>(supabaseUrl, supabaseAnonKey);
```

**File**: `.env`

```
VITE_SUPABASE_URL=https://xxx.supabase.co
VITE_SUPABASE_ANON_KEY=eyJxxx...
```

### 2. Create Auth Hook

**File**: `src/hooks/useAuth.ts`

```typescript
import { useState, useEffect, createContext, useContext } from 'react';
import { supabase } from '@/lib/supabase';
import type { User, Session } from '@supabase/supabase-js';

interface AuthContextType {
  user: User | null;
  session: Session | null;
  loading: boolean;
  signUp: (data: SignUpData) => Promise<void>;
  signIn: (identifier: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
  resetPassword: (email: string) => Promise<void>;
  updatePassword: (newPassword: string) => Promise<void>;
}

interface SignUpData {
  full_name: string;
  phone: string;
  email: string;
  password: string;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // Get initial session
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session);
      setUser(session?.user ?? null);
      setLoading(false);
    });

    // Listen for auth changes
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      setSession(session);
      setUser(session?.user ?? null);
    });

    return () => subscription.unsubscribe();
  }, []);

  const signUp = async (data: SignUpData) => {
    const { error } = await supabase.auth.signUp({
      email: data.email,
      password: data.password,
      options: {
        data: {
          full_name: data.full_name,
          phone: data.phone,
        },
      },
    });

    if (error) throw error;
  };

  const signIn = async (identifier: string, password: string) => {
    // Check if identifier is email or phone
    const isEmail = /\S+@\S+\.\S+/.test(identifier);
    let email = identifier;

    if (!isEmail) {
      // Lookup email by phone
      const { data: profile, error } = await supabase
        .from('profiles')
        .select('email')
        .eq('phone', identifier)
        .single();

      if (error || !profile) {
        throw new Error('Số điện thoại không tồn tại');
      }

      email = profile.email;
    }

    const { error } = await supabase.auth.signInWithPassword({
      email,
      password,
    });

    if (error) throw error;
  };

  const signOut = async () => {
    const { error } = await supabase.auth.signOut();
    if (error) throw error;
  };

  const resetPassword = async (email: string) => {
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}/reset-password`,
    });

    if (error) throw error;
  };

  const updatePassword = async (newPassword: string) => {
    const { error } = await supabase.auth.updateUser({
      password: newPassword,
    });

    if (error) throw error;
  };

  const value = {
    user,
    session,
    loading,
    signUp,
    signIn,
    signOut,
    resetPassword,
    updatePassword,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}
```

### 3. Protected Route Component

**File**: `src/components/ProtectedRoute.tsx`

```typescript
import { Navigate, Outlet } from 'react-router-dom';
import { useAuth } from '@/hooks/useAuth';
import { Loader2 } from 'lucide-react';

export function ProtectedRoute() {
  const { user, loading } = useAuth();

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin" />
      </div>
    );
  }

  if (!user) {
    return <Navigate to="/login" replace />;
  }

  return <Outlet />;
}
```

### 4. Setup Routes

**File**: `src/App.tsx`

```typescript
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider } from '@/hooks/useAuth';
import { ProtectedRoute } from '@/components/ProtectedRoute';
import { Login } from '@/pages/auth/Login';
import { Register } from '@/pages/auth/Register';
import { ForgotPassword } from '@/pages/auth/ForgotPassword';
import { ResetPassword } from '@/pages/auth/ResetPassword';
import { Dashboard } from '@/pages/dashboard/Dashboard';

function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <Routes>
          {/* Public routes */}
          <Route path="/login" element={<Login />} />
          <Route path="/register" element={<Register />} />
          <Route path="/forgot-password" element={<ForgotPassword />} />
          <Route path="/reset-password" element={<ResetPassword />} />

          {/* Protected routes */}
          <Route element={<ProtectedRoute />}>
            <Route path="/dashboard" element={<Dashboard />} />
            {/* Add more protected routes here */}
          </Route>

          {/* Redirect */}
          <Route path="/" element={<Navigate to="/dashboard" replace />} />
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  );
}

export default App;
```

### 5. Add to main.tsx

**File**: `src/main.tsx`

```typescript
import React from 'react';
import ReactDOM from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Toaster } from 'sonner';
import App from './App';
import './index.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 60 * 1000, // 1 minute
      refetchOnWindowFocus: false,
    },
  },
});

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
      <Toaster position="top-right" richColors />
    </QueryClientProvider>
  </React.StrictMode>
);
```

---

## 🧪 TESTING

### Manual Testing Checklist

**Đăng ký**:
- [ ] Form validation hoạt động đúng
- [ ] Hiển thị lỗi khi email đã tồn tại
- [ ] Hiển thị lỗi khi SĐT không hợp lệ
- [ ] Tự động đăng nhập sau khi đăng ký
- [ ] Redirect đến dashboard
- [ ] Profile được tạo tự động trong database

**Đăng nhập**:
- [ ] Đăng nhập với email thành công
- [ ] Đăng nhập với SĐT thành công
- [ ] Hiển thị lỗi khi sai mật khẩu
- [ ] Hiển thị lỗi khi SĐT/Email không tồn tại
- [ ] Remember me hoạt động
- [ ] Redirect đến dashboard

**Quên mật khẩu**:
- [ ] Email reset được gửi thành công
- [ ] Link reset hoạt động
- [ ] Cập nhật mật khẩu mới thành công
- [ ] Đăng nhập với mật khẩu mới thành công

**Protected Routes**:
- [ ] Chuyển hướng đến /login khi chưa đăng nhập
- [ ] Hiển thị trang khi đã đăng nhập
- [ ] Session persist sau khi refresh

**Đăng xuất**:
- [ ] Đăng xuất thành công
- [ ] Session bị xóa
- [ ] Redirect đến /login

### Test with Supabase

```typescript
// Test sign up
const testSignUp = async () => {
  const { data, error } = await supabase.auth.signUp({
    email: 'test@example.com',
    password: 'password123',
    options: {
      data: {
        full_name: 'Test User',
        phone: '0901234567',
      },
    },
  });

  console.log('Sign up:', { data, error });
};

// Test sign in
const testSignIn = async () => {
  const { data, error } = await supabase.auth.signInWithPassword({
    email: 'test@example.com',
    password: 'password123',
  });

  console.log('Sign in:', { data, error });
};

// Test get session
const testGetSession = async () => {
  const { data, error } = await supabase.auth.getSession();
  console.log('Session:', { data, error });
};

// Test sign out
const testSignOut = async () => {
  const { error } = await supabase.auth.signOut();
  console.log('Sign out:', { error });
};
```

---

## 📝 NOTES

### Security Best Practices
1. ✅ Sử dụng HTTPS trong production
2. ✅ Validate input ở cả client và server (RLS)
3. ✅ Hash passwords (Supabase tự động)
4. ✅ Implement rate limiting (Supabase built-in)
5. ✅ Use secure session storage
6. ✅ Implement CORS properly

### Error Handling
```typescript
// Centralized error handler
function handleAuthError(error: any) {
  if (error.message.includes('Invalid login credentials')) {
    return 'Email/SĐT hoặc mật khẩu không đúng';
  }
  if (error.message.includes('Email not confirmed')) {
    return 'Vui lòng xác nhận email trước khi đăng nhập';
  }
  if (error.message.includes('User already registered')) {
    return 'Email này đã được đăng ký';
  }
  return 'Có lỗi xảy ra. Vui lòng thử lại.';
}
```

### Session Management
- Session mặc định expire sau 1 giờ
- Refresh token tự động
- Persistent session với localStorage

---

## 🎯 NEXT STEPS

1. ✅ Complete auth implementation
2. 📄 Continue to [03-ASSET-MANAGEMENT.md](./03-ASSET-MANAGEMENT.md)
3. 🔜 Implement OTP (Phase 2)
4. 🔜 Add social login (Google, Facebook) - optional

---

**Last updated**: 2025-11-18
**Version**: 1.0.0
**Previous**: [01-DATABASE-SCHEMA.md](./01-DATABASE-SCHEMA.md) | **Next**: [03-ASSET-MANAGEMENT.md](./03-ASSET-MANAGEMENT.md)
