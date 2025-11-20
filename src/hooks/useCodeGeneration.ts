import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/lib/supabase';
import { useAuth } from './useAuth';
import { toast } from 'sonner';

// =============================================
// TYPES
// =============================================

export type ObjectType =
  | 'building'
  | 'room'
  | 'bed'
  | 'contract'
  | 'invoice'
  | 'payment'
  | 'service'
  | 'tenant'
  | 'lead'
  | 'deposit'
  | 'issue'
  | 'asset';

export type ResetPeriod = 'DAILY' | 'MONTHLY' | 'YEARLY' | 'NEVER';

export interface CodeSequence {
  id: string;
  user_id: string;
  object_type: ObjectType;
  prefix: string;
  separator: string;
  date_format: string | null; // YYYY, YYMM, YYMMDD, null
  sequence_length: number;
  current_sequence: number;
  reset_period: ResetPeriod;
  last_reset_at: string | null;
  created_at: string;
  updated_at: string;
}

// =============================================
// HOOKS
// =============================================

/**
 * useCodeSequence - Get code sequence configuration for an object type
 */
export const useCodeSequence = (objectType: ObjectType) => {
  const { data: user } = useAuth();

  return useQuery({
    queryKey: ['code-sequence', user?.id, objectType],
    queryFn: async () => {
      if (!user?.id) return null;

      const { data, error } = await supabase
        .from('code_sequences')
        .select('*')
        .eq('user_id', user.id)
        .eq('object_type', objectType)
        .single();

      if (error) {
        // Code sequence doesn't exist yet, return default
        if (error.code === 'PGRST116') return null;
        throw error;
      }

      return data as CodeSequence;
    },
    enabled: !!user?.id,
  });
};

/**
 * useCodeSequences - Get all code sequences for current user
 */
export const useCodeSequences = () => {
  const { data: user } = useAuth();

  return useQuery({
    queryKey: ['code-sequences', user?.id],
    queryFn: async () => {
      if (!user?.id) return [];

      const { data, error } = await supabase
        .from('code_sequences')
        .select('*')
        .eq('user_id', user.id);

      if (error) throw error;

      return (data || []) as CodeSequence[];
    },
    enabled: !!user?.id,
  });
};

/**
 * useUpdateCodeSequence - Update or create a code sequence
 */
export const useUpdateCodeSequence = () => {
  const queryClient = useQueryClient();
  const { data: user } = useAuth();

  return useMutation({
    mutationFn: async (codeSequence: Partial<CodeSequence>) => {
      if (!user?.id) throw new Error('User not authenticated');

      // Upsert code sequence
      const { data, error } = await supabase
        .from('code_sequences')
        .upsert(
          {
            user_id: user.id,
            object_type: codeSequence.object_type,
            prefix: codeSequence.prefix || '',
            separator: codeSequence.separator || '-',
            date_format: codeSequence.date_format,
            sequence_length: codeSequence.sequence_length || 4,
            current_sequence: codeSequence.current_sequence || 0,
            reset_period: codeSequence.reset_period || 'YEARLY',
            last_reset_at: codeSequence.last_reset_at,
            updated_at: new Date().toISOString(),
          },
          {
            onConflict: 'user_id,object_type',
          }
        )
        .select()
        .single();

      if (error) throw error;
      return data;
    },
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: ['code-sequences', user?.id] });
      queryClient.invalidateQueries({
        queryKey: ['code-sequence', user?.id, variables.object_type],
      });
      toast.success('Cấu hình sinh mã đã được lưu');
    },
    onError: (error) => {
      console.error('Error updating code sequence:', error);
      toast.error('Không thể lưu cấu hình sinh mã');
    },
  });
};

/**
 * useGenerateCode - Generate next code for an object type
 */
export const useGenerateCode = () => {
  const queryClient = useQueryClient();
  const { data: user } = useAuth();

  return useMutation({
    mutationFn: async (objectType: ObjectType) => {
      if (!user?.id) throw new Error('User not authenticated');

      // Get or create code sequence
      let { data: sequence, error } = await supabase
        .from('code_sequences')
        .select('*')
        .eq('user_id', user.id)
        .eq('object_type', objectType)
        .single();

      // Create default sequence if not exists
      if (error && error.code === 'PGRST116') {
        const defaultSequence = getDefaultCodeSequence(objectType);
        const { data: newSequence, error: insertError } = await supabase
          .from('code_sequences')
          .insert({
            user_id: user.id,
            ...defaultSequence,
          })
          .select()
          .single();

        if (insertError) throw insertError;
        sequence = newSequence;
      } else if (error) {
        throw error;
      }

      if (!sequence) throw new Error('Failed to get code sequence');

      // Check if need to reset sequence
      const needsReset = shouldResetSequence(sequence);
      let currentSequence = needsReset ? 1 : sequence.current_sequence + 1;
      const lastResetAt = needsReset ? new Date().toISOString() : sequence.last_reset_at;

      // Update sequence
      const { error: updateError } = await supabase
        .from('code_sequences')
        .update({
          current_sequence: currentSequence,
          last_reset_at: lastResetAt,
          updated_at: new Date().toISOString(),
        })
        .eq('id', sequence.id);

      if (updateError) throw updateError;

      // Generate code
      const generatedCode = formatCode({
        prefix: sequence.prefix,
        separator: sequence.separator,
        dateFormat: sequence.date_format,
        sequence: currentSequence,
        sequenceLength: sequence.sequence_length,
      });

      return {
        code: generatedCode,
        sequence: currentSequence,
      };
    },
    onSuccess: (_, objectType) => {
      queryClient.invalidateQueries({ queryKey: ['code-sequences', user?.id] });
      queryClient.invalidateQueries({
        queryKey: ['code-sequence', user?.id, objectType],
      });
    },
    onError: (error) => {
      console.error('Error generating code:', error);
      toast.error('Không thể sinh mã tự động');
    },
  });
};

// =============================================
// HELPER FUNCTIONS
// =============================================

/**
 * Get default code sequence for an object type
 */
export const getDefaultCodeSequence = (
  objectType: ObjectType
): Omit<CodeSequence, 'id' | 'user_id' | 'created_at' | 'updated_at'> => {
  const defaults: Record<
    ObjectType,
    Omit<CodeSequence, 'id' | 'user_id' | 'created_at' | 'updated_at'>
  > = {
    building: {
      object_type: 'building',
      prefix: 'TN',
      separator: '-',
      date_format: null,
      sequence_length: 3,
      current_sequence: 0,
      reset_period: 'NEVER',
      last_reset_at: null,
    },
    room: {
      object_type: 'room',
      prefix: 'P',
      separator: '',
      date_format: null,
      sequence_length: 3,
      current_sequence: 0,
      reset_period: 'NEVER',
      last_reset_at: null,
    },
    bed: {
      object_type: 'bed',
      prefix: 'G',
      separator: '',
      date_format: null,
      sequence_length: 2,
      current_sequence: 0,
      reset_period: 'NEVER',
      last_reset_at: null,
    },
    contract: {
      object_type: 'contract',
      prefix: 'HD',
      separator: '-',
      date_format: 'YYYY',
      sequence_length: 4,
      current_sequence: 0,
      reset_period: 'YEARLY',
      last_reset_at: null,
    },
    invoice: {
      object_type: 'invoice',
      prefix: 'INV',
      separator: '-',
      date_format: 'YYMM',
      sequence_length: 4,
      current_sequence: 0,
      reset_period: 'MONTHLY',
      last_reset_at: null,
    },
    payment: {
      object_type: 'payment',
      prefix: 'PT',
      separator: '-',
      date_format: 'YYMMDD',
      sequence_length: 4,
      current_sequence: 0,
      reset_period: 'DAILY',
      last_reset_at: null,
    },
    service: {
      object_type: 'service',
      prefix: 'DV',
      separator: '-',
      date_format: null,
      sequence_length: 3,
      current_sequence: 0,
      reset_period: 'NEVER',
      last_reset_at: null,
    },
    tenant: {
      object_type: 'tenant',
      prefix: 'KH',
      separator: '-',
      date_format: null,
      sequence_length: 4,
      current_sequence: 0,
      reset_period: 'NEVER',
      last_reset_at: null,
    },
    lead: {
      object_type: 'lead',
      prefix: 'LD',
      separator: '-',
      date_format: 'YYMM',
      sequence_length: 4,
      current_sequence: 0,
      reset_period: 'MONTHLY',
      last_reset_at: null,
    },
    deposit: {
      object_type: 'deposit',
      prefix: 'DC',
      separator: '-',
      date_format: 'YYMMDD',
      sequence_length: 3,
      current_sequence: 0,
      reset_period: 'DAILY',
      last_reset_at: null,
    },
    issue: {
      object_type: 'issue',
      prefix: 'SC',
      separator: '-',
      date_format: 'YYMM',
      sequence_length: 4,
      current_sequence: 0,
      reset_period: 'MONTHLY',
      last_reset_at: null,
    },
    asset: {
      object_type: 'asset',
      prefix: 'TS',
      separator: '-',
      date_format: null,
      sequence_length: 4,
      current_sequence: 0,
      reset_period: 'NEVER',
      last_reset_at: null,
    },
  };

  return defaults[objectType];
};

/**
 * Check if sequence should be reset based on reset period
 */
const shouldResetSequence = (sequence: CodeSequence): boolean => {
  if (sequence.reset_period === 'NEVER') return false;
  if (!sequence.last_reset_at) return true;

  const lastReset = new Date(sequence.last_reset_at);
  const now = new Date();

  switch (sequence.reset_period) {
    case 'DAILY':
      return (
        now.getDate() !== lastReset.getDate() ||
        now.getMonth() !== lastReset.getMonth() ||
        now.getFullYear() !== lastReset.getFullYear()
      );

    case 'MONTHLY':
      return (
        now.getMonth() !== lastReset.getMonth() ||
        now.getFullYear() !== lastReset.getFullYear()
      );

    case 'YEARLY':
      return now.getFullYear() !== lastReset.getFullYear();

    default:
      return false;
  }
};

/**
 * Format code from components
 */
const formatCode = ({
  prefix,
  separator,
  dateFormat,
  sequence,
  sequenceLength,
}: {
  prefix: string;
  separator: string;
  dateFormat: string | null;
  sequence: number;
  sequenceLength: number;
}): string => {
  let parts: string[] = [];

  // Add prefix
  if (prefix) {
    parts.push(prefix);
  }

  // Add date part
  if (dateFormat) {
    const now = new Date();
    const year = now.getFullYear().toString();
    const month = (now.getMonth() + 1).toString().padStart(2, '0');
    const day = now.getDate().toString().padStart(2, '0');

    let datePart = '';
    switch (dateFormat) {
      case 'YYYY':
        datePart = year;
        break;
      case 'YY':
        datePart = year.slice(-2);
        break;
      case 'YYMM':
        datePart = year.slice(-2) + month;
        break;
      case 'YYYYMM':
        datePart = year + month;
        break;
      case 'YYMMDD':
        datePart = year.slice(-2) + month + day;
        break;
      case 'YYYYMMDD':
        datePart = year + month + day;
        break;
      default:
        datePart = '';
    }

    if (datePart) {
      parts.push(datePart);
    }
  }

  // Add sequence number
  const sequenceStr = sequence.toString().padStart(sequenceLength, '0');
  parts.push(sequenceStr);

  // Join parts with separator
  return parts.join(separator);
};

/**
 * Preview what a generated code would look like
 */
export const previewCode = (codeSequence: Partial<CodeSequence>): string => {
  return formatCode({
    prefix: codeSequence.prefix || '',
    separator: codeSequence.separator || '-',
    dateFormat: codeSequence.date_format || null,
    sequence: codeSequence.current_sequence || 1,
    sequenceLength: codeSequence.sequence_length || 4,
  });
};

/**
 * Get object type label in Vietnamese
 */
export const getObjectTypeLabel = (objectType: ObjectType): string => {
  const labels: Record<ObjectType, string> = {
    building: 'Tòa nhà',
    room: 'Phòng',
    bed: 'Giường',
    contract: 'Hợp đồng',
    invoice: 'Hóa đơn',
    payment: 'Phiếu thu',
    service: 'Dịch vụ',
    tenant: 'Khách thuê',
    lead: 'Khách hẹn',
    deposit: 'Đặt cọc',
    issue: 'Sự cố',
    asset: 'Tài sản',
  };
  return labels[objectType] || objectType;
};

/**
 * Get reset period label in Vietnamese
 */
export const getResetPeriodLabel = (period: ResetPeriod): string => {
  const labels: Record<ResetPeriod, string> = {
    DAILY: 'Hàng ngày',
    MONTHLY: 'Hàng tháng',
    YEARLY: 'Hàng năm',
    NEVER: 'Không reset',
  };
  return labels[period] || period;
};

/**
 * Initialize default code sequences for a user
 */
export const initializeDefaultCodeSequences = async (userId: string) => {
  const objectTypes: ObjectType[] = [
    'building',
    'room',
    'bed',
    'contract',
    'invoice',
    'payment',
    'service',
    'tenant',
    'lead',
    'deposit',
    'issue',
    'asset',
  ];

  const sequences = objectTypes.map(type => ({
    user_id: userId,
    ...getDefaultCodeSequence(type),
  }));

  const { error } = await supabase.from('code_sequences').insert(sequences);

  if (error) {
    console.error('Error initializing code sequences:', error);
    throw error;
  }

  return sequences;
};
