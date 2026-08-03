import { useState } from "react";
import { useOpenClawRouteContext } from "../OpenClawRouteGuard";
import {
  useOpenClawKnowledge,
  useOpenClawKnowledgeList,
  useOpenClawKnowledgeMutations,
  useOpenClawKnowledgePreview,
} from "@/hooks/openclaw-zalo/useOpenClawResources";
import { classifyKnowledgeFailure } from "@/lib/openclaw-zalo/knowledge";
import type { KnowledgeSourceView } from "@/lib/openclaw-zalo/knowledge";
import OpenClawKnowledge from "./OpenClawKnowledge";

/**
 * Wires the knowledge screen to real data.
 *
 * Validate, publish and archive ARE bound: their requests are
 * `{version, organizationId, sourceId, knowledgeVersionId}` and nothing more, and the
 * detail RPC already returns the version id. Only Edit stays unbound, because create
 * and update need a content body that no RPC returns - and it is DISABLED rather
 * than wired to a no-op. An enabled button that does nothing is the failure this
 * screen was written to avoid.
 */
/** One sentence per distinct server behaviour, because each needs a different act. */
const FAILURE_COPY = {
  IDEMPOTENCY_CONFLICT: "Thao tác trùng mã lần gọi. Thử lại để hệ thống cấp mã mới.",
  VERSION_CONFLICT: "Người khác vừa sửa nguồn này. Tải lại rồi thao tác trên phiên bản mới.",
  NOT_FOUND: "Không tìm thấy nguồn hoặc phiên bản này trong tổ chức hiện tại.",
  PERMISSION_DENIED: "Bạn không có quyền thực hiện thao tác này.",
  PRECONDITION: "Trạng thái hiện tại không cho phép thao tác này. Tải lại để xem trạng thái mới.",
  UNKNOWN: "Thao tác không thành công. Thử lại hoặc báo vận hành.",
} as const;

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
  const mutations = useOpenClawKnowledgeMutations(
    selectedOrganizationId ?? "", accountId ?? "",
  );
  const [failure, setFailure] = useState<string | null>(null);

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
      busy={detailQuery.isLoading || mutations.validate.isPending
        || mutations.publish.isPending || mutations.archive.isPending}
      onSelectSource={sourceId => {
        setSelectedSourceId(sourceId);
        setFailure(null);
      }}
      failureMessage={failure}
      onAct={(action, source) => {
        // Edit needs a compose flow; the screen disables it rather than accepting a
        // click it cannot honour.
        if (action === "edit") return;
        const knowledgeVersionId = detail?.publishedVersionId ?? null;
        if (knowledgeVersionId === null) {
          setFailure("Chưa đọc được phiên bản hiện tại của nguồn này. Tải lại rồi thử tiếp.");
          return;
        }
        const request = {
          version: 1 as const,
          organizationId: selectedOrganizationId,
          sourceId: source.sourceId,
          knowledgeVersionId,
        };
        const variables = { clientOperationId: crypto.randomUUID(), request };
        const onError = (error: unknown) => setFailure(FAILURE_COPY[classifyKnowledgeFailure(error)]);
        setFailure(null);
        if (action === "validate") mutations.validate.mutate(variables, { onError });
        if (action === "publish") mutations.publish.mutate(variables, { onError });
        if (action === "archive") mutations.archive.mutate(variables, { onError });
      }}
      onPreviewQueryChange={setPreviewQuery}
    />
  );
}
