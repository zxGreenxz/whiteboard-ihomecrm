import { QueryRegion, type RegionQuery } from '@/components/errors/QueryRegion';
import { deriveFinanceQueryState } from '@/lib/financeQueryState';
import { ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Button } from "@/components/ui/button";
import { ArrowLeft } from "lucide-react";

interface ReportLayoutProps {
  title: string;
  description?: string;
  icon?: ReactNode;
  actions?: ReactNode;
  filters?: ReactNode;
  children: ReactNode;
  stats?: ReactNode;
  backPath?: string;
  queries?: readonly RegionQuery[];
  filterQueries?: readonly RegionQuery[];
}

export function ReportLayout({
  title,
  description,
  icon,
  actions,
  filters,
  children,
  stats,
  backPath,
  queries = [],
  filterQueries = [],
}: ReportLayoutProps) {
  const navigate = useNavigate();
  const canRender = queries.every(query => deriveFinanceQueryState(query).canRenderData);
  const exportBlocked = queries.some(query => query.isError || query.isLoading || query.status === "pending");

  return (
    <div className="space-y-6">
      {/* Back Button (if provided) */}
      {backPath && (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => navigate(backPath)}
          className="gap-2"
        >
          <ArrowLeft className="h-4 w-4" />
          Quay lại
        </Button>
      )}

      {/* Header */}
      <div className="flex justify-between items-start">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            {icon && <div className="text-primary">{icon}</div>}
            <h1 className="text-3xl font-bold tracking-tight">{title}</h1>
          </div>
          {description && (
            <p className="text-muted-foreground">{description}</p>
          )}
        </div>
        {actions && <div><fieldset className="flex gap-2" disabled={exportBlocked}>{actions}</fieldset>{exportBlocked && <p className="mt-1 text-xs text-muted-foreground">Chờ tải đủ dữ liệu để xuất báo cáo.</p>}</div>}
      </div>

      <Separator />

      {/* Stats Overview (if provided) */}
      {stats && canRender && (
        <>
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
            {stats}
          </div>
          <Separator />
        </>
      )}

      {/* Filters (if provided) */}
      {filters && (
        <>
          <Card>
            <CardHeader>
              <CardTitle className="text-sm font-medium">Bộ lọc</CardTitle>
            </CardHeader>
            <CardContent>{filterQueries.length ? <QueryRegion label="danh mục bộ lọc báo cáo" queries={filterQueries}>{filters}</QueryRegion> : filters}</CardContent>
          </Card>
        </>
      )}

      {/* Main Content */}
      <div className="space-y-4">{queries.length ? <QueryRegion label={title} queries={queries}>{children}</QueryRegion> : children}</div>
    </div>
  );
}
