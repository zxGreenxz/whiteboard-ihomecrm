import { useState, useEffect } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useResetPassword } from '@/hooks/useAuth';
import { supabase } from '@/integrations/supabase/client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Building2, ArrowLeft, Eye, EyeOff, CheckCircle, AlertCircle, Lock } from 'lucide-react';

const ResetPassword = () => {
  const navigate = useNavigate();
  const [formData, setFormData] = useState({
    password: '',
    confirmPassword: '',
  });
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [isValidSession, setIsValidSession] = useState<boolean | null>(null);
  const [success, setSuccess] = useState(false);

  const resetPasswordMutation = useResetPassword();

  // Check if user has a valid session from the reset link
  useEffect(() => {
    const checkSession = async () => {
      const { data: { session } } = await supabase.auth.getSession();

      // Check for recovery event from URL hash
      const hashParams = new URLSearchParams(window.location.hash.substring(1));
      const accessToken = hashParams.get('access_token');
      const type = hashParams.get('type');

      if (type === 'recovery' && accessToken) {
        // Set the session from the recovery token
        const { error } = await supabase.auth.setSession({
          access_token: accessToken,
          refresh_token: hashParams.get('refresh_token') || '',
        });

        if (!error) {
          setIsValidSession(true);
          // Clear the hash from URL
          window.history.replaceState(null, '', window.location.pathname);
        } else {
          setIsValidSession(false);
        }
      } else if (session) {
        setIsValidSession(true);
      } else {
        setIsValidSession(false);
      }
    };

    checkSession();

    // Listen for auth state changes
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event) => {
      if (event === 'PASSWORD_RECOVERY') {
        setIsValidSession(true);
      }
    });

    return () => subscription.unsubscribe();
  }, []);

  const validatePassword = (password: string): string[] => {
    const issues: string[] = [];
    if (password.length < 8) issues.push('Ít nhất 8 ký tự');
    if (!/[A-Z]/.test(password)) issues.push('Ít nhất 1 chữ hoa');
    if (!/[a-z]/.test(password)) issues.push('Ít nhất 1 chữ thường');
    if (!/[0-9]/.test(password)) issues.push('Ít nhất 1 số');
    return issues;
  };

  const getPasswordStrength = (password: string): { strength: number; label: string; color: string } => {
    const issues = validatePassword(password);
    const score = 4 - issues.length;

    if (score <= 1) return { strength: 25, label: 'Yếu', color: 'bg-red-500' };
    if (score === 2) return { strength: 50, label: 'Trung bình', color: 'bg-orange-500' };
    if (score === 3) return { strength: 75, label: 'Khá', color: 'bg-yellow-500' };
    return { strength: 100, label: 'Mạnh', color: 'bg-green-500' };
  };

  const validateForm = () => {
    const newErrors: Record<string, string> = {};
    const passwordIssues = validatePassword(formData.password);

    if (!formData.password) {
      newErrors.password = 'Mật khẩu không được để trống';
    } else if (passwordIssues.length > 0) {
      newErrors.password = `Mật khẩu phải có: ${passwordIssues.join(', ')}`;
    }

    if (!formData.confirmPassword) {
      newErrors.confirmPassword = 'Vui lòng xác nhận mật khẩu';
    } else if (formData.password !== formData.confirmPassword) {
      newErrors.confirmPassword = 'Mật khẩu xác nhận không khớp';
    }

    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();

    if (!validateForm()) return;

    resetPasswordMutation.mutate(
      { password: formData.password },
      {
        onSuccess: () => {
          setSuccess(true);
        },
      }
    );
  };

  const handleChange = (field: string, value: string) => {
    setFormData((prev) => ({ ...prev, [field]: value }));
    if (errors[field]) {
      setErrors((prev) => ({ ...prev, [field]: '' }));
    }
  };

  const passwordStrength = getPasswordStrength(formData.password);

  // Loading state
  if (isValidSession === null) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-blue-50 to-indigo-100 p-4">
        <Card className="w-full max-w-md">
          <CardContent className="pt-6">
            <div className="flex flex-col items-center space-y-4">
              <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent"></div>
              <p className="text-gray-600">Đang xác thực...</p>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  // Invalid or expired session
  if (isValidSession === false) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-blue-50 to-indigo-100 p-4">
        <Card className="w-full max-w-md">
          <CardHeader className="space-y-1">
            <div className="flex items-center justify-center mb-4">
              <div className="h-12 w-12 rounded-full bg-red-100 flex items-center justify-center">
                <AlertCircle className="h-6 w-6 text-red-600" />
              </div>
            </div>
            <CardTitle className="text-2xl font-bold text-center">
              Link không hợp lệ
            </CardTitle>
            <CardDescription className="text-center">
              Link đặt lại mật khẩu không hợp lệ hoặc đã hết hạn
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 text-sm text-amber-800">
              <p className="font-medium mb-1">Nguyên nhân có thể:</p>
              <ul className="list-disc list-inside space-y-1">
                <li>Link đã được sử dụng trước đó</li>
                <li>Link đã hết hạn (sau 1 giờ)</li>
                <li>Link không đúng định dạng</li>
              </ul>
            </div>
          </CardContent>
          <CardFooter className="flex flex-col space-y-2">
            <Link to="/forgot-password" className="w-full">
              <Button className="w-full">
                Yêu cầu link mới
              </Button>
            </Link>
            <Link to="/login" className="w-full">
              <Button variant="ghost" className="w-full">
                <ArrowLeft className="h-4 w-4 mr-2" />
                Quay lại đăng nhập
              </Button>
            </Link>
          </CardFooter>
        </Card>
      </div>
    );
  }

  // Success state
  if (success) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-blue-50 to-indigo-100 p-4">
        <Card className="w-full max-w-md">
          <CardHeader className="space-y-1">
            <div className="flex items-center justify-center mb-4">
              <div className="h-12 w-12 rounded-full bg-green-100 flex items-center justify-center">
                <CheckCircle className="h-6 w-6 text-green-600" />
              </div>
            </div>
            <CardTitle className="text-2xl font-bold text-center">
              Đổi mật khẩu thành công!
            </CardTitle>
            <CardDescription className="text-center">
              Mật khẩu của bạn đã được cập nhật. Bạn có thể đăng nhập với mật khẩu mới.
            </CardDescription>
          </CardHeader>
          <CardFooter>
            <Button
              className="w-full"
              onClick={() => navigate('/login')}
            >
              Đăng nhập ngay
            </Button>
          </CardFooter>
        </Card>
      </div>
    );
  }

  // Reset password form
  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-blue-50 to-indigo-100 p-4">
      <Card className="w-full max-w-md">
        <CardHeader className="space-y-1">
          <div className="flex items-center justify-center mb-4">
            <div className="h-12 w-12 rounded-full bg-primary flex items-center justify-center">
              <Lock className="h-6 w-6 text-white" />
            </div>
          </div>
          <CardTitle className="text-2xl font-bold text-center">
            Đặt mật khẩu mới
          </CardTitle>
          <CardDescription className="text-center">
            Nhập mật khẩu mới cho tài khoản của bạn
          </CardDescription>
        </CardHeader>
        <form onSubmit={handleSubmit}>
          <CardContent className="space-y-4">
            {/* New Password */}
            <div className="space-y-2">
              <Label htmlFor="password">Mật khẩu mới</Label>
              <div className="relative">
                <Input
                  id="password"
                  type={showPassword ? 'text' : 'password'}
                  placeholder="Nhập mật khẩu mới"
                  value={formData.password}
                  onChange={(e) => handleChange('password', e.target.value)}
                  className={errors.password ? 'border-red-500' : ''}
                  autoComplete="new-password"
                  autoFocus
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-700"
                >
                  {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>

              {/* Password strength indicator */}
              {formData.password && (
                <div className="space-y-1">
                  <div className="flex gap-1">
                    {[1, 2, 3, 4].map((i) => (
                      <div
                        key={i}
                        className={`h-1 flex-1 rounded-full transition-colors ${
                          i <= passwordStrength.strength / 25
                            ? passwordStrength.color
                            : 'bg-gray-200'
                        }`}
                      />
                    ))}
                  </div>
                  <p className={`text-xs ${
                    passwordStrength.strength === 100 ? 'text-green-600' : 'text-gray-500'
                  }`}>
                    Độ mạnh: {passwordStrength.label}
                  </p>
                </div>
              )}

              {errors.password && <p className="text-sm text-red-500">{errors.password}</p>}
            </div>

            {/* Confirm Password */}
            <div className="space-y-2">
              <Label htmlFor="confirmPassword">Xác nhận mật khẩu</Label>
              <div className="relative">
                <Input
                  id="confirmPassword"
                  type={showConfirmPassword ? 'text' : 'password'}
                  placeholder="Nhập lại mật khẩu mới"
                  value={formData.confirmPassword}
                  onChange={(e) => handleChange('confirmPassword', e.target.value)}
                  className={errors.confirmPassword ? 'border-red-500' : ''}
                  autoComplete="new-password"
                />
                <button
                  type="button"
                  onClick={() => setShowConfirmPassword(!showConfirmPassword)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-700"
                >
                  {showConfirmPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>

              {/* Match indicator */}
              {formData.confirmPassword && (
                <p className={`text-xs flex items-center gap-1 ${
                  formData.password === formData.confirmPassword
                    ? 'text-green-600'
                    : 'text-red-500'
                }`}>
                  {formData.password === formData.confirmPassword ? (
                    <>
                      <CheckCircle className="h-3 w-3" />
                      Mật khẩu khớp
                    </>
                  ) : (
                    <>
                      <AlertCircle className="h-3 w-3" />
                      Mật khẩu không khớp
                    </>
                  )}
                </p>
              )}

              {errors.confirmPassword && (
                <p className="text-sm text-red-500">{errors.confirmPassword}</p>
              )}
            </div>

            {/* Password requirements */}
            <div className="bg-gray-50 border border-gray-200 rounded-lg p-3 text-sm text-gray-600">
              <p className="font-medium mb-2">Yêu cầu mật khẩu:</p>
              <ul className="space-y-1">
                {[
                  { check: formData.password.length >= 8, text: 'Ít nhất 8 ký tự' },
                  { check: /[A-Z]/.test(formData.password), text: 'Ít nhất 1 chữ hoa (A-Z)' },
                  { check: /[a-z]/.test(formData.password), text: 'Ít nhất 1 chữ thường (a-z)' },
                  { check: /[0-9]/.test(formData.password), text: 'Ít nhất 1 số (0-9)' },
                ].map((req, index) => (
                  <li key={index} className={`flex items-center gap-2 ${
                    formData.password ? (req.check ? 'text-green-600' : 'text-gray-500') : 'text-gray-500'
                  }`}>
                    {formData.password && req.check ? (
                      <CheckCircle className="h-3 w-3" />
                    ) : (
                      <div className="h-3 w-3 rounded-full border border-current" />
                    )}
                    {req.text}
                  </li>
                ))}
              </ul>
            </div>
          </CardContent>

          <CardFooter className="flex flex-col space-y-4">
            <Button
              type="submit"
              className="w-full"
              disabled={resetPasswordMutation.isPending}
            >
              {resetPasswordMutation.isPending ? 'Đang cập nhật...' : 'Đặt mật khẩu mới'}
            </Button>

            <Link to="/login" className="w-full">
              <Button variant="ghost" className="w-full">
                <ArrowLeft className="h-4 w-4 mr-2" />
                Quay lại đăng nhập
              </Button>
            </Link>
          </CardFooter>
        </form>
      </Card>
    </div>
  );
};

export default ResetPassword;
