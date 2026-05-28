export interface MaterialCategory {
  id: string;
  user_id: string;
  name: string;
  description: string | null;
  created_at: string;
  updated_at: string;
}

export interface Material {
  id: string;
  user_id: string;
  code: string | null;
  name: string;
  category_id: string | null;
  unit: string;
  image_url: string | null;
  description: string | null;
  reorder_level: number;
  on_hand: number;
  avg_unit_cost: number;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface MaterialWithCategory extends Material {
  category: MaterialCategory | null;
}

export interface MaterialPurchase {
  id: string;
  user_id: string;
  code: string;
  purchase_date: string;
  supplier_id: string | null;
  total: number;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface MaterialPurchaseItem {
  id: string;
  purchase_id: string;
  material_id: string;
  quantity: number;
  unit_price: number;
  line_total: number;
}

export interface MaterialUsage {
  id: string;
  user_id: string;
  code: string;
  usage_date: string;
  job_id: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface MaterialUsageItem {
  id: string;
  usage_id: string;
  material_id: string;
  quantity: number;
  unit_cost_at_usage: number;
}

export interface MaterialAdjustment {
  id: string;
  user_id: string;
  code: string;
  adjustment_date: string;
  type: 'IN' | 'OUT';
  reason: string | null;
  created_at: string;
}

export interface MaterialAdjustmentItem {
  id: string;
  adjustment_id: string;
  material_id: string;
  quantity: number;
}
