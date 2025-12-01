import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.81.1';
import OpenAI from 'https://esm.sh/openai@4.70.4';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

interface ChatRequest {
  conversation_id?: string;
  message: string;
  include_context?: boolean;
  temperature?: number;
}

serve(async (req) => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    // Get authorization header
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) {
      throw new Error('Missing authorization header');
    }

    // Create Supabase client
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      },
    });

    // Get user from auth token
    const { data: { user }, error: userError } = await supabase.auth.getUser(
      authHeader.replace('Bearer ', '')
    );

    if (userError || !user) {
      throw new Error('Unauthorized');
    }

    // Parse request body
    const body: ChatRequest = await req.json();
    const { conversation_id, message, include_context = true, temperature = 0.7 } = body;

    if (!message || message.trim() === '') {
      throw new Error('Message is required');
    }

    // Get or create conversation
    let conversationId = conversation_id;
    if (!conversationId) {
      const { data: newConv, error: convError } = await supabase
        .from('ai_conversations')
        .insert({
          user_id: user.id,
          title: 'Cuộc trò chuyện mới',
          message_count: 0,
          total_tokens_used: 0,
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
        content: message,
        tokens_used: Math.ceil(message.length / 4),
      })
      .select()
      .single();

    if (msgError) throw msgError;

    // Get conversation context (recent messages)
    const { data: recentMessages } = await supabase
      .from('ai_messages')
      .select('role, content, created_at')
      .eq('conversation_id', conversationId)
      .order('created_at', { ascending: false })
      .limit(20);

    // Retrieve relevant context using embeddings (RAG)
    let relevantContext: any[] = [];
    if (include_context) {
      try {
        // Create OpenAI client for embeddings
        const openai = new OpenAI({
          apiKey: Deno.env.get('OPENAI_API_KEY'),
        });

        // Generate embedding for user message
        const embeddingResponse = await openai.embeddings.create({
          model: 'text-embedding-3-small',
          input: message,
        });

        const queryEmbedding = embeddingResponse.data[0].embedding;

        // Search similar memories
        const { data: similarMemories } = await supabase.rpc('search_similar_memories', {
          p_user_id: user.id,
          p_query_embedding: queryEmbedding,
          p_limit: 5,
          p_similarity_threshold: 0.7,
        });

        relevantContext = similarMemories || [];
      } catch (error) {
        console.error('Error retrieving context:', error);
        // Continue without context if retrieval fails
      }
    }

    // Build system message with context
    let systemMessage = `Bạn là trợ lý AI cá nhân thông minh của người dùng trong hệ thống quản lý bất động sản iHomeCRM.

Nhiệm vụ của bạn:
1. Trả lời các câu hỏi về dữ liệu: hợp đồng, khách thuê, tòa nhà, phòng, hóa đơn, thanh toán
2. Phân tích dữ liệu và tạo báo cáo
3. Đề xuất các hành động và kế hoạch
4. Ghi nhớ thông tin quan trọng từ các cuộc trò chuyện trước

Hãy trả lời một cách chính xác, ngắn gọn và hữu ích. Sử dụng tiếng Việt.`;

    if (relevantContext.length > 0) {
      systemMessage += '\n\nThông tin tham khảo từ bộ nhớ:\n';
      relevantContext.forEach((ctx, idx) => {
        systemMessage += `${idx + 1}. ${ctx.content}\n`;
        if (ctx.entity_type && ctx.entity_name) {
          systemMessage += `   (Liên quan: ${ctx.entity_type} - ${ctx.entity_name})\n`;
        }
      });
    }

    // Prepare messages for OpenAI
    const messages: any[] = [
      { role: 'system', content: systemMessage },
    ];

    // Add recent conversation history (reversed to chronological order)
    if (recentMessages && recentMessages.length > 0) {
      const chronologicalMessages = [...recentMessages].reverse();
      chronologicalMessages.forEach((msg) => {
        if (msg.role !== 'system') {
          messages.push({
            role: msg.role,
            content: msg.content,
          });
        }
      });
    }

    // Call OpenAI API
    const openai = new OpenAI({
      apiKey: Deno.env.get('OPENAI_API_KEY'),
    });

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages,
      temperature,
      max_tokens: 2000,
    });

    const assistantMessage = completion.choices[0].message.content;
    const tokensUsed = completion.usage?.total_tokens || 0;

    // Insert assistant response
    const { data: assistantMsg, error: assistantError } = await supabase
      .from('ai_messages')
      .insert({
        conversation_id: conversationId,
        role: 'assistant',
        content: assistantMessage,
        tokens_used: tokensUsed,
        context_used: relevantContext,
        model: 'gpt-4o-mini',
        temperature,
      })
      .select()
      .single();

    if (assistantError) throw assistantError;

    // Return response
    return new Response(
      JSON.stringify({
        success: true,
        conversation_id: conversationId,
        user_message: userMessage,
        assistant_message: assistantMsg,
        context_used: relevantContext.length,
      }),
      {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    );
  } catch (error) {
    console.error('Error in ai-chat function:', error);
    return new Response(
      JSON.stringify({
        success: false,
        error: error.message,
      }),
      {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    );
  }
});
