import { useState } from 'react';
import { UserCog, Plus, Mail, Phone, Shield, Trash2, Edit, UserCheck } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import * as z from 'zod';
import { format } from 'date-fns';
import { vi } from 'date-fns/locale';

// =============================================
// MOCK DATA (for demonstration)
// Future: Requires staff table and RBAC system
// =============================================

const MOCK_STAFF = [
  {
    id: '1',
    full_name: 'Nguyễn Văn An',
    email: 'an.nguyen@company.com',
    phone: '0901234567',
    role: 'ADMIN' as const,
    status: 'ACTIVE' as const,
    created_at: '2025-01-15T10:00:00Z',
  },
  {
    id: '2',
    full_name: 'Trần Thị Bình',
    email: 'binh.tran@company.com',
    phone: '0909876543',
    role: 'MANAGER' as const,
    status: 'ACTIVE' as const,
    created_at: '2025-01-16T10:00:00Z',
  },
  {
    id: '3',
    full_name: 'Lê Văn Cường',
    email: 'cuong.le@company.com',
    phone: '0912345678',
    role: 'STAFF' as const,
    status: 'INACTIVE' as const,
    created_at: '2025-01-17T10:00:00Z',
  },
];

// =============================================
// TYPES
// =============================================

type StaffRole = 'ADMIN' | 'MANAGER' | 'STAFF' | 'VIEWER';
type StaffStatus = 'ACTIVE' | 'INACTIVE' | 'SUSPENDED';

const staffSchema = z.object({
  full_name: z.string().min(1, 'Tên nhân viên là bắt buộc'),
  email: z.string().email('Email không hợp lệ'),
  phone: z.string().regex(/^[0-9]{10,11}$/, 'Số điện thoại không hợp lệ'),
  role: z.enum(['ADMIN', 'MANAGER', 'STAFF', 'VIEWER']),
});

// =============================================
// MAIN COMPONENT
// =============================================

const StaffPage = () => {
  const [isCreateOpen, setIsCreateOpen] = useState(false);

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Quản lý Nhân viên</h1>
          <p className="text-muted-foreground mt-2">
            Quản lý nhân viên và phân quyền truy cập hệ thống
          </p>
        </div>
        <Dialog open={isCreateOpen} onOpenChange={setIsCreateOpen}>
          <DialogTrigger asChild>
            <Button>
              <Plus className="h-4 w-4 mr-2" />
              Thêm nhân viên
            </Button>
          </DialogTrigger>
          <CreateStaffDialog onClose={() => setIsCreateOpen(false)} />
        </Dialog>
      </div>

      {/* Feature Notice */}
      <Alert>
        <AlertDescription>
          <strong>Lưu ý:</strong> Tính năng quản lý nhân viên yêu cầu RBAC (Role-Based Access Control) và multi-user support.
          Hiện tại đang sử dụng mock data để minh họa giao diện. Cần implement:
          <ul className="list-disc list-inside mt-2 space-y-1">
            <li>Bảng <code>staff</code> hoặc mở rộng <code>profiles</code></li>
            <li>Bảng <code>roles</code> và <code>permissions</code></li>
            <li>RLS policies cho multi-tenant</li>
            <li>Invitation system (email invites)</li>
          </ul>
        </AlertDescription>
      </Alert>

      {/* Staff List */}
      <Card>
        <CardHeader>
          <CardTitle>Danh sách nhân viên</CardTitle>
          <CardDescription>
            Tổng số: {MOCK_STAFF.length} nhân viên
          </CardDescription>
        </CardHeader>
        <CardContent>
          <StaffList staff={MOCK_STAFF} />
        </CardContent>
      </Card>

      {/* Roles & Permissions Info */}
      <Card>
        <CardHeader>
          <CardTitle>Vai trò và Quyền hạn</CardTitle>
          <CardDescription>
            Hệ thống phân quyền 4 cấp độ
          </CardDescription>
        </CardHeader>
        <CardContent>
          <RolesInfo />
        </CardContent>
      </Card>
    </div>
  );
};

// =============================================
// STAFF LIST
// =============================================

interface StaffListProps {
  staff: typeof MOCK_STAFF;
}

const StaffList = ({ staff }: StaffListProps) => {
  if (staff.length === 0) {
    return (
      <div className="text-center py-12 text-muted-foreground">
        <UserCog className="h-12 w-12 mx-auto mb-4 opacity-50" />
        <p>Chưa có nhân viên nào</p>
        <p className="text-sm mt-2">Click "Thêm nhân viên" để bắt đầu</p>
      </div>
    );
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Họ tên</TableHead>
          <TableHead>Email</TableHead>
          <TableHead>Số điện thoại</TableHead>
          <TableHead>Vai trò</TableHead>
          <TableHead>Trạng thái</TableHead>
          <TableHead>Ngày tham gia</TableHead>
          <TableHead className="text-right">Thao tác</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {staff.map((member) => (
          <TableRow key={member.id}>
            <TableCell>
              <div className="flex items-center gap-2">
                <div className="h-8 w-8 rounded-full bg-primary/10 flex items-center justify-center">
                  <UserCog className="h-4 w-4 text-primary" />
                </div>
                <span className="font-medium">{member.full_name}</span>
              </div>
            </TableCell>
            <TableCell>
              <div className="flex items-center gap-1 text-sm text-muted-foreground">
                <Mail className="h-3 w-3" />
                {member.email}
              </div>
            </TableCell>
            <TableCell>
              <div className="flex items-center gap-1 text-sm text-muted-foreground">
                <Phone className="h-3 w-3" />
                {member.phone}
              </div>
            </TableCell>
            <TableCell>
              <Badge variant={getRoleVariant(member.role)}>
                {getRoleLabel(member.role)}
              </Badge>
            </TableCell>
            <TableCell>
              <Badge
                variant={member.status === 'ACTIVE' ? 'success' : 'secondary'}
              >
                {member.status === 'ACTIVE' ? 'Hoạt động' : 'Tạm dừng'}
              </Badge>
            </TableCell>
            <TableCell className="text-sm text-muted-foreground">
              {format(new Date(member.created_at), 'dd/MM/yyyy', { locale: vi })}
            </TableCell>
            <TableCell className="text-right">
              <div className="flex items-center justify-end gap-2">
                <Button variant="ghost" size="icon" title="Chỉnh sửa">
                  <Edit className="h-4 w-4" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="text-destructive"
                  title="Xóa"
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
};

// =============================================
// CREATE STAFF DIALOG
// =============================================

interface CreateStaffDialogProps {
  onClose: () => void;
}

const CreateStaffDialog = ({ onClose }: CreateStaffDialogProps) => {
  const form = useForm({
    resolver: zodResolver(staffSchema),
    defaultValues: {
      full_name: '',
      email: '',
      phone: '',
      role: 'STAFF' as StaffRole,
    },
  });

  const onSubmit = (data: any) => {
    console.log('Create staff:', data);
    // TODO: Implement actual staff creation
    // Send invitation email
    onClose();
  };

  return (
    <DialogContent className="sm:max-w-[500px]">
      <DialogHeader>
        <DialogTitle>Thêm nhân viên mới</DialogTitle>
        <DialogDescription>
          Mời nhân viên mới tham gia vào hệ thống. Email mời sẽ được gửi tự động.
        </DialogDescription>
      </DialogHeader>

      <Form {...form}>
        <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
          <FormField
            control={form.control}
            name="full_name"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Họ tên *</FormLabel>
                <FormControl>
                  <Input placeholder="VD: Nguyễn Văn An" {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="email"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Email *</FormLabel>
                <FormControl>
                  <Input type="email" placeholder="an.nguyen@company.com" {...field} />
                </FormControl>
                <FormDescription>
                  Email để đăng nhập và nhận thông báo
                </FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="phone"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Số điện thoại *</FormLabel>
                <FormControl>
                  <Input placeholder="0901234567" {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="role"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Vai trò *</FormLabel>
                <Select onValueChange={field.onChange} defaultValue={field.value}>
                  <FormControl>
                    <SelectTrigger>
                      <SelectValue placeholder="Chọn vai trò" />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent>
                    <SelectItem value="ADMIN">Admin (Toàn quyền)</SelectItem>
                    <SelectItem value="MANAGER">Manager (Quản lý)</SelectItem>
                    <SelectItem value="STAFF">Staff (Nhân viên)</SelectItem>
                    <SelectItem value="VIEWER">Viewer (Chỉ xem)</SelectItem>
                  </SelectContent>
                </Select>
                <FormDescription>
                  Xem chi tiết quyền hạn bên dưới
                </FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Hủy
            </Button>
            <Button type="submit">
              <UserCheck className="h-4 w-4 mr-2" />
              Gửi lời mời
            </Button>
          </DialogFooter>
        </form>
      </Form>
    </DialogContent>
  );
};

// =============================================
// ROLES INFO
// =============================================

const RolesInfo = () => {
  const roles = [
    {
      name: 'ADMIN',
      label: 'Admin (Toàn quyền)',
      description: 'Có toàn quyền truy cập và quản lý hệ thống',
      permissions: [
        'Quản lý tất cả tòa nhà, phòng, hợp đồng',
        'Quản lý nhân viên và phân quyền',
        'Xem và chỉnh sửa cài đặt hệ thống',
        'Xem tất cả báo cáo và dữ liệu',
        'Xóa dữ liệu quan trọng',
      ],
      color: 'bg-red-100 text-red-800 border-red-200',
    },
    {
      name: 'MANAGER',
      label: 'Manager (Quản lý)',
      description: 'Quản lý hoạt động hàng ngày',
      permissions: [
        'Tạo và quản lý hợp đồng',
        'Tạo hóa đơn và thu tiền',
        'Quản lý khách thuê',
        'Xem báo cáo',
        'Không thể xóa dữ liệu quan trọng',
      ],
      color: 'bg-blue-100 text-blue-800 border-blue-200',
    },
    {
      name: 'STAFF',
      label: 'Staff (Nhân viên)',
      description: 'Nhân viên thực hiện công việc cụ thể',
      permissions: [
        'Xem danh sách phòng và khách thuê',
        'Ghi chỉ số điện nước',
        'Tạo sự cố/task',
        'Xem hóa đơn',
        'Không thể tạo/xóa hợp đồng',
      ],
      color: 'bg-green-100 text-green-800 border-green-200',
    },
    {
      name: 'VIEWER',
      label: 'Viewer (Chỉ xem)',
      description: 'Chỉ xem dữ liệu, không chỉnh sửa',
      permissions: [
        'Xem danh sách tòa nhà, phòng',
        'Xem thông tin khách thuê',
        'Xem báo cáo',
        'Không thể tạo/sửa/xóa bất kỳ dữ liệu nào',
      ],
      color: 'bg-gray-100 text-gray-800 border-gray-200',
    },
  ];

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
      {roles.map((role) => (
        <Card key={role.name} className="border-2">
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle className="text-base">{role.label}</CardTitle>
              <Badge variant="outline" className={role.color}>
                {role.name}
              </Badge>
            </div>
            <CardDescription>{role.description}</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              <p className="text-sm font-medium flex items-center gap-2">
                <Shield className="h-4 w-4" />
                Quyền hạn:
              </p>
              <ul className="space-y-1 text-sm text-muted-foreground">
                {role.permissions.map((permission, index) => (
                  <li key={index} className="flex items-start gap-2">
                    <span className="text-primary mt-0.5">•</span>
                    <span>{permission}</span>
                  </li>
                ))}
              </ul>
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
};

// =============================================
// HELPER FUNCTIONS
// =============================================

const getRoleLabel = (role: StaffRole): string => {
  const labels: Record<StaffRole, string> = {
    ADMIN: 'Admin',
    MANAGER: 'Manager',
    STAFF: 'Staff',
    VIEWER: 'Viewer',
  };
  return labels[role] || role;
};

const getRoleVariant = (role: StaffRole): 'default' | 'secondary' | 'outline' => {
  if (role === 'ADMIN') return 'default';
  if (role === 'MANAGER') return 'secondary';
  return 'outline';
};

export default StaffPage;
