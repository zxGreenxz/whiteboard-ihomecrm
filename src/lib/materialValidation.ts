import { z } from 'zod';

export const materialCategoryFormSchema = z.object({
  name: z.string().trim().min(1, 'Nhập tên danh mục'),
  description: z.string().optional().nullable(),
});
export type MaterialCategoryFormValues = z.infer<typeof materialCategoryFormSchema>;

export const materialFormSchema = z.object({
  code: z.string().optional().nullable(),
  name: z.string().trim().min(1, 'Nhập tên vật tư'),
  category_id: z.string().uuid().optional().nullable(),
  unit: z.string().trim().min(1, 'Nhập đơn vị (cái, m, kg…)'),
  image_url: z.string().optional().nullable(),
  description: z.string().optional().nullable(),
  reorder_level: z.coerce.number().min(0, 'Ngưỡng cảnh báo ≥ 0'),
});
export type MaterialFormValues = z.infer<typeof materialFormSchema>;
