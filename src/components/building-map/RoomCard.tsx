import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { formatCurrency } from "@/lib/utils";
import { Home, Users, AlertCircle } from "lucide-react";

export type RoomStatus = "AVAILABLE" | "OCCUPIED" | "RESERVED" | "EXPIRING_SOON" | "MAINTENANCE";

interface RoomCardProps {
  id: string;
  name: string;
  price: number;
  status: RoomStatus;
  tenantName?: string;
  daysUntilExpiry?: number;
  onClick?: () => void;
}

const STATUS_CONFIG = {
  AVAILABLE: {
    label: "Trống",
    color: "bg-red-50 border-red-200 hover:bg-red-100",
    badge: "bg-red-100 text-red-800",
    icon: Home,
    iconColor: "text-red-600",
  },
  OCCUPIED: {
    label: "Đang thuê",
    color: "bg-green-50 border-green-200 hover:bg-green-100",
    badge: "bg-green-100 text-green-800",
    icon: Users,
    iconColor: "text-green-600",
  },
  RESERVED: {
    label: "Đã đặt cọc",
    color: "bg-orange-50 border-orange-200 hover:bg-orange-100",
    badge: "bg-orange-100 text-orange-800",
    icon: AlertCircle,
    iconColor: "text-orange-600",
  },
  EXPIRING_SOON: {
    label: "Sắp trống",
    color: "bg-purple-50 border-purple-200 hover:bg-purple-100",
    badge: "bg-purple-100 text-purple-800",
    icon: AlertCircle,
    iconColor: "text-purple-600",
  },
  MAINTENANCE: {
    label: "Ngừng hoạt động",
    color: "bg-gray-50 border-gray-200 hover:bg-gray-100",
    badge: "bg-gray-100 text-gray-800",
    icon: AlertCircle,
    iconColor: "text-gray-600",
  },
};

export function RoomCard({
  name,
  price,
  status,
  tenantName,
  daysUntilExpiry,
  onClick,
}: RoomCardProps) {
  const config = STATUS_CONFIG[status];
  const Icon = config.icon;

  return (
    <Card
      className={`${config.color} border-2 cursor-pointer transition-all hover:shadow-md`}
      onClick={onClick}
    >
      <CardContent className="p-4">
        <div className="space-y-2">
          {/* Room name and icon */}
          <div className="flex items-center justify-between">
            <h3 className="font-semibold text-lg">{name}</h3>
            <Icon className={`w-5 h-5 ${config.iconColor}`} />
          </div>

          {/* Price */}
          <p className="text-sm font-medium text-muted-foreground">
            {formatCurrency(price)}/tháng
          </p>

          {/* Status badge */}
          <Badge className={`${config.badge} text-xs`}>
            {config.label}
          </Badge>

          {/* Tenant name for occupied rooms */}
          {tenantName && status === "OCCUPIED" && (
            <p className="text-xs text-muted-foreground truncate">
              {tenantName}
            </p>
          )}

          {/* Days until expiry for expiring soon */}
          {status === "EXPIRING_SOON" && daysUntilExpiry !== undefined && (
            <p className="text-xs text-purple-700 font-medium">
              Còn {daysUntilExpiry} ngày
            </p>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
