// Phiếu hoa hồng (chi, chờ duyệt) trên màn Thu chi: nút "Gán QL" chọn quản lý nhận hoa
// hồng → phiếu chuyển sang sổ ảo "Hoa hồng QL chờ trả lương" (migration 20260927155251):
// duyệt vẫn tính chi phí toà nhưng không ra tiền sổ thật; tiền trả qua lương quản lý.
//
// Nút chỉ hiện khi phiếu còn đủ điều kiện server nhận (chi, có hạng mục hoa hồng, chờ
// duyệt, chưa ghi sổ, phiếu tay hoặc phiếu HH hợp đồng). Quyền thật do
// assign_commission_manager_v1 quyết — thiếu quyền thì lỗi hiện nguyên văn.

import { useState, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { useAssignCommissionManager } from "@/hooks/useCommissionManager";
import { isCommissionType } from "@/lib/managerSalary";
import { QlManagerSelect } from "./QlManagerSelect";

/** Tên sổ ảo do salary_commission_book_v1 tạo — phiếu nằm đây là đã gán QL. */
export const COMMISSION_MANAGER_BOOK_NAME = "Hoa hồng QL chờ trả lương";

interface Props {
  voucher: {
    id: string;
    type: string;
    approval_status: string;
    approval_version: number;
    organization_id?: string | null;
    posting_status?: string | null;
    system_source?: string | null;
    account_name?: string | null;
    account_is_virtual?: boolean | null;
    items?: { type_name?: string | null; category?: string | null }[];
  };
  row: (label: string, value: ReactNode) => ReactNode;
}

export function CommissionManagerAction({ voucher, row }: Props) {
  const onBook = !!voucher.account_is_virtual && voucher.account_name === COMMISSION_MANAGER_BOOK_NAME;
  const isCommission =
    voucher.type === "EXPENSE" &&
    (voucher.items || []).some((i) => isCommissionType({ category: i.category, name: i.type_name }));
  const assignable =
    isCommission &&
    voucher.approval_status === "UNAPPROVED" &&
    (voucher.posting_status == null || voucher.posting_status === "UNPOSTED" || voucher.posting_status === "NOT_APPLICABLE") &&
    (voucher.system_source == null || voucher.system_source === "contract.commission") &&
    !!voucher.organization_id;
  const [open, setOpen] = useState(false);
  const [managerId, setManagerId] = useState("");
  const assign = useAssignCommissionManager();

  if (!isCommission || (!assignable && !onBook)) return null;

  return (
    <>
      {row(
        "Quản lý nhận HH",
        <span className="inline-flex flex-wrap items-center gap-2">
          <span>{onBook ? "Sổ ảo HH QL — tiền trả qua lương" : "Chưa gán (tiền chi từ sổ quỹ khi duyệt)"}</span>
          {assignable && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-7 px-2 text-xs"
              onClick={() => setOpen(true)}
              data-testid="ie-assign-commission-manager"
            >
              {onBook ? "Đổi QL" : "Gán QL"}
            </Button>
          )}
        </span>,
      )}
      {assignable && (
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle>Gán quản lý nhận hoa hồng</DialogTitle>
              <DialogDescription>
                Phiếu chuyển sang sổ ảo <b>{COMMISSION_MANAGER_BOOK_NAME}</b>: duyệt vẫn tính chi phí tòa nhưng
                không chi tiền từ sổ quỹ; tiền trả qua lương của quản lý.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-1">
              <Label htmlFor="hhql-manager">Quản lý</Label>
              {open && (
                <QlManagerSelect
                  id="hhql-manager"
                  organizationId={voucher.organization_id}
                  value={managerId}
                  onPick={(m) => setManagerId(m.staffId)}
                />
              )}
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setOpen(false)}>
                Huỷ
              </Button>
              <Button
                type="button"
                disabled={!managerId || assign.isPending}
                onClick={() =>
                  assign.mutate(
                    { voucherId: voucher.id, managerId, expectedVersion: voucher.approval_version },
                    { onSuccess: () => setOpen(false) },
                  )
                }
              >
                {assign.isPending ? "Đang gán…" : "Gán quản lý"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </>
  );
}

export default CommissionManagerAction;
