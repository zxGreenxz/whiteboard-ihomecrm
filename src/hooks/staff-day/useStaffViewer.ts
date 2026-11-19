// Cờ ẩn/hiện giao diện cho các màn «xem theo người». Tách khỏi useStaffDay vì cửa route
// StaffDayViewerRoute nạp sớm, không được kéo zod và các biên nhận vào chunk đầu của app.
import { useIsCompanyOwner } from "@/hooks/useIsCompanyOwner";
import { useIsSuperAdmin } from "@/hooks/useIsAdmin";

export function useStaffViewer() {
  const owner = useIsCompanyOwner();
  const admin = useIsSuperAdmin();
  const canView = owner.data === true || admin.data === true;
  return {
    canView,
    isOwner: owner.data === true,
    isLoading: !canView && (owner.isLoading || admin.isLoading),
    isError: !canView && (owner.isError || admin.isError),
    refetch: () => Promise.allSettled([owner.refetch(), admin.refetch()]),
  };
}
