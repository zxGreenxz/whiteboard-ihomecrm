import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '@/hooks/useAuth';
import { Loader2 } from 'lucide-react';
import { isAuthBootstrapTimeoutError } from '@/lib/authBootstrap';

interface ProtectedRouteProps {
  children: React.ReactNode;
}

/**
 * ProtectedRoute component
 *
 * Protects routes that require authentication.
 * If user is not authenticated, redirects to login page.
 * Shows loading state while checking authentication.
 */
const ProtectedRoute = ({ children }: ProtectedRouteProps) => {
  const { data: user, isLoading, isFetching, error, refetch } = useAuth();
  const location = useLocation();

  if (user) return <>{children}</>;

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-center">
          <Loader2 className="h-8 w-8 animate-spin text-primary mx-auto" />
          <p className="mt-2 text-sm text-gray-600">Đang tải...</p>
        </div>
      </div>
    );
  }

  if (error) {
    const timedOut = isAuthBootstrapTimeoutError(error);
    return (
      <div className="min-h-screen flex items-center justify-center px-6">
        <div className="max-w-sm text-center">
          <h1 className="text-lg font-semibold">Chưa thể kiểm tra phiên đăng nhập</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            {timedOut
              ? 'Ứng dụng mất quá nhiều thời gian để khôi phục phiên. Dữ liệu đăng nhập vẫn được giữ nguyên.'
              : 'Có lỗi khi khôi phục phiên đăng nhập. Vui lòng thử lại.'}
          </p>
          <div className="mt-4 flex justify-center gap-2">
            <button
              type="button"
              className="rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground disabled:opacity-60"
              disabled={isFetching}
              onClick={() => void refetch()}
            >
              {isFetching ? 'Đang thử lại…' : 'Thử lại'}
            </button>
            <button
              type="button"
              className="rounded-md border px-4 py-2 text-sm"
              onClick={() => window.location.reload()}
            >
              Tải lại ứng dụng
            </button>
          </div>
        </div>
      </div>
    );
  }

  // Save the attempted location for redirecting after login.
  return <Navigate to="/login" state={{ from: location }} replace />;
};

export default ProtectedRoute;
