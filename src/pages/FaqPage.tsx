import MainLayout from "@/components/layout/MainLayout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { HelpCircle } from "lucide-react";

const faqItems = [
  {
    question: "Làm thế nào để tạo toà nhà đầu tiên?",
    answer:
      "Vào mục Danh mục dữ liệu > Toà nhà, nhấn nút \"Thêm toà nhà\". Điền đầy đủ thông tin: Tên toà nhà, Địa chỉ, Tình trạng hoạt động, sau đó nhấn Lưu.",
  },
  {
    question: "Làm thế nào để thêm căn hộ vào toà nhà?",
    answer:
      "Vào mục Danh mục dữ liệu > Căn hộ, nhấn nút \"Thêm căn hộ\". Chọn Toà nhà, Tầng, nhập Tên căn hộ, Diện tích, Giá thuê và các thông tin khác.",
  },
  {
    question: "Quy trình tạo hợp đồng thuê như thế nào?",
    answer:
      "Quy trình gồm: Tạo khách hẹn → Chuyển đổi thành đặt cọc → Tạo hợp đồng. Bạn cũng có thể tạo hợp đồng trực tiếp từ mục Khách hàng > Hợp đồng.",
  },
  {
    question: "Làm thế nào để ghi chỉ số điện nước?",
    answer:
      "Vào mục Tài chính > Ghi chỉ số, chọn Toà nhà và Căn hộ, nhập chỉ số cuối kỳ cho điện và nước. Hệ thống sẽ tự động tính tiêu thụ.",
  },
  {
    question: "Hóa đơn được tạo tự động hay thủ công?",
    answer:
      "Bạn có thể tạo hóa đơn thủ công hoặc bật tính năng tự động sinh hóa đơn kỳ tiếp trong Cài đặt chung > tab Hóa đơn.",
  },
  {
    question: "Làm thế nào để phân quyền cho nhân viên?",
    answer:
      "Vào Cài đặt hệ thống > Nhân viên. Tạo Loại tài khoản (vai trò) với các quyền phù hợp, sau đó gán nhân viên vào vai trò và toà nhà tương ứng.",
  },
  {
    question: "Tôi có thể xuất báo cáo ra Excel/PDF không?",
    answer:
      "Có. Tất cả các trang báo cáo (BĐS, Tài chính, Công việc) đều hỗ trợ xuất ra Excel và PDF thông qua nút Xuất báo cáo.",
  },
  {
    question: "Ký hợp đồng điện tử hoạt động như thế nào?",
    answer:
      "Bật tính năng trong Cài đặt chung > tab Hợp đồng > \"Ký HĐ online\". Sau đó khi tạo hợp đồng, bạn có thể gửi link ký điện tử cho khách hàng.",
  },
  {
    question: "Làm thế nào để quản lý mẫu biểu?",
    answer:
      "Vào Cài đặt hệ thống > Mẫu biểu. Hệ thống hỗ trợ 6 loại mẫu: Mẫu chữ ký, HĐ đặt cọc, HĐ thuê, Biên bản bàn giao, Mẫu hóa đơn, Mẫu thu chi.",
  },
  {
    question: "Sơ đồ toà nhà hiển thị những gì?",
    answer:
      "Sơ đồ toà nhà hiển thị tất cả căn hộ theo tầng với mã màu trạng thái: Xanh (Đang thuê), Cam (Đã đặt cọc), Đỏ (Trống), Tím (Sắp trống), Xám (Ngừng hoạt động). Nhấn vào căn hộ để xem chi tiết.",
  },
];

export default function FaqPage() {
  return (
    <MainLayout
      title="Câu hỏi thường gặp"
      subtitle="Giải đáp các thắc mắc phổ biến về hệ thống CRM"
      icon={HelpCircle}
    >
      <div className="max-w-3xl">
        <Card>
          <CardHeader>
            <CardTitle>FAQ - Câu hỏi thường gặp</CardTitle>
          </CardHeader>
          <CardContent>
            <Accordion type="single" collapsible className="w-full">
              {faqItems.map((item, index) => (
                <AccordionItem key={index} value={`item-${index}`}>
                  <AccordionTrigger className="text-left">
                    {item.question}
                  </AccordionTrigger>
                  <AccordionContent className="text-muted-foreground">
                    {item.answer}
                  </AccordionContent>
                </AccordionItem>
              ))}
            </Accordion>
          </CardContent>
        </Card>
      </div>
    </MainLayout>
  );
}
