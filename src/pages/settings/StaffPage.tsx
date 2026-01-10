import { UserCog, UserPlus, Shield } from 'lucide-react';
import MainLayout from "@/components/layout/MainLayout";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';

const StaffPage = () => {
  const staff = [
    { id: 1, name: 'Nguyễn Văn A', email: 'admin@ihomecrm.com', role: 'ADMIN', status: 'active' },
  ];

  return (
    <MainLayout>
      <div className="container mx-auto p-6 max-w-4xl">
        <div className="flex items-center gap-3 mb-6">
          <div className="h-10 w-10 rounded-lg bg-green-100 flex items-center justify-center">
            <UserCog className="h-5 w-5 text-green-600" />
          </div>
          <div>
            <h1 className="text-2xl font-bold">Quản lý Nhân viên</h1>
            <p className="text-sm text-muted-foreground">
              Quản lý tài khoản và phân quyền nhân viên
            </p>
          </div>
        </div>

        <Card className="mb-6">
          <CardHeader>
            <CardTitle className="text-lg flex items-center gap-2">
              <Shield className="h-5 w-5" />
              Tính năng đa người dùng (Multi-user)
            </CardTitle>
            <CardDescription>
              Tính năng này đang được phát triển. Hiện tại hệ thống chỉ hỗ trợ 1 người dùng.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
              <p className="text-sm text-blue-900">
                📋 <strong>Kế hoạch phát triển:</strong> Tính năng quản lý nhiều nhân viên, phân quyền theo vai trò (RBAC), và audit logs sẽ được triển khai trong các phiên bản tiếp theo.
              </p>
            </div>
          </CardContent>
        </Card>

        <div className="flex justify-between items-center mb-4">
          <h3 className="font-semibold">Danh sách nhân viên ({staff.length})</h3>
          <Button disabled>
            <UserPlus className="h-4 w-4 mr-2" />
            Thêm nhân viên (Sắp ra mắt)
          </Button>
        </div>

        <div className="space-y-3">
          {staff.map((member) => (
            <Card key={member.id}>
              <CardContent className="p-4 flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="h-10 w-10 rounded-full bg-primary text-white flex items-center justify-center font-semibold">
                    {member.name.substring(0, 2).toUpperCase()}
                  </div>
                  <div>
                    <p className="font-medium">{member.name}</p>
                    <p className="text-sm text-muted-foreground">{member.email}</p>
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  <Badge variant={member.role === 'ADMIN' ? 'default' : 'secondary'}>
                    {member.role === 'ADMIN' ? 'Quản trị viên' : 'Nhân viên'}
                  </Badge>
                  <Badge variant={member.status === 'active' ? 'default' : 'secondary'} className="bg-green-100 text-green-700">
                    Hoạt động
                  </Badge>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    </MainLayout>
  );
};

export default StaffPage;
