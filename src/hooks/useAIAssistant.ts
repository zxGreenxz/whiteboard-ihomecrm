import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from './useAuth';
import { toast } from 'sonner';
import type {
  AIConversation,
  AIMessage,
  AIMemoryEmbedding,
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

      try {
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

        if (error) {
          console.error('Error fetching conversations:', error);
          throw error;
        }

        return (data || []) as AIConversation[];
      } catch (error) {
        console.error('Failed to fetch conversations:', error);
        throw error;
      }
    },
    enabled: !!user?.id,
    retry: 1,
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

      try {
        const { data, error } = await supabase
          .from('ai_conversations')
          .select('*')
          .eq('id', conversationId)
          .eq('user_id', user.id)
          .is('deleted_at', null)
          .single();

        if (error) {
          console.error('Error fetching conversation:', error);
          throw error;
        }

        return data as AIConversation;
      } catch (error) {
        console.error('Failed to fetch conversation:', error);
        throw error;
      }
    },
    enabled: !!user?.id && !!conversationId,
    retry: 1,
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

      try {
        const { data, error } = await supabase
          .from('ai_conversations')
          .insert({
            user_id: user.id,
            title: request.title || 'Cuộc trò chuyện mới',
            message_count: 0,
            total_tokens_used: 0,
            referenced_entities: [],
            tags: [],
            is_pinned: false,
            is_archived: false,
          })
          .select()
          .single();

        if (error) {
          console.error('Error creating conversation:', error);
          throw error;
        }

        return data as AIConversation;
      } catch (error) {
        console.error('Failed to create conversation:', error);
        throw error;
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['ai-conversations'] });
      toast.success('Đã tạo cuộc trò chuyện mới');
    },
    onError: (error: Error) => {
      console.error('Create conversation error:', error);
      toast.error('Lỗi khi tạo cuộc trò chuyện: ' + error.message);
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
      try {
        const { data, error } = await supabase
          .from('ai_conversations')
          .update(updates)
          .eq('id', id)
          .select()
          .single();

        if (error) {
          console.error('Error updating conversation:', error);
          throw error;
        }

        return data as AIConversation;
      } catch (error) {
        console.error('Failed to update conversation:', error);
        throw error;
      }
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['ai-conversations'] });
      queryClient.invalidateQueries({ queryKey: ['ai-conversation', data.id] });
      toast.success('Đã cập nhật cuộc trò chuyện');
    },
    onError: (error: Error) => {
      console.error('Update conversation error:', error);
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
      try {
        const { error } = await supabase
          .from('ai_conversations')
          .update({ deleted_at: new Date().toISOString() })
          .eq('id', conversationId);

        if (error) {
          console.error('Error deleting conversation:', error);
          throw error;
        }
      } catch (error) {
        console.error('Failed to delete conversation:', error);
        throw error;
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['ai-conversations'] });
      toast.success('Đã xóa cuộc trò chuyện');
    },
    onError: (error: Error) => {
      console.error('Delete conversation error:', error);
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

      try {
        const { data, error } = await supabase
          .from('ai_messages')
          .select('*')
          .eq('conversation_id', conversationId)
          .order('created_at', { ascending: true });

        if (error) {
          console.error('Error fetching messages:', error);
          throw error;
        }

        return (data || []) as AIMessage[];
      } catch (error) {
        console.error('Failed to fetch messages:', error);
        throw error;
      }
    },
    enabled: !!conversationId,
    retry: 1,
  });
}

/**
 * Send a message via Edge Function with AI integration
 */
export function useSendMessage() {
  const queryClient = useQueryClient();
  const { data: user } = useAuth();

  return useMutation({
    mutationFn: async (request: SendMessageRequest): Promise<{
      conversation_id: string;
      user_message: AIMessage;
      assistant_message: AIMessage;
    }> => {
      if (!user?.id) throw new Error('User not authenticated');

      try {
        // Get auth token
        const { data: { session } } = await supabase.auth.getSession();
        if (!session?.access_token) {
          throw new Error('No active session');
        }

        // Call Edge Function
        const { data, error } = await supabase.functions.invoke('ai-chat', {
          body: {
            conversation_id: request.conversation_id,
            message: request.message,
            include_context: request.include_context ?? true,
          },
          headers: {
            Authorization: `Bearer ${session.access_token}`,
          },
        });

        if (error) {
          console.error('Edge Function error:', error);
          throw error;
        }

        if (!data.success) {
          throw new Error(data.error || 'Failed to send message');
        }

        return {
          conversation_id: data.conversation_id,
          user_message: data.user_message,
          assistant_message: data.assistant_message,
        };
      } catch (error) {
        console.error('Failed to send message:', error);
        throw error;
      }
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['ai-conversations'] });
      queryClient.invalidateQueries({ queryKey: ['ai-conversation', data.conversation_id] });
      queryClient.invalidateQueries({ queryKey: ['ai-messages', data.conversation_id] });
      queryClient.invalidateQueries({ queryKey: ['ai-conversation-stats'] });
    },
    onError: (error: Error) => {
      console.error('Send message error:', error);
      toast.error('Lỗi khi gửi tin nhắn: ' + error.message);
    },
  });
}

// =============================================
// KNOWLEDGE BASE (EMBEDDINGS)
// =============================================

/**
 * Get all knowledge base entries for current user
 */
export function useKnowledgeBase(options?: {
  entity_type?: string;
  limit?: number;
}) {
  const { data: user } = useAuth();

  return useQuery({
    queryKey: ['ai-knowledge-base', user?.id, options],
    queryFn: async (): Promise<AIMemoryEmbedding[]> => {
      if (!user?.id) throw new Error('User not authenticated');

      try {
        let query = supabase
          .from('ai_memory_embeddings')
          .select('*')
          .eq('user_id', user.id)
          .order('created_at', { ascending: false });

        if (options?.entity_type) {
          query = query.eq('entity_type', options.entity_type);
        }

        if (options?.limit) {
          query = query.limit(options.limit);
        }

        const { data, error } = await query;

        if (error) {
          console.error('Error fetching knowledge base:', error);
          throw error;
        }

        return (data || []) as AIMemoryEmbedding[];
      } catch (error) {
        console.error('Failed to fetch knowledge base:', error);
        throw error;
      }
    },
    enabled: !!user?.id,
    retry: 1,
  });
}

/**
 * Create a new knowledge base entry (with embedding)
 */
export function useCreateKnowledgeEntry() {
  const queryClient = useQueryClient();
  const { data: user } = useAuth();

  return useMutation({
    mutationFn: async (request: {
      content: string;
      entity_type?: string;
      entity_id?: string;
      entity_name?: string;
      importance_score?: number;
    }): Promise<{ id: string }> => {
      if (!user?.id) throw new Error('User not authenticated');

      try {
        // Get auth token
        const { data: { session } } = await supabase.auth.getSession();
        if (!session?.access_token) {
          throw new Error('No active session');
        }

        // Call Edge Function to create embedding
        const { data, error } = await supabase.functions.invoke('ai-embeddings', {
          body: request,
          headers: {
            Authorization: `Bearer ${session.access_token}`,
          },
        });

        if (error) {
          console.error('Edge Function error:', error);
          throw error;
        }

        if (!data.success) {
          throw new Error(data.error || 'Failed to create embedding');
        }

        return { id: data.embedding_id };
      } catch (error) {
        console.error('Failed to create knowledge entry:', error);
        throw error;
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['ai-knowledge-base'] });
      toast.success('Đã thêm kiến thức mới');
    },
    onError: (error: Error) => {
      console.error('Create knowledge entry error:', error);
      toast.error('Lỗi khi thêm kiến thức: ' + error.message);
    },
  });
}

/**
 * Delete a knowledge base entry
 */
export function useDeleteKnowledgeEntry() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (entryId: string): Promise<void> => {
      try {
        const { error } = await supabase
          .from('ai_memory_embeddings')
          .delete()
          .eq('id', entryId);

        if (error) {
          console.error('Error deleting knowledge entry:', error);
          throw error;
        }
      } catch (error) {
        console.error('Failed to delete knowledge entry:', error);
        throw error;
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['ai-knowledge-base'] });
      toast.success('Đã xóa kiến thức');
    },
    onError: (error: Error) => {
      console.error('Delete knowledge entry error:', error);
      toast.error('Lỗi khi xóa: ' + error.message);
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

      try {
        const { data, error } = await supabase
          .from('ai_conversations')
          .select('*')
          .eq('user_id', user.id)
          .is('deleted_at', null)
          .or(`title.ilike.%${query}%,summary.ilike.%${query}%`)
          .order('last_message_at', { ascending: false, nullsFirst: false })
          .limit(20);

        if (error) {
          console.error('Error searching conversations:', error);
          throw error;
        }

        return (data || []) as AIConversation[];
      } catch (error) {
        console.error('Failed to search conversations:', error);
        throw error;
      }
    },
    enabled: !!user?.id && query.trim().length > 0,
    retry: 1,
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

      try {
        // Get all conversations
        const { data: allConvs, error: allError } = await supabase
          .from('ai_conversations')
          .select('message_count, total_tokens_used, created_at')
          .eq('user_id', user.id)
          .is('deleted_at', null);

        if (allError) {
          console.error('Error fetching stats:', allError);
          throw allError;
        }

        // Calculate stats
        const now = new Date();
        const firstDayOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

        const thisMonthConvs = allConvs?.filter(
          (c) => new Date(c.created_at) >= firstDayOfMonth
        ) || [];

        const stats: ConversationStats = {
          total_conversations: allConvs?.length || 0,
          total_messages: allConvs?.reduce((sum, c) => sum + (c.message_count || 0), 0) || 0,
          total_tokens_used: allConvs?.reduce((sum, c) => sum + (c.total_tokens_used || 0), 0) || 0,
          conversations_this_month: thisMonthConvs.length,
          messages_this_month: thisMonthConvs.reduce((sum, c) => sum + (c.message_count || 0), 0),
          tokens_this_month: thisMonthConvs.reduce((sum, c) => sum + (c.total_tokens_used || 0), 0),
        };

        return stats;
      } catch (error) {
        console.error('Failed to fetch stats:', error);
        throw error;
      }
    },
    enabled: !!user?.id,
    retry: 1,
  });
}