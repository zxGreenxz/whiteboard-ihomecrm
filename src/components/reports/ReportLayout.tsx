import { ReactNode } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";

interface ReportLayoutProps {
  title: string;
  description?: string;
  icon?: ReactNode;
  actions?: ReactNode;
  filters?: ReactNode;
  children: ReactNode;
  stats?: ReactNode;
}

export function ReportLayout({
  title,
  description,
  icon,
  actions,
  filters,
  children,
  stats,
}: ReportLayoutProps) {
  return (
    <div className="space-y-6">
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
        {actions && <div className="flex gap-2">{actions}</div>}
      </div>

      <Separator />

      {/* Stats Overview (if provided) */}
      {stats && (
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
            <CardContent>{filters}</CardContent>
          </Card>
        </>
      )}

      {/* Main Content */}
      <div className="space-y-4">{children}</div>
    </div>
  );
}
