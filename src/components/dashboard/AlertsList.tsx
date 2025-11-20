import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { AlertCircle, AlertTriangle, Info } from "lucide-react";
import { useAlerts } from "@/hooks/useDashboard";
import { useNavigate } from "react-router-dom";
import { format } from "date-fns";
import { vi } from "date-fns/locale";

export function AlertsList() {
  const { data: alerts = [], isLoading } = useAlerts();
  const navigate = useNavigate();

  const getSeverityConfig = (severity: string) => {
    switch (severity) {
      case "high":
        return {
          icon: AlertCircle,
          color: "text-red-600",
          bgColor: "bg-red-100",
          badge: "bg-red-100 text-red-800",
        };
      case "medium":
        return {
          icon: AlertTriangle,
          color: "text-orange-600",
          bgColor: "bg-orange-100",
          badge: "bg-orange-100 text-orange-800",
        };
      default:
        return {
          icon: Info,
          color: "text-blue-600",
          bgColor: "bg-blue-100",
          badge: "bg-blue-100 text-blue-800",
        };
    }
  };

  const getTypeLabel = (type: string) => {
    switch (type) {
      case "overdue_invoice":
        return "Hóa đơn quá hạn";
      case "expiring_contract":
        return "Hợp đồng hết hạn";
      case "urgent_issue":
        return "Sự cố khẩn cấp";
      default:
        return "Thông báo";
    }
  };

  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Cảnh báo & Thông báo</CardTitle>
          <CardDescription>Các vấn đề cần xử lý</CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-center text-muted-foreground py-8">Đang tải...</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center justify-between">
          <span>Cảnh báo & Thông báo</span>
          <Badge variant="outline">{alerts.length} cảnh báo</Badge>
        </CardTitle>
        <CardDescription>Các vấn đề cần được xử lý</CardDescription>
      </CardHeader>
      <CardContent>
        {alerts.length === 0 ? (
          <div className="text-center py-8">
            <p className="text-muted-foreground">Không có cảnh báo nào</p>
            <p className="text-sm text-muted-foreground mt-1">
              Hệ thống đang hoạt động bình thường
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {alerts.map((alert) => {
              const config = getSeverityConfig(alert.severity);
              const Icon = config.icon;

              return (
                <div
                  key={alert.id}
                  onClick={() => alert.link && navigate(alert.link)}
                  className={`flex gap-3 p-3 rounded-lg border ${
                    alert.link ? "cursor-pointer hover:bg-gray-50" : ""
                  }`}
                >
                  <div className={`flex-shrink-0 w-10 h-10 rounded-full ${config.bgColor} flex items-center justify-center`}>
                    <Icon className={`w-5 h-5 ${config.color}`} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-start justify-between gap-2 mb-1">
                      <p className="font-medium text-sm">{alert.title}</p>
                      <Badge className={config.badge} variant="secondary">
                        {getTypeLabel(alert.type)}
                      </Badge>
                    </div>
                    <p className="text-sm text-muted-foreground line-clamp-2">
                      {alert.description}
                    </p>
                    <p className="text-xs text-muted-foreground mt-1">
                      {format(new Date(alert.date), "dd/MM/yyyy HH:mm", { locale: vi })}
                    </p>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
