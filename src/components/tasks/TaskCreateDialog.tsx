import { useEffect, useMemo, useRef, useState } from "react";
import { CheckCircle2, XCircle, Plus } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useBuildings } from "@/hooks/useBuildings";
import { useRooms } from "@/hooks/useRooms";
import { useJobTypes, useCreateJobType } from "@/hooks/useJobTypes";
import { useCreateJob, useProfiles } from "@/hooks/useJobs";
import { useAuth } from "@/hooks/useAuth";
import { useIsMobile } from "@/hooks/use-mobile";
import AttachmentUpload from "@/components/income-expenses/AttachmentUpload";
import { Package } from "lucide-react";
import MaterialUsageItemsEditor, {
  type UsageItemRow,
  newUsageItemRow,
} from "@/components/materials/MaterialUsageItemsEditor";
import { useUpsertJobMaterialUsage } from "@/hooks/useMaterialUsages";
import { useMaterials } from "@/hooks/useMaterials";
import {
  parseJobQuickInput,
  formatDeadlineLabel,
  type BuildingRef,
  type RoomRef,
  type JobTypeRef,
} from "@/lib/jobQuickInput";

interface TaskCreateDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess: () => void;
}

const PLACEHOLDER = `Ví dụ:  201 1392qt sửa vòi nước
        201 1392qt sửa vòi nước 2     (sau 2 ngày)
        201 1392qt sửa vòi nước 17/5  (ngày cụ thể)
        tn  1392qt sửa bóng đèn hành lang chung  (toàn tòa nhà)`;

export default function TaskCreateDialog({
  open,
  onOpenChange,
  onSuccess,
}: TaskCreateDialogProps) {
  const { data: authUser } = useAuth();
  const { data: buildings = [] } = useBuildings();
  const { data: allRooms = [] } = useRooms();
  const { data: jobTypes = [] } = useJobTypes();
  const { data: profiles = [] } = useProfiles();
  const createJob = useCreateJob();
  const createJobType = useCreateJobType();
  const upsertJobMaterials = useUpsertJobMaterialUsage();
  const { data: allMaterials = [] } = useMaterials({});
  const isMobile = useIsMobile();

  const [rawInput, setRawInput] = useState("");
  const [attachments, setAttachments] = useState<string[]>([]);
  const [assigneeText, setAssigneeText] = useState("");
  const [creatingType, setCreatingType] = useState(false);
  const [materialItems, setMaterialItems] = useState<UsageItemRow[]>([
    newUsageItemRow(),
  ]);
  const assigneeInitedRef = useRef(false);
  const assigneeClearedOnFocusRef = useRef(false);

  useEffect(() => {
    if (open) {
      setRawInput("");
      setAttachments([]);
      setCreatingType(false);
      setMaterialItems([newUsageItemRow()]);
      assigneeInitedRef.current = false;
      assigneeClearedOnFocusRef.current = false;
      setAssigneeText("");
    }
  }, [open]);

  useEffect(() => {
    if (!open || assigneeInitedRef.current) return;
    if (!authUser?.id || profiles.length === 0) return;
    const current = (profiles as any[]).find((p) => p.id === authUser.id);
    setAssigneeText(current?.full_name ?? "");
    assigneeInitedRef.current = true;
  }, [open, authUser?.id, profiles]);

  const handleAssigneeFocus = () => {
    if (assigneeClearedOnFocusRef.current) return;
    setAssigneeText("");
    assigneeClearedOnFocusRef.current = true;
  };

  const buildingRefs = useMemo<BuildingRef[]>(
    () =>
      buildings.map((b: any) => ({
        id: b.id,
        name: b.name,
        code: b.code,
      })),
    [buildings],
  );

  const roomRefs = useMemo<RoomRef[]>(
    () =>
      allRooms.map((r: any) => ({
        id: r.id,
        name: r.name,
        code: r.code ?? null,
        building_id: r.building_id,
      })),
    [allRooms],
  );

  const jobTypeRefs = useMemo<JobTypeRef[]>(
    () => jobTypes.map((t: any) => ({ id: t.id, name: t.name })),
    [jobTypes],
  );

  const parsed = useMemo(
    () =>
      parseJobQuickInput(
        rawInput,
        new Date(),
        buildingRefs,
        roomRefs,
        jobTypeRefs,
      ),
    [rawInput, buildingRefs, roomRefs, jobTypeRefs],
  );

  const hasInput = rawInput.trim().length > 0;
  const canSubmit =
    hasInput &&
    !parsed.errors.structure &&
    !!parsed.buildingId &&
    (!!parsed.roomId || parsed.isBuildingWide) &&
    !!parsed.jobTypeId &&
    parsed.descriptionText.trim().length > 0 &&
    !createJob.isPending;

  const handleCreateMissingType = async () => {
    if (!parsed.jobTypeToken) return;
    setCreatingType(true);
    try {
      await createJobType.mutateAsync({ name: parsed.jobTypeToken });
    } finally {
      setCreatingType(false);
    }
  };

  const resolveAssignee = (): {
    assignee_id: string | null;
    assignee_name: string | null;
  } => {
    const text = assigneeText.trim();
    if (!text) return { assignee_id: null, assignee_name: null };
    const match = (profiles as any[]).find(
      (p) => p.full_name?.trim().toLowerCase() === text.toLowerCase(),
    );
    if (match) return { assignee_id: match.id, assignee_name: null };
    return { assignee_id: null, assignee_name: text };
  };

  const handleSubmit = async () => {
    if (!canSubmit) return;
    const matchedType = jobTypeRefs.find((t) => t.id === parsed.jobTypeId);
    const titleType = matchedType?.name ?? parsed.jobTypeToken;
    const title = `${titleType} ${parsed.descriptionText}`.trim();
    const { assignee_id, assignee_name } = resolveAssignee();
    try {
      const job: any = await createJob.mutateAsync({
        title,
        description: rawInput.trim(),
        building_id: parsed.buildingId,
        room_id: parsed.roomId,
        job_type_id: parsed.jobTypeId,
        priority: "NORMAL",
        assignee_id,
        assignee_name,
        deadline: parsed.deadline.toISOString(),
        visible_to_customer: false,
        attachments: attachments.length ? attachments : null,
        status: "IN_PROGRESS",
        started_at: new Date().toISOString(),
      });

      const cleanMaterials = materialItems
        .map((r) => {
          const m = allMaterials.find((x) => x.id === r.material_id);
          return {
            material_id: r.material_id ?? "",
            quantity: Number(r.quantity) || 0,
            unit_cost_at_usage: Number(m?.avg_unit_cost ?? 0),
          };
        })
        .filter((it) => it.material_id && it.quantity > 0);

      if (cleanMaterials.length > 0 && job?.id) {
        try {
          await upsertJobMaterials.mutateAsync({
            job_id: job.id,
            usage_date: new Date().toISOString().slice(0, 10),
            notes: null,
            items: cleanMaterials,
          });
        } catch {
          // toast already shown; job đã tạo nên không rollback
        }
      }

      onOpenChange(false);
      onSuccess();
    } catch {
      // toast handled by hook
    }
  };

  const deadlineLabel = useMemo(() => {
    const label = formatDeadlineLabel(parsed.deadline);
    if (parsed.deadlineSource === "default-tomorrow")
      return `${label} (mặc định: ngày mai)`;
    if (parsed.deadlineSource === "offset") return `${label} (theo số ngày)`;
    return label;
  }, [parsed.deadline, parsed.deadlineSource]);

  const formBody = (
    <>
      {/* Mô tả nhanh */}
      <div className="space-y-1">
        <label className="text-[13px] font-medium block">
          Mô tả nhanh <span className="text-red-500">*</span>
        </label>
        <Textarea
          autoFocus
          rows={3}
          placeholder={PLACEHOLDER}
          value={rawInput}
          onChange={(e) => setRawInput(e.target.value)}
          className="font-mono"
        />
        <p className="text-[11px] text-muted-foreground leading-tight">
          Cú pháp: <code>(phòng) (tòa) (loại) (mô tả) [ngày]</code>. Ngày: số
          (0=hôm nay, 1=mai…) hoặc <code>17/5</code>. Bỏ trống → mai. Nhập{" "}
          <code>tn</code> ở chỗ phòng nếu là việc cho cả tòa nhà.
        </p>
      </div>

      {/* Preview parse */}
      {hasInput && (
        <div className="rounded-md border bg-muted/30 p-2.5 space-y-1.5 text-[13px]">
          {parsed.errors.structure ? (
            <div className="flex items-start gap-2 text-red-600">
              <XCircle className="h-4 w-4 mt-0.5 shrink-0" />
              <span>{parsed.errors.structure}</span>
            </div>
          ) : (
            <>
              <PreviewRow
                label="Phòng"
                ok={!!parsed.roomId || parsed.isBuildingWide}
                valueOk={
                  parsed.isBuildingWide
                    ? "Toàn tòa nhà (không phòng cụ thể)"
                    : parsed.roomToken
                }
                error={parsed.errors.roomNotFound}
              />
              <PreviewRow
                label="Tòa nhà"
                ok={!!parsed.buildingId}
                valueOk={parsed.buildingToken}
                error={parsed.errors.buildingNotFound}
              />
              <PreviewRow
                label="Loại công việc"
                ok={!!parsed.jobTypeId}
                valueOk={parsed.jobTypeToken}
                error={parsed.errors.jobTypeNotFound}
                action={
                  !parsed.jobTypeId && parsed.jobTypeToken ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      className="h-7 ml-2"
                      disabled={creatingType || createJobType.isPending}
                      onClick={handleCreateMissingType}
                    >
                      <Plus className="h-3 w-3 mr-1" />
                      Tạo "{parsed.jobTypeToken}"
                    </Button>
                  ) : null
                }
              />
              <PreviewRow
                label="Mô tả"
                ok={parsed.descriptionText.trim().length > 0}
                valueOk={parsed.descriptionText || "(chưa có)"}
                error={
                  parsed.descriptionText.trim().length === 0
                    ? "Thiếu phần mô tả công việc."
                    : undefined
                }
              />
              <PreviewRow label="Hạn hoàn thành" ok valueOk={deadlineLabel} />
            </>
          )}
        </div>
      )}

      {/* Người thực hiện */}
      <div className="space-y-1">
        <label className="text-[13px] font-medium block" htmlFor="assignee-input">
          Người thực hiện
        </label>
        <Input
          id="assignee-input"
          list="assignee-suggestions"
          placeholder="Chọn từ danh sách hoặc gõ tên tự do"
          value={assigneeText}
          onChange={(e) => setAssigneeText(e.target.value)}
          onFocus={handleAssigneeFocus}
          autoComplete="off"
        />
        <datalist id="assignee-suggestions">
          {(profiles as any[]).map((p) => (
            <option key={p.id} value={p.full_name} />
          ))}
        </datalist>
      </div>

      {/* Vật tư sử dụng */}
      <div className="space-y-1">
        <label className="text-[13px] font-medium flex items-center gap-1.5">
          <Package className="h-3.5 w-3.5" />
          Vật tư sử dụng cho công việc
          <span className="text-muted-foreground font-normal text-[11px]">
            (tuỳ chọn — sẽ tự trừ kho khi lưu)
          </span>
        </label>
        <MaterialUsageItemsEditor
          items={materialItems}
          onItemsChange={setMaterialItems}
        />
      </div>

      {/* Đính kèm */}
      <div className="space-y-1">
        <label className="text-[13px] font-medium block">Đính kèm</label>
        <AttachmentUpload
          attachments={attachments}
          onChange={setAttachments}
          userId={authUser?.id ?? ""}
          bucket="job-attachments"
        />
      </div>
    </>
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className={
          isMobile
            ? "max-w-full w-full h-[100dvh] !top-auto !bottom-0 !left-0 !translate-x-0 !translate-y-0 rounded-t-2xl rounded-b-none flex flex-col p-0 gap-0 data-[state=open]:!slide-in-from-bottom data-[state=closed]:!slide-out-to-bottom"
            : "sm:max-w-[640px] max-h-[90vh] overflow-y-auto"
        }
      >
        {isMobile ? (
          <>
            <div className="shrink-0 pt-2 pb-1 flex justify-center">
              <div className="w-10 h-1 bg-zinc-300 rounded-full" />
            </div>
            <DialogHeader className="shrink-0 px-4 pb-2.5 border-b">
              <DialogTitle className="text-green-600 uppercase font-semibold text-base">
                Thêm công việc
              </DialogTitle>
            </DialogHeader>
            <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
              {formBody}
            </div>
            <DialogFooter className="shrink-0 px-4 py-3 border-t flex flex-col gap-2 bg-background">
              <Button
                type="button"
                className="bg-green-600 hover:bg-green-700 text-white w-full h-11"
                disabled={!canSubmit}
                onClick={handleSubmit}
              >
                {createJob.isPending ? "Đang lưu..." : "Lưu"}
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={() => onOpenChange(false)}
                className="w-full h-11"
              >
                Huỷ
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle className="text-green-600 uppercase font-semibold">
                THÊM CÔNG VIỆC
              </DialogTitle>
            </DialogHeader>
            <div className="space-y-4">{formBody}</div>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => onOpenChange(false)}
              >
                Huỷ
              </Button>
              <Button
                type="button"
                className="bg-green-600 hover:bg-green-700 text-white"
                disabled={!canSubmit}
                onClick={handleSubmit}
              >
                {createJob.isPending ? "Đang lưu..." : "Lưu"}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function PreviewRow({
  label,
  ok,
  valueOk,
  error,
  action,
}: {
  label: string;
  ok: boolean;
  valueOk: string;
  error?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex items-start gap-2">
      {ok ? (
        <CheckCircle2 className="h-4 w-4 mt-0.5 shrink-0 text-green-600" />
      ) : (
        <XCircle className="h-4 w-4 mt-0.5 shrink-0 text-red-500" />
      )}
      <div className="flex-1 min-w-0">
        <div className="flex items-center flex-wrap">
          <span className="text-muted-foreground mr-2">{label}:</span>
          <span className={ok ? "font-medium" : "font-medium text-red-600"}>
            {valueOk}
          </span>
          {action}
        </div>
        {error && <p className="text-xs text-red-600 mt-0.5">{error}</p>}
      </div>
    </div>
  );
}
