import { useId } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { zodResolver } from "@hookform/resolvers/zod";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { CCCDQrData } from "@/lib/cccdQrParser";
import { validOcrDate, type OcrReview, type OcrField } from "@/lib/ocr/parser";

const schema = z.object({
  idNumber: z.string().regex(/^\d{12}$/, "Nhập đủ 12 chữ số."),
  fullName: z
    .string()
    .trim()
    .min(1, "Nhập họ và tên.")
    .max(150)
    .regex(/^[\p{L}\p{M} .'-]+$/u, "Kiểm tra họ và tên."),
  dateOfBirth: z
    .string()
    .refine((value) => Boolean(validOcrDate(value)), "Nhập ngày sinh hợp lệ."),
  gender: z.enum(["Nam", "Nữ"], {
    errorMap: () => ({ message: "Chọn giới tính theo thẻ." }),
  }),
  permanentAddress: z
    .string()
    .trim()
    .min(1, "Nhập đầy đủ nơi thường trú.")
    .max(500),
});
type Values = z.infer<typeof schema>;
const fields: { name: OcrField; label: string; type?: string }[] = [
  { name: "idNumber", label: "Số CCCD (từ ảnh)" },
  { name: "fullName", label: "Họ và tên (từ ảnh)" },
  { name: "dateOfBirth", label: "Ngày sinh (từ ảnh)", type: "date" },
  { name: "gender", label: "Giới tính (từ ảnh)" },
  { name: "permanentAddress", label: "Nơi thường trú đầy đủ (từ ảnh)" },
];
const stateText = {
  readable: "Đọc được · cần đối chiếu",
  check: "Cần kiểm tra kỹ",
  missing: "Chưa đọc được · cần bổ sung",
};
export default function CCCDOcrReview({
  review,
  onApply,
  busy,
}: {
  review: OcrReview;
  onApply: (data: CCCDQrData) => Promise<void>;
  busy: boolean;
}) {
  const id = useId();
  const form = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: {
      idNumber: review.data.idNumber,
      fullName: review.data.fullName,
      dateOfBirth: review.data.dateOfBirth,
      gender: review.data.gender as Values["gender"],
      permanentAddress: review.data.permanentAddress,
    },
  });
  const submit = form.handleSubmit(async (values) => {
    await onApply({
      idNumber: values.idNumber ?? "",
      fullName: values.fullName ?? "",
      dateOfBirth: values.dateOfBirth ?? "",
      gender: values.gender ?? "",
      permanentAddress: values.permanentAddress ?? "",
      source: "ocr",
      ocrReviewApplied: true,
      idIssuePlace: "Cục Cảnh sát",
      idIssueDate: "",
    });
  });
  return (
    <section
      data-testid="cccd-ocr-review"
      aria-label="Kiểm tra thông tin từ ảnh"
      className="rounded-lg border p-3 space-y-3"
      onKeyDown={(event) => {
        if (event.key === "Enter" && event.target instanceof HTMLInputElement) {
          event.preventDefault();
          void submit();
        }
      }}
    >
      <p className="text-sm font-medium">
        Thông tin đọc từ ảnh (OCR) — chưa xác minh
      </p>
      <p className="text-xs text-muted-foreground">
        Đối chiếu và bổ sung đủ 5 trường theo thẻ trước khi áp dụng. Giữ nguyên
        địa chỉ in trên thẻ.
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        {fields.map((field) => {
          const controlId = `${id}-${field.name}`,
            error = form.formState.errors[field.name];
          return (
            <div
              key={field.name}
              className={
                field.name === "permanentAddress"
                  ? "sm:col-span-2 space-y-1"
                  : "space-y-1"
              }
            >
              <Label htmlFor={controlId}>{field.label}</Label>
              {field.name === "gender" ? (
                <select
                  id={controlId}
                  {...form.register("gender")}
                  className="flex h-10 w-full rounded-md border bg-background px-3 text-sm"
                  aria-invalid={Boolean(error)}
                >
                  <option value="">Chưa xác định</option>
                  <option value="Nam">Nam</option>
                  <option value="Nữ">Nữ</option>
                </select>
              ) : field.name === "permanentAddress" ? (
                <Textarea
                  id={controlId}
                  {...form.register(field.name)}
                  aria-invalid={Boolean(error)}
                />
              ) : (
                <Input
                  id={controlId}
                  type={field.type ?? "text"}
                  inputMode={field.name === "idNumber" ? "numeric" : undefined}
                  {...form.register(field.name)}
                  aria-invalid={Boolean(error)}
                />
              )}
              <p className="text-xs text-muted-foreground">
                {stateText[review.states[field.name]]}
              </p>
              {error && (
                <p role="alert" className="text-xs text-red-600">
                  {error.message}
                </p>
              )}
            </div>
          );
        })}
      </div>
      <p className="text-xs text-muted-foreground">
        Nơi cấp mặc định: Cục Cảnh sát. Ngày cấp chưa đọc được, sẽ để trống.
      </p>
      <Button type="button" disabled={busy} onClick={() => void submit()}>
        Áp dụng thông tin đã kiểm tra
      </Button>
    </section>
  );
}
