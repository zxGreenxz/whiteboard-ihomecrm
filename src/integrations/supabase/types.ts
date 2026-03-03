export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "13.0.5"
  }
  public: {
    Tables: {
      areas: {
        Row: {
          code: string | null
          created_at: string
          deleted_at: string | null
          description: string | null
          id: string
          name: string
          status: string
          updated_at: string
          user_id: string
        }
        Insert: {
          code?: string | null
          created_at?: string
          deleted_at?: string | null
          description?: string | null
          id?: string
          name: string
          status?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          code?: string | null
          created_at?: string
          deleted_at?: string | null
          description?: string | null
          id?: string
          name?: string
          status?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      asset_categories: {
        Row: {
          created_at: string
          description: string | null
          id: string
          name: string
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          description?: string | null
          id?: string
          name: string
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          description?: string | null
          id?: string
          name?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      asset_handovers: {
        Row: {
          contract_id: string
          created_at: string
          handover_date: string
          id: string
          items: Json
          landlord_signature: string | null
          notes: string | null
          tenant_signature: string | null
          type: string
          user_id: string
        }
        Insert: {
          contract_id: string
          created_at?: string
          handover_date: string
          id?: string
          items: Json
          landlord_signature?: string | null
          notes?: string | null
          tenant_signature?: string | null
          type: string
          user_id: string
        }
        Update: {
          contract_id?: string
          created_at?: string
          handover_date?: string
          id?: string
          items?: Json
          landlord_signature?: string | null
          notes?: string | null
          tenant_signature?: string | null
          type?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "asset_handovers_contract_id_fkey"
            columns: ["contract_id"]
            isOneToOne: false
            referencedRelation: "contracts"
            referencedColumns: ["id"]
          },
        ]
      }
      asset_maintenance: {
        Row: {
          asset_id: string
          assigned_to: string | null
          cost: number | null
          created_at: string
          id: string
          issue_description: string
          maintenance_date: string
          notes: string | null
          status: string | null
          user_id: string
        }
        Insert: {
          asset_id: string
          assigned_to?: string | null
          cost?: number | null
          created_at?: string
          id?: string
          issue_description: string
          maintenance_date: string
          notes?: string | null
          status?: string | null
          user_id: string
        }
        Update: {
          asset_id?: string
          assigned_to?: string | null
          cost?: number | null
          created_at?: string
          id?: string
          issue_description?: string
          maintenance_date?: string
          notes?: string | null
          status?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "asset_maintenance_asset_id_fkey"
            columns: ["asset_id"]
            isOneToOne: false
            referencedRelation: "assets"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "asset_maintenance_assigned_to_fkey"
            columns: ["assigned_to"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      asset_movements: {
        Row: {
          asset_id: string
          created_at: string
          from_location: string | null
          from_room_id: string | null
          id: string
          movement_date: string
          quantity: number
          reason: string | null
          to_location: string | null
          to_room_id: string | null
          user_id: string
        }
        Insert: {
          asset_id: string
          created_at?: string
          from_location?: string | null
          from_room_id?: string | null
          id?: string
          movement_date: string
          quantity: number
          reason?: string | null
          to_location?: string | null
          to_room_id?: string | null
          user_id: string
        }
        Update: {
          asset_id?: string
          created_at?: string
          from_location?: string | null
          from_room_id?: string | null
          id?: string
          movement_date?: string
          quantity?: number
          reason?: string | null
          to_location?: string | null
          to_room_id?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "asset_movements_asset_id_fkey"
            columns: ["asset_id"]
            isOneToOne: false
            referencedRelation: "assets"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "asset_movements_from_room_id_fkey"
            columns: ["from_room_id"]
            isOneToOne: false
            referencedRelation: "rooms"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "asset_movements_to_room_id_fkey"
            columns: ["to_room_id"]
            isOneToOne: false
            referencedRelation: "rooms"
            referencedColumns: ["id"]
          },
        ]
      }
      assets: {
        Row: {
          building_id: string | null
          category_id: string | null
          code: string | null
          condition: Database["public"]["Enums"]["asset_condition"] | null
          created_at: string
          deleted_at: string | null
          description: string | null
          id: string
          images: Json | null
          name: string
          purchase_date: string | null
          purchase_price: number | null
          quantity: number | null
          room_id: string | null
          supplier_id: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          building_id?: string | null
          category_id?: string | null
          code?: string | null
          condition?: Database["public"]["Enums"]["asset_condition"] | null
          created_at?: string
          deleted_at?: string | null
          description?: string | null
          id?: string
          images?: Json | null
          name: string
          purchase_date?: string | null
          purchase_price?: number | null
          quantity?: number | null
          room_id?: string | null
          supplier_id?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          building_id?: string | null
          category_id?: string | null
          code?: string | null
          condition?: Database["public"]["Enums"]["asset_condition"] | null
          created_at?: string
          deleted_at?: string | null
          description?: string | null
          id?: string
          images?: Json | null
          name?: string
          purchase_date?: string | null
          purchase_price?: number | null
          quantity?: number | null
          room_id?: string | null
          supplier_id?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "assets_building_id_fkey"
            columns: ["building_id"]
            isOneToOne: false
            referencedRelation: "buildings"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "assets_category_id_fkey"
            columns: ["category_id"]
            isOneToOne: false
            referencedRelation: "asset_categories"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "assets_room_id_fkey"
            columns: ["room_id"]
            isOneToOne: false
            referencedRelation: "rooms"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "assets_supplier_id_fkey"
            columns: ["supplier_id"]
            isOneToOne: false
            referencedRelation: "suppliers"
            referencedColumns: ["id"]
          },
        ]
      }
      beds: {
        Row: {
          code: string | null
          created_at: string
          deleted_at: string | null
          deposit_amount: number
          description: string | null
          id: string
          name: string
          rent_price: number
          room_id: string
          status: Database["public"]["Enums"]["bed_status"]
          updated_at: string
        }
        Insert: {
          code?: string | null
          created_at?: string
          deleted_at?: string | null
          deposit_amount: number
          description?: string | null
          id?: string
          name: string
          rent_price: number
          room_id: string
          status?: Database["public"]["Enums"]["bed_status"]
          updated_at?: string
        }
        Update: {
          code?: string | null
          created_at?: string
          deleted_at?: string | null
          deposit_amount?: number
          description?: string | null
          id?: string
          name?: string
          rent_price?: number
          room_id?: string
          status?: Database["public"]["Enums"]["bed_status"]
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "beds_room_id_fkey"
            columns: ["room_id"]
            isOneToOne: false
            referencedRelation: "rooms"
            referencedColumns: ["id"]
          },
        ]
      }
      buildings: {
        Row: {
          amenities: Json | null
          area_id: string | null
          code: string | null
          created_at: string
          deleted_at: string | null
          description: string | null
          district: string
          id: string
          images: Json | null
          name: string
          province: string
          status: Database["public"]["Enums"]["building_status"]
          street_address: string | null
          total_floors: number | null
          total_rooms: number | null
          type: Database["public"]["Enums"]["building_type"]
          updated_at: string
          user_id: string
          ward: string
        }
        Insert: {
          amenities?: Json | null
          area_id?: string | null
          code?: string | null
          created_at?: string
          deleted_at?: string | null
          description?: string | null
          district: string
          id?: string
          images?: Json | null
          name: string
          province: string
          status?: Database["public"]["Enums"]["building_status"]
          street_address?: string | null
          total_floors?: number | null
          total_rooms?: number | null
          type?: Database["public"]["Enums"]["building_type"]
          updated_at?: string
          user_id: string
          ward: string
        }
        Update: {
          amenities?: Json | null
          area_id?: string | null
          code?: string | null
          created_at?: string
          deleted_at?: string | null
          description?: string | null
          district?: string
          id?: string
          images?: Json | null
          name?: string
          province?: string
          status?: Database["public"]["Enums"]["building_status"]
          street_address?: string | null
          total_floors?: number | null
          total_rooms?: number | null
          type?: Database["public"]["Enums"]["building_type"]
          updated_at?: string
          user_id?: string
          ward?: string
        }
        Relationships: [
          {
            foreignKeyName: "buildings_area_id_fkey"
            columns: ["area_id"]
            isOneToOne: false
            referencedRelation: "areas"
            referencedColumns: ["id"]
          },
        ]
      }
      code_sequences: {
        Row: {
          created_at: string
          current_sequence: number | null
          date_format: string | null
          id: string
          last_reset_at: string | null
          object_type: string
          prefix: string
          reset_period: string | null
          separator: string | null
          sequence_length: number | null
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          current_sequence?: number | null
          date_format?: string | null
          id?: string
          last_reset_at?: string | null
          object_type: string
          prefix: string
          reset_period?: string | null
          separator?: string | null
          sequence_length?: number | null
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          current_sequence?: number | null
          date_format?: string | null
          id?: string
          last_reset_at?: string | null
          object_type?: string
          prefix?: string
          reset_period?: string | null
          separator?: string | null
          sequence_length?: number | null
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      contract_extensions: {
        Row: {
          additional_deposit_required: number | null
          approved_at: string | null
          approved_by: string | null
          contract_id: string
          created_at: string
          deposit_changed: boolean | null
          extension_date: string
          extension_months: number
          extension_type: string
          id: string
          new_contract_id: string | null
          new_deposit: number | null
          new_end_date: string
          new_rent_price: number | null
          new_services: Json | null
          notes: string | null
          old_end_date: string
          rent_price_changed: boolean | null
          services_changed: boolean | null
          status: string
          updated_at: string
          user_id: string
        }
        Insert: {
          additional_deposit_required?: number | null
          approved_at?: string | null
          approved_by?: string | null
          contract_id: string
          created_at?: string
          deposit_changed?: boolean | null
          extension_date?: string
          extension_months: number
          extension_type: string
          id?: string
          new_contract_id?: string | null
          new_deposit?: number | null
          new_end_date: string
          new_rent_price?: number | null
          new_services?: Json | null
          notes?: string | null
          old_end_date: string
          rent_price_changed?: boolean | null
          services_changed?: boolean | null
          status?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          additional_deposit_required?: number | null
          approved_at?: string | null
          approved_by?: string | null
          contract_id?: string
          created_at?: string
          deposit_changed?: boolean | null
          extension_date?: string
          extension_months?: number
          extension_type?: string
          id?: string
          new_contract_id?: string | null
          new_deposit?: number | null
          new_end_date?: string
          new_rent_price?: number | null
          new_services?: Json | null
          notes?: string | null
          old_end_date?: string
          rent_price_changed?: boolean | null
          services_changed?: boolean | null
          status?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "contract_extensions_contract_id_fkey"
            columns: ["contract_id"]
            isOneToOne: false
            referencedRelation: "contracts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "contract_extensions_new_contract_id_fkey"
            columns: ["new_contract_id"]
            isOneToOne: false
            referencedRelation: "contracts"
            referencedColumns: ["id"]
          },
        ]
      }
      contract_services: {
        Row: {
          contract_id: string
          created_at: string
          id: string
          initial_reading: number | null
          service_id: string
          unit_price: number
          updated_at: string
        }
        Insert: {
          contract_id: string
          created_at?: string
          id?: string
          initial_reading?: number | null
          service_id: string
          unit_price: number
          updated_at?: string
        }
        Update: {
          contract_id?: string
          created_at?: string
          id?: string
          initial_reading?: number | null
          service_id?: string
          unit_price?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "contract_services_contract_id_fkey"
            columns: ["contract_id"]
            isOneToOne: false
            referencedRelation: "contracts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "contract_services_service_id_fkey"
            columns: ["service_id"]
            isOneToOne: false
            referencedRelation: "services"
            referencedColumns: ["id"]
          },
        ]
      }
      contract_terminations: {
        Row: {
          actual_move_out_date: string
          approved_at: string | null
          approved_by: string | null
          cleaning_fee: number | null
          contract_id: string
          created_at: string
          damage_description: string | null
          damage_fee: number | null
          damage_images: Json | null
          early_termination_fee: number | null
          id: string
          internal_notes: string | null
          notes: string | null
          notice_date: string | null
          notice_violation_fee: number | null
          other_fees: number | null
          other_fees_description: string | null
          outstanding_debt: number | null
          prorated_days: number | null
          prorated_rent: number | null
          prorated_services: number | null
          refund_amount: number | null
          refund_date: string | null
          refund_method: Database["public"]["Enums"]["payment_method"] | null
          refund_receipt_url: string | null
          status: string
          termination_date: string
          termination_type: string
          total_deductions: number | null
          total_deposit: number
          updated_at: string
          user_id: string
        }
        Insert: {
          actual_move_out_date: string
          approved_at?: string | null
          approved_by?: string | null
          cleaning_fee?: number | null
          contract_id: string
          created_at?: string
          damage_description?: string | null
          damage_fee?: number | null
          damage_images?: Json | null
          early_termination_fee?: number | null
          id?: string
          internal_notes?: string | null
          notes?: string | null
          notice_date?: string | null
          notice_violation_fee?: number | null
          other_fees?: number | null
          other_fees_description?: string | null
          outstanding_debt?: number | null
          prorated_days?: number | null
          prorated_rent?: number | null
          prorated_services?: number | null
          refund_amount?: number | null
          refund_date?: string | null
          refund_method?: Database["public"]["Enums"]["payment_method"] | null
          refund_receipt_url?: string | null
          status?: string
          termination_date?: string
          termination_type: string
          total_deductions?: number | null
          total_deposit: number
          updated_at?: string
          user_id: string
        }
        Update: {
          actual_move_out_date?: string
          approved_at?: string | null
          approved_by?: string | null
          cleaning_fee?: number | null
          contract_id?: string
          created_at?: string
          damage_description?: string | null
          damage_fee?: number | null
          damage_images?: Json | null
          early_termination_fee?: number | null
          id?: string
          internal_notes?: string | null
          notes?: string | null
          notice_date?: string | null
          notice_violation_fee?: number | null
          other_fees?: number | null
          other_fees_description?: string | null
          outstanding_debt?: number | null
          prorated_days?: number | null
          prorated_rent?: number | null
          prorated_services?: number | null
          refund_amount?: number | null
          refund_date?: string | null
          refund_method?: Database["public"]["Enums"]["payment_method"] | null
          refund_receipt_url?: string | null
          status?: string
          termination_date?: string
          termination_type?: string
          total_deductions?: number | null
          total_deposit?: number
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "contract_terminations_contract_id_fkey"
            columns: ["contract_id"]
            isOneToOne: false
            referencedRelation: "contracts"
            referencedColumns: ["id"]
          },
        ]
      }
      contract_transfers: {
        Row: {
          approved_at: string | null
          approved_by: string | null
          contract_id: string
          created_at: string
          deposit_transfer_type: string | null
          id: string
          move_in_date: string | null
          move_out_date: string | null
          new_bed_id: string | null
          new_deposit: number | null
          new_end_date: string | null
          new_rent_price: number | null
          new_room_id: string | null
          new_services: Json | null
          new_start_date: string | null
          new_tenant_deposit_paid: number | null
          new_tenant_id: string | null
          notes: string | null
          old_bed_id: string | null
          old_room_id: string | null
          old_tenant_deposit_refund: number | null
          old_tenant_id: string | null
          old_tenant_outstanding: number | null
          old_tenant_settlement_amount: number | null
          old_tenant_settlement_date: string | null
          reason: string | null
          status: string
          transfer_date: string
          transfer_fee: number | null
          transfer_type: string
          updated_at: string
          user_id: string
        }
        Insert: {
          approved_at?: string | null
          approved_by?: string | null
          contract_id: string
          created_at?: string
          deposit_transfer_type?: string | null
          id?: string
          move_in_date?: string | null
          move_out_date?: string | null
          new_bed_id?: string | null
          new_deposit?: number | null
          new_end_date?: string | null
          new_rent_price?: number | null
          new_room_id?: string | null
          new_services?: Json | null
          new_start_date?: string | null
          new_tenant_deposit_paid?: number | null
          new_tenant_id?: string | null
          notes?: string | null
          old_bed_id?: string | null
          old_room_id?: string | null
          old_tenant_deposit_refund?: number | null
          old_tenant_id?: string | null
          old_tenant_outstanding?: number | null
          old_tenant_settlement_amount?: number | null
          old_tenant_settlement_date?: string | null
          reason?: string | null
          status?: string
          transfer_date?: string
          transfer_fee?: number | null
          transfer_type: string
          updated_at?: string
          user_id: string
        }
        Update: {
          approved_at?: string | null
          approved_by?: string | null
          contract_id?: string
          created_at?: string
          deposit_transfer_type?: string | null
          id?: string
          move_in_date?: string | null
          move_out_date?: string | null
          new_bed_id?: string | null
          new_deposit?: number | null
          new_end_date?: string | null
          new_rent_price?: number | null
          new_room_id?: string | null
          new_services?: Json | null
          new_start_date?: string | null
          new_tenant_deposit_paid?: number | null
          new_tenant_id?: string | null
          notes?: string | null
          old_bed_id?: string | null
          old_room_id?: string | null
          old_tenant_deposit_refund?: number | null
          old_tenant_id?: string | null
          old_tenant_outstanding?: number | null
          old_tenant_settlement_amount?: number | null
          old_tenant_settlement_date?: string | null
          reason?: string | null
          status?: string
          transfer_date?: string
          transfer_fee?: number | null
          transfer_type?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "contract_transfers_contract_id_fkey"
            columns: ["contract_id"]
            isOneToOne: false
            referencedRelation: "contracts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "contract_transfers_new_bed_id_fkey"
            columns: ["new_bed_id"]
            isOneToOne: false
            referencedRelation: "beds"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "contract_transfers_new_room_id_fkey"
            columns: ["new_room_id"]
            isOneToOne: false
            referencedRelation: "rooms"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "contract_transfers_new_tenant_id_fkey"
            columns: ["new_tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "contract_transfers_old_bed_id_fkey"
            columns: ["old_bed_id"]
            isOneToOne: false
            referencedRelation: "beds"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "contract_transfers_old_room_id_fkey"
            columns: ["old_room_id"]
            isOneToOne: false
            referencedRelation: "rooms"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "contract_transfers_old_tenant_id_fkey"
            columns: ["old_tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      contracts: {
        Row: {
          actual_end_date: string | null
          bed_id: string | null
          contract_file_url: string | null
          contract_number: string | null
          contract_template_id: string | null
          created_at: string
          deleted_at: string | null
          deposit_paid: number | null
          deposit_remaining: number | null
          discounts: Json | null
          end_date: string
          expected_move_out_date: string | null
          id: string
          initial_electricity_reading: number | null
          initial_water_reading: number | null
          invoice_template_id: string | null
          notes: string | null
          parent_contract_id: string | null
          payment_cycle: Database["public"]["Enums"]["payment_cycle"] | null
          rent_price: number
          room_id: string | null
          signed_date: string
          start_billing_date: string | null
          start_date: string
          status: Database["public"]["Enums"]["contract_status"]
          tenant_id: string
          total_deposit: number
          updated_at: string
          user_id: string
        }
        Insert: {
          actual_end_date?: string | null
          bed_id?: string | null
          contract_file_url?: string | null
          contract_number?: string | null
          contract_template_id?: string | null
          created_at?: string
          deleted_at?: string | null
          deposit_paid?: number | null
          deposit_remaining?: number | null
          discounts?: Json | null
          end_date: string
          expected_move_out_date?: string | null
          id?: string
          initial_electricity_reading?: number | null
          initial_water_reading?: number | null
          invoice_template_id?: string | null
          notes?: string | null
          parent_contract_id?: string | null
          payment_cycle?: Database["public"]["Enums"]["payment_cycle"] | null
          rent_price: number
          room_id?: string | null
          signed_date: string
          start_billing_date?: string | null
          start_date: string
          status?: Database["public"]["Enums"]["contract_status"]
          tenant_id: string
          total_deposit?: number
          updated_at?: string
          user_id: string
        }
        Update: {
          actual_end_date?: string | null
          bed_id?: string | null
          contract_file_url?: string | null
          contract_number?: string | null
          contract_template_id?: string | null
          created_at?: string
          deleted_at?: string | null
          deposit_paid?: number | null
          deposit_remaining?: number | null
          discounts?: Json | null
          end_date?: string
          expected_move_out_date?: string | null
          id?: string
          initial_electricity_reading?: number | null
          initial_water_reading?: number | null
          invoice_template_id?: string | null
          notes?: string | null
          parent_contract_id?: string | null
          payment_cycle?: Database["public"]["Enums"]["payment_cycle"] | null
          rent_price?: number
          room_id?: string | null
          signed_date?: string
          start_billing_date?: string | null
          start_date?: string
          status?: Database["public"]["Enums"]["contract_status"]
          tenant_id?: string
          total_deposit?: number
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "contracts_bed_id_fkey"
            columns: ["bed_id"]
            isOneToOne: false
            referencedRelation: "beds"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "contracts_contract_template_id_fkey"
            columns: ["contract_template_id"]
            isOneToOne: false
            referencedRelation: "document_templates"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "contracts_invoice_template_id_fkey"
            columns: ["invoice_template_id"]
            isOneToOne: false
            referencedRelation: "document_templates"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "contracts_parent_contract_id_fkey"
            columns: ["parent_contract_id"]
            isOneToOne: false
            referencedRelation: "contracts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "contracts_room_id_fkey"
            columns: ["room_id"]
            isOneToOne: false
            referencedRelation: "rooms"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "contracts_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      deposits: {
        Row: {
          amount: number
          bed_id: string | null
          contract_id: string | null
          created_at: string
          deposit_date: string
          hold_until: string | null
          id: string
          notes: string | null
          receipt_image_url: string | null
          room_id: string | null
          status: Database["public"]["Enums"]["deposit_status"]
          tenant_id: string
          updated_at: string
          user_id: string
        }
        Insert: {
          amount: number
          bed_id?: string | null
          contract_id?: string | null
          created_at?: string
          deposit_date?: string
          hold_until?: string | null
          id?: string
          notes?: string | null
          receipt_image_url?: string | null
          room_id?: string | null
          status?: Database["public"]["Enums"]["deposit_status"]
          tenant_id: string
          updated_at?: string
          user_id: string
        }
        Update: {
          amount?: number
          bed_id?: string | null
          contract_id?: string | null
          created_at?: string
          deposit_date?: string
          hold_until?: string | null
          id?: string
          notes?: string | null
          receipt_image_url?: string | null
          room_id?: string | null
          status?: Database["public"]["Enums"]["deposit_status"]
          tenant_id?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "deposits_bed_id_fkey"
            columns: ["bed_id"]
            isOneToOne: false
            referencedRelation: "beds"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "deposits_contract_id_fkey"
            columns: ["contract_id"]
            isOneToOne: false
            referencedRelation: "contracts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "deposits_room_id_fkey"
            columns: ["room_id"]
            isOneToOne: false
            referencedRelation: "rooms"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "deposits_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      departments: {
        Row: {
          id: string
          user_id: string
          code: string
          name: string
          description: string | null
          manager_id: string | null
          phone: string | null
          email: string | null
          is_active: boolean | null
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          user_id: string
          code: string
          name: string
          description?: string | null
          manager_id?: string | null
          phone?: string | null
          email?: string | null
          is_active?: boolean | null
          created_at?: string
          updated_at?: string
        }
        Update: {
          id?: string
          user_id?: string
          code?: string
          name?: string
          description?: string | null
          manager_id?: string | null
          phone?: string | null
          email?: string | null
          is_active?: boolean | null
          created_at?: string
          updated_at?: string
        }
        Relationships: []
      }
      expenses: {
        Row: {
          amount: number
          building_id: string | null
          category: Database["public"]["Enums"]["expense_category"]
          created_at: string
          deleted_at: string | null
          description: string
          expense_date: string
          id: string
          notes: string | null
          receipt_image_url: string | null
          room_id: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          amount: number
          building_id?: string | null
          category: Database["public"]["Enums"]["expense_category"]
          created_at?: string
          deleted_at?: string | null
          description: string
          expense_date?: string
          id?: string
          notes?: string | null
          receipt_image_url?: string | null
          room_id?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          amount?: number
          building_id?: string | null
          category?: Database["public"]["Enums"]["expense_category"]
          created_at?: string
          deleted_at?: string | null
          description?: string
          expense_date?: string
          id?: string
          notes?: string | null
          receipt_image_url?: string | null
          room_id?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "expenses_building_id_fkey"
            columns: ["building_id"]
            isOneToOne: false
            referencedRelation: "buildings"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "expenses_room_id_fkey"
            columns: ["room_id"]
            isOneToOne: false
            referencedRelation: "rooms"
            referencedColumns: ["id"]
          },
        ]
      }
      invoice_items: {
        Row: {
          amount: number
          created_at: string
          current_reading: number | null
          description: string
          id: string
          invoice_id: string
          previous_reading: number | null
          quantity: number | null
          service_id: string | null
          type: Database["public"]["Enums"]["invoice_item_type"]
          unit_price: number
        }
        Insert: {
          amount: number
          created_at?: string
          current_reading?: number | null
          description: string
          id?: string
          invoice_id: string
          previous_reading?: number | null
          quantity?: number | null
          service_id?: string | null
          type: Database["public"]["Enums"]["invoice_item_type"]
          unit_price: number
        }
        Update: {
          amount?: number
          created_at?: string
          current_reading?: number | null
          description?: string
          id?: string
          invoice_id?: string
          previous_reading?: number | null
          quantity?: number | null
          service_id?: string | null
          type?: Database["public"]["Enums"]["invoice_item_type"]
          unit_price?: number
        }
        Relationships: [
          {
            foreignKeyName: "invoice_items_invoice_id_fkey"
            columns: ["invoice_id"]
            isOneToOne: false
            referencedRelation: "invoices"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "invoice_items_service_id_fkey"
            columns: ["service_id"]
            isOneToOne: false
            referencedRelation: "services"
            referencedColumns: ["id"]
          },
        ]
      }
      invoices: {
        Row: {
          billing_period_end: string
          billing_period_start: string
          contract_id: string
          created_at: string
          deleted_at: string | null
          discount_amount: number | null
          due_date: string
          id: string
          invoice_number: string | null
          issue_date: string
          notes: string | null
          paid_amount: number | null
          paid_date: string | null
          previous_debt: number | null
          remaining_amount: number | null
          status: Database["public"]["Enums"]["invoice_status"]
          subtotal: number
          tax_amount: number | null
          title: string
          total_amount: number
          updated_at: string
          user_id: string
        }
        Insert: {
          billing_period_end: string
          billing_period_start: string
          contract_id: string
          created_at?: string
          deleted_at?: string | null
          discount_amount?: number | null
          due_date: string
          id?: string
          invoice_number?: string | null
          issue_date?: string
          notes?: string | null
          paid_amount?: number | null
          paid_date?: string | null
          previous_debt?: number | null
          remaining_amount?: number | null
          status?: Database["public"]["Enums"]["invoice_status"]
          subtotal?: number
          tax_amount?: number | null
          title: string
          total_amount?: number
          updated_at?: string
          user_id: string
        }
        Update: {
          billing_period_end?: string
          billing_period_start?: string
          contract_id?: string
          created_at?: string
          deleted_at?: string | null
          discount_amount?: number | null
          due_date?: string
          id?: string
          invoice_number?: string | null
          issue_date?: string
          notes?: string | null
          paid_amount?: number | null
          paid_date?: string | null
          previous_debt?: number | null
          remaining_amount?: number | null
          status?: Database["public"]["Enums"]["invoice_status"]
          subtotal?: number
          tax_amount?: number | null
          title?: string
          total_amount?: number
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "invoices_contract_id_fkey"
            columns: ["contract_id"]
            isOneToOne: false
            referencedRelation: "contracts"
            referencedColumns: ["id"]
          },
        ]
      }
      issue_categories: {
        Row: {
          created_at: string
          description: string | null
          id: string
          name: string
          user_id: string
        }
        Insert: {
          created_at?: string
          description?: string | null
          id?: string
          name: string
          user_id: string
        }
        Update: {
          created_at?: string
          description?: string | null
          id?: string
          name?: string
          user_id?: string
        }
        Relationships: []
      }
      issue_comments: {
        Row: {
          comment: string
          created_at: string
          id: string
          images: Json | null
          issue_id: string
          user_id: string
        }
        Insert: {
          comment: string
          created_at?: string
          id?: string
          images?: Json | null
          issue_id: string
          user_id: string
        }
        Update: {
          comment?: string
          created_at?: string
          id?: string
          images?: Json | null
          issue_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "issue_comments_issue_id_fkey"
            columns: ["issue_id"]
            isOneToOne: false
            referencedRelation: "issues"
            referencedColumns: ["id"]
          },
        ]
      }
      issues: {
        Row: {
          actual_cost: number | null
          assigned_at: string | null
          assigned_to: string | null
          attachments: Json | null
          building_id: string | null
          category_id: string | null
          closed_at: string | null
          contract_id: string | null
          created_at: string
          description: string
          due_date: string | null
          estimated_cost: number | null
          feedback: string | null
          id: string
          images: Json | null
          priority: Database["public"]["Enums"]["issue_priority"] | null
          rating: number | null
          reported_by_staff_id: string | null
          reported_by_tenant_id: string | null
          resolved_at: string | null
          room_id: string | null
          status: Database["public"]["Enums"]["issue_status"] | null
          title: string
          updated_at: string
          user_id: string
        }
        Insert: {
          actual_cost?: number | null
          assigned_at?: string | null
          assigned_to?: string | null
          attachments?: Json | null
          building_id?: string | null
          category_id?: string | null
          closed_at?: string | null
          contract_id?: string | null
          created_at?: string
          description: string
          due_date?: string | null
          estimated_cost?: number | null
          feedback?: string | null
          id?: string
          images?: Json | null
          priority?: Database["public"]["Enums"]["issue_priority"] | null
          rating?: number | null
          reported_by_staff_id?: string | null
          reported_by_tenant_id?: string | null
          resolved_at?: string | null
          room_id?: string | null
          status?: Database["public"]["Enums"]["issue_status"] | null
          title: string
          updated_at?: string
          user_id: string
        }
        Update: {
          actual_cost?: number | null
          assigned_at?: string | null
          assigned_to?: string | null
          attachments?: Json | null
          building_id?: string | null
          category_id?: string | null
          closed_at?: string | null
          contract_id?: string | null
          created_at?: string
          description?: string
          due_date?: string | null
          estimated_cost?: number | null
          feedback?: string | null
          id?: string
          images?: Json | null
          priority?: Database["public"]["Enums"]["issue_priority"] | null
          rating?: number | null
          reported_by_staff_id?: string | null
          reported_by_tenant_id?: string | null
          resolved_at?: string | null
          room_id?: string | null
          status?: Database["public"]["Enums"]["issue_status"] | null
          title?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "issues_assigned_to_fkey"
            columns: ["assigned_to"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "issues_building_id_fkey"
            columns: ["building_id"]
            isOneToOne: false
            referencedRelation: "buildings"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "issues_category_id_fkey"
            columns: ["category_id"]
            isOneToOne: false
            referencedRelation: "issue_categories"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "issues_contract_id_fkey"
            columns: ["contract_id"]
            isOneToOne: false
            referencedRelation: "contracts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "issues_reported_by_staff_id_fkey"
            columns: ["reported_by_staff_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "issues_reported_by_tenant_id_fkey"
            columns: ["reported_by_tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "issues_room_id_fkey"
            columns: ["room_id"]
            isOneToOne: false
            referencedRelation: "rooms"
            referencedColumns: ["id"]
          },
        ]
      }
      job_groups: {
        Row: {
          id: string
          user_id: string
          name: string
          description: string | null
          color: string | null
          icon: string | null
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          user_id: string
          name: string
          description?: string | null
          color?: string | null
          icon?: string | null
          created_at?: string
          updated_at?: string
        }
        Update: {
          id?: string
          user_id?: string
          name?: string
          description?: string | null
          color?: string | null
          icon?: string | null
          created_at?: string
          updated_at?: string
        }
        Relationships: []
      }
      jobs: {
        Row: {
          id: string
          user_id: string
          code: string
          title: string
          description: string | null
          building_id: string | null
          room_id: string | null
          bed_id: string | null
          job_group_id: string | null
          job_type_id: string | null
          priority: string
          assignee_id: string | null
          deadline: string | null
          status: string
          visible_to_customer: boolean | null
          attachments: Json | null
          completion_time: string | null
          completion_description: string | null
          completion_attachments: Json | null
          acceptance_result: string | null
          customer_evaluation: string | null
          customer_comments: string | null
          accepted_at: string | null
          started_at: string | null
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          user_id: string
          code?: string
          title: string
          description?: string | null
          building_id?: string | null
          room_id?: string | null
          bed_id?: string | null
          job_group_id?: string | null
          job_type_id?: string | null
          priority?: string
          assignee_id?: string | null
          deadline?: string | null
          status?: string
          visible_to_customer?: boolean | null
          attachments?: Json | null
          completion_time?: string | null
          completion_description?: string | null
          completion_attachments?: Json | null
          acceptance_result?: string | null
          customer_evaluation?: string | null
          customer_comments?: string | null
          accepted_at?: string | null
          started_at?: string | null
          created_at?: string
          updated_at?: string
        }
        Update: {
          id?: string
          user_id?: string
          code?: string
          title?: string
          description?: string | null
          building_id?: string | null
          room_id?: string | null
          bed_id?: string | null
          job_group_id?: string | null
          job_type_id?: string | null
          priority?: string
          assignee_id?: string | null
          deadline?: string | null
          status?: string
          visible_to_customer?: boolean | null
          attachments?: Json | null
          completion_time?: string | null
          completion_description?: string | null
          completion_attachments?: Json | null
          acceptance_result?: string | null
          customer_evaluation?: string | null
          customer_comments?: string | null
          accepted_at?: string | null
          started_at?: string | null
          created_at?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "jobs_building_id_fkey"
            columns: ["building_id"]
            isOneToOne: false
            referencedRelation: "buildings"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "jobs_room_id_fkey"
            columns: ["room_id"]
            isOneToOne: false
            referencedRelation: "rooms"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "jobs_bed_id_fkey"
            columns: ["bed_id"]
            isOneToOne: false
            referencedRelation: "beds"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "jobs_job_group_id_fkey"
            columns: ["job_group_id"]
            isOneToOne: false
            referencedRelation: "job_groups"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "jobs_job_type_id_fkey"
            columns: ["job_type_id"]
            isOneToOne: false
            referencedRelation: "job_types"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "jobs_assignee_id_fkey"
            columns: ["assignee_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      job_types: {
        Row: {
          id: string
          user_id: string
          name: string
          job_group_id: string | null
          description: string | null
          default_priority: Database["public"]["Enums"]["issue_priority"] | null
          customer_contact_deadline: number | null
          acceptance_deadline: number | null
          completion_deadline: number | null
          business_hours_only: boolean | null
          default_department_id: string | null
          auto_assign: boolean | null
          is_active: boolean | null
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          user_id: string
          name: string
          job_group_id?: string | null
          description?: string | null
          default_priority?: Database["public"]["Enums"]["issue_priority"] | null
          customer_contact_deadline?: number | null
          acceptance_deadline?: number | null
          completion_deadline?: number | null
          business_hours_only?: boolean | null
          default_department_id?: string | null
          auto_assign?: boolean | null
          is_active?: boolean | null
          created_at?: string
          updated_at?: string
        }
        Update: {
          id?: string
          user_id?: string
          name?: string
          job_group_id?: string | null
          description?: string | null
          default_priority?: Database["public"]["Enums"]["issue_priority"] | null
          customer_contact_deadline?: number | null
          acceptance_deadline?: number | null
          completion_deadline?: number | null
          business_hours_only?: boolean | null
          default_department_id?: string | null
          auto_assign?: boolean | null
          is_active?: boolean | null
          created_at?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "job_types_job_group_id_fkey"
            columns: ["job_group_id"]
            isOneToOne: false
            referencedRelation: "job_groups"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "job_types_default_department_id_fkey"
            columns: ["default_department_id"]
            isOneToOne: false
            referencedRelation: "departments"
            referencedColumns: ["id"]
          },
        ]
      }
      leads: {
        Row: {
          appointment_date: string | null
          assigned_staff_id: string | null
          building_id: string | null
          contract_id: string | null
          created_at: string
          customer_name: string
          deposit_id: string | null
          email: string | null
          id: string
          notes: string | null
          phone: string
          room_id: string | null
          source: Database["public"]["Enums"]["lead_source"] | null
          status: Database["public"]["Enums"]["lead_status"] | null
          updated_at: string
          user_id: string
        }
        Insert: {
          appointment_date?: string | null
          assigned_staff_id?: string | null
          building_id?: string | null
          contract_id?: string | null
          created_at?: string
          customer_name: string
          deposit_id?: string | null
          email?: string | null
          id?: string
          notes?: string | null
          phone: string
          room_id?: string | null
          source?: Database["public"]["Enums"]["lead_source"] | null
          status?: Database["public"]["Enums"]["lead_status"] | null
          updated_at?: string
          user_id: string
        }
        Update: {
          appointment_date?: string | null
          assigned_staff_id?: string | null
          building_id?: string | null
          contract_id?: string | null
          created_at?: string
          customer_name?: string
          deposit_id?: string | null
          email?: string | null
          id?: string
          notes?: string | null
          phone?: string
          room_id?: string | null
          source?: Database["public"]["Enums"]["lead_source"] | null
          status?: Database["public"]["Enums"]["lead_status"] | null
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "leads_assigned_staff_id_fkey"
            columns: ["assigned_staff_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "leads_building_id_fkey"
            columns: ["building_id"]
            isOneToOne: false
            referencedRelation: "buildings"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "leads_contract_id_fkey"
            columns: ["contract_id"]
            isOneToOne: false
            referencedRelation: "contracts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "leads_deposit_id_fkey"
            columns: ["deposit_id"]
            isOneToOne: false
            referencedRelation: "deposits"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "leads_room_id_fkey"
            columns: ["room_id"]
            isOneToOne: false
            referencedRelation: "rooms"
            referencedColumns: ["id"]
          },
        ]
      }
      meter_readings: {
        Row: {
          consumption: number | null
          contract_id: string
          created_at: string
          current_reading: number
          id: string
          meter_image_url: string | null
          meter_type: Database["public"]["Enums"]["meter_type"]
          notes: string | null
          previous_reading: number
          reading_date: string
          service_id: string
          user_id: string
        }
        Insert: {
          consumption?: number | null
          contract_id: string
          created_at?: string
          current_reading: number
          id?: string
          meter_image_url?: string | null
          meter_type: Database["public"]["Enums"]["meter_type"]
          notes?: string | null
          previous_reading?: number
          reading_date: string
          service_id: string
          user_id: string
        }
        Update: {
          consumption?: number | null
          contract_id?: string
          created_at?: string
          current_reading?: number
          id?: string
          meter_image_url?: string | null
          meter_type?: Database["public"]["Enums"]["meter_type"]
          notes?: string | null
          previous_reading?: number
          reading_date?: string
          service_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "meter_readings_contract_id_fkey"
            columns: ["contract_id"]
            isOneToOne: false
            referencedRelation: "contracts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "meter_readings_service_id_fkey"
            columns: ["service_id"]
            isOneToOne: false
            referencedRelation: "services"
            referencedColumns: ["id"]
          },
        ]
      }
      notification_logs: {
        Row: {
          channel: Database["public"]["Enums"]["notification_channel"]
          created_at: string
          error_message: string | null
          id: string
          notification_id: string
          provider_response: Json | null
          recipient_email: string | null
          recipient_id: string | null
          recipient_phone: string | null
          sent_at: string | null
          status: Database["public"]["Enums"]["notification_status"]
        }
        Insert: {
          channel: Database["public"]["Enums"]["notification_channel"]
          created_at?: string
          error_message?: string | null
          id?: string
          notification_id: string
          provider_response?: Json | null
          recipient_email?: string | null
          recipient_id?: string | null
          recipient_phone?: string | null
          sent_at?: string | null
          status: Database["public"]["Enums"]["notification_status"]
        }
        Update: {
          channel?: Database["public"]["Enums"]["notification_channel"]
          created_at?: string
          error_message?: string | null
          id?: string
          notification_id?: string
          provider_response?: Json | null
          recipient_email?: string | null
          recipient_id?: string | null
          recipient_phone?: string | null
          sent_at?: string | null
          status?: Database["public"]["Enums"]["notification_status"]
        }
        Relationships: [
          {
            foreignKeyName: "notification_logs_notification_id_fkey"
            columns: ["notification_id"]
            isOneToOne: false
            referencedRelation: "notifications"
            referencedColumns: ["id"]
          },
        ]
      }
      notification_templates: {
        Row: {
          created_at: string
          email_body: string | null
          email_subject: string | null
          id: string
          is_active: boolean | null
          name: string
          push_body: string | null
          push_title: string | null
          sms_content: string | null
          type: Database["public"]["Enums"]["notification_type"]
          user_id: string
          zalo_template_id: string | null
        }
        Insert: {
          created_at?: string
          email_body?: string | null
          email_subject?: string | null
          id?: string
          is_active?: boolean | null
          name: string
          push_body?: string | null
          push_title?: string | null
          sms_content?: string | null
          type: Database["public"]["Enums"]["notification_type"]
          user_id: string
          zalo_template_id?: string | null
        }
        Update: {
          created_at?: string
          email_body?: string | null
          email_subject?: string | null
          id?: string
          is_active?: boolean | null
          name?: string
          push_body?: string | null
          push_title?: string | null
          sms_content?: string | null
          type?: Database["public"]["Enums"]["notification_type"]
          user_id?: string
          zalo_template_id?: string | null
        }
        Relationships: []
      }
      notifications: {
        Row: {
          channel: Database["public"]["Enums"]["notification_channel"]
          content: string
          contract_id: string | null
          created_at: string
          error_message: string | null
          id: string
          invoice_id: string | null
          issue_id: string | null
          recipient_emails: string[] | null
          recipient_phones: string[] | null
          recipient_tenant_ids: string[] | null
          scheduled_at: string | null
          sent_at: string | null
          status: Database["public"]["Enums"]["notification_status"] | null
          subject: string | null
          type: Database["public"]["Enums"]["notification_type"]
          user_id: string
        }
        Insert: {
          channel: Database["public"]["Enums"]["notification_channel"]
          content: string
          contract_id?: string | null
          created_at?: string
          error_message?: string | null
          id?: string
          invoice_id?: string | null
          issue_id?: string | null
          recipient_emails?: string[] | null
          recipient_phones?: string[] | null
          recipient_tenant_ids?: string[] | null
          scheduled_at?: string | null
          sent_at?: string | null
          status?: Database["public"]["Enums"]["notification_status"] | null
          subject?: string | null
          type: Database["public"]["Enums"]["notification_type"]
          user_id: string
        }
        Update: {
          channel?: Database["public"]["Enums"]["notification_channel"]
          content?: string
          contract_id?: string | null
          created_at?: string
          error_message?: string | null
          id?: string
          invoice_id?: string | null
          issue_id?: string | null
          recipient_emails?: string[] | null
          recipient_phones?: string[] | null
          recipient_tenant_ids?: string[] | null
          scheduled_at?: string | null
          sent_at?: string | null
          status?: Database["public"]["Enums"]["notification_status"] | null
          subject?: string | null
          type?: Database["public"]["Enums"]["notification_type"]
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "notifications_contract_id_fkey"
            columns: ["contract_id"]
            isOneToOne: false
            referencedRelation: "contracts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "notifications_invoice_id_fkey"
            columns: ["invoice_id"]
            isOneToOne: false
            referencedRelation: "invoices"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "notifications_issue_id_fkey"
            columns: ["issue_id"]
            isOneToOne: false
            referencedRelation: "issues"
            referencedColumns: ["id"]
          },
        ]
      }
      payments: {
        Row: {
          amount: number
          created_at: string
          id: string
          invoice_id: string
          notes: string | null
          payment_date: string
          payment_method: Database["public"]["Enums"]["payment_method"]
          receipt_image_url: string | null
          receipt_number: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          amount: number
          created_at?: string
          id?: string
          invoice_id: string
          notes?: string | null
          payment_date?: string
          payment_method?: Database["public"]["Enums"]["payment_method"]
          receipt_image_url?: string | null
          receipt_number?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          amount?: number
          created_at?: string
          id?: string
          invoice_id?: string
          notes?: string | null
          payment_date?: string
          payment_method?: Database["public"]["Enums"]["payment_method"]
          receipt_image_url?: string | null
          receipt_number?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "payments_invoice_id_fkey"
            columns: ["invoice_id"]
            isOneToOne: false
            referencedRelation: "invoices"
            referencedColumns: ["id"]
          },
        ]
      }
      profiles: {
        Row: {
          address: string | null
          avatar_url: string | null
          company_name: string | null
          created_at: string
          default_payment_due_days: number | null
          email: string | null
          full_name: string
          id: string
          language: string | null
          phone: string | null
          subscription_expires_at: string | null
          subscription_plan: string | null
          timezone: string | null
          updated_at: string
        }
        Insert: {
          address?: string | null
          avatar_url?: string | null
          company_name?: string | null
          created_at?: string
          default_payment_due_days?: number | null
          email?: string | null
          full_name: string
          id: string
          language?: string | null
          phone?: string | null
          subscription_expires_at?: string | null
          subscription_plan?: string | null
          timezone?: string | null
          updated_at?: string
        }
        Update: {
          address?: string | null
          avatar_url?: string | null
          company_name?: string | null
          created_at?: string
          default_payment_due_days?: number | null
          email?: string | null
          full_name?: string
          id?: string
          language?: string | null
          phone?: string | null
          subscription_expires_at?: string | null
          subscription_plan?: string | null
          timezone?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      rooms: {
        Row: {
          amenities: Json | null
          area: number | null
          building_id: string
          code: string | null
          created_at: string
          deleted_at: string | null
          deposit_amount: number
          description: string | null
          floor: number
          id: string
          images: Json | null
          max_occupants: number | null
          name: string
          rent_price: number
          status: Database["public"]["Enums"]["room_status"]
          updated_at: string
        }
        Insert: {
          amenities?: Json | null
          area?: number | null
          building_id: string
          code?: string | null
          created_at?: string
          deleted_at?: string | null
          deposit_amount: number
          description?: string | null
          floor?: number
          id?: string
          images?: Json | null
          max_occupants?: number | null
          name: string
          rent_price: number
          status?: Database["public"]["Enums"]["room_status"]
          updated_at?: string
        }
        Update: {
          amenities?: Json | null
          area?: number | null
          building_id?: string
          code?: string | null
          created_at?: string
          deleted_at?: string | null
          deposit_amount?: number
          description?: string | null
          floor?: number
          id?: string
          images?: Json | null
          max_occupants?: number | null
          name?: string
          rent_price?: number
          status?: Database["public"]["Enums"]["room_status"]
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "rooms_building_id_fkey"
            columns: ["building_id"]
            isOneToOne: false
            referencedRelation: "buildings"
            referencedColumns: ["id"]
          },
        ]
      }
      service_buildings: {
        Row: {
          building_id: string
          created_at: string
          id: string
          service_id: string
        }
        Insert: {
          building_id: string
          created_at?: string
          id?: string
          service_id: string
        }
        Update: {
          building_id?: string
          created_at?: string
          id?: string
          service_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "service_buildings_building_id_fkey"
            columns: ["building_id"]
            isOneToOne: false
            referencedRelation: "buildings"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "service_buildings_service_id_fkey"
            columns: ["service_id"]
            isOneToOne: false
            referencedRelation: "services"
            referencedColumns: ["id"]
          },
        ]
      }
      service_quota_tiers: {
        Row: {
          created_at: string
          from_value: number
          id: string
          quota_id: string
          tier_number: number
          to_value: number | null
          unit_price: number
        }
        Insert: {
          created_at?: string
          from_value: number
          id?: string
          quota_id: string
          tier_number: number
          to_value?: number | null
          unit_price: number
        }
        Update: {
          created_at?: string
          from_value?: number
          id?: string
          quota_id?: string
          tier_number?: number
          to_value?: number | null
          unit_price?: number
        }
        Relationships: [
          {
            foreignKeyName: "service_quota_tiers_quota_id_fkey"
            columns: ["quota_id"]
            isOneToOne: false
            referencedRelation: "service_quotas"
            referencedColumns: ["id"]
          },
        ]
      }
      services: {
        Row: {
          code: string | null
          created_at: string
          deleted_at: string | null
          description: string | null
          fee_type: Database["public"]["Enums"]["fee_type"] | null
          id: string
          is_default: boolean | null
          is_mandatory: boolean | null
          name: string
          pricing_type: Database["public"]["Enums"]["pricing_type"] | null
          quota_id: string | null
          tax_rate: number | null
          type: Database["public"]["Enums"]["service_type"]
          unit: string | null
          unit_price: number
          updated_at: string
          user_id: string
        }
        Insert: {
          code?: string | null
          created_at?: string
          deleted_at?: string | null
          description?: string | null
          fee_type?: Database["public"]["Enums"]["fee_type"] | null
          id?: string
          is_default?: boolean | null
          is_mandatory?: boolean | null
          name: string
          pricing_type?: Database["public"]["Enums"]["pricing_type"] | null
          quota_id?: string | null
          tax_rate?: number | null
          type: Database["public"]["Enums"]["service_type"]
          unit?: string | null
          unit_price?: number
          updated_at?: string
          user_id: string
        }
        Update: {
          code?: string | null
          created_at?: string
          deleted_at?: string | null
          description?: string | null
          fee_type?: Database["public"]["Enums"]["fee_type"] | null
          id?: string
          is_default?: boolean | null
          is_mandatory?: boolean | null
          name?: string
          pricing_type?: Database["public"]["Enums"]["pricing_type"] | null
          quota_id?: string | null
          tax_rate?: number | null
          type?: Database["public"]["Enums"]["service_type"]
          unit?: string | null
          unit_price?: number
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "services_quota_id_fkey"
            columns: ["quota_id"]
            isOneToOne: false
            referencedRelation: "service_quotas"
            referencedColumns: ["id"]
          },
        ]
      }
      settings: {
        Row: {
          created_at: string
          id: string
          key: string
          updated_at: string
          user_id: string
          value: Json
        }
        Insert: {
          created_at?: string
          id?: string
          key: string
          updated_at?: string
          user_id: string
          value: Json
        }
        Update: {
          created_at?: string
          id?: string
          key?: string
          updated_at?: string
          user_id?: string
          value?: Json
        }
        Relationships: []
      }
      signature_templates: {
        Row: {
          code: string
          created_at: string
          font_style: string | null
          id: string
          is_active: boolean | null
          name: string
          signature_data: Json | null
          signature_type: string
          signature_url: string | null
          text_content: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          code: string
          created_at?: string
          font_style?: string | null
          id?: string
          is_active?: boolean | null
          name: string
          signature_data?: Json | null
          signature_type: string
          signature_url?: string | null
          text_content?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          code?: string
          created_at?: string
          font_style?: string | null
          id?: string
          is_active?: boolean | null
          name?: string
          signature_data?: Json | null
          signature_type?: string
          signature_url?: string | null
          text_content?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      suppliers: {
        Row: {
          address: string | null
          created_at: string
          deleted_at: string | null
          email: string | null
          id: string
          name: string
          phone: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          address?: string | null
          created_at?: string
          deleted_at?: string | null
          email?: string | null
          id?: string
          name: string
          phone?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          address?: string | null
          created_at?: string
          deleted_at?: string | null
          email?: string | null
          id?: string
          name?: string
          phone?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      tenants: {
        Row: {
          avatar_url: string | null
          created_at: string
          date_of_birth: string | null
          deleted_at: string | null
          email: string | null
          emergency_contact_name: string | null
          emergency_contact_phone: string | null
          emergency_contact_relationship: string | null
          full_name: string
          gender: string | null
          id: string
          id_images: Json | null
          id_number: string | null
          id_type: Database["public"]["Enums"]["id_type"] | null
          notes: string | null
          permanent_address: string | null
          phone: string
          status: Database["public"]["Enums"]["tenant_status"] | null
          updated_at: string
          user_id: string
        }
        Insert: {
          avatar_url?: string | null
          created_at?: string
          date_of_birth?: string | null
          deleted_at?: string | null
          email?: string | null
          emergency_contact_name?: string | null
          emergency_contact_phone?: string | null
          emergency_contact_relationship?: string | null
          full_name: string
          gender?: string | null
          id?: string
          id_images?: Json | null
          id_number?: string | null
          id_type?: Database["public"]["Enums"]["id_type"] | null
          notes?: string | null
          permanent_address?: string | null
          phone: string
          status?: Database["public"]["Enums"]["tenant_status"] | null
          updated_at?: string
          user_id: string
        }
        Update: {
          avatar_url?: string | null
          created_at?: string
          date_of_birth?: string | null
          deleted_at?: string | null
          email?: string | null
          emergency_contact_name?: string | null
          emergency_contact_phone?: string | null
          emergency_contact_relationship?: string | null
          full_name?: string
          gender?: string | null
          id?: string
          id_images?: Json | null
          id_number?: string | null
          id_type?: Database["public"]["Enums"]["id_type"] | null
          notes?: string | null
          permanent_address?: string | null
          phone?: string
          status?: Database["public"]["Enums"]["tenant_status"] | null
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      vehicles: {
        Row: {
          brand: string | null
          color: string | null
          contract_id: string | null
          created_at: string
          deleted_at: string | null
          id: string
          images: Json | null
          license_plate: string | null
          model: string | null
          notes: string | null
          parking_fee: number | null
          tenant_id: string
          updated_at: string
          user_id: string
          vehicle_type: Database["public"]["Enums"]["vehicle_type"]
        }
        Insert: {
          brand?: string | null
          color?: string | null
          contract_id?: string | null
          created_at?: string
          deleted_at?: string | null
          id?: string
          images?: Json | null
          license_plate?: string | null
          model?: string | null
          notes?: string | null
          parking_fee?: number | null
          tenant_id: string
          updated_at?: string
          user_id: string
          vehicle_type: Database["public"]["Enums"]["vehicle_type"]
        }
        Update: {
          brand?: string | null
          color?: string | null
          contract_id?: string | null
          created_at?: string
          deleted_at?: string | null
          id?: string
          images?: Json | null
          license_plate?: string | null
          model?: string | null
          notes?: string | null
          parking_fee?: number | null
          tenant_id?: string
          updated_at?: string
          user_id?: string
          vehicle_type?: Database["public"]["Enums"]["vehicle_type"]
        }
        Relationships: [
          {
            foreignKeyName: "vehicles_contract_id_fkey"
            columns: ["contract_id"]
            isOneToOne: false
            referencedRelation: "contracts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "vehicles_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      floors: {
        Row: {
          id: string
          building_id: string
          floor_number: number
          name: string | null
          description: string | null
          status: string | null
          user_id: string
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          building_id: string
          floor_number: number
          name?: string | null
          description?: string | null
          status?: string | null
          user_id: string
          created_at?: string
          updated_at?: string
        }
        Update: {
          id?: string
          building_id?: string
          floor_number?: number
          name?: string | null
          description?: string | null
          status?: string | null
          user_id?: string
          created_at?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "floors_building_id_fkey"
            columns: ["building_id"]
            isOneToOne: false
            referencedRelation: "buildings"
            referencedColumns: ["id"]
          },
        ]
      }
      hotlines: {
        Row: {
          id: string
          name: string
          phone_number: string
          description: string | null
          is_active: boolean | null
          user_id: string
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          name: string
          phone_number: string
          description?: string | null
          is_active?: boolean | null
          user_id: string
          created_at?: string
          updated_at?: string
        }
        Update: {
          id?: string
          name?: string
          phone_number?: string
          description?: string | null
          is_active?: boolean | null
          user_id?: string
          created_at?: string
          updated_at?: string
        }
        Relationships: []
      }
      income_expense_types: {
        Row: {
          id: string
          name: string
          type: string
          description: string | null
          is_default: boolean | null
          user_id: string
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          name: string
          type: string
          description?: string | null
          is_default?: boolean | null
          user_id: string
          created_at?: string
          updated_at?: string
        }
        Update: {
          id?: string
          name?: string
          type?: string
          description?: string | null
          is_default?: boolean | null
          user_id?: string
          created_at?: string
          updated_at?: string
        }
        Relationships: []
      }
      service_quotas: {
        Row: {
          created_at: string
          deleted_at: string | null
          description: string | null
          id: string
          name: string
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          deleted_at?: string | null
          description?: string | null
          id?: string
          name: string
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          deleted_at?: string | null
          description?: string | null
          id?: string
          name?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      meters: {
        Row: {
          id: string
          user_id: string
          code: string
          building_id: string
          room_id: string | null
          service_id: string
          meter_type: Database["public"]["Enums"]["meter_type"]
          name: string | null
          installation_date: string | null
          initial_reading: number | null
          current_reading: number | null
          status: string
          location_note: string | null
          manufacturer: string | null
          model: string | null
          serial_number: string | null
          notes: string | null
          created_at: string
          updated_at: string
          deleted_at: string | null
        }
        Insert: {
          id?: string
          user_id: string
          code: string
          building_id: string
          room_id?: string | null
          service_id: string
          meter_type: Database["public"]["Enums"]["meter_type"]
          name?: string | null
          installation_date?: string | null
          initial_reading?: number | null
          current_reading?: number | null
          status?: string
          location_note?: string | null
          manufacturer?: string | null
          model?: string | null
          serial_number?: string | null
          notes?: string | null
          created_at?: string
          updated_at?: string
          deleted_at?: string | null
        }
        Update: {
          id?: string
          user_id?: string
          code?: string
          building_id?: string
          room_id?: string | null
          service_id?: string
          meter_type?: Database["public"]["Enums"]["meter_type"]
          name?: string | null
          installation_date?: string | null
          initial_reading?: number | null
          current_reading?: number | null
          status?: string
          location_note?: string | null
          manufacturer?: string | null
          model?: string | null
          serial_number?: string | null
          notes?: string | null
          created_at?: string
          updated_at?: string
          deleted_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "meters_building_id_fkey"
            columns: ["building_id"]
            isOneToOne: false
            referencedRelation: "buildings"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "meters_room_id_fkey"
            columns: ["room_id"]
            isOneToOne: false
            referencedRelation: "rooms"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "meters_service_id_fkey"
            columns: ["service_id"]
            isOneToOne: false
            referencedRelation: "services"
            referencedColumns: ["id"]
          },
        ]
      }
      auto_debt_config: {
        Row: {
          id: string
          building_id: string | null
          is_enabled: boolean | null
          bank_account: string | null
          matching_rules: Json | null
          user_id: string
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          building_id?: string | null
          is_enabled?: boolean | null
          bank_account?: string | null
          matching_rules?: Json | null
          user_id: string
          created_at?: string
          updated_at?: string
        }
        Update: {
          id?: string
          building_id?: string | null
          is_enabled?: boolean | null
          bank_account?: string | null
          matching_rules?: Json | null
          user_id?: string
          created_at?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "auto_debt_config_building_id_fkey"
            columns: ["building_id"]
            isOneToOne: false
            referencedRelation: "buildings"
            referencedColumns: ["id"]
          },
        ]
      }
      roles: {
        Row: {
          id: string
          name: string
          description: string | null
          permissions: Json
          user_id: string
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          name: string
          description?: string | null
          permissions?: Json
          user_id: string
          created_at?: string
          updated_at?: string
        }
        Update: {
          id?: string
          name?: string
          description?: string | null
          permissions?: Json
          user_id?: string
          created_at?: string
          updated_at?: string
        }
        Relationships: []
      }
      staff_assignments: {
        Row: {
          id: string
          staff_id: string
          role_id: string
          building_id: string | null
          user_id: string
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          staff_id: string
          role_id: string
          building_id?: string | null
          user_id: string
          created_at?: string
          updated_at?: string
        }
        Update: {
          id?: string
          staff_id?: string
          role_id?: string
          building_id?: string | null
          user_id?: string
          created_at?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "staff_assignments_role_id_fkey"
            columns: ["role_id"]
            isOneToOne: false
            referencedRelation: "roles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "staff_assignments_building_id_fkey"
            columns: ["building_id"]
            isOneToOne: false
            referencedRelation: "buildings"
            referencedColumns: ["id"]
          },
        ]
      }
      subscription_plans: {
        Row: {
          id: string
          name: string
          description: string | null
          price: number
          duration_months: number
          max_rooms: number | null
          max_buildings: number | null
          features: Json | null
          is_active: boolean | null
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          name: string
          description?: string | null
          price: number
          duration_months: number
          max_rooms?: number | null
          max_buildings?: number | null
          features?: Json | null
          is_active?: boolean | null
          created_at?: string
          updated_at?: string
        }
        Update: {
          id?: string
          name?: string
          description?: string | null
          price?: number
          duration_months?: number
          max_rooms?: number | null
          max_buildings?: number | null
          features?: Json | null
          is_active?: boolean | null
          created_at?: string
          updated_at?: string
        }
        Relationships: []
      }
      user_subscriptions: {
        Row: {
          id: string
          user_id: string
          plan_id: string
          start_date: string
          end_date: string
          status: string | null
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          user_id: string
          plan_id: string
          start_date: string
          end_date: string
          status?: string | null
          created_at?: string
          updated_at?: string
        }
        Update: {
          id?: string
          user_id?: string
          plan_id?: string
          start_date?: string
          end_date?: string
          status?: string | null
          created_at?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "user_subscriptions_plan_id_fkey"
            columns: ["plan_id"]
            isOneToOne: false
            referencedRelation: "subscription_plans"
            referencedColumns: ["id"]
          },
        ]
      }
      task_types: {
        Row: {
          id: string
          name: string
          description: string | null
          color: string | null
          user_id: string
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          name: string
          description?: string | null
          color?: string | null
          user_id: string
          created_at?: string
          updated_at?: string
        }
        Update: {
          id?: string
          name?: string
          description?: string | null
          color?: string | null
          user_id?: string
          created_at?: string
          updated_at?: string
        }
        Relationships: []
      }
      asset_warehouses: {
        Row: {
          id: string
          name: string
          location: string | null
          building_id: string | null
          user_id: string
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          name: string
          location?: string | null
          building_id?: string | null
          user_id: string
          created_at?: string
          updated_at?: string
        }
        Update: {
          id?: string
          name?: string
          location?: string | null
          building_id?: string | null
          user_id?: string
          created_at?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "asset_warehouses_building_id_fkey"
            columns: ["building_id"]
            isOneToOne: false
            referencedRelation: "buildings"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      contract_extension_history: {
        Row: {
          approved_at: string | null
          contract_id: string | null
          contract_number: string | null
          created_at: string | null
          extension_date: string | null
          extension_id: string | null
          extension_months: number | null
          extension_type: string | null
          new_end_date: string | null
          old_end_date: string | null
          rent_price: number | null
          rent_price_changed: boolean | null
          status: string | null
          tenant_id: string | null
          tenant_name: string | null
        }
        Relationships: [
          {
            foreignKeyName: "contract_extensions_contract_id_fkey"
            columns: ["contract_id"]
            isOneToOne: false
            referencedRelation: "contracts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "contracts_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Functions: {
      create_new_contract_extension: {
        Args: {
          p_contract_id: string
          p_extension_months: number
          p_new_deposit?: number
          p_new_rent_price?: number
          p_notes?: string
        }
        Returns: string
      }
      create_room_transfer: {
        Args: {
          p_contract_id: string
          p_move_date?: string
          p_new_bed_id?: string
          p_new_rent_price?: number
          p_new_room_id?: string
          p_reason?: string
        }
        Returns: string
      }
      create_simple_extension: {
        Args: {
          p_contract_id: string
          p_extension_months: number
          p_new_rent_price?: number
          p_notes?: string
        }
        Returns: string
      }
      create_tenant_transfer: {
        Args: {
          p_contract_id: string
          p_new_tenant_id: string
          p_reason?: string
          p_transfer_date?: string
          p_transfer_fee?: number
        }
        Returns: string
      }
      estimate_termination_costs: {
        Args: {
          p_cleaning_fee?: number
          p_contract_id: string
          p_damage_fee?: number
          p_early_termination_fee?: number
          p_move_out_date: string
        }
        Returns: {
          outstanding_debt: number
          prorated_rent: number
          prorated_services: number
          refund_amount: number
          total_deposit: number
          total_fees: number
        }[]
      }
      generate_code: {
        Args: { p_object_type: string; p_user_id: string }
        Returns: string
      }
      get_contract_extension_count: {
        Args: { p_contract_id: string }
        Returns: number
      }
      get_meters_without_readings: {
        Args: {
          p_user_id: string
          p_building_id?: string
          p_room_id?: string
          p_meter_type?: Database["public"]["Enums"]["meter_type"]
          p_month?: string
        }
        Returns: {
          meter_id: string
          meter_code: string
          meter_name: string
          room_name: string
          meter_type_value: Database["public"]["Enums"]["meter_type"]
          last_reading: number
          last_reading_date: string
        }[]
      }
      show_limit: { Args: never; Returns: number }
      show_trgm: { Args: { "": string }; Returns: string[] }
    }
    Enums: {
      asset_condition: "NEW" | "GOOD" | "FAIR" | "POOR" | "BROKEN"
      bed_status:
        | "AVAILABLE"
        | "OCCUPIED"
        | "RESERVED"
        | "MAINTENANCE"
        | "UNAVAILABLE"
      building_status: "ACTIVE" | "INACTIVE" | "MAINTENANCE"
      building_type:
        | "APARTMENT"
        | "DORMITORY"
        | "HOUSE"
        | "OFFICE"
        | "SLEEPBOX"
        | "HOMESTAY"
      contract_status:
        | "DRAFT"
        | "ACTIVE"
        | "EXTENDED"
        | "TRANSFERRED"
        | "TERMINATED"
        | "EXPIRED"
      deposit_status:
        | "PENDING"
        | "CONFIRMED"
        | "CONVERTED"
        | "REFUNDED"
        | "FORFEITED"
      expense_category:
        | "MAINTENANCE"
        | "REPAIR"
        | "UTILITIES"
        | "SALARY"
        | "SUPPLIES"
        | "OTHER"
      fee_type:
        | "TIEN_PHI_DICH_VU"
        | "TIEN_DIEN"
        | "TIEN_NUOC"
        | "TIEN_PHI_KHAC"
        | "TIEN_VE_SINH"
      id_type: "CCCD" | "CMND" | "PASSPORT" | "OTHER"
      invoice_item_type: "RENT" | "SERVICE" | "PENALTY" | "DISCOUNT" | "OTHER"
      invoice_status:
        | "DRAFT"
        | "PENDING_APPROVAL"
        | "APPROVED"
        | "PAID"
        | "PARTIAL_PAID"
        | "OVERDUE"
        | "CANCELLED"
      issue_priority: "LOW" | "MEDIUM" | "HIGH" | "URGENT"
      issue_status:
        | "NEW"
        | "ASSIGNED"
        | "IN_PROGRESS"
        | "RESOLVED"
        | "CLOSED"
        | "CANCELLED"
      lead_source:
        | "FACEBOOK"
        | "ZALO"
        | "PHONE"
        | "REFERRAL"
        | "WALK_IN"
        | "WEBSITE"
        | "OTHER"
      lead_status:
        | "B1_LEAD"
        | "B2_APPOINTMENT"
        | "B3_CONSULTATION"
        | "CONVERTED"
        | "FAILED"
      meter_type: "ELECTRICITY" | "WATER" | "GAS" | "OTHER"
      notification_channel: "IN_APP" | "EMAIL" | "SMS" | "ZALO" | "PUSH"
      notification_status: "PENDING" | "SENT" | "FAILED" | "CANCELLED" | "READ"
      notification_type:
        | "NEW_INVOICE"
        | "PAYMENT_REMINDER"
        | "OVERDUE_INVOICE"
        | "CONTRACT_EXPIRING"
        | "ISSUE_RESOLVED"
        | "GENERAL_ANNOUNCEMENT"
        | "CUSTOM"
      payment_cycle: "MONTHLY" | "QUARTERLY" | "SEMI_ANNUAL" | "ANNUAL"
      payment_method:
        | "CASH"
        | "BANK_TRANSFER"
        | "MOMO"
        | "VNPAY"
        | "ZALO_PAY"
        | "OTHER"
      pricing_type:
        | "DON_GIA_CO_DINH_THANG"
        | "DON_GIA_CO_DINH_DONG_HO"
        | "DON_GIA_BIEN_DONG"
        | "DON_GIA_THEO_NGUOI"
        | "DON_GIA_THEO_PHONG"
      room_status:
        | "AVAILABLE"
        | "OCCUPIED"
        | "RESERVED"
        | "MAINTENANCE"
        | "UNAVAILABLE"
      service_type: "FIXED" | "PER_PERSON" | "PER_ROOM" | "METER_READING"
      tenant_status:
        | "PROSPECT"
        | "DEPOSITED"
        | "ACTIVE"
        | "INACTIVE"
        | "BLACKLIST"
      vehicle_type: "MOTORBIKE" | "CAR" | "BICYCLE" | "OTHER"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      asset_condition: ["NEW", "GOOD", "FAIR", "POOR", "BROKEN"],
      bed_status: [
        "AVAILABLE",
        "OCCUPIED",
        "RESERVED",
        "MAINTENANCE",
        "UNAVAILABLE",
      ],
      building_status: ["ACTIVE", "INACTIVE", "MAINTENANCE"],
      building_type: [
        "APARTMENT",
        "DORMITORY",
        "HOUSE",
        "OFFICE",
        "SLEEPBOX",
        "HOMESTAY",
      ],
      contract_status: [
        "DRAFT",
        "ACTIVE",
        "EXTENDED",
        "TRANSFERRED",
        "TERMINATED",
        "EXPIRED",
      ],
      deposit_status: [
        "PENDING",
        "CONFIRMED",
        "CONVERTED",
        "REFUNDED",
        "FORFEITED",
      ],
      expense_category: [
        "MAINTENANCE",
        "REPAIR",
        "UTILITIES",
        "SALARY",
        "SUPPLIES",
        "OTHER",
      ],
      fee_type: [
        "TIEN_PHI_DICH_VU",
        "TIEN_DIEN",
        "TIEN_NUOC",
        "TIEN_PHI_KHAC",
        "TIEN_VE_SINH",
      ],
      id_type: ["CCCD", "CMND", "PASSPORT", "OTHER"],
      invoice_item_type: ["RENT", "SERVICE", "PENALTY", "DISCOUNT", "OTHER"],
      invoice_status: [
        "DRAFT",
        "PENDING_APPROVAL",
        "APPROVED",
        "PAID",
        "PARTIAL_PAID",
        "OVERDUE",
        "CANCELLED",
      ],
      issue_priority: ["LOW", "MEDIUM", "HIGH", "URGENT"],
      issue_status: [
        "NEW",
        "ASSIGNED",
        "IN_PROGRESS",
        "RESOLVED",
        "CLOSED",
        "CANCELLED",
      ],
      lead_source: [
        "FACEBOOK",
        "ZALO",
        "PHONE",
        "REFERRAL",
        "WALK_IN",
        "WEBSITE",
        "OTHER",
      ],
      lead_status: [
        "B1_LEAD",
        "B2_APPOINTMENT",
        "B3_CONSULTATION",
        "CONVERTED",
        "FAILED",
      ],
      meter_type: ["ELECTRICITY", "WATER", "GAS", "OTHER"],
      notification_channel: ["IN_APP", "EMAIL", "SMS", "ZALO", "PUSH"],
      notification_status: ["PENDING", "SENT", "FAILED", "CANCELLED", "READ"],
      notification_type: [
        "NEW_INVOICE",
        "PAYMENT_REMINDER",
        "OVERDUE_INVOICE",
        "CONTRACT_EXPIRING",
        "ISSUE_RESOLVED",
        "GENERAL_ANNOUNCEMENT",
        "CUSTOM",
      ],
      payment_cycle: ["MONTHLY", "QUARTERLY", "SEMI_ANNUAL", "ANNUAL"],
      payment_method: [
        "CASH",
        "BANK_TRANSFER",
        "MOMO",
        "VNPAY",
        "ZALO_PAY",
        "OTHER",
      ],
      pricing_type: [
        "DON_GIA_CO_DINH_THANG",
        "DON_GIA_CO_DINH_DONG_HO",
        "DON_GIA_BIEN_DONG",
        "DON_GIA_THEO_NGUOI",
        "DON_GIA_THEO_PHONG",
      ],
      room_status: [
        "AVAILABLE",
        "OCCUPIED",
        "RESERVED",
        "MAINTENANCE",
        "UNAVAILABLE",
      ],
      service_type: ["FIXED", "PER_PERSON", "PER_ROOM", "METER_READING"],
      tenant_status: [
        "PROSPECT",
        "DEPOSITED",
        "ACTIVE",
        "INACTIVE",
        "BLACKLIST",
      ],
      vehicle_type: ["MOTORBIKE", "CAR", "BICYCLE", "OTHER"],
    },
  },
} as const
