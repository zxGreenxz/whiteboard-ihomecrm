import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from './useAuth';
import { toast } from 'sonner';
import type {
  AIConversation,
  AIMessage,
  SendMessageRequest,
  CreateConversationRequest,
  ConversationStats,
} from '@/types/ai';

// =============================================
// CONVERSATIONS
// =============================================

/**
 * Get all conversations for current user
 */
export function useConversations(options?: {
  includeArchived?: boolean;
  limit?: number;
}) {
  const { data: user } = useAuth();

  return useQuery({
    queryKey: ['ai-conversations', user?.id, options],
    queryFn: async (): Promise<AIConversation[]> => {
      if (!user?.id) throw new Error('User not authenticated');

      let query = supabase
        .from('ai_conversations')
        .select('*')
        .eq('user_id', user.id)
        .is('deleted_at', null)
        .order('last_message_at', { ascending: false, nullsFirst: false })
        .order('created_at', { ascending: false });

      if (!options?.includeArchived) {
        query = query.eq('is_archived', false);
      }

      if (options?.limit) {
        query = query.limit(options.limit);
      }

      const { data, error } = await query;

      if (error) throw error;
      return data || [];
    },
    enabled: !!user?.id,
  });
}

/**
 * Get a single conversation by ID
 */
export function useConversation(conversationId?: string) {
  const { data: user } = useAuth();

  return useQuery({
    queryKey: ['ai-conversation', conversationId],
    queryFn: async (): Promise<AIConversation | null> => {
      if (!user?.id || !conversationId) return null;

      const { data, error } = await supabase
        .from('ai_conversations')
        .select('*')
        .eq('id', conversationId)
        .eq('user_id', user.id)
        .is('deleted_at', null)
        .single();

      if (error) throw error;
      return data;
    },
    enabled: !!user?.id && !!conversationId,
  });
}

/**
 * Create a new conversation
 */
export function useCreateConversation() {
  const queryClient = useQueryClient();
  const { data: user } = useAuth();

  return useMutation({
    mutationFn: async (request: CreateConversationRequest): Promise<AIConversation> => {
      if (!user?.id) throw new Error('User not authenticated');

      const { data, error } = await supabase
        .from('ai_conversations')
        .insert({
          user_id: user.id,
          title: request.title || 'Cuộc trò chuyện mới',
        })
        .select()
        .single();

      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['ai-conversations'] });
    },
  });
}

/**
 * Update conversation (title, pin, archive, etc.)
 */
export function useUpdateConversation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      id,
      updates,
    }: {
      id: string;
      updates: Partial<AIConversation>;
    }): Promise<AIConversation> => {
      const { data, error } = await supabase
        .from('ai_conversations')
        .update(updates)
        .eq('id', id)
        .select()
        .single();

      if (error) throw error;
      return data;
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['ai-conversations'] });
      queryClient.invalidateQueries({ queryKey: ['ai-conversation', data.id] });
      toast.success('Đã cập nhật cuộc trò chuyện');
    },
    onError: (error) => {
      toast.error('Lỗi khi cập nhật: ' + error.message);
    },
  });
}

/**
 * Delete conversation (soft delete)
 */
export function useDeleteConversation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (conversationId: string): Promise<void> => {
      const { error } = await supabase
        .from('ai_conversations')
        .update({ deleted_at: new Date().toISOString() })
        .eq('id', conversationId);

      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['ai-conversations'] });
      toast.success('Đã xóa cuộc trò chuyện');
    },
    onError: (error) => {
      toast.error('Lỗi khi xóa: ' + error.message);
    },
  });
}

// =============================================
// MESSAGES
// =============================================

/**
 * Get messages for a conversation
 */
export function useMessages(conversationId?: string) {
  return useQuery({
    queryKey: ['ai-messages', conversationId],
    queryFn: async (): Promise<AIMessage[]> => {
      if (!conversationId) return [];

      const { data, error } = await supabase
        .from('ai_messages')
        .select('*')
        .eq('conversation_id', conversationId)
        .order('created_at', { ascending: true });

      if (error) throw error;
      return data || [];
    },
    enabled: !!conversationId,
  });
}

/**
 * Send a message (this will be handled by Edge Function in production)
 * For now, we'll create a placeholder that stores the message
 */
export function useSendMessage() {
  const queryClient = useQueryClient();
  const { data: user } = useAuth();

  return useMutation({
    mutationFn: async (request: SendMessageRequest): Promise<{
      conversation_id: string;
      user_message: AIMessage;
    }> => {
      if (!user?.id) throw new Error('User not authenticated');

      let conversationId = request.conversation_id;

      // Create new conversation if needed
      if (!conversationId) {
        const { data: newConv, error: convError } = await supabase
          .from('ai_conversations')
          .insert({
            user_id: user.id,
            title: 'Cuộc trò chuyện mới',
          })
          .select()
          .single();

        if (convError) throw convError;
        conversationId = newConv.id;
      }

      // Insert user message
      const { data: userMessage, error: msgError } = await supabase
        .from('ai_messages')
        .insert({
          conversation_id: conversationId,
          role: 'user',
          content: request.message,
          tokens_used: Math.ceil(request.message.length / 4), // Rough estimate
        })
        .select()
        .single();

      if (msgError) throw msgError;

      // TODO: Call OpenAI API via Edge Function to get assistant response
      // For now, we'll return a placeholder response
      
      return {
        conversation_id: conversationId,
        user_message: userMessage,
      };
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['ai-conversations'] });
      queryClient.invalidateQueries({ queryKey: ['ai-conversation', data.conversation_id] });
      queryClient.invalidateQueries({ queryKey: ['ai-messages', data.conversation_id] });
    },
    onError: (error) => {
      toast.error('Lỗi khi gửi tin nhắn: ' + error.message);
    },
  });
}

// =============================================
// SEARCH & STATS
// =============================================

/**
 * Search conversations by content
 */
export function useSearchConversations(query: string) {
  const { data: user } = useAuth();

  return useQuery({
    queryKey: ['ai-conversations-search', query, user?.id],
    queryFn: async (): Promise<AIConversation[]> => {
      if (!user?.id || !query.trim()) return [];

      const { data, error } = await supabase
        .from('ai_conversations')
        .select('*')
        .eq('user_id', user.id)
        .is('deleted_at', null)
        .or(`title.ilike.%${query}%,summary.ilike.%${query}%`)
        .order('last_message_at', { ascending: false, nullsFirst: false })
        .limit(20);

      if (error) throw error;
      return data || [];
    },
    enabled: !!user?.id && query.trim().length > 0,
  });
}

/**
 * Get conversation statistics
 */
export function useConversationStats() {
  const { data: user } = useAuth();

  return useQuery({
    queryKey: ['ai-conversation-stats', user?.id],
    queryFn: async (): Promise<ConversationStats> => {
      if (!user?.id) throw new Error('User not authenticated');

      // Get all conversations
      const { data: allConvs, error: allError } = await supabase
        .from('ai_conversations')
        .select('message_count, total_tokens_used, created_at')
        .eq('user_id', user.id)
        .is('deleted_at', null);

      if (allError) throw allError;

      // Calculate stats
      const now = new Date();
      const firstDayOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

      const thisMonthConvs = allConvs?.filter(
        (c) => new Date(c.created_at) >= firstDayOfMonth
      ) || [];

      const stats: ConversationStats = {
        total_conversations: allConvs?.length || 0,
        total_messages: allConvs?.reduce((sum, c) => sum + c.message_count, 0) || 0,
        total_tokens_used: allConvs?.reduce((sum, c) => sum + c.total_tokens_used, 0) || 0,
        conversations_this_month: thisMonthConvs.length,
        messages_this_month: thisMonthConvs.reduce((sum, c) => sum + c.message_count, 0),
        tokens_this_month: thisMonthConvs.reduce((sum, c) => sum + c.total_tokens_used, 0),
      };

      return stats;
    },
    enabled: !!user?.id,
  });
}