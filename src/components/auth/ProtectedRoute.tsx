import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '@/hooks/useAuth';
import { LoadingState } from '@/components/loading/LoadingState';
import { isAuthBootstrapTimeoutError } from '@/lib/authBootstrap';
import { safeAuthRedirect } from '@/lib/authRedirect';

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
    // Đang khôi phục phiên: khối xám, không vòng xoay + chữ "Đang tải…" (chủ chốt
    // 02/10/2026); câu đó chỉ còn cho trình đọc màn hình. Hết hạn chờ thì useAuth
    // trả lỗi và màn "Chưa thể kiểm tra phiên đăng nhập" bên dưới hiện ra.
    return (
      <div className="min-h-screen p-6">
        {/* Không có nút Thử lại lúc 8 s: bấm sẽ huỷ lượt getSession đang chạy và đếm lại hạn chờ;
            quá hạn thì màn "Chưa thể kiểm tra phiên" bên dưới đã có nút riêng (review PR #116). */}
        <LoadingState label="phiên đăng nhập" variant="detail" rows={6} className="mx-auto w-full max-w-4xl" />
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

  // Keep the destination through a document reload as well as SPA navigation.
  const next = safeAuthRedirect(location.pathname + location.search + location.hash) ?? '/';
  return <Navigate to={`/login?next=${encodeURIComponent(next)}`} state={{ from: location }} replace />;
};

export default ProtectedRoute;
