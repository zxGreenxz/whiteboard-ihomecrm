import {
  directoryFreshness,
  OPENCLAW_CRM_EVENT_TYPES,
  scheduleActions,
  type OpenClawScheduleStatus,
  type SalesGroupView,
  type ScheduleAction,
} from "@/lib/openclaw-zalo/schedules";

export interface ScheduleView {
  scheduleId: string;
  status: OpenClawScheduleStatus;
  timezone: string;
  localRecurrenceRule: string;
  /** Computed by the server; the browser must not recompute it - see below. */
  nextRunAt: string | null;
  missedOccurrencePolicy: string;
}

interface OpenClawSchedulesAndGroupsProps {
  groups: readonly SalesGroupView[];
  schedules: readonly ScheduleView[];
  loading: boolean;
  canManage: boolean;
  now: string;
  busy: boolean;
  onToggleAllowlist: (group: SalesGroupView) => void;
  onRequestDirectorySync: () => void;
  onScheduleAction: (action: ScheduleAction, schedule: ScheduleView) => void;
}

const FRESHNESS_COPY = {
  FRESH: "Danh bạ còn hạn",
  STALE: "Danh bạ quá hạn",
  UNKNOWN: "Không rõ hạn danh bạ",
} as const;

const STATUS_COPY: Record<OpenClawScheduleStatus, string> = {
  PAUSED: "Đang tạm dừng",
  // The one status that means live and sending. It was missing, so React rendered
  // an empty line for it - on a screen that tells the operator activation happens
  // elsewhere, which made a running schedule invisible.
  ACTIVE: "Đang chạy",
  CANCELLED: "Đã huỷ",
  COMPLETE: "Đã xong",
};

const ACTION_COPY: Record<ScheduleAction, string> = {
  pause: "Tạm dừng",
  cancel: "Huỷ",
};

const SCHEDULE_BLOCK_COPY = {
  PERMISSION: "Cần quyền quản lý tự động hoá.",
  STATUS: "Không hợp lệ ở trạng thái hiện tại.",
} as const;

export default function OpenClawSchedulesAndGroups(props: OpenClawSchedulesAndGroupsProps) {
  if (props.loading && props.groups.length === 0 && props.schedules.length === 0) {
    return (
      <p data-openclaw-schedules="loading" className="p-4 text-sm text-[#607585]">
        Đang tải nhóm và lịch…
      </p>
    );
  }

  return (
    <div className="grid gap-6 p-4">
      <section data-openclaw-schedules="groups">
        <h2 className="text-lg font-black tracking-[-0.02em]">Nhóm sale</h2>
        {/* The list RPC does not return the Zalo provider group id, so selection is by
            the internal target id. Saying so keeps "exact stable ID" from reading as
            a promise the data cannot support. */}
        <p className="mt-1 text-xs leading-5 text-[#607585]">
          Chọn theo định danh nội bộ của nhóm. Máy chủ không trả về mã nhóm phía Zalo, nên ở đây
          không đối chiếu được với mã bạn thấy trong ứng dụng Zalo.
        </p>

        {props.groups.length === 0 ? (
          <p data-openclaw-schedules="groups-empty" className="mt-3 text-sm text-[#607585]">
            Chưa có nhóm nào trong danh bạ.
          </p>
        ) : (
          <ul className="mt-3 grid gap-2">
            {props.groups.map(group => {
              const freshness = directoryFreshness(group, props.now);
              return (
                <li
                  key={group.targetId}
                  data-openclaw-group={group.targetId}
                  className="border border-[#cbd5df] bg-white p-3"
                >
                  <p className="text-sm font-bold">{group.displayName}</p>
                  <p className="mt-1 text-xs leading-5 text-[#607585]">
                    {group.memberCount} thành viên · danh bạ v{group.directoryVersion} ·{" "}
                    <span data-openclaw-freshness={freshness}>{FRESHNESS_COPY[freshness]}</span>
                  </p>
                  <button
                    type="button"
                    onClick={() => props.onToggleAllowlist(group)}
                    disabled={!props.canManage || props.busy}
                    data-openclaw-action="toggle-allowlist"
                    className="mt-2 min-h-11 w-full border border-[#9fb0bf] bg-white px-3 text-sm font-bold disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {group.isAllowed === true ? "Bỏ khỏi danh sách cho phép" : "Cho phép nhóm này"}
                  </button>
                </li>
              );
            })}
          </ul>
        )}

        <button
          type="button"
          onClick={props.onRequestDirectorySync}
          disabled={!props.canManage || props.busy}
          data-openclaw-action="request-directory-sync"
          className="mt-3 min-h-11 w-full border border-[#9fb0bf] bg-white px-4 text-sm font-bold disabled:cursor-not-allowed disabled:opacity-60"
        >
          Yêu cầu đồng bộ danh bạ
        </button>
        {/* Fire-and-forget: there is no status read path and no realtime for this, so
            a determinate progress indicator would be invented. */}
        <p className="mt-1 text-xs leading-5 text-[#607585]">
          Yêu cầu được xếp hàng; không có đường theo dõi tiến độ, nên hãy tải lại danh sách sau
          ít phút để xem đã cập nhật chưa.
        </p>
        <p className="mt-1 text-xs leading-5 text-[#8a4b12]">
          Trạng thái hạn danh bạ ở đây chỉ mang tính tham khảo. Mốc thời gian mà máy chủ thực sự
          đối chiếu nằm ở bảng khác và không được trả về, nên thao tác vẫn có thể bị từ chối vì
          quá hạn dù ở đây hiện còn hạn.
        </p>
      </section>

      <section data-openclaw-schedules="list">
        <h2 className="text-lg font-black tracking-[-0.02em]">Lịch gửi</h2>
        {props.schedules.length === 0 ? (
          <p data-openclaw-schedules="empty" className="mt-2 text-sm text-[#607585]">
            Chưa có lịch nào.
          </p>
        ) : (
          <ul className="mt-2 grid gap-2">
            {props.schedules.map(schedule => {
              const actions = scheduleActions({
                canManage: props.canManage,
                status: schedule.status,
              });
              return (
                <li
                  key={schedule.scheduleId}
                  data-openclaw-schedule={schedule.scheduleId}
                  className="border border-[#cbd5df] bg-white p-3"
                >
                  <p className="text-sm font-bold" data-openclaw-schedule-status={schedule.status}>
                    {STATUS_COPY[schedule.status]}
                  </p>
                  <p className="mt-1 font-mono text-xs text-[#526777]">
                    {schedule.timezone} · {schedule.localRecurrenceRule}
                  </p>
                  {/* Server-computed. DST gap and fold resolution live in columns the
                      browser cannot read, so a locally computed "next run" would
                      disagree with reality exactly on the days it matters. */}
                  <p className="mt-1 text-xs leading-5 text-[#607585]">
                    Lần chạy kế tiếp: {schedule.nextRunAt ?? "chưa xác định"}
                  </p>
                  <p className="mt-1 text-xs leading-5 text-[#607585]">
                    Lỡ nhịp thì bỏ qua ({schedule.missedOccurrencePolicy}), không gửi bù.
                  </p>
                  <div className="mt-2 grid gap-2 sm:grid-cols-2">
                    {(Object.keys(ACTION_COPY) as ScheduleAction[]).map(action => (
                      <div key={action}>
                        <button
                          type="button"
                          onClick={() => props.onScheduleAction(action, schedule)}
                          disabled={!actions[action].enabled || props.busy}
                          data-openclaw-action={`schedule-${action}`}
                          className="min-h-11 w-full border border-[#9fb0bf] bg-white px-3 text-sm font-bold disabled:cursor-not-allowed disabled:opacity-60"
                        >
                          {ACTION_COPY[action]}
                        </button>
                        {/* A greyed button with no reason reads as a broken screen.
                            The knowledge screen states its reasons; so does this. */}
                        {actions[action].blockedBy !== null && (
                          <p
                            data-openclaw-schedule-blocked={`${action}:${actions[action].blockedBy}`}
                            className="mt-1 text-xs leading-5 text-[#8a4b12]"
                          >
                            {SCHEDULE_BLOCK_COPY[actions[action].blockedBy!]}
                          </p>
                        )}
                      </div>
                    ))}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
        {/* No Activate/Resume anywhere: no function in the migration set performs that
            transition, so the button could only ever fail. */}
        <p className="mt-2 text-xs leading-5 text-[#607585]">
          Lịch tạo ra ở trạng thái tạm dừng. Việc cho chạy nằm ngoài màn hình này, nên ở đây chỉ
          có tạm dừng và huỷ.
        </p>
      </section>

      <section data-openclaw-schedules="crm-events">
        <h2 className="text-lg font-black tracking-[-0.02em]">Sự kiện CRM kích hoạt</h2>
        <ul className="mt-2 grid gap-2">
          {OPENCLAW_CRM_EVENT_TYPES.map(event => (
            <li
              key={event.eventType}
              data-openclaw-crm-event={event.eventType}
              className="border border-[#cbd5df] bg-white p-3 text-sm"
            >
              <p className="font-bold">{event.label}</p>
              <p className="mt-1 font-mono text-xs text-[#526777]">
                {event.eventType} ← {event.canonicalSource}
              </p>
            </li>
          ))}
        </ul>
        {/* Read-only by necessity: there is no write RPC for subscriptions. */}
        <p className="mt-2 text-xs leading-5 text-[#607585]">
          Ba loại sự kiện này cố định trong lược đồ. Việc đăng ký nhận sự kiện chưa có đường ghi
          từ giao diện, nên đây là danh sách để tra cứu.
        </p>
      </section>
    </div>
  );
}
