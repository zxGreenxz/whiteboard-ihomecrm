import { AlertTriangle, ArrowLeft, Building2, Network } from "lucide-react";
import { Link } from "react-router-dom";

import { LoadingState } from "@/components/loading/LoadingState";
import { Button } from "@/components/ui/button";

/**
 * Chờ dữ liệu lần đầu (quyền, toà nhà, đội máy): khung trang — nút về iHomeCRM + tiêu đề —
 * hiện ngay, phần dữ liệu là khối xám; không chữ "Đang tải" (chủ chốt 02/10/2026).
 * Chưa dựng được NetworkCenterShell vì nó cần danh sách toà nhà.
 */
export function NetworkCenterLoading() {
  return (
    <div className="network-center" aria-busy="true">
      <header className="nc-header">
        <div className="nc-header-brand">
          <Link to="/" className="nc-back-link">
            <ArrowLeft aria-hidden="true" />
            Về iHomeCRM
          </Link>
          <div className="nc-title-row">
            <span className="nc-brand-icon"><Network aria-hidden="true" /></span>
            <div>
              <p className="nc-eyebrow">iHomeCRM / vận hành</p>
              <h1>Trung tâm mạng</h1>
            </div>
          </div>
        </div>
      </header>
      <main className="nc-main">
        <LoadingState label="Trung tâm mạng" variant="table" rows={8} />
      </main>
    </div>
  );
}

/** Chờ dữ liệu một toà (đã ở trong NetworkCenterShell): chỉ khối xám trong vùng nội dung. */
export function NetworkCenterSectionLoading() {
  return <LoadingState label="dữ liệu toà nhà" variant="detail" rows={6} />;
}

export function NetworkCenterError({ retry }: { retry: () => void }) {
  return (
    <main className="network-center nc-state-page">
      <AlertTriangle aria-hidden="true" />
      <h1>Không tải được toà nhà</h1>
      <p>Network Center không tự tạo dữ liệu thay thế khi truy vấn toà nhà thất bại.</p>
      <Button onClick={retry}>Thử lại</Button>
      <Button asChild variant="outline"><Link to="/">← Về iHomeCRM</Link></Button>
    </main>
  );
}

export function NetworkCenterEmpty() {
  return (
    <main className="network-center nc-state-page">
      <Building2 aria-hidden="true" />
      <h1>Chưa có toà nhà vật lý</h1>
      <p>Trung tâm mạng chỉ hiển thị các toà thật mà tài khoản hiện tại được phép truy cập.</p>
      <Button asChild><Link to="/buildings">Mở danh mục toà nhà</Link></Button>
      <Button asChild variant="outline"><Link to="/">← Về iHomeCRM</Link></Button>
    </main>
  );
}

export function NetworkCenterNotFound({ building = false }: { building?: boolean }) {
  return (
    <section className="nc-state-card">
      <AlertTriangle aria-hidden="true" />
      <h2>{building ? "Không tìm thấy toà nhà" : "Không tìm thấy trang"}</h2>
      <p>{building
        ? "ID này không nằm trong danh sách toà nhà vật lý mà bạn được phép truy cập."
        : "Đường dẫn không thuộc Trung tâm mạng."}</p>
      <Button asChild><Link to="/network-center">Về danh sách mạng</Link></Button>
    </section>
  );
}
