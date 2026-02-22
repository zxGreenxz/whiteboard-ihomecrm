import MainLayout from "@/components/layout/MainLayout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Smartphone, Home, User, ExternalLink } from "lucide-react";

export default function AppGuidePage() {
  return (
    <MainLayout
      title="Hướng dẫn sử dụng App Resident"
      subtitle="Tài liệu tham khảo hướng dẫn sử dụng ứng dụng di động Resident"
      icon={Smartphone}
    >
      <div className="max-w-3xl">
        <Tabs defaultValue="landlord" className="w-full">
          <TabsList className="grid w-full grid-cols-2">
            <TabsTrigger value="landlord" className="flex items-center gap-2">
              <Home className="h-4 w-4" />
              Dành cho chủ nhà
            </TabsTrigger>
            <TabsTrigger value="tenant" className="flex items-center gap-2">
              <User className="h-4 w-4" />
              Dành cho khách hàng
            </TabsTrigger>
          </TabsList>

          <TabsContent value="landlord">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Home className="h-5 w-5" />
                  Hướng dẫn App Resident - Dành cho chủ nhà
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <p className="text-muted-foreground">
                  App Resident giúp chủ nhà quản lý toà nhà, căn hộ và khách hàng ngay trên điện thoại di động.
                </p>

                <div className="space-y-3">
                  <h3 className="font-semibold">Tính năng chính</h3>
                  <ul className="list-disc list-inside space-y-1 text-sm text-muted-foreground">
                    <li>Xem tổng quan tình trạng toà nhà và căn hộ</li>
                    <li>Quản lý hợp đồng thuê và đặt cọc</li>
                    <li>Ghi chỉ số điện nước và tạo hóa đơn</li>
                    <li>Theo dõi thu chi và công nợ</li>
                    <li>Gửi thông báo đến khách hàng</li>
                    <li>Quản lý công việc</li>
                    <li>Xem báo cáo kinh doanh</li>
                  </ul>
                </div>

                <div className="space-y-3">
                  <h3 className="font-semibold">Cách sử dụng</h3>
                  <ol className="list-decimal list-inside space-y-1 text-sm text-muted-foreground">
                    <li>Tải app Resident từ App Store hoặc Google Play</li>
                    <li>Đăng nhập bằng tài khoản chủ nhà đã đăng ký</li>
                    <li>Truy cập các tính năng quản lý từ menu chính</li>
                  </ol>
                </div>

                <div className="rounded-lg border p-4 bg-muted/50">
                  <p className="text-sm text-muted-foreground">
                    Để xem hướng dẫn chi tiết, vui lòng truy cập tài liệu hướng dẫn đầy đủ tại{" "}
                    <a
                      href="https://app-docs.resident.vn/"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-primary hover:underline inline-flex items-center gap-1"
                    >
                      app-docs.resident.vn
                      <ExternalLink className="h-3 w-3" />
                    </a>
                  </p>
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="tenant">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <User className="h-5 w-5" />
                  Hướng dẫn App Resident - Dành cho khách hàng
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <p className="text-muted-foreground">
                  App Resident giúp khách hàng theo dõi hợp đồng, hóa đơn và liên lạc với chủ nhà một cách tiện lợi.
                </p>

                <div className="space-y-3">
                  <h3 className="font-semibold">Tính năng chính</h3>
                  <ul className="list-disc list-inside space-y-1 text-sm text-muted-foreground">
                    <li>Xem thông tin hợp đồng thuê hiện tại</li>
                    <li>Theo dõi hóa đơn và lịch thanh toán</li>
                    <li>Chốt chỉ số điện nước (nếu được bật)</li>
                    <li>Gửi yêu cầu sửa chữa, báo công việc</li>
                    <li>Nhận thông báo từ chủ nhà</li>
                    <li>Ký hợp đồng điện tử (nếu được bật)</li>
                  </ul>
                </div>

                <div className="space-y-3">
                  <h3 className="font-semibold">Cách sử dụng</h3>
                  <ol className="list-decimal list-inside space-y-1 text-sm text-muted-foreground">
                    <li>Tải app Resident từ App Store hoặc Google Play</li>
                    <li>Đăng nhập bằng tài khoản khách hàng được cung cấp</li>
                    <li>Xem hợp đồng, hóa đơn và gửi yêu cầu từ menu chính</li>
                  </ol>
                </div>

                <div className="rounded-lg border p-4 bg-muted/50">
                  <p className="text-sm text-muted-foreground">
                    Để xem hướng dẫn chi tiết, vui lòng truy cập tài liệu hướng dẫn đầy đủ tại{" "}
                    <a
                      href="https://app-docs.resident.vn/"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-primary hover:underline inline-flex items-center gap-1"
                    >
                      app-docs.resident.vn
                      <ExternalLink className="h-3 w-3" />
                    </a>
                  </p>
                </div>
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      </div>
    </MainLayout>
  );
}
