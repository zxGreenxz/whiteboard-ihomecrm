# Đo GitNexus và kiểm chứng thay đổi ngày 11/09/2026

Bằng chứng của đợt triển khai, không phải hướng dẫn cần đọc mỗi task.
Luật hiện hành nằm ở [Project Contract §12](../engineering/PROJECT_CONTRACT.md#12-tra-cứu-mã-nguồn-và-gitnexus).

## Phương pháp

Hai worktree riêng từ nguồn sản phẩm `5a836b0146f15558a2f2abee530c4c304f3b81bc`,
cùng Windows, Node 22.20.0 và GitNexus 1.6.9 đã có trong npm cache; không tính cài package qua mạng.
Worktree mới áp sáu file tooling của `62ece204` rồi commit riêng để đo nhánh source không đổi.
Các sửa tiếp theo từ review bảo vệ lỗi filesystem/process; số đo dưới đây thuộc bản benchmark này.
Không copy index giữa worktree. Mỗi cấu hình có một lần dựng mới và hai lần không đổi source.
Đây là mẫu local nhỏ, không phải cam kết thời gian cho mọi máy. CI/test dùng Node theo runtime-matrix.

## Dựng và cập nhật index

| Trường hợp | Cấu hình cũ | Cấu hình mới |
|---|---:|---:|
| Chưa có index | 60,936 giây | 50,392 giây |
| Source không đổi, lần 1 | 35,272 giây | 6,521 giây |
| Source không đổi, lần 2 | 34,959 giây | 6,252 giây |
| Sửa nhỏ một file TS, lần 1 | Không đo | Lỗi sau 65,585 giây |
| Sửa nhỏ TS lần 2, dựng phục hồi chủ động | Không đo | 50,566 giây; dựng đầy đủ |

Lần incremental mới báo `Failed calling LOWER: Invalid UTF-8` sau khi mở rộng thêm 88 importer.
Wrapper trả mã 2, bỏ manifest; status và cả bốn query sau đó đều từ chối dùng index.
Lần thứ hai là phép đo phục hồi được chạy chủ động, **không phải incremental thành công hoặc retry tự động**.
Chưa xác định nguyên nhân bên trong GitNexus/Ladybug; không tuyên bố đã chữa lỗi thư viện này.

Cả hai index có 2.741 file và embeddings = 0. Bản cũ: 26.511 node, 54.914 edge,
567,8 MB; bản mới ban đầu: 26.542 node, 55.039 edge, 566,7 MB (MB thập phân).
Chênh lệch symbol đến từ tooling đã thay. Bản cũ sinh 20 community skill mỗi lần;
bản mới không sinh hướng dẫn. Dung lượng không giảm đáng kể.

## Truy vấn và đối chiếu source

Query mới đo trên index đã phục hồi, kiểm source trước/sau; riêng status mất 1,909 giây.
Số ký tự là stdout, không phải token tính phí; JSON mới được nén một dòng.

| Câu hỏi | Graph cũ: giây / ký tự | Graph mới: giây / ký tự | `rg` sau khi cache ấm: giây / ký tự |
|---|---:|---:|---:|
| Callers của `calculateContractDepositBalance` | 3,803 / 1.045 | 6,000 / 699 | 0,047 / 5.772 |
| Helpers của `buildCreateContractRpcArgs` | 3,836 / 1.502 | 6,092 / 1.015 | 0,021 / 4.135 |
| Trace `createContractV2` → `normalizeDateOnly` | 3,762 / 1.229 | 5,740 / 716 | 0,026 / 6.126 |
| RPC `append_income_expense_supplement_v1` → SQL/ACL | 4,038 / 4.994 | 6,143 / 3.824 | 0,060 / 5.307 |

Lượt `rg` đầu quét `src` và migrations mất lần lượt 5,823 và 6,571 giây; các lượt sau nhanh hơn.
Các lệnh nguồn được khoanh theo tên symbol/file đã biết, chưa tính thời gian agent chọn hướng tìm và đọc hiểu.
Không suy số ký tự hoặc thời gian một query thành chi phí hoàn tất một task.

- Hai production caller: `useContractFormState.ts` và `useContractSubmit.ts`.
- Bốn helper: `requiredDateOnly`, `optionalDateOnly`, `normalizeFirstBillingPeriod`, `normalizeIdempotencyKey`.
- Trace gồm ba cạnh: `createContractV2` → `buildCreateContractRpcArgs` → `normalizeFirstBillingPeriod` → `normalizeDateOnly`.
- Graph không tìm ra định nghĩa SQL/ACL của RPC; `rg` tìm được caller trong `src/hooks/income-expenses/supplements.ts`
  và CREATE/REVOKE/GRANT trong `supabase/migrations/20260910042229_income_expense_supplements_v1.sql`.
  `query --limit 5` giới hạn nhóm process theo upstream, không đảm bảo tổng output chỉ có năm definition.

## Kết luận sử dụng

Bỏ sinh skill giúp tránh dựng lại vô ích. Kiểm content digest làm query tốn thêm thời gian nhưng chặn graph cũ.
Giữ CLI tùy chọn cho quan hệ TS/JS nhiều file; source/manifest/harness là đường mặc định và dự phòng.
Không cần graph để CI xanh hoặc phát hành. Chưa có số đo token tính phí, không công bố tỷ lệ tiết kiệm token.
Ngân sách tự dựng 120 giây là trần chờ; lỗi/hết giờ thì chuyển source, không nới timeout hoặc dựng lặp.
