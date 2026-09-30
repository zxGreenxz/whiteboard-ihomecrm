import { FileSignature, Upload, Pencil, Type } from 'lucide-react';
import MainLayout from "@/components/layout/MainLayout";
import { Button } from '@/components/ui/button';

const SignaturesPage = () => {


  return (
    <MainLayout>
      <div className="container mx-auto p-6 max-w-4xl">
        <div className="flex items-center gap-3 mb-6">
          <div className="h-10 w-10 rounded-lg bg-indigo-100 flex items-center justify-center">
            <FileSignature className="h-5 w-5 text-indigo-600" />
          </div>
          <div>
            <h1 className="text-2xl font-bold">Mẫu chữ ký</h1>
            <p className="text-sm text-muted-foreground">
              Quản lý chữ ký điện tử cho hợp đồng và hóa đơn
            </p>
          </div>
        </div>

        <div className="mb-6 flex gap-3">
          <Button disabled>
            <Upload className="h-4 w-4 mr-2" />
            Tải ảnh lên
          </Button>
          <Button variant="outline" disabled>
            <Pencil className="h-4 w-4 mr-2" />
            Vẽ chữ ký
          </Button>
          <Button variant="outline" disabled>
            <Type className="h-4 w-4 mr-2" />
            Nhập text
          </Button>
        </div>

        <p role="status" className="rounded-md border p-4 text-sm text-muted-foreground">Tính năng mẫu chữ ký chưa được kết nối với dữ liệu. Các thao tác tải ảnh, vẽ và nhập chữ ký chưa khả dụng.</p>
      </div>
    </MainLayout>
  );
};

export default SignaturesPage;
