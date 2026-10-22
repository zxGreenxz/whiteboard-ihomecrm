import { useMemo, useState } from "react";
import { Loader2, RefreshCw } from "lucide-react";

import { LoadingState, RefreshBar } from "@/components/loading/LoadingState";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useDoorKeyLinks, useDoorRecords, useDoorTempPasswordLogs } from "@/hooks/door-access/useDoorAccessQueries";
import type { DoorDevice } from "@/lib/door-access/dto";
import type { DoorAccessCaller } from "@/lib/door-access/edge";
import { doorErrorMessage } from "@/lib/door-access/errors";
import { DAY_MS, formatDayTime, recordMethodLabel, vnDate } from "@/lib/door-access/format";
import { indexLinks, indexTempPasswordNames, mergeRecordPages, recordPerson } from "@/lib/door-access/records";
import { historyRange } from "@/lib/door-access/view";
import { cn } from "@/lib/utils";

import { ErrorPanel, Notice, Pill } from "./parts";

type Quick = "today" | "7d" | null;

export function HistoryTab({ caller, device }: { caller: DoorAccessCaller; device: DoorDevice }) {
  const today = vnDate(Date.now());
  const [from, setFrom] = useState(today);
  const [to, setTo] = useState(today);
  const [quick, setQuick] = useState<Quick>("today");
  const { range, problem } = useMemo(() => historyRange(from, to), [from, to]);

  const records = useDoorRecords(caller, device.id, range);
  const links = useDoorKeyLinks(caller, device.id);
  const linkIndex = useMemo(() => indexLinks(links.data ?? []), [links.data]);
  // Tên mật khẩu tạm tạo từ CRM — lỗi tải thì cột Người chỉ thiếu tên, không chặn lịch sử.
  const tempLogs = useDoorTempPasswordLogs(caller, device.id);
  const tempNames = useMemo(() => indexTempPasswordNames(tempLogs.data?.logs ?? []), [tempLogs.data]);
  const rows = useMemo(() => mergeRecordPages(records.data?.pages ?? []), [records.data]);

  const pickQuick = (value: Exclude<Quick, null>) => {
    const now = Date.now();
    const end = vnDate(now);
    setTo(end);
    setFrom(value === "today" ? end : vnDate(now - 6 * DAY_MS));
    setQuick(value);
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-2">
        <div className="flex gap-1.5" role="group" aria-label="Chọn nhanh khoảng ngày">
          {(["today", "7d"] as const).map((value) => (
            <Button
              key={value}
              type="button"
              size="sm"
              variant={quick === value ? "default" : "outline"}
              aria-pressed={quick === value}
              onClick={() => pickQuick(value)}
            >
              {value === "today" ? "Hôm nay" : "7 ngày"}
            </Button>
          ))}
        </div>
        <div className="grid grid-cols-2 gap-2">
          <div>
            <Label htmlFor="door-history-from" className="text-xs">
              Từ ngày
            </Label>
            <Input
              id="door-history-from"
              type="date"
              value={from}
              max={to || undefined}
              className="h-9"
              onChange={(event) => {
                setFrom(event.target.value);
                setQuick(null);
              }}
            />
          </div>
          <div>
            <Label htmlFor="door-history-to" className="text-xs">
              Đến ngày
            </Label>
            <Input
              id="door-history-to"
              type="date"
              value={to}
              min={from || undefined}
              className="h-9"
              onChange={(event) => {
                setTo(event.target.value);
                setQuick(null);
              }}
            />
          </div>
        </div>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="ml-auto"
          disabled={!range || records.isFetching}
          onClick={() => void records.refetch()}
        >
          <RefreshCw className={cn("mr-1.5 h-4 w-4", records.isFetching && "animate-spin")} aria-hidden="true" />
          Làm mới
        </Button>
      </div>

      {problem && <Notice tone="error">{problem}</Notice>}
      {links.isError && (
        <Notice tone="warning">
          Chưa tải được danh sách gắn khách — cột Người chỉ hiện tên trên máy.{" "}
          <button type="button" className="font-medium underline" onClick={() => void links.refetch()}>
            Tải lại
          </button>
        </Notice>
      )}

      {range && records.data === undefined && records.isPending && <LoadingState label="lịch sử ra vào" variant="list" rows={5} />}
      {range && records.data === undefined && records.isError && (
        <ErrorPanel error={records.error} title="Chưa tải được lịch sử ra vào" onRetry={() => void records.refetch()} />
      )}
      {range && records.data !== undefined && rows.length === 0 && (
        <p className="rounded-xl border border-dashed px-4 py-10 text-center text-sm text-muted-foreground">
          Không có lượt ra vào nào trong khoảng ngày này.
        </p>
      )}
      {range && records.data !== undefined && rows.length > 0 && (
        <div className="relative">
          <RefreshBar active={records.isFetching && !records.isFetchingNextPage} />
          <ul className="divide-y rounded-xl border bg-card" aria-label="Lịch sử ra vào">
            {rows.map((record) => {
              const person = recordPerson(record, linkIndex, tempNames);
              return (
                <li key={record.id} className="grid grid-cols-[4.75rem_1fr] gap-x-3 gap-y-0.5 px-3 py-2.5 sm:grid-cols-[6rem_11rem_1fr]">
                  <span className="text-sm tabular-nums text-muted-foreground">{record.at === null ? "—" : formatDayTime(record.at)}</span>
                  <span className="text-sm font-medium">
                    {record.kind === "alarm" ? <Pill tone="red">{recordMethodLabel(record)}</Pill> : recordMethodLabel(record)}
                  </span>
                  <span className="col-start-2 min-w-0 text-sm sm:col-start-auto">
                    <span className={cn(person.source === "none" && "text-muted-foreground")}>{person.name}</span>
                    {person.detail && <span className="text-muted-foreground"> · {person.detail}</span>}
                    {person.link?.tenancy === "MOVED_OUT" && (
                      <span className="ml-1.5">
                        <Pill tone="red">Đã trả phòng</Pill>
                      </span>
                    )}
                  </span>
                </li>
              );
            })}
          </ul>
          {records.hasNextPage && (
            <div className="mt-3 flex justify-center">
              <Button type="button" variant="outline" disabled={records.isFetchingNextPage} onClick={() => void records.fetchNextPage()}>
                {records.isFetchingNextPage && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" aria-hidden="true" />}
                Xem thêm
              </Button>
            </div>
          )}
        </div>
      )}
      {records.data !== undefined && records.isFetchNextPageError && (
        <Notice tone="error">Chưa tải thêm được: {doorErrorMessage(records.error)} Bấm Xem thêm để thử lại.</Notice>
      )}
      {records.data !== undefined && records.isRefetchError && (
        <Notice tone="warning">Chưa làm mới được — đang hiện dữ liệu lần trước. Bấm Làm mới để thử lại.</Notice>
      )}
    </div>
  );
}
