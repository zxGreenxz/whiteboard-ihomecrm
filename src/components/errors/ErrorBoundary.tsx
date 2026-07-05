import React, { Component, ErrorInfo, ReactNode } from "react";
import { AlertTriangle, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  isChunkLoadError,
  reloadOnceForStaleChunk,
  hasAutoReloadBudget,
  isReloadPending,
} from "@/lib/chunkReload";

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
  errorInfo: ErrorInfo | null;
  isChunkError: boolean;
  // Lỗi chunk-load còn "ngân sách" auto-reload → sẽ tự tải lại, hiện spinner
  // thay vì thẻ lỗi để không chớp cảnh báo ngay trước khi trang tự hồi phục.
  willAutoReload: boolean;
}

class ErrorBoundary extends Component<Props, State> {
  public state: State = {
    hasError: false,
    error: null,
    errorInfo: null,
    isChunkError: false,
    willAutoReload: false,
  };

  public static getDerivedStateFromError(error: Error): State {
    const chunk = isChunkLoadError(error);
    return {
      hasError: true,
      error,
      errorInfo: null,
      isChunkError: chunk,
      willAutoReload: chunk && hasAutoReloadBudget(),
    };
  }

  public componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    // Chunk lazy 404/poisoned sau deploy mới (Vite emit bare import() cho chunk
    // không có dep nên không qua vite:preloadError) → bust cache độc + reload lấy
    // bản mới. Truyền `error` để rút URL chunk hỏng mà bust đúng entry.
    if (isChunkLoadError(error)) {
      if (reloadOnceForStaleChunk(error)) return;
      // Hết lượt / privacy mode → không auto-reload nữa: rơi về thẻ "Có phiên
      // bản mới" + nút Tải lại thủ công thay vì kẹt spinner vĩnh viễn.
      this.setState({ willAutoReload: false });
      return;
    }
    console.error("ErrorBoundary caught an error:", error, errorInfo);
    this.setState({ errorInfo });
  }

  private handleRefresh = () => {
    window.location.reload();
  };

  private handleGoHome = () => {
    window.location.href = "/";
  };

  public render() {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback;
      }

      // Đang tự cứu (retry import / bust-cache + reload đã lên lịch): hiện
      // spinner trung tính thay vì chớp thẻ lỗi. `isReloadPending()` bắt cả khi
      // reload được lên lịch từ vite:preloadError (main.tsx) mà một lỗi khác
      // vẫn nổi lên boundary trong lúc chờ reload.
      if (this.state.willAutoReload || isReloadPending()) {
        return (
          <div className="min-h-screen flex items-center justify-center bg-gray-50">
            <div className="text-center">
              <RefreshCw className="h-8 w-8 animate-spin text-blue-600 mx-auto" />
              <p className="mt-3 text-sm text-gray-600">Đang tải…</p>
            </div>
          </div>
        );
      }

      // Chunk lazy 404 sau deploy mà auto-reload đã hết lượt (hoặc privacy mode):
      // hiện thẻ thân thiện + nút "Tải lại" thủ công thay vì kẹt màn trắng.
      if (this.state.isChunkError) {
        return (
          <div className="min-h-screen flex items-center justify-center bg-gray-50 p-4">
            <div className="max-w-md w-full bg-white rounded-lg shadow-lg p-6 text-center">
              <div className="h-16 w-16 rounded-full bg-blue-100 flex items-center justify-center mx-auto mb-4">
                <RefreshCw className="h-8 w-8 text-blue-600" />
              </div>
              <h1 className="text-xl font-bold text-gray-900 mb-2">Có phiên bản mới</h1>
              <p className="text-gray-600 mb-4">
                Ứng dụng vừa được cập nhật. Hãy tải lại để dùng bản mới nhất.
              </p>
              <div className="flex justify-center">
                <Button onClick={this.handleRefresh}>
                  <RefreshCw className="h-4 w-4 mr-2" />
                  Tải lại
                </Button>
              </div>
            </div>
          </div>
        );
      }

      return (
        <div className="min-h-screen flex items-center justify-center bg-gray-50 p-4">
          <div className="max-w-md w-full bg-white rounded-lg shadow-lg p-6 text-center">
            <div className="h-16 w-16 rounded-full bg-red-100 flex items-center justify-center mx-auto mb-4">
              <AlertTriangle className="h-8 w-8 text-red-600" />
            </div>
            <h1 className="text-xl font-bold text-gray-900 mb-2">
              Đã xảy ra lỗi
            </h1>
            <p className="text-gray-600 mb-4">
              Rất tiếc, đã có lỗi xảy ra khi tải trang này. Vui lòng thử lại.
            </p>

            {process.env.NODE_ENV === "development" && this.state.error && (
              <div className="mb-4 p-3 bg-red-50 rounded-md text-left">
                <p className="text-sm font-mono text-red-800 break-all">
                  {this.state.error.toString()}
                </p>
                {this.state.errorInfo && (
                  <details className="mt-2">
                    <summary className="text-xs text-red-600 cursor-pointer">
                      Chi tiết lỗi
                    </summary>
                    <pre className="mt-2 text-xs text-red-700 overflow-auto max-h-40">
                      {this.state.errorInfo.componentStack}
                    </pre>
                  </details>
                )}
              </div>
            )}

            <div className="flex gap-3 justify-center">
              <Button variant="outline" onClick={this.handleGoHome}>
                Về trang chủ
              </Button>
              <Button onClick={this.handleRefresh}>
                <RefreshCw className="h-4 w-4 mr-2" />
                Tải lại
              </Button>
            </div>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

export default ErrorBoundary;
