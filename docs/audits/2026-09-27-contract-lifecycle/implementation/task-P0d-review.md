# Review độc lập P0d — TEST money reconciliation

- Base: `54fc5857e5e7ec1d46fa22288a1115cf403ce6e2`
- Head: `449de52e11400b8f2df48d011d6dcf229683b624`
- Phạm vi: brief + scope đã duyệt + report + diff P0d; chỉ đọc code/DB, chỉ ghi báo cáo này.

## Spec verdict: cần sửa một trường hợp phân loại kết quả

Các đường chính phù hợp thiết kế: opt-in TEST trước cấu hình legacy; scope/ref/URL/credential validation; marker/TLS qua transport; JWT thật và RPC hiện hữu; SQL độc lập xác định IDs; A-after ở transaction mới với predicate gốc; V2 lấy account universe độc lập và giữ balance toàn lịch sử; digest/count/paging; không đổi app, schema, chính sách tiền hoặc quyền. Amendment uppercase chỉ mở alphabet của VALUE, không mở raw/in-list filters. Không thấy đường mới báo PASS khi thiếu ngưỡng hoặc nguồn rỗng.

**Important — REST xác nhận zero rows bị báo lỗi thực thi thay vì mismatch nguồn.** `scripts/contract-lifecycle/reconcile.mjs:182` gọi `selectRows` mà không có `allowEmpty: true`. Transport hiện hữu (`scripts/contract-lifecycle/transport.mjs:173,197–199`) mặc định từ chối cả response hợp lệ `Content-Range: */0` với `[]`. Khi SQL A đã có voucher, đây là một chênh lệch nguồn xác định (ví dụ actor mất toàn bộ quyền đọc), nhưng bị catch tại `reconcile.mjs:192` thành exit 2 `v1_rest_error`, không tới `compareV1` để trả exit 1 `source_mismatch`. Đây không phải false PASS; vấn đề là phân biệt mismatch/RLS với lỗi thực thi sai hợp đồng exit 0/1/2/3, và bài test hiện tại không đại diện đường adapter thật.

Sửa tối thiểu: cho phép chính xác empty REST response đi tới comparator trong adapter V1 bằng option đã có; vẫn giữ các response sai range/count là lỗi. Thêm regression gọi `runV1` qua `selectAll` thật với fake HTTP boundary trả `*/0`, yêu cầu exit 1 dù thiếu cap; không chỉ gọi comparator trực tiếp.

## Quality verdict: cần regression ở ranh giới transport trước khi chấp nhận

`reconcile.test.mjs:25–27` truyền trực tiếp `rest: []` vào `compareV1`, nên pass nhưng không phát hiện Important ở trên. Cấu trúc tổng thể nhỏ, side-effect-free, query cố định và bind tham số; decimal dùng BigInt, không che sai lệch bằng epsilon. Hai legacy entry points chỉ thêm early dispatch. Không thấy thay đổi nghiệp vụ hoặc mở rộng filter ngoài amendment được phép.

Không có Critical hoặc Minor riêng cần ghi nhận trong phạm vi này.

## Bằng chứng kiểm cụ thể

Không chạy lại suite 40 tests, mutation hoặc live TEST đã được report. Một probe mới chỉ nhằm nghi vấn cụ thể trên, chạy Node 24.18.0 qua `npm exec --yes --package=node@24.18.0 -- node --input-type=module`:

- `runV1` dùng fake read-only transaction, SQL baseline một row có amount 10, RPC tổng 10, HTTP page trả `Content-Range: */0`, rows `[]`.
- Dùng **selectAll thật**, không stub comparator hoặc selectRows.
- Kết quả: `{"status":2,"reason":"v1_rest_error","catalogCode":"missing,_short_or_extra_page"}`. Yêu cầu theo scope: mismatch exit 1.
- Probe không credential, không mạng, không ghi DB, không sửa code/index.

Receipt có live PASS tại code SHA `2d5d3ae99e65941e063409a3b4b8e599e5a2c312`: V1 2.115 voucher/3 pages; V2 17 accounts/3.722 posting lines. Đây là bằng chứng do implementer cung cấp, không phải lần chạy độc lập của reviewer, và không bao phủ case lỗi đã nêu.

## Giới hạn cross-task

Không review P0c hoặc toàn bộ lifecycle goal; không chứng nhận production, migration, RLS mutation, release, draft PR hoặc gate toàn repo. V1 vẫn chỉ bắt drift tại hai endpoint snapshots, không chứng minh HTTP snapshot isolation hay thay đổi thoáng qua rồi revert. V2 chỉ chứng minh SQL pagination, không tự chứng minh PostgREST cap. Không dùng kết quả review này làm phê duyệt phát hành.
