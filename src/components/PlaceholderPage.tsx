import MainLayout from '@/components/layout/MainLayout';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Construction, ArrowLeft } from 'lucide-react';
import { useNavigate } from 'react-router-dom';

interface PlaceholderPageProps {
  title: string;
  description?: string;
  icon?: React.ComponentType<{ className?: string }>;
  phase?: number;
}

/**
 * PlaceholderPage Component
 *
 * Generic placeholder for pages that haven't been implemented yet.
 * Shows a friendly message with the page name and which phase it will be implemented in.
 */
const PlaceholderPage = ({
  title,
  description = 'Trang này đang được phát triển và sẽ sớm ra mắt.',
  icon: Icon = Construction,
  phase
}: PlaceholderPageProps) => {
  const navigate = useNavigate();

  return (
    <MainLayout>
      <div className="flex items-center justify-center min-h-[calc(100vh-12rem)]">
        <Card className="w-full max-w-md">
          <CardHeader className="text-center">
            <div className="mx-auto mb-4 h-16 w-16 rounded-full bg-gray-100 flex items-center justify-center">
              <Icon className="h-8 w-8 text-gray-600" />
            </div>
            <CardTitle className="text-2xl">{title}</CardTitle>
            <CardDescription className="mt-2">
              {description}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {phase && (
              <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 text-sm">
                <p className="text-blue-900">
                  <strong>Ghi chú:</strong> Tính năng này sẽ được phát triển trong <strong>Phase {phase}</strong> của kế hoạch implementation.
                </p>
              </div>
            )}

            <div className="space-y-2 text-sm text-muted-foreground">
              <p>Trong khi chờ đợi, bạn có thể:</p>
              <ul className="list-disc list-inside space-y-1 pl-2">
                <li>Khám phá các tính năng đã hoàn thành</li>
                <li>Xem lại Bảng tin</li>
                <li>Kiểm tra documentation</li>
              </ul>
            </div>

            <Button
              onClick={() => navigate('/')}
              className="w-full"
              variant="default"
            >
              <ArrowLeft className="h-4 w-4 mr-2" />
              Quay về Dashboard
            </Button>
          </CardContent>
        </Card>
      </div>
    </MainLayout>
  );
};

export default PlaceholderPage;
