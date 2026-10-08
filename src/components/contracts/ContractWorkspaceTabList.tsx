import { TabsList, TabsTrigger } from '@/components/ui/tabs';
import { InlineSkeleton } from '@/components/loading/LoadingState';
import { useContractExitCases } from '@/hooks/useContractExitCases';
import { useContractDrafts } from '@/hooks/useContractDrafts';
import { useContractMeterFollowups } from '@/hooks/useContractMeterFollowups';

/** Header only; the page owns the selected tab and its contents. */
export function ContractWorkspaceTabList({ buildingIds }: { buildingIds: string[] }) {
  const exits = useContractExitCases({ buildingIds, state: 'PENDING', limit: 10, offset: 0 });
  const drafts = useContractDrafts(buildingIds.length === 1 ? buildingIds[0] : undefined);
  const meters = useContractMeterFollowups(buildingIds, 0);
  const visibleBuildings = new Set(buildingIds);
  const draftCount = drafts.data?.filter(draft =>
    draft.status !== 'SIGNED' && (!visibleBuildings.size || visibleBuildings.has(draft.building_id)),
  ).length;

  // Chưa có số: vạch xám trong ô đếm (không "…", không 0) — chủ chốt 02/10/2026; câu
  // "Đang tải …" chỉ còn cho trình đọc màn hình. Lỗi đọc vẫn là "!" kèm lời giải thích.
  const exitWaiting = !exits.isError && !exits.data;
  const draftWaiting = !drafts.isError && draftCount === undefined;
  const exitBadge = exits.isError ? '!' : exits.data ? String(exits.data.total) : null;
  const draftBadge = drafts.isError ? '!' : draftCount === undefined ? null : String(draftCount);
  const exitTitle = exits.isError ? 'Không tải được hồ sơ chờ quyết toán' : 'Hồ sơ chờ quyết toán';
  const draftTitle = drafts.isError ? 'Không tải được bản nháp chưa ký' : 'Bản nháp chưa ký';
  // Ô "Chỉ số" chỉ hiện khi có hồ sơ chờ chỉ số (hoặc đọc lỗi) — đang chờ thì chưa hiện.
  const meterBadge = meters.isError ? '!' : !meters.data ? null : meters.data.total > 0 ? String(meters.data.total) : null;
  const meterTitle = meters.isError ? 'Không tải được hồ sơ chờ chỉ số' : 'Chờ bổ sung / kiểm tra chỉ số bàn giao';

  return <TabsList aria-label="Các mục hợp đồng" className="h-auto max-w-full flex-wrap justify-start gap-1">
    <TabsTrigger value="contracts" className="h-8 px-2.5 text-xs sm:text-sm">Danh sách</TabsTrigger>
    <TabsTrigger value="exits" title={exitTitle} className="h-8 px-2.5 text-xs sm:text-sm">
      Chờ quyết toán <span className="ml-1 rounded-full bg-background/80 px-1.5 text-xs tabular-nums">
        {exitWaiting ? <InlineSkeleton label="hồ sơ chờ quyết toán" width="0.75rem" /> : exitBadge}
      </span>
      {meterBadge !== null && <span title={meterTitle} className="ml-1 rounded-full bg-amber-100 px-1.5 text-xs text-amber-900 tabular-nums">Chỉ số {meterBadge}</span>}
    </TabsTrigger>
    <TabsTrigger value="drafts" title={draftTitle} className="h-8 px-2.5 text-xs sm:text-sm">
      Hợp đồng nháp <span className="ml-1 rounded-full bg-background/80 px-1.5 text-xs tabular-nums">
        {draftWaiting ? <InlineSkeleton label="bản nháp chưa ký" width="0.75rem" /> : draftBadge}
      </span>
    </TabsTrigger>
  </TabsList>;
}
