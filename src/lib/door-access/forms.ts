import { z } from "zod";

import { DEVICE_KINDS, type DoorTenant } from "./dto";

/** Gắn một số trên máy: với khách đang thuê ở tòa, hoặc một nhãn (vd nhân viên). */
export const KEY_LABEL_MAX = 80;

export const linkKeyFormSchema = z
  .object({
    mode: z.enum(["customer", "label"]),
    customerId: z.string(),
    label: z.string(),
  })
  .superRefine((values, ctx) => {
    if (values.mode === "customer") {
      if (!z.string().uuid().safeParse(values.customerId).success) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["customerId"], message: "Chọn khách đang thuê." });
      }
      return;
    }
    const label = values.label.trim();
    if (!label) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["label"], message: "Nhập nhãn, ví dụ “Nhân viên bảo vệ”." });
    else if ([...label].length > KEY_LABEL_MAX) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["label"], message: `Nhãn tối đa ${KEY_LABEL_MAX} ký tự.` });
    }
  });
export type LinkKeyFormValues = z.infer<typeof linkKeyFormSchema>;

/** Khách có thể thuê nhiều phòng ở cùng tòa — gộp theo khách để mỗi người chỉ một lựa chọn. */
export function tenantOptions(tenants: readonly DoorTenant[]): Array<{ customerId: string; name: string; rooms: string[]; representative: boolean }> {
  const byCustomer = new Map<string, { customerId: string; name: string; rooms: string[]; representative: boolean }>();
  for (const tenant of tenants) {
    const current = byCustomer.get(tenant.customer_id);
    if (current) {
      if (tenant.room_name && !current.rooms.includes(tenant.room_name)) current.rooms.push(tenant.room_name);
      current.representative = current.representative || tenant.is_representative;
      continue;
    }
    byCustomer.set(tenant.customer_id, {
      customerId: tenant.customer_id,
      name: tenant.full_name,
      rooms: tenant.room_name ? [tenant.room_name] : [],
      representative: tenant.is_representative,
    });
  }
  const collator = new Intl.Collator("vi");
  return [...byCustomer.values()].sort(
    (a, b) => collator.compare(a.rooms[0] ?? "", b.rooms[0] ?? "") || collator.compare(a.name, b.name),
  );
}

// ---------------------------------------------------------------------------------------------
// Máy cửa (tab Thiết bị)

export const DEVICE_NAME_MAX = 60;

const integerIn = (min: number, max: number, message: string) =>
  z.string().refine((value) => /^\d{1,3}$/.test(value.trim()) && Number(value) >= min && Number(value) <= max, { message });

export const deviceFormSchema = z.object({
  buildingId: z.string().uuid({ message: "Chọn tòa." }),
  displayName: z
    .string()
    .refine((value) => value.trim().length > 0, { message: "Nhập tên hiển thị." })
    .refine((value) => [...value.trim()].length <= DEVICE_NAME_MAX, { message: `Tên tối đa ${DEVICE_NAME_MAX} ký tự.` }),
  deviceKind: z.enum(DEVICE_KINDS),
  channelId: integerIn(1, 64, "Kênh mở cửa là số từ 1 đến 64."),
  passwordLength: integerIn(6, 10, "Độ dài mật khẩu tạm từ 6 đến 10 số."),
});
export type DeviceFormValues = z.infer<typeof deviceFormSchema>;
