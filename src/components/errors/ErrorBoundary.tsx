import React, { Component, ErrorInfo, ReactNode } from "react";
import { AlertTriangle, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { RefreshBar } from "@/components/loading/LoadingState";
import {
  isChunkLoadError,
  reloadOnceForStaleChunk,
  hasAutoReloadBudget,
  isReloadPending,
  reloadBustingChunkCache,
} from "@/lib/chunkReload";
import { reportBoundaryError } from "./boundaryReporter";

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
  pageName?: string;
}

interface State {
  hasError: boolean;
  error: Error | null;
  errorInfo: ErrorInfo | null;
  isChunkError: boolean;
  resolvedPageName: string | null;
  // Lỗi chunk-load còn "ngân sách" auto-reload → sẽ tự tải lại, hiện spinner
  // thay vì thẻ lỗi để không chớp cảnh báo ngay trước khi trang tự hồi phục.
  willAutoReload: boolean;
}

class ErrorBoundary extends Component<Props, State> {
  public override state: State = {
    hasError: false,
    error: null,
    errorInfo: null,
    isChunkError: false,
    resolvedPageName: null,
    willAutoReload: false,
  };

  public static getDerivedStateFromError(error: Error): State {
    const chunk = isChunkLoadError(error);
    return {
      hasError: true,
      error,
      errorInfo: null,
      isChunkError: chunk,
      resolvedPageName: null,
      willAutoReload: chunk && hasAutoReloadBudget(),
    };
  }

  public override componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    // Báo TRƯỚC nhánh chunk-error: lỗi chunk dẫn tới reload, và sau reload thì
    // không còn gì để kể lại. Ô cắm rỗng ở mọi màn hình không đăng ký nhận.
    reportBoundaryError(error, errorInfo);

    // Chunk lazy 404/poisoned sau deploy mới (Vite emit bare import() cho chunk
    // không có dep nên không qua vite:preloadError) → bust cache độc + reload lấy
    // bản mới. Truyền `error` để rút URL chunk hỏng mà bust đúng entry.
    if (isChunkLoadError(error)) {
      if (reloadOnceForStaleChunk(error)) return;
      // Hết lượt / privacy mode: chuyển sang nút tải lại thủ công.
      this.setState({ willAutoReload: false });
      this.resolvePageName();
      return;
    }
    console.error("ErrorBoundary caught an error:", error, errorInfo);
    this.setState({ errorInfo });
    this.resolvePageName();
  }

  private resolvePageName = () => {
    if ((this.props.pageName !== undefined && this.props.pageName !== null) || this.props.fallback) return;
    const path = typeof window === 'undefined' ? '' : window.location.pathname;
    void import('@/lib/errorPageNames')
      .then(({ errorPageName }) => { this.setState({ resolvedPageName: errorPageName(path) }); })
      .catch(() => { this.setState({ resolvedPageName: 'đang mở' }); });
  };

  private handleRefresh = () => {
    window.location.reload();
  };

  // Thẻ lỗi chunk: reload trần dùng lại 404/HTML độc còn trong cache → bust trước.
  // Hiện vạch "Đang tải…" trong lúc chờ, như lượt tự động.
  private handleChunkRefresh = () => {
    reloadBustingChunkCache(this.state.error);
    this.setState({ willAutoReload: true });
  };

  private handleGoHome = () => {
    window.location.href = "/";
  };

  public override render() {
    const pageName = this.props.pageName ?? this.state.resolvedPageName ?? 'đang mở';
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback;
      }

      // Đang tự cứu (retry import / bust-cache + reload đã lên lịch): nền trơn
      // + vạch mảnh mép trên thay vì chớp thẻ lỗi; chữ chỉ cho trình đọc màn hình
      // (chủ chốt 02/10/2026). `isReloadPending()` bắt cả khi reload được lên lịch
      // từ vite:preloadError (main.tsx) mà một lỗi khác vẫn nổi lên boundary.
      if (this.state.willAutoReload || isReloadPending()) {
        return (
          <div className="relative min-h-screen bg-gray-50">
            <RefreshBar active label="Đang tải…" />
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
              <h1 className="text-xl font-bold text-gray-900 mb-2">Chưa tải được trang {pageName}.</h1>
              <p className="text-gray-600 mb-4">
                Chưa tải đủ nội dung để mở trang. Bạn có thể tải lại để tiếp tục.
              </p>
              <div className="flex justify-center">
                <Button onClick={this.handleChunkRefresh}>
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
              Chưa mở được trang {pageName}.
            </h1>
            <p className="text-gray-600 mb-4">
              Nội dung trang chưa hiển thị được. Bạn có thể tải lại hoặc quay về trang chủ.
            </p>

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
