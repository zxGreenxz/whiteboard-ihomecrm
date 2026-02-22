import MainLayout from "@/components/layout/MainLayout";
import { Card, CardContent } from "@/components/ui/card";
import { ArrowLeft, Construction } from "lucide-react";
import { Link } from "react-router-dom";
import { LucideIcon } from "lucide-react";

interface PlaceholderPageProps {
  title: string;
  subtitle: string;
  icon: LucideIcon;
}

export default function PlaceholderPage({ title, subtitle, icon }: PlaceholderPageProps) {
  return (
    <MainLayout title={title} subtitle={subtitle} icon={icon}>
      <div className="space-y-4">
        <Link
          to="/settings/categories"
          className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          <ArrowLeft className="h-4 w-4" />
          Quay lại Danh mục khác
        </Link>
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-12 text-center">
            <Construction className="h-12 w-12 text-muted-foreground mb-4" />
            <h3 className="text-lg font-medium mb-2">Tính năng đang phát triển</h3>
            <p className="text-sm text-muted-foreground">
              Trang {title} sẽ sớm được hoàn thiện.
            </p>
          </CardContent>
        </Card>
      </div>
    </MainLayout>
  );
}
