import { Link } from 'react-router-dom';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Building2, Lock } from 'lucide-react';

// Đăng ký công khai đã đóng theo mô hình RBAC single-org.
// Tài khoản mới chỉ được tạo qua trang Admin (super_admin invite).
// Xem ~/.claude/plans/breezy-finding-gem.md mục Phase 7.
const Register = () => {
  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-primary/5 via-background to-primary/10 p-4">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <div className="mx-auto w-16 h-16 bg-primary/10 rounded-full flex items-center justify-center mb-4">
            <Building2 className="w-8 h-8 text-primary" />
          </div>
          <CardTitle className="text-2xl">Đăng ký đã đóng</CardTitle>
          <CardDescription>
            Hệ thống chỉ phục vụ một tổ chức cố định. Vui lòng liên hệ quản trị
            viên để được tạo tài khoản.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-start gap-2 rounded-md bg-muted p-3 text-sm text-muted-foreground">
            <Lock className="w-4 h-4 mt-0.5 flex-shrink-0" />
            <span>
              Đăng ký công khai đã được vô hiệu hoá. Nếu anh/chị là nhân viên
              mới, hãy nhờ admin phân quyền và tạo tài khoản từ trang quản trị.
            </span>
          </div>
          <Button asChild variant="default" className="w-full">
            <Link to="/login">Quay lại đăng nhập</Link>
          </Button>
        </CardContent>
      </Card>
    </div>
  );
};

export default Register;
