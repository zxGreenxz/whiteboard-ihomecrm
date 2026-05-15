import { type ReactNode } from "react";
import { usePermission } from "@/hooks/usePermissions";

interface CanProps {
  resource: string;
  action: string;
  children: ReactNode;
  fallback?: ReactNode;
  // Khi true: render children disabled (cần caller xử lý prop disabled),
  // mặc định false = ẩn hoàn toàn theo quyết định "Ẩn hoàn toàn".
  showWhenDenied?: boolean;
}

// <Can resource="contracts" action="terminate">
//   <Button>Huỷ hợp đồng</Button>
// </Can>
//
// Trong khi đang load quyền, KHÔNG render children để tránh hiện thoáng
// nút cấm rồi mới ẩn — hành vi nhất quán với "ẩn hoàn toàn".
export const Can = ({ resource, action, children, fallback = null, showWhenDenied = false }: CanProps) => {
  const { allowed, loading } = usePermission(resource, action);
  if (loading) return null;
  if (!allowed) return showWhenDenied ? <>{children}</> : <>{fallback}</>;
  return <>{children}</>;
};

export default Can;
