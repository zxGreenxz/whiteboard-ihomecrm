import React, { Component, ErrorInfo, ReactNode } from 'react';
import { AlertTriangle, RefreshCcw, Home } from 'lucide-react';
import { Button } from './ui/button';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from './ui/card';
import { Alert, AlertDescription, AlertTitle } from './ui/alert';

// =============================================
// TYPES
// =============================================

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
  onReset?: () => void;
}

interface State {
  hasError: boolean;
  error: Error | null;
  errorInfo: ErrorInfo | null;
}

// =============================================
// ERROR BOUNDARY COMPONENT
// =============================================

class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = {
      hasError: false,
      error: null,
      errorInfo: null,
    };
  }

  static getDerivedStateFromError(error: Error): State {
    // Update state so the next render will show the fallback UI
    return {
      hasError: true,
      error,
      errorInfo: null,
    };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    // Log error to console for debugging
    console.error('ErrorBoundary caught an error:', error, errorInfo);

    // Update state with error details
    this.setState({
      error,
      errorInfo,
    });

    // TODO: Log error to error reporting service (e.g., Sentry, LogRocket)
    // logErrorToService(error, errorInfo);
  }

  handleReset = () => {
    // Reset error state
    this.setState({
      hasError: false,
      error: null,
      errorInfo: null,
    });

    // Call optional reset callback
    if (this.props.onReset) {
      this.props.onReset();
    }
  };

  handleGoHome = () => {
    // Reset error and navigate to home
    this.handleReset();
    window.location.href = '/';
  };

  render() {
    if (this.state.hasError) {
      // Custom fallback UI
      if (this.props.fallback) {
        return this.props.fallback;
      }

      // Default fallback UI
      return (
        <div className="min-h-screen flex items-center justify-center bg-muted/30 p-4">
          <Card className="max-w-2xl w-full">
            <CardHeader>
              <div className="flex items-center gap-3">
                <div className="h-12 w-12 rounded-full bg-destructive/10 flex items-center justify-center">
                  <AlertTriangle className="h-6 w-6 text-destructive" />
                </div>
                <div>
                  <CardTitle className="text-2xl">Đã xảy ra lỗi</CardTitle>
                  <CardDescription>
                    Ứng dụng gặp sự cố không mong muốn
                  </CardDescription>
                </div>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              <Alert variant="destructive">
                <AlertTriangle className="h-4 w-4" />
                <AlertTitle>Thông báo lỗi</AlertTitle>
                <AlertDescription>
                  {this.state.error?.message || 'Lỗi không xác định'}
                </AlertDescription>
              </Alert>

              {process.env.NODE_ENV === 'development' && this.state.errorInfo && (
                <details className="text-sm">
                  <summary className="cursor-pointer font-medium mb-2 hover:underline">
                    Chi tiết lỗi (Development only)
                  </summary>
                  <div className="mt-2 p-4 bg-muted rounded-lg overflow-auto">
                    <pre className="text-xs whitespace-pre-wrap">
                      {this.state.error?.stack}
                    </pre>
                    <div className="mt-4 pt-4 border-t">
                      <p className="font-medium mb-2">Component Stack:</p>
                      <pre className="text-xs whitespace-pre-wrap">
                        {this.state.errorInfo.componentStack}
                      </pre>
                    </div>
                  </div>
                </details>
              )}

              <div className="space-y-2 text-sm text-muted-foreground">
                <p>Vui lòng thử các bước sau:</p>
                <ul className="list-disc list-inside space-y-1 ml-2">
                  <li>Tải lại trang</li>
                  <li>Xóa cache trình duyệt</li>
                  <li>Đăng nhập lại</li>
                  <li>Liên hệ hỗ trợ nếu lỗi vẫn tiếp tục</li>
                </ul>
              </div>
            </CardContent>
            <CardFooter className="flex gap-3">
              <Button onClick={this.handleReset} variant="default">
                <RefreshCcw className="h-4 w-4 mr-2" />
                Thử lại
              </Button>
              <Button onClick={this.handleGoHome} variant="outline">
                <Home className="h-4 w-4 mr-2" />
                Về trang chủ
              </Button>
            </CardFooter>
          </Card>
        </div>
      );
    }

    // No error, render children normally
    return this.props.children;
  }
}

export default ErrorBoundary;

// =============================================
// HELPER COMPONENTS
// =============================================

/**
 * Simple Error Fallback for inline usage
 */
export const SimpleErrorFallback = ({ error, reset }: { error: Error; reset?: () => void }) => (
  <div className="p-6 text-center">
    <AlertTriangle className="h-12 w-12 text-destructive mx-auto mb-4" />
    <h3 className="text-lg font-semibold mb-2">Đã xảy ra lỗi</h3>
    <p className="text-sm text-muted-foreground mb-4">{error.message}</p>
    {reset && (
      <Button onClick={reset} size="sm">
        <RefreshCcw className="h-4 w-4 mr-2" />
        Thử lại
      </Button>
    )}
  </div>
);
