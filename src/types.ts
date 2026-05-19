import { LucideIcon } from "lucide-react";

export type Role = "Marketing Team" | "Coding Team" | "Technical Team" | "Call Center" | "Technical Back Office" | "Manager" | "Restaurants" | "Super Visor" | "Area Manager" | "Operation Manager";

export interface AppNotification {
  id: string;
  notificationType: 'NEW_REQUEST' | 'BUSY_BRANCH' | 'HIDDEN_ITEM' | 'CALL_CENTER' | 'DEDICATION_ALERT';
  title_en: string;
  title_ar: string;
  message_en: string;
  message_ar: string;
  brand_id?: number;
  branch_id?: number;
  role_target?: string[];
  timestamp: string;
}

export interface User {
  id: number;
  username: string;
  role_id: number;
  role_name: Role;
  brand_id?: number;
  brand_name?: string;
  brand_ids?: number[];
  brand_names?: string[];
  branch_id?: number;
  branch_ids?: number[];
  branch_name?: string;
  branch_names?: string[];
  is_active: boolean;
}

export interface PendingRequest {
  id: number;
  user_id: number;
  username?: string;
  type: 'hide_unhide' | 'busy_branch';
  data: any;
  status: 'Pending' | 'Approved' | 'Rejected';
  created_at: string;
  updated_at: string;
  processed_by?: number;
  processor_name?: string;
}

export interface Brand {
  id: number;
  name: string;
}

export interface DynamicField {
  id: number;
  name_en: string;
  name_ar: string;
  type: "text" | "number" | "dropdown" | "multiselect" | "checkbox";
  is_mandatory: boolean;
  is_active: boolean;
  field_order: number;
}

export interface FieldOption {
  id: number;
  field_id: number;
  value_en: string;
  value_ar: string;
  price: number;
}

export interface ModifierOption {
  id: number;
  group_id: number;
  name_en: string;
  name_ar: string;
  price_adjustment: number;
  code?: string;
}

export interface ModifierGroup {
  id: number;
  product_id: number;
  name_en: string;
  name_ar: string;
  selection_type: 'single' | 'multiple';
  is_required: boolean;
  min_selection: number;
  max_selection: number;
  code?: string;
  options: ModifierOption[];
}

export interface Product {
  id: number;
  brand_id: number;
  brand_name: string;
  created_by: number;
  creator_name: string;
  created_at: string;
  updated_at: string;
  product_code?: string;
  categoryCode?: string;
  modifierGroups?: ModifierGroup[];
  channels?: string[];
  is_offline?: boolean;
}

export interface ProductFieldValue {
  id: number;
  product_id: number;
  field_id: number;
  value: string;
}

export interface AuditLog {
  id: number;
  user_id: number;
  username: string;
  action: string;
  target_table: string;
  target_id?: number;
  old_value?: string;
  new_value?: string;
  timestamp: string;
}

export interface BusyPeriodRecord {
  id: number;
  user_id: number;
  username?: string;
  date: string;
  brand: string;
  branch: string;
  start_time: string;
  end_time: string;
  total_duration: string;
  total_duration_minutes: number;
  reason_category: string;
  responsible_party: string;
  comment?: string;
  internal_notes?: string;
  created_at: string;
  timer_duration?: number;
  timer_expires_at?: string;
  alarm_triggered?: boolean;
  alarm_dismissed?: boolean;
}

export interface LateOrderRequest {
  id: number;
  call_center_user_id: number;
  call_center_name?: string;
  creator_role?: string;
  brand_id: number;
  brand_name?: string;
  branch_id: number;
  branch_name?: string;
  customer_name: string;
  customer_phone: string;
  order_id: string;
  platform: string;
  call_center_message?: string;
  case_type: string;
  technical_type?: string;
  dedication_time?: string;
  status: 'Pending' | 'Approved' | 'Rejected';
  restaurant_message?: string;
  restaurant_response_at?: string;
  restaurant_viewed_at?: string;
  manager_viewed_at?: string;
  manager_responded_at?: string;
  dynamic_values?: {
    field_id: number;
    value: string;
    name_en: string;
    name_ar: string;
    type: string;
  }[];
  created_at: string;
  updated_at: string;
  attachment_url?: string;
  attachment_type?: string;
}

export interface CallCenterFormField {
  id: number;
  name_en: string;
  name_ar: string;
  type: 'text' | 'selection' | 'number' | 'textarea';
  is_required: boolean;
  display_order: number;
  is_active: boolean;
}

export interface CallCenterFieldOption {
  id: number;
  field_id: number;
  value_en: string;
  value_ar: string;
  display_order: number;
}

export interface Branch {
  id: number;
  brand_id: number;
  name: string;
}
