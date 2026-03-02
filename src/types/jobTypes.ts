export type IssuePriority = 'LOW' | 'MEDIUM' | 'HIGH' | 'URGENT';

export interface JobGroup {
  id: string;
  user_id: string;
  name: string;
  description: string | null;
  color: string | null;
  icon: string | null;
  created_at: string;
  updated_at: string;
}

export interface Department {
  id: string;
  user_id: string;
  code: string;
  name: string;
  description: string | null;
  manager_id: string | null;
  phone: string | null;
  email: string | null;
  is_active: boolean | null;
  created_at: string;
  updated_at: string;
}

export interface JobType {
  id: string;
  user_id: string;
  name: string;
  job_group_id: string | null;
  description: string | null;
  default_priority: IssuePriority | null;
  customer_contact_deadline: number | null;
  acceptance_deadline: number | null;
  completion_deadline: number | null;
  business_hours_only: boolean | null;
  default_department_id: string | null;
  auto_assign: boolean | null;
  is_active: boolean | null;
  created_at: string;
  updated_at: string;
}

export interface JobTypeWithRelations extends JobType {
  job_groups: { id: string; name: string } | null;
  departments: { id: string; name: string } | null;
}
