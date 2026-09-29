import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import { ChevronDown, FilePenLine, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useOrganization } from '@/contexts/OrganizationContext';
import { useMyPermissions } from '@/hooks/useMyPermissions';
import { useMyBuildingScope } from '@/hooks/useMyBuildingScope';
import { canUse } from '@/lib/permissionPages';
import type { ContractDraft } from '@/lib/contractDrafts';

const DraftList = lazy(() => import('./ContractDraftList').then(module => ({ default: module.ContractDraftList })));
const DraftForm = lazy(() => import('./ContractDraftFormDialog').then(module => ({ default: module.ContractDraftFormDialog })));
const SigningDialog = lazy(() => import('./ConfirmContractSigningDialog').then(module => ({ default: module.ConfirmContractSigningDialog })));
const TransferPanel = lazy(() => import('./ContractTransferLinkPanel').then(module => ({ default: module.ContractTransferLinkPanel })));

/** Same entry for desktop and mobile; heavy editor/export code loads on demand. */
export function ContractDraftWorkspace({ buildingId, buildingIds, alwaysExpanded = false }: {
  buildingId?: string; buildingIds?: string[]; alwaysExpanded?: boolean;
}) {
  const { selectedOrganizationId } = useOrganization();
  const { data: permissions } = useMyPermissions();
  const { hasAnyScope } = useMyBuildingScope();
  const [expanded, setExpanded] = useState(false);
  const [editorOpen, setEditorOpen] = useState(false);
  const [draft, setDraft] = useState<ContractDraft>();
  const [signingDraft, setSigningDraft] = useState<ContractDraft>();
  const [transferDraft, setTransferDraft] = useState<ContractDraft>();
  const canCreate = hasAnyScope && canUse(permissions, 'contracts', 'create');
  const canEdit = canUse(permissions, 'contracts', 'edit');
  const canExport = canUse(permissions, 'contracts', 'print');
  const editorPrefill = useMemo(() => buildingId ? { buildingId } : undefined, [buildingId]);

  useEffect(() => {
    setEditorOpen(false);
    setDraft(undefined);
    setSigningDraft(undefined);
    setTransferDraft(undefined);
  }, [selectedOrganizationId, buildingId]);

  const editDraft = (value: ContractDraft) => {
    setDraft(value);
    setEditorOpen(true);
  };

  return <section className="rounded-lg border bg-background" aria-label="Hợp đồng nháp">
    <div className="flex flex-wrap items-center justify-between gap-3 p-3">
      {alwaysExpanded ? <div className="flex items-center gap-2">
        <FilePenLine className="h-4 w-4" />
        <div><h2 className="font-semibold">Hợp đồng nháp</h2>
          <p className="text-xs text-muted-foreground">Soạn sẵn, tải gửi khách xem trước</p></div>
      </div> : <Button variant="ghost" className="h-auto justify-start px-1 text-left" aria-expanded={expanded}
        onClick={() => setExpanded(value => !value)}>
        <FilePenLine className="mr-2 h-4 w-4" />
        <span><span className="block font-semibold">Hợp đồng nháp</span>
          <span className="block text-xs font-normal text-muted-foreground">Soạn sẵn, tải gửi khách xem trước</span></span>
        <ChevronDown className={`ml-3 h-4 w-4 transition-transform ${expanded ? 'rotate-180' : ''}`} />
      </Button>}
      {canCreate && <Button size="sm" variant="outline" onClick={() => { setDraft(undefined); setEditorOpen(true); }}>
        <Plus className="mr-1 h-4 w-4" />Soạn nháp
      </Button>}
    </div>
    {(alwaysExpanded || expanded) && <Suspense fallback={<p className="p-4 text-sm text-muted-foreground">Đang tải bản nháp…</p>}>
      <DraftList buildingId={buildingId} buildingIds={buildingIds} canEdit={canEdit} canExport={canExport} canSign={canCreate}
        onEdit={editDraft} onExport={editDraft} onSign={value => {
          if (value.status === 'SIGNED') setSigningDraft(value);
          else editDraft(value);
        }} onTransfer={setTransferDraft} />
    </Suspense>}
    {transferDraft && <div className="p-3"><Button variant="ghost" size="sm" onClick={() => setTransferDraft(undefined)}>Đóng liên kết nhượng</Button>
      <Suspense fallback={<p className="text-sm">Đang tải liên kết nhượng…</p>}><TransferPanel key={transferDraft.id} draft={transferDraft} canEdit={canEdit} /></Suspense>
    </div>}
    {signingDraft && <Suspense fallback={<p role="status" className="p-4 text-sm">Đang mở xác nhận ký…</p>}>
      <SigningDialog key={`${selectedOrganizationId}:${signingDraft.id}`} open
        onOpenChange={open => { if (!open) setSigningDraft(undefined); }} draft={signingDraft}
        canSign={canCreate} canPrint={canExport} />
    </Suspense>}
    {editorOpen && <Suspense fallback={<p role="status" className="p-4 text-sm">Đang mở bản nháp…</p>}>
      <DraftForm open={editorOpen} onOpenChange={setEditorOpen} draft={draft}
        prefill={editorPrefill} canExport={canExport}
        onSaved={() => setExpanded(true)} />
    </Suspense>}
  </section>;
}
