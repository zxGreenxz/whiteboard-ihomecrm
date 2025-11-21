/**
 * Code Generation Utility
 *
 * Generates auto-incrementing codes for entities based on configurable formats.
 * Supports tokens: {prefix}, {year}, {month}, {seq:N}, {building}, {floor}
 *
 * Examples:
 * - Contract: "HD{year}{month}{seq:4}" → HD202511001
 * - Invoice: "INV{year}{month}{seq:4}" → INV202511001
 * - Building: "B{seq:3}" → B001
 * - Room: "{building}{floor}{seq:2}" → B001101
 */

import { supabase } from '@/integrations/supabase/client';

/**
 * Get next sequence number for a given entity type
 */
async function getNextSequence(
  entityType: 'building' | 'room' | 'contract' | 'invoice' | 'payment',
  userId: string,
  resetPeriod: 'NEVER' | 'YEARLY' | 'MONTHLY' = 'YEARLY'
): Promise<number> {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');

  // Determine reset key based on period
  let resetKey = entityType;
  if (resetPeriod === 'YEARLY') {
    resetKey = `${entityType}_${year}`;
  } else if (resetPeriod === 'MONTHLY') {
    resetKey = `${entityType}_${year}${month}`;
  }

  // Try to get existing sequence
  const { data: existing, error: selectError } = await supabase
    .from('code_sequences')
    .select('*')
    .eq('user_id', userId)
    .eq('entity_type', resetKey)
    .maybeSingle();

  if (selectError) throw selectError;

  if (existing) {
    // Increment existing sequence
    const newSequence = existing.current_sequence + 1;

    const { error: updateError } = await supabase
      .from('code_sequences')
      .update({ current_sequence: newSequence })
      .eq('id', existing.id);

    if (updateError) throw updateError;

    return newSequence;
  } else {
    // Create new sequence starting at 1
    const { error: insertError } = await supabase
      .from('code_sequences')
      .insert({
        user_id: userId,
        entity_type: resetKey,
        current_sequence: 1,
      });

    if (insertError) throw insertError;

    return 1;
  }
}

/**
 * Replace tokens in format string with actual values
 */
function replaceTokens(
  format: string,
  tokens: {
    prefix?: string;
    year?: string;
    month?: string;
    seq?: number;
    building?: string;
    floor?: number | string;
  }
): string {
  let result = format;

  // Replace simple tokens
  if (tokens.prefix) result = result.replace('{prefix}', tokens.prefix);
  if (tokens.year) result = result.replace('{year}', tokens.year);
  if (tokens.month) result = result.replace('{month}', tokens.month);
  if (tokens.building) result = result.replace('{building}', tokens.building);
  if (tokens.floor !== undefined) result = result.replace('{floor}', String(tokens.floor));

  // Replace sequence with padding {seq:N}
  if (tokens.seq !== undefined) {
    const seqMatch = result.match(/\{seq:(\d+)\}/);
    if (seqMatch) {
      const padding = parseInt(seqMatch[1], 10);
      const paddedSeq = String(tokens.seq).padStart(padding, '0');
      result = result.replace(seqMatch[0], paddedSeq);
    } else {
      // No padding specified, just use sequence
      result = result.replace('{seq}', String(tokens.seq));
    }
  }

  return result;
}

/**
 * Generate building code
 *
 * @param format - Format string (e.g., "B{seq:3}")
 * @param userId - User ID for sequence tracking
 * @returns Generated code (e.g., "B001")
 */
export async function generateBuildingCode(
  format: string,
  userId: string
): Promise<string> {
  const sequence = await getNextSequence('building', userId, 'NEVER');

  return replaceTokens(format, { seq: sequence });
}

/**
 * Generate room code
 *
 * @param format - Format string (e.g., "{building}{floor}{seq:2}")
 * @param userId - User ID for sequence tracking
 * @param buildingCode - Building code (e.g., "B001")
 * @param floor - Floor number (e.g., 1)
 * @returns Generated code (e.g., "B001101")
 */
export async function generateRoomCode(
  format: string,
  userId: string,
  buildingCode: string,
  floor: number
): Promise<string> {
  const sequence = await getNextSequence('room', userId, 'NEVER');

  return replaceTokens(format, {
    building: buildingCode,
    floor,
    seq: sequence,
  });
}

/**
 * Generate contract number
 *
 * @param prefix - Prefix (e.g., "HD")
 * @param format - Format string (e.g., "{prefix}{year}{month}{seq:4}")
 * @param userId - User ID for sequence tracking
 * @param resetPeriod - When to reset sequence
 * @returns Generated number (e.g., "HD202511001")
 */
export async function generateContractNumber(
  prefix: string,
  format: string,
  userId: string,
  resetPeriod: 'NEVER' | 'YEARLY' | 'MONTHLY' = 'YEARLY'
): Promise<string> {
  const now = new Date();
  const year = String(now.getFullYear());
  const month = String(now.getMonth() + 1).padStart(2, '0');

  const sequence = await getNextSequence('contract', userId, resetPeriod);

  return replaceTokens(format, {
    prefix,
    year,
    month,
    seq: sequence,
  });
}

/**
 * Generate invoice number
 *
 * @param prefix - Prefix (e.g., "INV")
 * @param format - Format string (e.g., "{prefix}{year}{month}{seq:4}")
 * @param userId - User ID for sequence tracking
 * @param resetPeriod - When to reset sequence
 * @returns Generated number (e.g., "INV202511001")
 */
export async function generateInvoiceNumber(
  prefix: string,
  format: string,
  userId: string,
  resetPeriod: 'NEVER' | 'YEARLY' | 'MONTHLY' = 'YEARLY'
): Promise<string> {
  const now = new Date();
  const year = String(now.getFullYear());
  const month = String(now.getMonth() + 1).padStart(2, '0');

  const sequence = await getNextSequence('invoice', userId, resetPeriod);

  return replaceTokens(format, {
    prefix,
    year,
    month,
    seq: sequence,
  });
}

/**
 * Generate payment receipt number
 *
 * @param prefix - Prefix (e.g., "PT")
 * @param format - Format string (e.g., "{prefix}{year}{month}{seq:4}")
 * @param userId - User ID for sequence tracking
 * @param resetPeriod - When to reset sequence
 * @returns Generated number (e.g., "PT202511001")
 */
export async function generatePaymentNumber(
  prefix: string,
  format: string,
  userId: string,
  resetPeriod: 'NEVER' | 'YEARLY' | 'MONTHLY' = 'YEARLY'
): Promise<string> {
  const now = new Date();
  const year = String(now.getFullYear());
  const month = String(now.getMonth() + 1).padStart(2, '0');

  const sequence = await getNextSequence('payment', userId, resetPeriod);

  return replaceTokens(format, {
    prefix,
    year,
    month,
    seq: sequence,
  });
}

/**
 * Helper: Check if code generation is enabled for an entity
 */
export function isAutoGenerateEnabled(
  entityType: 'contract' | 'invoice',
  config: any
): boolean {
  if (entityType === 'contract') {
    return config?.auto_generate_contract_number === true;
  }
  if (entityType === 'invoice') {
    return config?.auto_generate_invoice_number === true;
  }
  return false;
}
