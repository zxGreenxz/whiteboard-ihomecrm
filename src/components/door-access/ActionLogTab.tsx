import { useMemo } from "react";
import { Loader2, RefreshCw } from "lucide-react";

import { LoadingState, RefreshBar } from "@/components/loading/LoadingState";
import { Button } from "@/components/ui/button";
import { useDoorActionLogs } from "@/hooks/door-access/useDoorAccessQueries";
import type { DoorDevice } from "@/lib/door-access/dto";
import type { DoorAccessCaller } from "@/lib/door-access/edge";
import { doorErrorMessage } from "@/lib/door-access/errors";
import { ACTION_LABEL, formatDayTime, logDetailText, logStatus, type LogStatusTone } from "@/lib/door-access/format";
import { mergeLogPages } from "@/lib/door-access/view";
import { cn } from "@/lib/utils";

import { ErrorPanel, Notice, Pill } from "./parts";

const STATUS_TONE: Record<LogStatusTone, "green" | "red" | "amber" | "muted"> = {
  ok: "green",
  failed: "red",
  unknown: "amber",
  pending: "muted",
};

export function ActionLogTab({ caller, device }: { caller: DoorAccessCaller; device: DoorDevice }) {
  const logs = useDoorActionLogs(caller, device.id);
  const rows = useMemo(() => mergeLogPages(logs.data?.pages ?? []), [logs.data]);
  const now = Date.now();

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">Thao tác ghi từ CRM trên máy này, mới nhất trước.</p>
        <Button type="button" size="sm" variant="ghost" disabled={logs.isFetching} onClick={() => void logs.refetch()}>
          <RefreshCw className={cn("mr-1.5 h-4 w-4", logs.isFetching && "animate-spin")} aria-hidden="true" />
          Làm mới
        </Button>
      </div>
      {logs.data === undefined && logs.isPending && <LoadingState label="nhật ký thao tác" variant="list" rows={4} />}
      {logs.data === undefined && logs.isError && (
        <ErrorPanel error={logs.error} title="Chưa tải được nhật ký thao tác" onRetry={() => void logs.refetch()} />
      )}
      {logs.data !== undefined && rows.length === 0 && (
        <p className="rounded-xl border border-dashed px-4 py-10 text-center text-sm text-muted-foreground">
          Chưa có thao tác nào từ CRM trên máy này.
        </p>
      )}
      {rows.length > 0 && (
        <div className="relative">
          <RefreshBar active={logs.isFetching && !logs.isFetchingNextPage} />
          <ul className="divide-y rounded-xl border bg-card" aria-label="Nhật ký thao tác">
            {rows.map((log) => {
              const status = logStatus(log, now);
              const detail = logDetailText(log);
              return (
                <li key={log.id} className="space-y-1 px-3 py-2.5">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span className="text-sm tabular-nums text-muted-foreground">{formatDayTime(Date.parse(log.created_at))}</span>
                    <span className="text-sm font-medium">{ACTION_LABEL[log.action]}</span>
                    <Pill tone={STATUS_TONE[status.tone]}>{status.label}</Pill>
                  </div>
                  <p className="text-sm">
                    {log.actor_name ?? "Không rõ người làm"}
                    {detail && <span className="text-muted-foreground"> · {detail}</span>}
                  </p>
                  {log.status !== "OK" && log.error_message && (
                    <p className="break-words text-xs text-destructive">
                      {log.error_code ? `${log.error_code}: ` : ""}
                      {log.error_message}
                    </p>
                  )}
                </li>
              );
            })}
          </ul>
          {logs.hasNextPage && (
            <div className="mt-3 flex justify-center">
              <Button type="button" variant="outline" disabled={logs.isFetchingNextPage} onClick={() => void logs.fetchNextPage()}>
                {logs.isFetchingNextPage && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" aria-hidden="true" />}
                Xem thêm
              </Button>
            </div>
          )}
        </div>
      )}
      {logs.data !== undefined && logs.isFetchNextPageError && (
        <Notice tone="error">Chưa tải thêm được: {doorErrorMessage(logs.error)} Bấm Xem thêm để thử lại.</Notice>
      )}
      {logs.data !== undefined && logs.isRefetchError && (
        <Notice tone="warning">Chưa làm mới được — đang hiện nhật ký lần trước.</Notice>
      )}
    </div>
  );
}
