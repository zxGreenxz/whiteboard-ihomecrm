// Khoản thu hoá đơn (kiểu mới, có dòng thu) trên màn Thu chi: hiện hình thức thu +
// sổ nhận hiện tại và nút "Đổi hình thức thu" (đợt 1 sửa phiếu, 25/09/2026).
//
// Quyền thật do máy chủ quyết (change_collection_tender_method_v1: người đã thu, chủ
// công ty, super admin); nút chỉ hiện cho đúng ba vai đó để khỏi mời người khác bấm
// rồi ăn lỗi. Khoản thu kiểu cũ (trước 28/07, không có dòng thu) không hiện gì.

import { useState, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import ChangeCollectionMethodDialog from "@/components/invoices/ChangeCollectionMethodDialog";
import { useAuth } from "@/hooks/useAuth";
import { useIsAdmin } from "@/hooks/useIsAdmin";
import { useIsCompanyOwner } from "@/hooks/useIsCompanyOwner";
import {
  changeMethodTenderOfVoucher,
  tenderMethodChangeBlock,
  useTenderForVoucher,
} from "@/hooks/useCollectionTenders";
import { PAYMENT_METHOD_LABELS } from "@/lib/incomeExpenseRevision";

interface Props {
  voucher: {
    id: string;
    type: string;
    invoice_id?: string | null;
    approval_status: string;
    organization_id?: string | null;
  };
  /** Mỗi mặt (bảng máy tính / thẻ điện thoại) tự vẽ dòng nhãn–giá trị của nó. */
  row: (label: string, value: ReactNode) => ReactNode;
}

export function CollectionMethodAction({ voucher, row }: Props) {
  const applies =
    voucher.type === "INCOME" && !!voucher.invoice_id && voucher.approval_status !== "CANCELLED";
  const { data: tender } = useTenderForVoucher(voucher.id, { enabled: applies });
  const { data: authUser } = useAuth();
  const { data: isAdmin = false } = useIsAdmin();
  const { data: isCompanyOwner = false } = useIsCompanyOwner();
  const [open, setOpen] = useState(false);

  if (!applies || !tender || tender.collection?.status !== "ACTIVE") return null;

  const dialogTender = changeMethodTenderOfVoucher(tender);
  const organizationId = voucher.organization_id ?? null;
  const canChange =
    !!dialogTender &&
    !!organizationId &&
    (isAdmin || isCompanyOwner || tender.collection?.actor_id === authUser?.id);
  const block = dialogTender ? tenderMethodChangeBlock(dialogTender) : null;
  const hienTai =
    (PAYMENT_METHOD_LABELS[tender.payment_method] ?? tender.payment_method) +
    (tender.account_name ? ` · ${tender.account_name}` : "");

  return (
    <>
      {row(
        "Hình thức thu",
        <span className="inline-flex flex-wrap items-center gap-2">
          <span>{hienTai}</span>
          {canChange && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-7 px-2 text-xs"
              disabled={!!block}
              title={block ?? "Đổi hình thức thu (sổ đi theo hình thức; phải ghi lý do)"}
              onClick={() => setOpen(true)}
              data-testid="ie-change-collection-method"
            >
              Đổi hình thức thu
            </Button>
          )}
        </span>,
      )}
      {canChange && dialogTender && organizationId && (
        <ChangeCollectionMethodDialog
          open={open}
          onOpenChange={setOpen}
          organizationId={organizationId}
          tender={dialogTender}
        />
      )}
    </>
  );
}

export default CollectionMethodAction;
