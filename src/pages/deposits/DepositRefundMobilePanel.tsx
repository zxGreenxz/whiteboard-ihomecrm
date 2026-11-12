import { useState } from "react";
import { Link } from "react-router-dom";
import { QueryRegion } from "@/components/errors/QueryRegion";
import { LoadingState } from "@/components/loading/LoadingState";
import { useOrganization } from "@/contexts/OrganizationContext";
import { useBuildings } from "@/hooks/useBuildings";
import { useDepositRefundsForfeits, type RefundForfeitRow } from "@/hooks/useDepositDashboard";
import { formatCurrency } from "@/lib/utils";
import { formatISODateVN } from "@/lib/vnDate";

function RefundCard({ row }: { row: RefundForfeitRow }) {
  return (
    <li className="min-w-0 space-y-2 rounded-xl border bg-white p-3 text-sm">
      <div className="flex flex-wrap items-start justify-between gap-1">
        <b className="break-words">{row.building_name} · Phòng {row.room_name}</b>
        <span className="text-xs text-muted-foreground">{formatISODateVN(row.termination_date)}</span>
      </div>
      <Link className="block break-words text-primary underline" to={`/contracts/${row.contract_id}`}>
        {row.contract_number || "Mở hợp đồng"} · {row.customer_name}
      </Link>
      <p className="text-xs text-muted-foreground">
        {row.kind === "FORFEIT" ? "Bỏ cọc" : "Hoàn cọc"} · Quyết toán theo hồ sơ: {formatCurrency(row.settlement_net)}
      </p>
      {row.kind === "FORFEIT" ? (
        <p>{row.settlement_net < 0 ? `Khách nợ ${formatCurrency(-row.settlement_net)}` : "Cọc thành doanh thu"}</p>
      ) : row.refund_done ? (
        <div className="space-y-1">
          <p className="font-medium text-emerald-700">Đã hoàn {formatCurrency(row.posted_refund)}</p>
          {row.refund_drift !== 0 && <p role="alert" className="text-amber-800">Lệch hồ sơ {formatCurrency(row.refund_drift)} — cần đối chiếu.</p>}
        </div>
      ) : row.settlement_net < 0 ? (
        <p className="text-red-700">Khách còn nợ {formatCurrency(-row.settlement_net)}</p>
      ) : row.settlement_net > 0 ? (
        <p role="alert" className="text-amber-800">Chưa có phiếu hoàn · {formatCurrency(row.settlement_net)} theo hồ sơ. Đối chiếu chứng từ trước khi chi thêm.</p>
      ) : (
        <p className="text-muted-foreground">Không phát sinh hoàn</p>
      )}
      {row.posted_refund_count > 1 && (
        <p role="alert" className="font-medium text-amber-800">Có {row.posted_refund_count} phiếu hoàn đã vào sổ — cần rà soát trùng trước khi chi thêm.</p>
      )}
      {row.posted_refund_codes.length > 0 && (
        <p className="break-words text-xs text-muted-foreground">Phiếu đã vào sổ: {row.posted_refund_codes.join(", ")}</p>
      )}
    </li>
  );
}

function ScopedRefunds({ organizationId }: { organizationId: string }) {
  const buildingsQuery = useBuildings({ includeVirtual: true });
  const refundsQuery = useDepositRefundsForfeits();
  const [expanded, setExpanded] = useState(false);
  // Không đưa kết luận thiếu phiếu từ cache ra khi lượt đọc mới đang báo lỗi.
  const sources = [buildingsQuery, refundsQuery].map(query => query.isError ? { ...query, data: undefined } : query);
  // Reader cũ trả mọi dòng RLS cho phép. Giới hạn lại theo công ty đang chọn,
  // kể cả khi tài khoản xem được nhiều công ty; chưa đọc được tòa thì chưa kết luận.
  const buildingIds = new Set((buildingsQuery.data ?? [])
    .filter(building => building.organization_id === organizationId)
    .map(building => building.id));
  const rows = (refundsQuery.data ?? []).filter(row => buildingIds.has(row.building_id));
  const missing = rows.filter(row => row.kind !== "FORFEIT" && !row.refund_done && row.settlement_net > 0).length;
  const duplicates = rows.filter(row => row.posted_refund_count > 1).length;
  const drift = rows.filter(row => row.kind !== "FORFEIT" && row.refund_done && row.refund_drift !== 0).length;

  return (
    <section aria-label="Hoàn / Bỏ cọc hợp đồng" className="min-w-0 space-y-3 rounded-xl border bg-white p-3">
      <h2>
        <button type="button" aria-expanded={expanded} aria-controls="mobile-contract-refunds"
          className="flex min-h-11 w-full items-center justify-between gap-2 text-left font-bold"
          onClick={() => setExpanded(value => !value)}>
          <span>Hoàn / Bỏ cọc</span><span aria-hidden="true">{expanded ? "−" : "+"}</span>
        </button>
      </h2>
      <QueryRegion label="hoàn / bỏ cọc hợp đồng" queries={sources} skeleton="list" rows={3}>
        <p className="text-xs text-muted-foreground">{rows.length} hồ sơ thanh lý thuộc các tòa đang xem được của công ty đã chọn.</p>
        {(missing > 0 || duplicates > 0 || drift > 0) && (
          <div role="alert" className="space-y-1 rounded-lg bg-amber-50 p-2 text-sm text-amber-900">
            {missing > 0 && <p>{missing} hồ sơ chưa có phiếu hoàn.</p>}
            {duplicates > 0 && <p>{duplicates} hồ sơ có nhiều phiếu hoàn.</p>}
            {drift > 0 && <p>{drift} hồ sơ lệch số tiền hoàn.</p>}
            <p>Mở Hoàn / Bỏ cọc để đối chiếu trước khi chi thêm.</p>
          </div>
        )}
        <div id="mobile-contract-refunds" hidden={!expanded}>
          {expanded && (rows.length === 0 ? (
            <p className="text-sm text-muted-foreground">Chưa có hồ sơ thanh lý trong phạm vi đang xem.</p>
          ) : (
            <ul className="space-y-3">{rows.map(row => <RefundCard key={row.id} row={row} />)}</ul>
          ))}
        </div>
      </QueryRegion>
    </section>
  );
}

export function DepositRefundMobilePanel() {
  const organization = useOrganization();
  if (organization.isLoading) return <LoadingState label="phạm vi hoàn / bỏ cọc" variant="cards" />;
  if (organization.isError) return (
    <div role="alert" className="rounded-xl border bg-white p-3 text-sm">
      <p>Chưa xác định được công ty để xem hoàn / bỏ cọc hợp đồng.</p>
      <button type="button" className="mt-2 underline" onClick={() => void organization.refetchOrganizations()}>Tải lại công ty</button>
    </div>
  );
  if (!organization.selectedOrganizationId) {
    return <p role="status" className="rounded-xl border bg-white p-3 text-sm">Chọn công ty để xem hoàn / bỏ cọc hợp đồng.</p>;
  }
  return <ScopedRefunds key={organization.selectedOrganizationId} organizationId={organization.selectedOrganizationId} />;
}
