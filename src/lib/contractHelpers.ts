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

  // Fetch contract details
  const { data: contract } = await supabase
    .from('contracts')
    .select(`
      *,
      tenant:tenants(*),
      room:rooms(*),
      contract_services(
        service_id,
        unit_price,
        initial_reading,
        service:services(*)
      )
    `)
    .eq('id', contractId)
    .single();

  if (!contract) return null;

  // Fetch invoice config for numbering
  const { data: invoiceSettings } = await supabase
    .from('settings')
    .select('value')
    .eq('user_id', userId)
    .eq('key', 'invoice_config')
    .maybeSingle();

  const invoiceConfig = invoiceSettings?.value as any;

  // Auto-generate invoice number (will be implemented in invoiceHelpers)
  let invoiceNumber = null;
  if (invoiceConfig?.auto_generate_invoice_number) {
    // This will be handled by invoiceHelpers.ts
    invoiceNumber = 'AUTO'; // Placeholder
  }

  // Calculate invoice amounts
  const rentAmount = contract.rent_price || 0;
  let totalAmount = rentAmount;

  // Add service fees
  if (contract.contract_services && contract.contract_services.length > 0) {
    for (const cs of contract.contract_services) {
      const service = cs.service;
      if (service.billing_type === 'FIXED' || service.billing_type === 'PER_ROOM') {
        totalAmount += cs.unit_price;
      }
    }
  }

  // Create invoice
  const { data: invoice, error } = await supabase
    .from('invoices')
    .insert({
      user_id: userId,
      contract_id: contractId,
      tenant_id: contract.tenant_id,
      room_id: contract.room_id,
      invoice_number: invoiceNumber,
      issue_date: new Date().toISOString(),
      due_date: new Date(Date.now() + (invoiceConfig?.payment_due_days || 7) * 24 * 60 * 60 * 1000).toISOString(),
      amount: totalAmount,
      amount_paid: 0,
      status: 'DRAFT',
    })
    .select('id')
    .single();

  if (error) {
    console.error('Error auto-creating invoice:', error);
    return null;
  }

  return invoice.id;
}
