import { Link } from "react-router-dom";
import { Users } from "lucide-react";
import { cn } from "@/lib/utils";
import { useStaffDayTeam, useStaffViewer } from "@/hooks/staff-day/useStaffDay";

const chip = "flex h-9 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-3.5 text-[13px] font-medium";
const chipOn = "border-primary bg-primary font-semibold text-primary-foreground";
const chipOff = "bg-white text-foreground hover:bg-slate-100";

const DOT: Record<string, string> = {
  ticked: "bg-emerald-600",
  leave_approved: "bg-sky-500",
  pending_leave: "bg-sky-500",
  flagged: "bg-red-600",
  voided: "bg-red-600",
};

/** `active`: "team", "me" hoặc id người đang xem. Chỉ hiện với Chủ công ty/super admin. */
export function PersonPicker({ active }: { active: string }) {
  const viewer = useStaffViewer();
  const team = useStaffDayTeam(undefined, viewer.canView, true);
  if (!viewer.canView) return null;

  return (
    <nav aria-label="Chọn người để xem" className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-0.5">
      <Link to="/my-day/team" aria-current={active === "team" ? "page" : undefined} className={cn(chip, active === "team" ? chipOn : chipOff)}>
        <Users className="h-4 w-4" aria-hidden="true" /> Cả đội
      </Link>
      <Link to="/my-day" aria-current={active === "me" ? "page" : undefined} className={cn(chip, active === "me" ? chipOn : chipOff)}>
        Tôi
      </Link>
      {(team.data?.members ?? []).map((member) => {
        const on = active === member.user.id;
        return (
          <Link
            key={member.user.id}
            to={`/my-day/nguoi/${member.user.id}`}
            aria-current={on ? "page" : undefined}
            className={cn(chip, on ? chipOn : chipOff)}
          >
            {!on && <span aria-hidden="true" className={cn("h-2 w-2 rounded-full", DOT[member.day.status] ?? "bg-amber-500")} />}
            {member.user.name}
          </Link>
        );
      })}
    </nav>
  );
}
