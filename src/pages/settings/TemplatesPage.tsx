import { FileText, Upload, Download, Eye } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Badge } from '@/components/ui/badge';

const TemplatesPage = () => {
  const templates = {
    contract: [
      { id: 1, name: 'Hợp đồng thuê phòng trọ', type: 'DOCX', size: '45 KB', isDefault: true },
      { id: 2, name: 'Hợp đồng thuê KTX', type: 'DOCX', size: '42 KB', isDefault: false },
    ],
    invoice: [
      { id: 3, name: 'Hóa đơn A4', type: 'PDF', size: '28 KB', isDefault: true },
      { id: 4, name: 'Hóa đơn Thermal 80mm', type: 'PDF', size: '25 KB', isDefault: false },
    ],
    receipt: [
      { id: 5, name: 'Biên lai thu tiền', type: 'PDF', size: '22 KB', isDefault: true },
    ],
  };

  const variables = [
    { name: '{company_name}', desc: 'Tên công ty' },
    { name: '{company_address}', desc: 'Địa chỉ công ty' },
    { name: '{tenant_name}', desc: 'Tên khách thuê' },
    { name: '{room_name}', desc: 'Tên phòng' },
    { name: '{contract_number}', desc: 'Số hợp đồng' },
    { name: '{rent_price}', desc: 'Giá thuê' },
    { name: '{deposit_amount}', desc: 'Tiền cọc' },
    { name: '{start_date}', desc: 'Ngày bắt đầu' },
    { name: '{end_date}', desc: 'Ngày kết thúc' },
    { name: '{invoice_number}', desc: 'Số hóa đơn' },
    { name: '{total_amount}', desc: 'Tổng tiền' },
    { name: '{payment_due_date}', desc: 'Hạn thanh toán' },
  ];

  return (
    <div className="container mx-auto p-6 max-w-6xl">
      {/* Header */}
      <div className="flex items-center gap-3 mb-6">
        <div className="h-10 w-10 rounded-lg bg-purple-100 flex items-center justify-center">
          <FileText className="h-5 w-5 text-purple-600" />
        </div>
        <div>
          <h1 className="text-2xl font-bold">Mẫu biểu</h1>
          <p className="text-sm text-muted-foreground">
            Quản lý mẫu hợp đồng, hóa đơn và biên lai
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Templates Section */}
        <div className="lg:col-span-2">
          <Tabs defaultValue="contract">
            <TabsList className="grid w-full grid-cols-3">
              <TabsTrigger value="contract">Hợp đồng</TabsTrigger>
              <TabsTrigger value="invoice">Hóa đơn</TabsTrigger>
              <TabsTrigger value="receipt">Biên lai</TabsTrigger>
            </TabsList>

            {/* Contract Templates */}
            <TabsContent value="contract" className="space-y-4">
              <div className="flex justify-between items-center">
                <h3 className="font-semibold">Mẫu hợp đồng ({templates.contract.length})</h3>
                <Button size="sm">
                  <Upload className="h-4 w-4 mr-2" />
                  Tải lên mẫu mới
                </Button>
              </div>

              {templates.contract.map((template) => (
                <Card key={template.id}>
                  <CardContent className="p-4 flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <FileText className="h-8 w-8 text-blue-600" />
                      <div>
                        <div className="flex items-center gap-2">
                          <p className="font-medium">{template.name}</p>
                          {template.isDefault && (
                            <Badge variant="default" className="text-xs">Mặc định</Badge>
                          )}
                        </div>
                        <p className="text-sm text-muted-foreground">
                          {template.type} • {template.size}
                        </p>
                      </div>
                    </div>
                    <div className="flex gap-2">
                      <Button variant="outline" size="sm">
                        <Eye className="h-4 w-4 mr-2" />
                        Xem trước
                      </Button>
                      <Button variant="outline" size="sm">
                        <Download className="h-4 w-4 mr-2" />
                        Tải xuống
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </TabsContent>

            {/* Invoice Templates */}
            <TabsContent value="invoice" className="space-y-4">
              <div className="flex justify-between items-center">
                <h3 className="font-semibold">Mẫu hóa đơn ({templates.invoice.length})</h3>
                <Button size="sm">
                  <Upload className="h-4 w-4 mr-2" />
                  Tải lên mẫu mới
                </Button>
              </div>

              {templates.invoice.map((template) => (
                <Card key={template.id}>
                  <CardContent className="p-4 flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <FileText className="h-8 w-8 text-green-600" />
                      <div>
                        <div className="flex items-center gap-2">
                          <p className="font-medium">{template.name}</p>
                          {template.isDefault && (
                            <Badge variant="default" className="text-xs">Mặc định</Badge>
                          )}
                        </div>
                        <p className="text-sm text-muted-foreground">
                          {template.type} • {template.size}
                        </p>
                      </div>
                    </div>
                    <div className="flex gap-2">
                      <Button variant="outline" size="sm">
                        <Eye className="h-4 w-4 mr-2" />
                        Xem trước
                      </Button>
                      <Button variant="outline" size="sm">
                        <Download className="h-4 w-4 mr-2" />
                        Tải xuống
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </TabsContent>

            {/* Receipt Templates */}
            <TabsContent value="receipt" className="space-y-4">
              <div className="flex justify-between items-center">
                <h3 className="font-semibold">Mẫu biên lai ({templates.receipt.length})</h3>
                <Button size="sm">
                  <Upload className="h-4 w-4 mr-2" />
                  Tải lên mẫu mới
                </Button>
              </div>

              {templates.receipt.map((template) => (
                <Card key={template.id}>
                  <CardContent className="p-4 flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <FileText className="h-8 w-8 text-orange-600" />
                      <div>
                        <div className="flex items-center gap-2">
                          <p className="font-medium">{template.name}</p>
                          {template.isDefault && (
                            <Badge variant="default" className="text-xs">Mặc định</Badge>
                          )}
                        </div>
                        <p className="text-sm text-muted-foreground">
                          {template.type} • {template.size}
                        </p>
                      </div>
                    </div>
                    <div className="flex gap-2">
                      <Button variant="outline" size="sm">
                        <Eye className="h-4 w-4 mr-2" />
                        Xem trước
                      </Button>
                      <Button variant="outline" size="sm">
                        <Download className="h-4 w-4 mr-2" />
                        Tải xuống
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </TabsContent>
          </Tabs>
        </div>

        {/* Variables Reference */}
        <div>
          <Card>
            <CardHeader>
              <CardTitle className="text-lg">Biến động (Variables)</CardTitle>
              <CardDescription>
                Sử dụng các biến này trong mẫu
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="space-y-3 max-h-[600px] overflow-y-auto">
                {variables.map((variable, index) => (
                  <div key={index} className="border-b pb-2">
                    <code className="text-xs bg-gray-100 px-2 py-1 rounded font-mono">
                      {variable.name}
                    </code>
                    <p className="text-xs text-muted-foreground mt-1">
                      {variable.desc}
                    </p>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
};

export default TemplatesPage;
