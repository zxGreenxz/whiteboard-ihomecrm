/**
 * Contract Helper Functions
 *
 * Provides utilities for contract creation including:
 * - Auto-generate contract numbers based on settings
 * - Create auto-notifications for contract events
 * - Auto-create invoices based on settings
 */

import { supabase } from '@/integrations/supabase/client';
import { generateContractNumber } from './codeGenerator';
import { getNotificationContent } from '@/hooks/useNotifications';

/**
 * Generate contract number if auto-generation is enabled
 *
 * @param userId - User ID
 * @returns Generated contract number or null if disabled
 */
export async function autoGenerateContractNumber(
  userId: string
): Promise<string | null> {
  // Fetch contract config settings
  const { data: settings } = await supabase
    .from('settings')
    .select('value')
    .eq('user_id', userId)
    .eq('key', 'contract_config')
    .maybeSingle();

  if (!settings?.value) return null;

  const config = settings.value as any;

  // Check if auto-generation is enabled
  if (!config.auto_generate_contract_number) return null;

  // Generate number using configured format
  const prefix = config.contract_number_prefix || 'HD';
  const format = config.contract_number_format || '{prefix}{year}{month}{seq:4}';

  try {
    const contractNumber = await generateContractNumber(prefix, format, userId, 'YEARLY');
    return contractNumber;
  } catch (error) {
    console.error('Error generating contract number:', error);
    return null;
  }
}

/**
 * Create notification for new contract
 *
 * @param contractId - Contract ID
 * @param userId - User ID
 * @param tenantName - Tenant name
 * @param roomName - Room name
 * @param contractNumber - Contract number
 */
export async function createContractNotification(
  contractId: string,
  userId: string,
  tenantName: string,
  roomName: string,
  contractNumber: string
): Promise<void> {
  // Check notification settings
  const { data: settings } = await supabase
    .from('settings')
    .select('value')
    .eq('user_id', userId)
    .eq('key', 'notification_config')
    .maybeSingle();

  // Default: send notifications
  if (settings?.value && (settings.value as any).send_payment_confirmation === false) {
    return; // Don't send if disabled
  }

  // Create notification
  await supabase.from('notifications').insert({
    user_id: userId,
    type: 'CUSTOM',
    channel: 'IN_APP',
    subject: 'Hợp đồng mới được tạo',
    content: `Hợp đồng ${contractNumber} đã được tạo cho khách ${tenantName} (phòng ${roomName}).`,
    contract_id: contractId,
    status: 'PENDING',
  });
}

/**
 * Auto-create invoice for contract if enabled in settings
 *
 * @param contractId - Contract ID
 * @param userId - User ID
 * @returns Invoice ID if created, null otherwise
 */
export async function autoCreateInvoiceForContract(
  contractId: string,
  userId: string
): Promise<string | null> {
  // Fetch contract config
  const { data: settings } = await supabase
    .from('settings')
    .select('value')
    .eq('user_id', userId)
    .eq('key', 'contract_config')
    .maybeSingle();

  if (!settings?.value) return null;

  const config = settings.value as any;

  // Check if auto-create is enabled
  if (!config.auto_create_invoice) return null;

  // Fetch contract details with services
  const { data: contract } = await supabase
    .from('contracts')
    .select(`
      *,
      tenant:tenants!contracts_tenant_id_fkey(*),
      room:rooms!contracts_room_id_fkey(*),
      contract_services(
        id,
        service_id,
        unit_price,
        initial_reading,
        service:services!contract_services_service_id_fkey(
          id,
          name,
          billing_type,
          unit
        )
      )
    `)
    .eq('id', contractId)
    .single();

  if (!contract) return null;

  // Fetch invoice config for numbering and settings
  const { data: invoiceSettings } = await supabase
    .from('settings')
    .select('value')
    .eq('user_id', userId)
    .eq('key', 'invoice_config')
    .maybeSingle();

  const invoiceConfig = invoiceSettings?.value as any;
  const paymentDueDays = invoiceConfig?.payment_due_days || 7;

  // Generate invoice number
  let invoiceNumber = null;
  if (invoiceConfig?.auto_generate_invoice_number !== false) {
    const { generateInvoiceNumber } = await import('./codeGenerator');
    const prefix = invoiceConfig?.invoice_number_prefix || 'INV';
    const format = invoiceConfig?.invoice_number_format || '{prefix}{year}{month}{seq:4}';
    try {
      invoiceNumber = await generateInvoiceNumber(prefix, format, userId, 'YEARLY');
    } catch (e) {
      console.error('Error generating invoice number:', e);
    }
  }

  // Calculate billing period (first month from start_billing_date or start_date)
  const startDate = new Date(contract.start_billing_date || contract.start_date);
  const billingPeriodStart = new Date(startDate.getFullYear(), startDate.getMonth(), 1);
  const billingPeriodEnd = new Date(startDate.getFullYear(), startDate.getMonth() + 1, 0);

  // Prepare invoice items
  const invoiceItems: Array<{
    type: string;
    description: string;
    quantity: number;
    unit_price: number;
    amount: number;
    service_id?: string;
  }> = [];

  // Add rent item
  const rentAmount = contract.rent_price || 0;
  invoiceItems.push({
    type: 'RENT',
    description: 'Tiền thuê phòng',
    quantity: 1,
    unit_price: rentAmount,
    amount: rentAmount,
  });

  // Add service fees
  if (contract.contract_services && contract.contract_services.length > 0) {
    for (const cs of contract.contract_services) {
      const service = cs.service;
      if (!service) continue;

      // Fixed services and per-room services
      if (service.billing_type === 'FIXED' || service.billing_type === 'PER_ROOM') {
        invoiceItems.push({
          type: 'SERVICE',
          description: service.name,
          quantity: 1,
          unit_price: cs.unit_price,
          amount: cs.unit_price,
          service_id: cs.service_id,
        });
      }

      // Per-person services (assumes 1 person if no quantity specified)
      if (service.billing_type === 'PER_PERSON') {
        const quantity = 1; // Default to 1 person per contract
        invoiceItems.push({
          type: 'SERVICE',
          description: service.name,
          quantity: quantity,
          unit_price: cs.unit_price,
          amount: quantity * cs.unit_price,
          service_id: cs.service_id,
        });
      }
    }
  }

  // Calculate totals
  const subtotal = invoiceItems.reduce((sum, item) => sum + item.amount, 0);
  const totalAmount = subtotal;

  // Create invoice
  const issueDate = new Date();
  const dueDate = new Date(issueDate.getTime() + paymentDueDays * 24 * 60 * 60 * 1000);
  const billingMonth = billingPeriodStart.toLocaleDateString('vi-VN', {
    month: '2-digit',
    year: 'numeric'
  });

  const { data: invoice, error: invoiceError } = await supabase
    .from('invoices')
    .insert({
      user_id: userId,
      contract_id: contractId,
      invoice_number: invoiceNumber,
      title: `Tiền nhà & Dịch vụ - ${billingMonth}`,
      billing_period_start: billingPeriodStart.toISOString().split('T')[0],
      billing_period_end: billingPeriodEnd.toISOString().split('T')[0],
      issue_date: issueDate.toISOString().split('T')[0],
      due_date: dueDate.toISOString().split('T')[0],
      status: 'DRAFT',
      subtotal,
      total_amount: totalAmount,
      paid_amount: 0,
      remaining_amount: totalAmount,
    })
    .select('id')
    .single();

  if (invoiceError) {
    console.error('Error auto-creating invoice:', invoiceError);
    return null;
  }

  // Create invoice items
  if (invoiceItems.length > 0) {
    const itemsToInsert = invoiceItems.map(item => ({
      invoice_id: invoice.id,
      type: item.type as any,
      description: item.description,
      quantity: item.quantity,
      unit_price: item.unit_price,
      amount: item.amount,
      service_id: item.service_id,
    }));

    const { error: itemsError } = await supabase
      .from('invoice_items')
      .insert(itemsToInsert);

    if (itemsError) {
      console.error('Error creating invoice items:', itemsError);
    }
  }

  return invoice.id;
}
