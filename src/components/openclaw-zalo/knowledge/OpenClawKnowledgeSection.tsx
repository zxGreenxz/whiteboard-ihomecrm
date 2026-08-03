import { useState } from "react";
import { useOpenClawRouteContext } from "../OpenClawRouteGuard";
import {
  useOpenClawKnowledge,
  useOpenClawKnowledgeList,
  useOpenClawKnowledgePreview,
} from "@/hooks/openclaw-zalo/useOpenClawResources";
import type { KnowledgeSourceView } from "@/lib/openclaw-zalo/knowledge";
import OpenClawKnowledge from "./OpenClawKnowledge";

/**
 * Wires the knowledge screen to real data.
 *
 * The mutations are deliberately not bound yet: create and update both need a
 * content body, and no RPC returns the existing one, so an edit form here would have
 * to invent a compose flow before the read gap is closed. The read screen is
 * genuinely useful on its own - lifecycle, sensitivity, version and the blocked
 * reasons - and shipping it without a half-built editor keeps that honest.
 */
export default function OpenClawKnowledgeSection() {
  const { selectedOrganizationId, bootstrap, can } = useOpenClawRouteContext();
  const accountId = bootstrap.account?.accountId ?? null;
  const canManage = can("manage_knowledge");
  const [selectedSourceId, setSelectedSourceId] = useState<string | null>(null);
  const [previewQuery, setPreviewQuery] = useState("");

  const listQuery = useOpenClawKnowledgeList(
    canManage ? selectedOrganizationId : null,
    accountId,
  );
  const previewQueryResult = useOpenClawKnowledgePreview(
    canManage ? selectedOrganizationId : null,
    accountId,
    previewQuery.trim(),
  );

  // The LIST carries no contentHash and no validationResult - only
  // openclaw_get_knowledge_v1 does - so the selected source is fetched separately
  // and merged in. Reading them off the list would have been `undefined` silently
  // presented as "not validated", which is the difference between a disabled
  // Publish button and a wrong one.
  const detailQuery = useOpenClawKnowledge(
    canManage ? selectedOrganizationId : null,
    accountId,
    selectedSourceId,
  );
  const detail = detailQuery.data?.knowledge ?? null;

  const sources: KnowledgeSourceView[] = (listQuery.data?.items ?? []).map(item => ({
    sourceId: item.sourceId!,
    title: item.title!,
    sourceKind: item.sourceKind!,
    sensitivity: item.sensitivity!,
    lifecycleState: item.lifecycleState as KnowledgeSourceView["lifecycleState"],
    currentVersion: item.currentVersion!,
    contentHash: item.sourceId === selectedSourceId ? detail?.contentHash ?? null : null,
    validationResult: item.sourceId === selectedSourceId
      ? detail?.validationResult ?? null
      : null,
  }));

  return (
    <OpenClawKnowledge
      sources={sources}
      loading={listQuery.isLoading}
      canManage={canManage}
      selectedSourceId={selectedSourceId}
      previewMatches={(previewQueryResult.data?.items ?? []).map(match => ({
        chunkIndex: match.chunkIndex!,
        text: match.chunkText!,
      }))}
      previewQuery={previewQuery}
      busy={detailQuery.isLoading}
      onSelectSource={setSelectedSourceId}
      // Mutations land with the compose flow; wiring a handler that silently does
      // nothing would be worse than a disabled control.
      onAct={() => undefined}
      onPreviewQueryChange={setPreviewQuery}
    />
  );
}
