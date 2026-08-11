// Ô cache của picker khách trong màn hợp đồng: KEY trỏ đúng chỗ, và phép chèn
// khách vừa tạo không làm hỏng dữ liệu đang có.
//
// VÌ SAO CHỈ TEST HÀM THUẦN
//   Vitest ở repo này chạy môi trường `node` (vite.config.ts không đặt
//   `environment`, package.json không có jsdom), nên không render được hook.
//   Vì vậy hai thứ đáng canh nhất được tách thành hàm thuần: `customersQueryKey`
//   và `insertCustomerIntoPickerCache`. Phần còn lại của
//   `useSeedCustomerIntoPickerCache` chỉ là một lời gọi `setQueryData` — không
//   có logic riêng để hỏng.
//
// VÌ SAO KEY ĐÁNG CÓ TEST RIÊNG
//   `setQueryData` ghi vào một key KHÔNG AI ĐỌC là hỏng im lặng tuyệt đối:
//   không lỗi, không cảnh báo, chỉ là khách vừa tạo không hiện ra. Ca
//   "picker key phải khớp key mà useCustomers sinh ra" ở dưới là thứ duy nhất
//   bắt được việc hai bên trôi khỏi nhau.
import { describe, expect, it, vi } from "vitest";

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { from: vi.fn(), rpc: vi.fn() },
}));
vi.mock("@/lib/authSession", () => ({ getSessionUser: vi.fn() }));

import {
  CUSTOMER_PICKER_QUERY_KEY,
  customersQueryKey,
  insertCustomerIntoPickerCache,
} from "@/hooks/useCustomers";
import type { Customer } from "@/types/customer";

function khach(id: string, ten = `Khách ${id}`): Customer {
  return { id, full_name: ten, phone: `090${id}` } as Customer;
}

describe("customersQueryKey", () => {
  it("giữ NGUYÊN key cũ khi không bật skipLocationEnrichment", () => {
    // Đổi hình dạng key của ba consumer còn lại sẽ làm mất cache một lượt sau
    // deploy, và `placeholderData: keepPreviousData` hết dữ liệu cũ để giữ ⇒
    // bảng khách hàng nháy "Đang tải" vô cớ. Ca này chặn việc đó.
    expect(customersQueryKey(undefined, undefined)).toEqual([
      "customers",
      undefined,
      undefined,
    ]);
    const filters = { status: "RENTING" } as never;
    const pagination = { page: 2, pageSize: 20 };
    expect(customersQueryKey(filters, pagination)).toEqual([
      "customers",
      filters,
      pagination,
    ]);
  });

  it("thêm phần tử phân biệt khi bỏ enrichment — hình dạng dữ liệu khác thì ô cache phải khác", () => {
    expect(customersQueryKey(undefined, undefined, true)).not.toEqual(
      customersQueryKey(undefined, undefined),
    );
  });

  it("vẫn giữ gốc \"customers\" để hub realtime invalidate theo prefix còn phủ", () => {
    // Tạo một GỐC mới (vd ["customers-picker"]) là rơi ra ngoài descriptor ở
    // src/hooks/realtime/operations.ts — realtime chết im lặng cho đúng màn này.
    expect(customersQueryKey(undefined, undefined, true)[0]).toBe("customers");
  });

  it("hằng của picker phải khớp key mà useCustomers sinh ra cho picker", () => {
    // Picker gọi useCustomers(undefined, undefined, { skipLocationEnrichment: true }).
    expect(CUSTOMER_PICKER_QUERY_KEY).toEqual(
      customersQueryKey(undefined, undefined, true),
    );
  });
});

describe("insertCustomerIntoPickerCache", () => {
  it("chèn khách mới vào ĐẦU danh sách", () => {
    // Query sắp created_at desc ⇒ khách mới nhất đứng đầu. Chèn vào cuối thì ở
    // 500 khách người dùng phải cuộn hết danh sách mới thấy thứ mình vừa tạo.
    const truoc = { data: [khach("a"), khach("b")], count: 2 };
    const sau = insertCustomerIntoPickerCache(truoc, khach("moi"));
    expect(sau.data.map((c) => c.id)).toEqual(["moi", "a", "b"]);
  });

  it("tăng count cho khớp số dòng", () => {
    const sau = insertCustomerIntoPickerCache(
      { data: [khach("a")], count: 1 },
      khach("moi"),
    );
    expect(sau.count).toBe(2);
  });

  it("chạy được khi cache còn rỗng", () => {
    // Tổ chức chưa có khách nào: picker chưa từng fetch ⇒ prev === undefined.
    const sau = insertCustomerIntoPickerCache(undefined, khach("moi"));
    expect(sau).toEqual({ data: [khach("moi")], count: 1 });
  });

  it("idempotent theo id — gọi hai lần không tạo hàng trùng", () => {
    // Một invalidateQueries hoặc một event realtime có thể đã kịp mang khách đó
    // về trước. Chèn lần hai sẽ vừa nhân đôi hàng vừa đẩy count lệch.
    const mot = insertCustomerIntoPickerCache(undefined, khach("moi"));
    const hai = insertCustomerIntoPickerCache(mot, khach("moi"));
    expect(hai.data).toHaveLength(1);
    expect(hai.count).toBe(1);
    expect(hai).toBe(mot);
  });

  it("không sửa tại chỗ mảng cũ", () => {
    // React Query so sánh tham chiếu để quyết định re-render; sửa tại chỗ là
    // cách kinh điển để cache đổi mà giao diện không đổi.
    const truoc = { data: [khach("a")], count: 1 };
    const goc = truoc.data;
    insertCustomerIntoPickerCache(truoc, khach("moi"));
    expect(truoc.data).toBe(goc);
    expect(truoc.data).toHaveLength(1);
  });
});
