import { ExternalLink, FlaskConical, RefreshCw } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

/**
 * Workflow chạy scripts/test-env/sync.mjs trên GitHub Actions. Nút mở trang workflow
 * để bấm "Run workflow": việc đồng bộ cần mật khẩu database production, thứ không
 * bao giờ được nằm trong trình duyệt hay trong project TEST.
 */
export const LINK_WORKFLOW_DONG_BO =
  'https://github.com/zxGreenxz/whiteboard-ihomecrm/actions/workflows/test-env-sync.yml';

/** Thẻ giới thiệu môi trường TEST + nút đồng bộ — chỉ render ở bản build TEST. */
export default function TheMoiTruongTest() {
  return (
    <Card className="border-amber-300/60 dark:border-amber-800/60">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <FlaskConical className="h-4 w-4" />
          Môi trường TEST
          <Badge variant="outline">bản sao production</Badge>
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          Database riêng mang đúng dữ liệu, tài khoản và vai trò của production tại lần đồng bộ gần
          nhất. Thao tác ở đây không ảnh hưởng sổ sách thật. Ảnh và file đính kèm không được chép
          nên sẽ không mở được. Đăng nhập bằng mật khẩu TEST riêng, không dùng mật khẩu thật.
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm">
          Đồng bộ sẽ <b>xoá sạch</b> dữ liệu TEST rồi chép lại từ production, sau đó tự đối chiếu
          từng bảng. Mọi thứ đang thử dở sẽ mất, và phải đăng nhập lại.
        </p>
        <Button variant="outline" asChild>
          <a href={LINK_WORKFLOW_DONG_BO} target="_blank" rel="noreferrer">
            <RefreshCw className="mr-2 h-4 w-4" />
            Đồng bộ dữ liệu mới nhất
            <ExternalLink className="ml-2 h-3.5 w-3.5" />
          </a>
        </Button>
        <p className="text-xs text-muted-foreground">
          Trang GitHub mở ra → bấm <b>Run workflow</b>. Chạy khoảng 10–20 phút.
        </p>
      </CardContent>
    </Card>
  );
}
