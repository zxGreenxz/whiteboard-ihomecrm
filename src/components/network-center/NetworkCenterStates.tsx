import { AlertTriangle, Building2, LoaderCircle } from "lucide-react";
import { Link } from "react-router-dom";

import { Button } from "@/components/ui/button";

export function NetworkCenterLoading() {
  return (
    <main className="network-center nc-state-page" aria-busy="true">
      <LoaderCircle className="nc-spin" aria-hidden="true" />
      <h1>Đang tải Trung tâm mạng</h1>
      <p>Đang lấy danh sách toà nhà theo quyền RLS hiện tại.</p>
    </main>
  );
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
