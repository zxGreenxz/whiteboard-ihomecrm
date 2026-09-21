import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/hooks/useAuth";
import { useOrganization } from "@/contexts/OrganizationContext";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { CreatableSettlementSourceRef } from "@/lib/contractSettlementCreate";
import { readSettlementSaleProposalPage } from "@/lib/contractSettlementCreateRepository";
export function ContractSettlementSaleProposalSelector({
  organizationId,
  onSelectSource,
}: {
  organizationId: string;
  onSelectSource: (
    source: Extract<
      CreatableSettlementSourceRef,
      { kind: "sale_contract" | "sale_deposit" }
    >,
  ) => void;
}) {
  const { data: actor } = useAuth(),
    { selectedOrganizationId } = useOrganization(),
    [kind, setKind] = useState<"sale_contract" | "sale_deposit">(
      "sale_contract",
    ),
    [search, setSearch] = useState(""),
    [page, setPage] = useState(0);
  const q = useQuery({
    queryKey: [
      "contract-settlement-sale-proposals",
      organizationId,
      actor?.id,
      kind,
      search,
      page,
    ],
    enabled: !!actor && organizationId === selectedOrganizationId,
    retry: false,
    queryFn: () =>
      readSettlementSaleProposalPage(organizationId, kind, search, page),
  });
  if (!actor || organizationId !== selectedOrganizationId)
    return <p role="status">Chọn đúng tổ chức trước khi tìm nguồn đề xuất.</p>;
  return (
    <div className="space-y-3 text-sm">
      <p>
        Chọn hợp đồng hoặc phiếu thu cọc để đề xuất thưởng. Việc chọn nguồn chưa
        phát sinh nghĩa vụ hay phiếu chi.
      </p>
      <div className="flex gap-2">
        <Button
          variant={kind === "sale_contract" ? "default" : "outline"}
          onClick={() => {
            setKind("sale_contract");
            setPage(0);
          }}
        >
          Hợp đồng
        </Button>
        <Button
          variant={kind === "sale_deposit" ? "default" : "outline"}
          onClick={() => {
            setKind("sale_deposit");
            setPage(0);
          }}
        >
          Phiếu cọc
        </Button>
      </div>
      <Input
        aria-label="Tìm nguồn đề xuất thưởng"
        value={search}
        onChange={(e) => {
          setSearch(e.target.value);
          setPage(0);
        }}
        placeholder="Tìm mã hợp đồng / phiếu cọc"
      />
      {q.isLoading ? (
        <p role="status">Đang tải nguồn…</p>
      ) : q.error ? (
        <div role="alert">
          <p>Không tải được nguồn đề xuất thưởng.</p>
          <Button variant="outline" onClick={() => void q.refetch()}>
            Tải lại
          </Button>
        </div>
      ) : q.data?.length ? (
        <ul className="divide-y">
          {q.data.map((row) => (
            <li key={JSON.stringify(row.sourceRef)}>
              <button
                type="button"
                className="w-full py-3 text-left hover:bg-muted"
                onClick={() => onSelectSource(row.sourceRef)}
              >
                <b>{row.code || "Chưa có mã"}</b> · {row.name}
                <span className="block text-muted-foreground">
                  {row.sourceDate}
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p>Không có nguồn phù hợp trong phạm vi được xem.</p>
      )}
      <div className="flex justify-between">
        <Button
          variant="outline"
          disabled={page === 0 || q.isFetching}
          onClick={() => setPage((p) => p - 1)}
        >
          Trang trước
        </Button>
        <Button
          variant="outline"
          disabled={q.data?.length !== 30 || q.isFetching}
          onClick={() => setPage((p) => p + 1)}
        >
          Trang sau
        </Button>
      </div>
    </div>
  );
}
