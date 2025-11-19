import { Navigate } from 'react-router-dom';
import { useAuth } from '@/hooks/useAuth';
import { Loader2 } from 'lucide-react';

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
  const { data: user, isLoading } = useAuth();

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

  if (user) {
    // User is already authenticated, redirect to home
    return <Navigate to="/" replace />;
  }

  return <>{children}</>;
};

export default PublicRoute;
