import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { ArrowLeft } from "lucide-react";
import { cn } from "@/lib/utils";
import type { Tone } from "@/lib/staffDay";

const AVATAR_COLORS = ["bg-primary", "bg-blue-500", "bg-violet-500", "bg-amber-600", "bg-rose-500", "bg-teal-600"];

export function avatarColor(name: string): string {
  let hash = 0;
  for (const ch of name) hash = (hash * 31 + ch.charCodeAt(0)) % 997;
  return AVATAR_COLORS[hash % AVATAR_COLORS.length] ?? "bg-primary";
}

export function PersonAvatar({ name, size = "md" }: { name: string; size?: "sm" | "md" }) {
  return (
    <div
      aria-hidden="true"
      className={cn(
        "flex shrink-0 items-center justify-center rounded-full font-bold text-white",
        size === "sm" ? "h-7 w-7 text-xs" : "h-10 w-10",
        avatarColor(name),
      )}
    >
      {name.trim().charAt(0).toUpperCase()}
    </div>
  );
}

export function StaffShell({ wide, children }: { wide?: boolean; children: ReactNode }) {
  return (
    <div className="min-h-dvh bg-slate-50">
      <div className={cn("mx-auto space-y-3 px-4 pb-24 pt-4", wide ? "max-w-[1280px] lg:px-6" : "max-w-[480px]")}>
        {children}
      </div>
    </div>
  );
}

export function StaffHeader({ backTo, backLabel, title, sub, right }: {
  backTo: string;
  backLabel: string;
  title: string;
  sub?: ReactNode;
  right?: ReactNode;
}) {
  return (
    <div className="flex items-center gap-2">
      <Link to={backTo} aria-label={backLabel} className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full hover:bg-slate-200">
        <ArrowLeft className="h-5 w-5" aria-hidden="true" />
      </Link>
      <div className="min-w-0 flex-1">
        <h1 className="truncate text-lg font-bold tracking-tight">{title}</h1>
        {sub ? <p className="truncate text-xs text-muted-foreground">{sub}</p> : null}
      </div>
      {right}
    </div>
  );
}

export function Card({ label, className, children }: { label: string; className?: string; children: ReactNode }) {
  return (
    <section aria-label={label} className={cn("flex flex-col gap-2.5 rounded-2xl border bg-white p-3.5 shadow-sm", className)}>
      {children}
    </section>
  );
}

export function CardTitle({ icon, children, right }: { icon?: ReactNode; children: ReactNode; right?: ReactNode }) {
  return (
    <div className="flex items-center gap-2 font-bold">
      {icon}
      <h2 className="text-sm font-bold">{children}</h2>
      {right ? <div className="ml-auto text-xs font-medium text-muted-foreground">{right}</div> : null}
    </div>
  );
}

const TONE_CLASS: Record<Tone, string> = {
  success: "border-emerald-200 bg-emerald-50 text-emerald-800",
  warning: "border-amber-200 bg-amber-50 text-amber-800",
  danger: "border-red-200 bg-red-50 text-red-700",
  info: "border-sky-200 bg-sky-50 text-sky-800",
  neutral: "border-slate-200 bg-slate-100 text-slate-700",
};

export function StatusPill({ tone, children, className }: { tone: Tone; children: ReactNode; className?: string }) {
  return (
    <span className={cn("inline-flex items-center whitespace-nowrap rounded-full border px-2 py-0.5 text-xs font-semibold", TONE_CLASS[tone], className)}>
      {children}
    </span>
  );
}

export function StatTile({ label, value, of, alert }: { label: string; value: ReactNode; of?: ReactNode; alert?: boolean }) {
  return (
    <div className="rounded-[10px] bg-slate-100 px-2.5 py-2">
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div className={cn("font-mono text-lg font-bold", alert && "text-orange-700")}>
        {value}
        {of != null ? <span className="text-xs text-muted-foreground">/{of}</span> : null}
      </div>
    </div>
  );
}
