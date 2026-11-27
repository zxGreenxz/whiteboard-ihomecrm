import { useMemo, useState } from "react";
import { CalendarDays, Loader2 } from "lucide-react";

import { useDoorKeyLinks, useDoorRecords, useDoorTempPasswordLogs } from "@/hooks/door-access/useDoorAccessQueries";
import type { DoorDevice } from "@/lib/door-access/dto";
import type { DoorAccessCaller } from "@/lib/door-access/edge";
import { doorErrorMessage } from "@/lib/door-access/errors";
import { DAY_MS, vnDate } from "@/lib/door-access/format";
import {
  HISTORY_FILTER_LABEL,
  dateRangeText,
  groupByDay,
  historyCounts,
  historyRow,
  recordFilterOf,
  visibleHistoryFilters,
  type HistoryFilter,
  type HistoryRow,
  type HistoryTone,
} from "@/lib/door-access/mobile";
import { indexLinks, indexTempPasswordNames, mergeRecordPages } from "@/lib/door-access/records";
import { indexTempPasswordLogs } from "@/lib/door-access/tempPassword";
import { HISTORY_MAX_DAYS, historyRange } from "@/lib/door-access/view";

import { MobileSheet } from "./MobileSheet";
import { MobileError, MobileLoading, MobileNotice } from "./mobileParts";

const PILL: Record<HistoryTone, string> = {
  fp: "pill pill-fp",
  plain: "pill pill-plain",
  temp: "pill pill-temp",
  remote: "pill pill-remote",
  alarm: "pill pill-alarm",
};

export function HistoryRows({ rows, label }: { rows: readonly HistoryRow[]; label: string }) {
  return (
    <ul className="card rows" aria-label={label}>
      {rows.map((row) => (
        <li key={row.id} className={row.alarm || row.movedOut ? "row alarm" : "row"}>
          <span className="row-time">{row.time}</span>
          <span className="row-main">
            <span className={row.muted ? "row-t mute" : "row-t"}>{row.who}</span>
            <span className="row-s" style={row.movedOut ? { color: "var(--red-ink)", fontWeight: 600 } : undefined}>
              {row.sub}
            </span>
          </span>
          <span className={PILL[row.tone]}>{row.how}</span>
        </li>
      ))}
    </ul>
  );
}

type Quick = "today" | "2d" | "7d" | "31d";
const QUICK_LABEL: Record<Quick, string> = { today: "Hôm nay", "2d": "2 ngày", "7d": "7 ngày", "31d": "31 ngày" };
const QUICK_DAYS: Record<Quick, number> = { today: 1, "2d": 2, "7d": 7, "31d": HISTORY_MAX_DAYS };

function RangeSheet({
  open,
  from,
  to,
  onClose,
  onApply,
}: {
  open: boolean;
  from: string;
  to: string;
  onClose: () => void;
  onApply: (from: string, to: string) => void;
}) {
  const [draft, setDraft] = useState({ from, to });
  const [lastOpen, setLastOpen] = useState(open);
  // Mỗi lần mở lại tấm: bắt đầu từ khoảng đang xem.
  if (open !== lastOpen) {
    setLastOpen(open);
    if (open) setDraft({ from, to });
  }
  const { problem } = historyRange(draft.from, draft.to);
  const pick = (quick: Quick) => {
    const now = Date.now();
    onApply(vnDate(now - (QUICK_DAYS[quick] - 1) * DAY_MS), vnDate(now));
  };
  return (
    <MobileSheet open={open} onClose={onClose} title="Chọn khoảng ngày" description={`Mỗi lần xem tối đa ${HISTORY_MAX_DAYS} ngày, đọc trực tiếp từ máy cửa.`}>
      <div className="seg" role="group" aria-label="Chọn nhanh">
        {(Object.keys(QUICK_LABEL) as Quick[]).map((quick) => (
          <button key={quick} type="button" onClick={() => pick(quick)}>
            {QUICK_LABEL[quick]}
          </button>
        ))}
      </div>
      <div className="grid grid-cols-2 gap-2">
        <label className="field" style={{ gap: 5 }}>
          <span className="hint" style={{ fontWeight: 600, color: "var(--ink-2)" }}>
            Từ ngày
          </span>
          <input
            className="input sm"
            type="date"
            value={draft.from}
            max={draft.to || undefined}
            aria-invalid={problem ? "true" : undefined}
            onChange={(event) => setDraft((current) => ({ ...current, from: event.target.value }))}
          />
        </label>
        <label className="field" style={{ gap: 5 }}>
          <span className="hint" style={{ fontWeight: 600, color: "var(--ink-2)" }}>
            Đến ngày
          </span>
          <input
            className="input sm"
            type="date"
            value={draft.to}
            min={draft.from || undefined}
            aria-invalid={problem ? "true" : undefined}
            onChange={(event) => setDraft((current) => ({ ...current, to: event.target.value }))}
          />
        </label>
      </div>
      {problem && (
        <p className="err" role="alert">
          {problem}
        </p>
      )}
      <button type="button" className="btn btn-primary btn-block" disabled={problem !== null} onClick={() => onApply(draft.from, draft.to)}>
        Xem lịch sử
      </button>
    </MobileSheet>
  );
}

export function MobileHistory({ caller, device }: { caller: DoorAccessCaller; device: DoorDevice }) {
  const today = vnDate(Date.now());
  const [from, setFrom] = useState(today);
  const [to, setTo] = useState(today);
  const [rangeOpen, setRangeOpen] = useState(false);
  const [filter, setFilter] = useState<HistoryFilter>("all");
  const { range } = useMemo(() => historyRange(from, to), [from, to]);

  const records = useDoorRecords(caller, device.id, range);
  const links = useDoorKeyLinks(caller, device.id);
  const tempLogs = useDoorTempPasswordLogs(caller, device.id);
  const all = useMemo(() => mergeRecordPages(records.data?.pages ?? []), [records.data]);
  const counts = useMemo(() => historyCounts(all), [all]);
  const chips = visibleHistoryFilters(counts, filter);
  const days = useMemo(() => {
    const linkIndex = indexLinks(links.data ?? []);
    const logs = tempLogs.data?.logs ?? [];
    const names = indexTempPasswordNames(logs);
    const byId = indexTempPasswordLogs(logs);
    const shown = all.filter((record) => filter === "all" || recordFilterOf(record) === filter);
    return groupByDay(
      shown.map((record) => historyRow(record, linkIndex, names, byId)),
      Date.now(),
    );
  }, [all, filter, links.data, tempLogs.data]);

  return (
    <>
      <button type="button" className="card flex min-h-[50px] items-center gap-2.5 px-3.5 text-left" onClick={() => setRangeOpen(true)}>
        <CalendarDays className="h-[18px] w-[18px] shrink-0 text-[var(--ink-2)]" aria-hidden="true" />
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-bold">{dateRangeText(from, to)}</span>
          <span className="block text-xs text-[var(--ink-mute)]">Mỗi lần xem tối đa {HISTORY_MAX_DAYS} ngày</span>
        </span>
        <span className="text-[13px] font-semibold text-[var(--brand)]">Đổi ngày</span>
      </button>

      <div className="hscroll" role="group" aria-label="Lọc theo cách mở">
        {chips.map((chip) => (
          <button key={chip} type="button" className="chip" aria-pressed={filter === chip} onClick={() => setFilter(chip)}>
            {HISTORY_FILTER_LABEL[chip]} <span className="n">{counts[chip]}</span>
          </button>
        ))}
      </div>

      {links.isError && (
        <MobileNotice tone="warn">
          Chưa tải được danh sách gắn khách — chỉ hiện tên trên máy.{" "}
          <button type="button" className="font-semibold underline" onClick={() => void links.refetch()}>
            Tải lại
          </button>
        </MobileNotice>
      )}
      {records.data === undefined && records.isPending && <MobileLoading text="Đang đọc lịch sử từ máy cửa…" />}
      {records.data === undefined && records.isError && (
        <MobileError error={records.error} title="Chưa tải được lịch sử ra vào" onRetry={() => void records.refetch()} />
      )}
      {records.data !== undefined && days.length === 0 && (
        <div className="card empty">
          {all.length === 0 ? "Không có lượt ra vào nào trong khoảng ngày này." : "Không có lượt nào khớp bộ lọc. Chọn Tất cả hoặc đổi ngày."}
        </div>
      )}
      {days.map((day) => (
        <section key={day.key} className="sec" aria-label={day.title}>
          <div className="sec-h">
            <h2>{day.title}</h2>
            <span className="count">{day.rows.length} lượt</span>
          </div>
          <HistoryRows rows={day.rows} label={`Lịch sử ${day.title}`} />
        </section>
      ))}
      {records.hasNextPage && (
        <button type="button" className="btn btn-ghost btn-block" disabled={records.isFetchingNextPage} onClick={() => void records.fetchNextPage()}>
          {records.isFetchingNextPage && <Loader2 className="animate-spin" aria-hidden="true" />}
          Tải thêm
        </button>
      )}
      {records.data !== undefined && records.isFetchNextPageError && (
        <MobileNotice tone="danger">Chưa tải thêm được: {doorErrorMessage(records.error)} Bấm Tải thêm để thử lại.</MobileNotice>
      )}
      {records.data !== undefined && records.isRefetchError && (
        <MobileNotice tone="warn">Chưa làm mới được — đang hiện dữ liệu lần trước.</MobileNotice>
      )}

      <RangeSheet
        open={rangeOpen}
        from={from}
        to={to}
        onClose={() => setRangeOpen(false)}
        onApply={(nextFrom, nextTo) => {
          setFrom(nextFrom);
          setTo(nextTo);
          setFilter("all");
          setRangeOpen(false);
        }}
      />
    </>
  );
}
