import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Gauge, CheckCircle, Clock, Zap, Droplet } from "lucide-react";
import { useMeterReadingStats } from "@/hooks/useMeterReadings";

interface MeterReadingStatsProps {
  buildingId?: string;
  month?: string;
}

export function MeterReadingStats({ buildingId, month }: MeterReadingStatsProps) {
  const { data: stats, isLoading } = useMeterReadingStats(buildingId, month);

  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
      {/* Công tơ chưa chốt */}
      <Card className="border-l-4 border-l-slate-500 hover:shadow-md transition-shadow">
        <CardHeader className="flex flex-row items-center justify-between pb-2 space-y-0">
          <CardTitle className="text-sm font-medium text-muted-foreground">Công tơ chưa chốt</CardTitle>
          <div className="h-10 w-10 rounded-full bg-slate-100 flex items-center justify-center">
            <Gauge className="h-5 w-5 text-slate-600" />
          </div>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <Skeleton className="h-8 w-16" />
          ) : (
            <div className="text-3xl font-bold text-foreground">
              {(stats?.total_readings ?? 0).toLocaleString('vi-VN')}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Chỉ số đã duyệt */}
      <Card className="border-l-4 border-l-emerald-500 hover:shadow-md transition-shadow">
        <CardHeader className="flex flex-row items-center justify-between pb-2 space-y-0">
          <CardTitle className="text-sm font-medium text-muted-foreground">Chỉ số đã duyệt</CardTitle>
          <div className="h-10 w-10 rounded-full bg-emerald-100 flex items-center justify-center">
            <CheckCircle className="h-5 w-5 text-emerald-600" />
          </div>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <Skeleton className="h-8 w-16" />
          ) : (
            <div className="text-3xl font-bold text-emerald-600">
              {(stats?.approved_count ?? 0).toLocaleString('vi-VN')}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Chỉ số chưa duyệt */}
      <Card className="border-l-4 border-l-yellow-500 hover:shadow-md transition-shadow">
        <CardHeader className="flex flex-row items-center justify-between pb-2 space-y-0">
          <CardTitle className="text-sm font-medium text-muted-foreground">Chỉ số chưa duyệt</CardTitle>
          <div className="h-10 w-10 rounded-full bg-yellow-100 flex items-center justify-center">
            <Clock className="h-5 w-5 text-yellow-600" />
          </div>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <Skeleton className="h-8 w-16" />
          ) : (
            <div className="text-3xl font-bold text-yellow-600">
              {(stats?.unapproved_count ?? 0).toLocaleString('vi-VN')}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Tổng tiêu thụ điện */}
      <Card className="border-l-4 border-l-blue-500 hover:shadow-md transition-shadow">
        <CardHeader className="flex flex-row items-center justify-between pb-2 space-y-0">
          <CardTitle className="text-sm font-medium text-muted-foreground">Tổng tiêu thụ điện</CardTitle>
          <div className="h-10 w-10 rounded-full bg-blue-100 flex items-center justify-center">
            <Zap className="h-5 w-5 text-blue-600" />
          </div>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <Skeleton className="h-8 w-24" />
          ) : (
            <div className="text-2xl font-bold text-foreground">
              {(stats?.electricity_consumption ?? 0).toLocaleString('vi-VN')} <span className="text-sm font-normal text-muted-foreground">kWh</span>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Tổng tiêu thụ nước */}
      <Card className="border-l-4 border-l-cyan-500 hover:shadow-md transition-shadow">
        <CardHeader className="flex flex-row items-center justify-between pb-2 space-y-0">
          <CardTitle className="text-sm font-medium text-muted-foreground">Tổng tiêu thụ nước</CardTitle>
          <div className="h-10 w-10 rounded-full bg-cyan-100 flex items-center justify-center">
            <Droplet className="h-5 w-5 text-cyan-600" />
          </div>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <Skeleton className="h-8 w-24" />
          ) : (
            <div className="text-2xl font-bold text-foreground">
              {(stats?.water_consumption ?? 0).toLocaleString('vi-VN')} <span className="text-sm font-normal text-muted-foreground">m³</span>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
