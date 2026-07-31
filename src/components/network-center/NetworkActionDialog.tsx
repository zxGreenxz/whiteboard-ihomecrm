import { Play, ShieldAlert } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import type { NetworkActionRequest, NetworkActionType, NetworkBuilding, NetworkJob, NetworkJobStatus } from "@/lib/network-center/contracts";
import type { NetworkActionIntent, NetworkIntentStatus } from "@/lib/network-center/intentRegistry";
import { NETWORK_ACTION_DEFINITIONS } from "@/lib/network-center/model";
import { allowsNetworkExecution } from "@/lib/network-center/model";
import { ExecuteButton } from "./ExecuteGuard";

interface NetworkActionDialogProps {
  site: NetworkBuilding;
  canExecute: boolean;
  disabledReason: string;
  isDemo?: boolean;
  persistedIntent?: NetworkActionIntent | null;
  onExecute: (request: NetworkActionRequest) => Promise<NetworkJob>;
}

const initialFieldsFor = (type: NetworkActionType): Record<string, string | number | boolean> => {
  const definition = NETWORK_ACTION_DEFINITIONS.find((candidate) => candidate.type === type)!;
  return Object.fromEntries(
    definition.fields
      .filter((field) => field.defaultValue !== undefined)
      .map((field) => [field.key, field.defaultValue!]),
  );
};

export function shouldPreserveActionDraft(input: {
  submitting: boolean;
  status: NetworkJobStatus | null;
  persistedStatus?: NetworkIntentStatus | null;
}): boolean {
  return Boolean(input.persistedStatus)
    || input.submitting || input.status === "queued" || input.status === "running"
    || input.status === "uncertain";
}

export function canRetryActionIntent(status?: NetworkIntentStatus | null): boolean {
  return status === "SUBMISSION_UNKNOWN";
}

export function NetworkActionDialog({
  site,
  canExecute,
  disabledReason,
  isDemo = false,
  persistedIntent = null,
  onExecute,
}: NetworkActionDialogProps) {
  const [open, setOpen] = useState(false);
  const [type, setType] = useState<NetworkActionType>("flush_dns_cache");
  const [reason, setReason] = useState("");
  const [fields, setFields] = useState<Record<string, string | number | boolean>>({});
  const [confirmation, setConfirmation] = useState("");
  const [error, setError] = useState("");
  const [result, setResult] = useState<NetworkJob | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const definition = useMemo(
    () => NETWORK_ACTION_DEFINITIONS.find((candidate) => candidate.type === type)!,
    [type],
  );
  const lanInterfaces = site.interfaces.filter(
    (item) => item.role === "lan" && !item.protected && item.status === "up",
  );
  const draftLocked = shouldPreserveActionDraft({
    submitting,
    status: result?.status ?? null,
    persistedStatus: persistedIntent?.status ?? null,
  });
  const canRetryUnknown = canRetryActionIntent(persistedIntent?.status);
  const executionAllowed = allowsNetworkExecution(canExecute, site.rolloutState);

  const resetDraft = useCallback(() => {
    setType("flush_dns_cache");
    setReason("");
    setFields(initialFieldsFor("flush_dns_cache"));
    setConfirmation("");
    setError("");
    setResult(null);
    setSubmitting(false);
  }, []);

  useEffect(() => {
    setOpen(false);
    if (!persistedIntent || persistedIntent.target.buildingId !== site.buildingId) {
      resetDraft();
      return;
    }
    setType(persistedIntent.target.actionType);
    setReason(persistedIntent.target.reason);
    setFields(persistedIntent.target.parameters);
    setConfirmation(persistedIntent.target.confirmation ?? "");
    setError("");
    setResult(
      persistedIntent.commandId
        ? site.jobs.find((job) => job.id === persistedIntent.commandId) ?? null
        : null,
    );
    setSubmitting(persistedIntent.status === "SUBMITTING");
  }, [persistedIntent, resetDraft, site.buildingId, site.jobs]);

  useEffect(() => {
    const authoritative = result
      ? site.jobs.find((job) => job.id === result.id)
      : persistedIntent?.commandId
        ? site.jobs.find((job) => job.id === persistedIntent.commandId)
      : site.jobs.find((job) => job.isStableIntent && shouldPreserveActionDraft({
        submitting: false,
        status: job.status,
      }));
    if (!authoritative || authoritative === result) return;
    setResult(authoritative);
    setType(authoritative.action);
    setReason(authoritative.reason);
    setFields({
      ...authoritative.parameters,
      ...(authoritative.target.interfaceId
        ? { interfaceId: authoritative.target.interfaceId }
        : {}),
    });
  }, [persistedIntent?.commandId, result, site.jobs]);

  const chooseType = (nextType: NetworkActionType) => {
    if (draftLocked) return;
    setType(nextType);
    setFields(initialFieldsFor(nextType));
    setConfirmation("");
    setResult(null);
    setError("");
  };

  const changeOpen = (nextOpen: boolean) => {
    setOpen(nextOpen);
    if (!nextOpen && !draftLocked) resetDraft();
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (draftLocked && !canRetryUnknown) return;
    setResult(null);
    setError("");
    setSubmitting(true);
    try {
      setResult(await onExecute({ type, reason, fields, confirmation }));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Không thể thực thi thao tác");
    } finally {
      setSubmitting(false);
    }
  };

  if (!executionAllowed) {
    return (
      <ExecuteButton
        canExecute={canExecute}
        rolloutState={site.rolloutState}
        disabledReason={disabledReason}
      >
        <Play data-icon="inline-start" aria-hidden="true" /> Thao tác MikroTik
      </ExecuteButton>
    );
  }

  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogTrigger asChild>
        <Button><Play data-icon="inline-start" aria-hidden="true" /> Thao tác MikroTik</Button>
      </DialogTrigger>
      <DialogContent className="network-center network-center-dialog nc-dialog nc-dialog-wide">
        <DialogHeader>
          <DialogTitle>{isDemo ? "Mô phỏng thao tác MikroTik cục bộ" : "Thao tác MikroTik"}</DialogTitle>
          <DialogDescription>
            {isDemo
              ? "Chỉ thay đổi bộ nhớ demo trong trình duyệt, không gọi router thật."
              : "Yêu cầu được kiểm tra, đưa vào hàng đợi worker và thực thi trực tiếp trên MikroTik mục tiêu."}
            {" "}Luồng: kiểm tra đầu vào → sao lưu → thực hiện → kiểm tra sau → hoàn tất.
          </DialogDescription>
        </DialogHeader>
        <form className="nc-form" onSubmit={submit}>
          <div className="nc-field">
            <Label>Loại thao tác</Label>
            <Select value={type} disabled={draftLocked} onValueChange={(value) => chooseType(value as NetworkActionType)}>
              <SelectTrigger aria-label="Loại thao tác"><SelectValue /></SelectTrigger>
              <SelectContent className="network-center nc-select-content">
                <SelectGroup>
                  {NETWORK_ACTION_DEFINITIONS.map((action) => (
                    <SelectItem key={action.type} value={action.type}>{action.label}</SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </div>

          <section className="nc-action-preview" aria-label="Xem trước thao tác">
            <div><span>Mục tiêu</span><strong>{site.buildingName} · {site.router.identity}</strong></div>
            <div><span>Rủi ro</span><strong><ShieldAlert aria-hidden="true" /> {definition.risk}</strong></div>
            <div><span>Trước / Sau</span><strong>{definition.preview}</strong></div>
            <div><span>Sao lưu</span><strong>{definition.backupRule}</strong></div>
            <div><span>Kiểm tra sau</span><strong>{definition.postCheck}</strong></div>
          </section>

          {definition.fields.map((field) => field.type === "select" ? (
            <div className="nc-field" key={field.key}>
              <Label>{field.label}</Label>
              <Select
                value={String(fields[field.key] ?? "")}
                disabled={draftLocked}
                onValueChange={(value) => setFields((current) => ({ ...current, [field.key]: value }))}
              >
                <SelectTrigger aria-label={field.label}><SelectValue placeholder="Chọn cổng LAN đang UP" /></SelectTrigger>
                <SelectContent className="network-center nc-select-content">
                  <SelectGroup>
                    {lanInterfaces.map((networkInterface) => (
                      <SelectItem key={networkInterface.id} value={networkInterface.id}>{networkInterface.name}</SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </div>
          ) : (
            <div className="nc-field" key={field.key}>
              <Label htmlFor={`action-${field.key}`}>{field.label}</Label>
              <Input
                id={`action-${field.key}`}
                type="number"
                min={field.min}
                max={field.max}
                value={String(fields[field.key] ?? field.defaultValue ?? "")}
                disabled={draftLocked}
                onChange={(event) => setFields((current) => ({ ...current, [field.key]: Number(event.target.value) }))}
              />
            </div>
          ))}

          <div className="nc-field">
            <Label htmlFor="network-action-reason">Lý do thao tác</Label>
            <Textarea
              id="network-action-reason"
              value={reason}
              disabled={draftLocked}
              onChange={(event) => setReason(event.target.value)}
              placeholder="Nêu lý do vận hành cụ thể"
            />
          </div>

          {definition.requiresIdentity ? (
            <div className="nc-field">
              <Label htmlFor="router-confirmation">Gõ chính xác {site.router.identity} để xác nhận</Label>
              <Input
                id="router-confirmation"
                value={confirmation}
                disabled={draftLocked}
                onChange={(event) => setConfirmation(event.target.value)}
                autoComplete="off"
              />
            </div>
          ) : null}

          {error ? <p className="nc-form-error" role="alert">{error}</p> : null}
          <div className="nc-job-result" aria-live="polite">
            {result ? (
              <>
                <strong>{result.result}</strong>
                <ol>{result.stages.map((stage) => <li key={stage.key}>✓ {stage.label}: {stage.detail}</li>)}</ol>
              </>
            ) : isDemo ? "Kết quả mô phỏng cục bộ sẽ xuất hiện tại đây." : "Trạng thái hàng đợi sẽ xuất hiện tại đây."}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => changeOpen(false)}>Đóng</Button>
            <Button type="submit" disabled={!executionAllowed || (draftLocked && !canRetryUnknown)}>
              {submitting
                ? "Đang gửi…"
                : canRetryUnknown
                  ? "Thử gửi lại an toàn"
                  : draftLocked
                    ? "Đang theo dõi intent hiện tại"
                    : isDemo
                      ? "Kiểm tra và mô phỏng cục bộ"
                      : "Kiểm tra và thực thi"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
