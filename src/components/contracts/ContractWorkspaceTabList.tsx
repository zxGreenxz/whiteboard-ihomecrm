import { TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useContractExitCases } from '@/hooks/useContractExitCases';
import { useContractDrafts } from '@/hooks/useContractDrafts';

/** Header only; the page owns the selected tab and its contents. */
export function ContractWorkspaceTabList({ buildingIds }: { buildingIds: string[] }) {
  const exits = useContractExitCases({ buildingIds, state: 'PENDING', limit: 10, offset: 0 });
  const drafts = useContractDrafts(buildingIds.length === 1 ? buildingIds[0] : undefined);
  const visibleBuildings = new Set(buildingIds);
  const draftCount = drafts.data?.filter(draft =>
    draft.status !== 'SIGNED' && (!visibleBuildings.size || visibleBuildings.has(draft.building_id)),
  ).length;

  const exitBadge = exits.isError ? '!' : exits.data ? String(exits.data.total) : '…';
  const draftBadge = drafts.isError ? '!' : draftCount === undefined ? '…' : String(draftCount);
  const exitTitle = exits.isError ? 'Không tải được hồ sơ chờ quyết toán' : exits.data ? 'Hồ sơ chờ quyết toán' : 'Đang tải hồ sơ chờ quyết toán';
  const draftTitle = drafts.isError ? 'Không tải được bản nháp chưa ký' : draftCount === undefined ? 'Đang tải bản nháp chưa ký' : 'Bản nháp chưa ký';

  return <TabsList aria-label="Các mục hợp đồng" className="h-auto max-w-full flex-wrap justify-start gap-1">
    <TabsTrigger value="contracts" className="h-8 px-2.5 text-xs sm:text-sm">Danh sách</TabsTrigger>
    <TabsTrigger value="exits" title={exitTitle} className="h-8 px-2.5 text-xs sm:text-sm">
      Chờ quyết toán <span className="ml-1 rounded-full bg-background/80 px-1.5 text-xs tabular-nums">{exitBadge}</span>
    </TabsTrigger>
    <TabsTrigger value="drafts" title={draftTitle} className="h-8 px-2.5 text-xs sm:text-sm">
      Hợp đồng nháp <span className="ml-1 rounded-full bg-background/80 px-1.5 text-xs tabular-nums">{draftBadge}</span>
    </TabsTrigger>
  </TabsList>;
}
