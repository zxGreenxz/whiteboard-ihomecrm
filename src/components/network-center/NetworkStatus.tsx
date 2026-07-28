import {
  AlertTriangle,
  CheckCircle2,
  CircleDot,
  CircleX,
  Clock3,
  ShieldCheck,
} from "lucide-react";

import type {
  BackupStatus,
  IncidentSeverity,
  IncidentStatus,
  NetworkHealth,
} from "@/lib/network-center/contracts";

type StatusKind =
  | NetworkHealth
  | BackupStatus
  | IncidentSeverity
  | IncidentStatus
  | "maintenance"
  | "view-only"
  | "execute";

const config: Record<StatusKind, { label: string; icon: typeof CheckCircle2; tone: string }> = {
  online: { label: "Hoạt động tốt", icon: CheckCircle2, tone: "good" },
  degraded: { label: "Suy giảm", icon: AlertTriangle, tone: "warn" },
  offline: { label: "Mất kết nối", icon: CircleX, tone: "bad" },
  fresh: { label: "Backup mới", icon: ShieldCheck, tone: "good" },
  stale: { label: "Backup cũ", icon: Clock3, tone: "warn" },
  critical: { label: "Nghiêm trọng", icon: CircleX, tone: "bad" },
  high: { label: "Cao", icon: AlertTriangle, tone: "bad" },
  medium: { label: "Trung bình", icon: AlertTriangle, tone: "warn" },
  low: { label: "Thấp", icon: CircleDot, tone: "info" },
  open: { label: "Đang mở", icon: CircleX, tone: "bad" },
  acknowledged: { label: "Đã xác nhận", icon: CheckCircle2, tone: "info" },
  resolved: { label: "Đã phục hồi", icon: CheckCircle2, tone: "good" },
  maintenance: { label: "Đang bảo trì", icon: Clock3, tone: "warn" },
  "view-only": { label: "Chỉ xem", icon: ShieldCheck, tone: "neutral" },
  execute: { label: "Được thực thi", icon: ShieldCheck, tone: "good" },
};

export function NetworkStatus({ kind, label }: { kind: StatusKind; label?: string }) {
  const item = config[kind];
  const Icon = item.icon;
  return (
    <span className={`nc-status nc-status-${item.tone}`}>
      <Icon aria-hidden="true" />
      <span>{label ?? item.label}</span>
    </span>
  );
}
