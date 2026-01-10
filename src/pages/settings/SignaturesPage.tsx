import { FileSignature, Upload, Pencil, Type } from 'lucide-react';
import MainLayout from "@/components/layout/MainLayout";
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';

const SignaturesPage = () => {
  const signatures = [
    { id: 1, name: 'Chữ ký Giám đốc', type: 'Upload', url: '/signatures/director.png' },
    { id: 2, name: 'Chữ ký Kế toán', type: 'Draw', url: null },
  ];

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
          <Button>
            <Upload className="h-4 w-4 mr-2" />
            Tải ảnh lên
          </Button>
          <Button variant="outline">
            <Pencil className="h-4 w-4 mr-2" />
            Vẽ chữ ký
          </Button>
          <Button variant="outline">
            <Type className="h-4 w-4 mr-2" />
            Nhập text
          </Button>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {signatures.map((signature) => (
            <Card key={signature.id}>
              <CardHeader>
                <CardTitle className="text-base">{signature.name}</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="bg-gray-50 h-32 rounded flex items-center justify-center mb-3">
                  {signature.url ? (
                    <img src={signature.url} alt={signature.name} className="max-h-full" />
                  ) : (
                    <p className="text-muted-foreground text-sm">Chưa có chữ ký</p>
                  )}
                </div>
                <p className="text-xs text-muted-foreground">Phương thức: {signature.type}</p>
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    </MainLayout>
  );
};

export default SignaturesPage;
