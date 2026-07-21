import { Navigate } from 'react-router-dom';
import { useAuth } from '@/hooks/useAuth';
import { Loader2 } from 'lucide-react';
import { isAuthBootstrapTimeoutError } from '@/lib/authBootstrap';

interface PublicRouteProps {
  children: React.ReactNode;
}

/**
 * PublicRoute component
 *
 * For pages that should only be accessible when NOT authenticated
 * (like login, register, forgot password).
 * If user is already authenticated, redirects to home page.
 */
const PublicRoute = ({ children }: PublicRouteProps) => {
  const { data: user, isLoading, isFetching, error, refetch } = useAuth();

  if (user) {
    return <Navigate to="/" replace />;
  }

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

  return <>{children}</>;
};

export default PublicRoute;
