import { useState, useEffect, useRef } from 'react';
import MainLayout from "@/components/layout/MainLayout";
import { Bot, Plus, Search, Archive, Pin, Trash2, MoreVertical, Send, Loader2, AlertCircle, Book, X, Settings, Sparkles, MessageSquare, Brain, Zap, Stars } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  useConversations,
  useMessages,
  useCreateConversation,
  useSendMessage,
  useUpdateConversation,
  useDeleteConversation,
  useConversationStats,
  useKnowledgeBase,
  useCreateKnowledgeEntry,
  useDeleteKnowledgeEntry,
} from '@/hooks/useAIAssistant';
import { cn } from '@/lib/utils';
import { format } from 'date-fns';
import { vi } from 'date-fns/locale';
import { APIKeysSettings } from '@/components/ai/APIKeysSettings';

const AIAssistantPage = () => {
  const [selectedConversationId, setSelectedConversationId] = useState<string | undefined>();
  const [messageInput, setMessageInput] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [activeTab, setActiveTab] = useState('chat');
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Knowledge Base state
  const [showAddKnowledge, setShowAddKnowledge] = useState(false);
  const [knowledgeContent, setKnowledgeContent] = useState('');
  const [knowledgeEntityType, setKnowledgeEntityType] = useState('');

  // Hooks
  const { data: conversations, isLoading: loadingConversations, error: conversationsError } = useConversations();
  const { data: messages, isLoading: loadingMessages, error: messagesError } = useMessages(selectedConversationId);
  const { data: stats, error: statsError } = useConversationStats();
  const { data: knowledgeBase, isLoading: loadingKnowledge } = useKnowledgeBase();
  const createConversation = useCreateConversation();
  const sendMessage = useSendMessage();
  const updateConversation = useUpdateConversation();
  const deleteConversation = useDeleteConversation();
  const createKnowledgeEntry = useCreateKnowledgeEntry();
  const deleteKnowledgeEntry = useDeleteKnowledgeEntry();

  // Auto scroll to bottom on new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // Check if tables exist
  const tablesNotExist = conversationsError?.message?.includes('relation') ||
                         conversationsError?.message?.includes('does not exist');

  // Filter conversations by search
  const filteredConversations = conversations?.filter((conv) =>
    conv.title.toLowerCase().includes(searchQuery.toLowerCase())
  );

  // Handle new conversation
  const handleNewConversation = async () => {
    try {
      const result = await createConversation.mutateAsync({
        title: 'Cuộc trò chuyện mới',
      });
      setSelectedConversationId(result.id);
    } catch (error) {
      console.error('Error creating conversation:', error);
    }
  };

  // Handle send message
  const handleSendMessage = async () => {
    if (!messageInput.trim()) return;

    const message = messageInput;
    setMessageInput('');

    try {
      await sendMessage.mutateAsync({
        conversation_id: selectedConversationId,
        message,
        include_context: true,
      });
    } catch (error) {
      console.error('Error sending message:', error);
    }
  };

  // Handle pin conversation
  const handlePinConversation = (id: string, isPinned: boolean) => {
    updateConversation.mutate({
      id,
      updates: { is_pinned: !isPinned },
    });
  };

  // Handle archive conversation
  const handleArchiveConversation = (id: string) => {
    updateConversation.mutate({
      id,
      updates: { is_archived: true },
    });
    if (selectedConversationId === id) {
      setSelectedConversationId(undefined);
    }
  };

  // Handle delete conversation
  const handleDeleteConversation = (id: string) => {
    if (confirm('Bạn có chắc muốn xóa cuộc trò chuyện này?')) {
      deleteConversation.mutate(id);
      if (selectedConversationId === id) {
        setSelectedConversationId(undefined);
      }
    }
  };

  // Handle add knowledge
  const handleAddKnowledge = async () => {
    if (!knowledgeContent.trim()) return;

    try {
      await createKnowledgeEntry.mutateAsync({
        content: knowledgeContent,
        entity_type: knowledgeEntityType || undefined,
      });
      setKnowledgeContent('');
      setKnowledgeEntityType('');
      setShowAddKnowledge(false);
    } catch (error) {
      console.error('Error adding knowledge:', error);
    }
  };

  // Handle delete knowledge
  const handleDeleteKnowledge = (id: string) => {
    if (confirm('Bạn có chắc muốn xóa kiến thức này?')) {
      deleteKnowledgeEntry.mutate(id);
    }
  };

  // Show error if tables don't exist
  if (tablesNotExist) {
    return (
      <MainLayout>
        <div className="container mx-auto p-6 max-w-4xl">
          <Alert variant="destructive">
            <AlertCircle className="h-4 w-4" />
            <AlertTitle>Cần chạy Database Migration</AlertTitle>
            <AlertDescription className="mt-2 space-y-2">
              <p>
                Các bảng AI Assistant chưa được tạo trong database. Vui lòng chạy migration sau:
              </p>
              <ol className="list-decimal list-inside space-y-1 mt-2">
                <li>Vào Supabase Dashboard → SQL Editor</li>
                <li>Copy nội dung file: <code className="bg-muted px-1 py-0.5 rounded">supabase/migrations/026_ai_assistant_tables.sql</code></li>
                <li>Paste vào SQL Editor và chạy</li>
                <li>Refresh lại trang này</li>
              </ol>
              <p className="mt-4 text-sm">
                <strong>Lỗi chi tiết:</strong> {conversationsError?.message}
              </p>
            </AlertDescription>
          </Alert>
        </div>
      </MainLayout>
    );
  }

  return (
    <MainLayout>
      <div className="min-h-screen bg-gradient-to-br from-purple-50 via-blue-50 to-pink-50 dark:from-gray-950 dark:via-purple-950/20 dark:to-blue-950/20">
        <div className="container mx-auto p-6 max-w-full h-[calc(100vh-4rem)]">
        {/* Animated Header with Gradients */}
        <div className="relative mb-6 overflow-hidden rounded-2xl bg-gradient-to-r from-purple-600 via-blue-600 to-pink-600 p-6 shadow-2xl">
          {/* Animated background effect */}
          <div className="absolute inset-0 bg-gradient-to-r from-purple-600/50 via-blue-600/50 to-pink-600/50 animate-pulse"></div>

          <div className="relative z-10 flex items-center justify-between">
            <div className="flex items-center gap-4">
              <div className="relative group">
                <div className="absolute -inset-1 bg-gradient-to-r from-yellow-400 via-pink-500 to-purple-600 rounded-2xl blur opacity-75 group-hover:opacity-100 transition duration-200 animate-pulse"></div>
                <div className="relative h-16 w-16 rounded-2xl bg-white dark:bg-gray-900 flex items-center justify-center shadow-xl transform group-hover:scale-110 transition-transform duration-200">
                  <Bot className="h-8 w-8 text-transparent bg-clip-text bg-gradient-to-r from-purple-600 to-blue-600" />
                  <Sparkles className="absolute -top-1 -right-1 h-5 w-5 text-yellow-400 animate-bounce" />
                </div>
              </div>
              <div className="text-white">
                <h1 className="text-3xl font-bold flex items-center gap-2">
                  Trợ lý AI
                  <Stars className="h-6 w-6 text-yellow-400 animate-spin-slow" />
                </h1>
                <p className="text-blue-100 font-medium flex items-center gap-2">
                  <Brain className="h-4 w-4" />
                  Trợ lý cá nhân với bộ nhớ dài hạn
                </p>
              </div>
            </div>

            {/* Stats Cards */}
            {stats && (
              <div className="flex gap-4">
                <div className="bg-white/20 backdrop-blur-lg rounded-xl p-4 text-center min-w-[100px] border border-white/30 hover:bg-white/30 transition-all duration-200 transform hover:scale-105">
                  <p className="text-3xl font-bold text-white">{stats.total_conversations}</p>
                  <p className="text-xs text-blue-100 font-medium">Cuộc trò chuyện</p>
                </div>
                <div className="bg-white/20 backdrop-blur-lg rounded-xl p-4 text-center min-w-[100px] border border-white/30 hover:bg-white/30 transition-all duration-200 transform hover:scale-105">
                  <p className="text-3xl font-bold text-white">{stats.total_messages}</p>
                  <p className="text-xs text-blue-100 font-medium">Tin nhắn</p>
                </div>
                <div className="bg-white/20 backdrop-blur-lg rounded-xl p-4 text-center min-w-[100px] border border-white/30 hover:bg-white/30 transition-all duration-200 transform hover:scale-105">
                  <p className="text-3xl font-bold text-white">
                    {(stats.total_tokens_used / 1000).toFixed(1)}K
                  </p>
                  <p className="text-xs text-blue-100 font-medium">Tokens</p>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Main Tabs with Modern Design */}
        <Tabs value={activeTab} onValueChange={setActiveTab} className="h-[calc(100%-10rem)]">
          <TabsList className="mb-4 bg-white dark:bg-gray-900 p-1 rounded-xl shadow-lg border-2 border-purple-200 dark:border-purple-800">
            <TabsTrigger
              value="chat"
              className="data-[state=active]:bg-gradient-to-r data-[state=active]:from-purple-500 data-[state=active]:to-blue-500 data-[state=active]:text-white rounded-lg font-semibold"
            >
              <MessageSquare className="h-4 w-4 mr-2" />
              Trò chuyện
            </TabsTrigger>
            <TabsTrigger
              value="knowledge"
              className="data-[state=active]:bg-gradient-to-r data-[state=active]:from-blue-500 data-[state=active]:to-teal-500 data-[state=active]:text-white rounded-lg font-semibold"
            >
              <Book className="h-4 w-4 mr-2" />
              Kho kiến thức
            </TabsTrigger>
            <TabsTrigger
              value="settings"
              className="data-[state=active]:bg-gradient-to-r data-[state=active]:from-orange-500 data-[state=active]:to-pink-500 data-[state=active]:text-white rounded-lg font-semibold"
            >
              <Settings className="h-4 w-4 mr-2" />
              Cài đặt API
            </TabsTrigger>
          </TabsList>

          {/* Chat Tab */}
          <TabsContent value="chat" className="h-full mt-0">
            <div className="grid grid-cols-12 gap-6 h-full">
              {/* Sidebar - Conversation List with Gradient */}
              <div className="col-span-3">
                <Card className="h-full flex flex-col shadow-2xl border-2 border-purple-200 dark:border-purple-800 bg-gradient-to-br from-white to-purple-50 dark:from-gray-900 dark:to-purple-950/30 overflow-hidden">
                  <CardHeader className="pb-3 bg-gradient-to-r from-purple-100 to-blue-100 dark:from-purple-900/30 dark:to-blue-900/30">
                    <div className="flex items-center justify-between">
                      <CardTitle className="text-lg font-bold bg-gradient-to-r from-purple-600 to-blue-600 bg-clip-text text-transparent">
                        Cuộc trò chuyện
                      </CardTitle>
                      <Button
                        size="sm"
                        onClick={handleNewConversation}
                        disabled={createConversation.isPending}
                        className="bg-gradient-to-r from-purple-500 to-blue-500 hover:from-purple-600 hover:to-blue-600 text-white shadow-lg transform hover:scale-110 transition-transform"
                      >
                        {createConversation.isPending ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          <Plus className="h-4 w-4" />
                        )}
                      </Button>
                    </div>
                    <div className="relative mt-2">
                      <Search className="absolute left-3 top-3 h-4 w-4 text-purple-500" />
                      <Input
                        placeholder="Tìm kiếm..."
                        className="pl-10 border-2 border-purple-200 focus:border-purple-500 rounded-xl"
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                      />
                    </div>
                  </CardHeader>
                  <CardContent className="flex-1 p-0">
                    <ScrollArea className="h-full">
                      {loadingConversations ? (
                        <div className="flex items-center justify-center py-8">
                          <div className="relative">
                            <Loader2 className="h-8 w-8 animate-spin text-purple-500" />
                            <Sparkles className="absolute -top-1 -right-1 h-4 w-4 text-yellow-400 animate-bounce" />
                          </div>
                        </div>
                      ) : filteredConversations?.length === 0 ? (
                        <div className="text-center py-8 px-4">
                          <div className="relative inline-block mb-4">
                            <MessageSquare className="h-16 w-16 text-purple-300 dark:text-purple-700" />
                            <Sparkles className="absolute -top-2 -right-2 h-6 w-6 text-yellow-400 animate-pulse" />
                          </div>
                          <p className="text-sm text-gray-600 dark:text-gray-400 font-medium mb-3">
                            Chưa có cuộc trò chuyện nào
                          </p>
                          <Button
                            variant="outline"
                            size="sm"
                            className="border-2 border-purple-300 hover:bg-purple-50 dark:hover:bg-purple-950"
                            onClick={handleNewConversation}
                          >
                            <Plus className="h-4 w-4 mr-2" />
                            Tạo mới
                          </Button>
                        </div>
                      ) : (
                        <div className="space-y-2 p-3">
                          {filteredConversations?.map((conv) => (
                            <div
                              key={conv.id}
                              className={cn(
                                'group flex items-start gap-3 p-4 rounded-xl cursor-pointer transition-all duration-200 border-2',
                                selectedConversationId === conv.id
                                  ? 'bg-gradient-to-r from-purple-100 to-blue-100 dark:from-purple-900/50 dark:to-blue-900/50 border-purple-400 shadow-lg transform scale-105'
                                  : 'bg-white dark:bg-gray-800 border-transparent hover:border-purple-300 hover:shadow-md hover:scale-102'
                              )}
                              onClick={() => setSelectedConversationId(conv.id)}
                            >
                              <div className="flex-1 min-w-0">
                                <div className="flex items-center gap-2">
                                  {conv.is_pinned && (
                                    <Pin className="h-4 w-4 text-yellow-500 fill-yellow-500" />
                                  )}
                                  <p className="text-sm font-bold truncate bg-gradient-to-r from-purple-700 to-blue-700 dark:from-purple-400 dark:to-blue-400 bg-clip-text text-transparent">
                                    {conv.title}
                                  </p>
                                </div>
                                <p className="text-xs text-gray-500 dark:text-gray-400 mt-1 font-medium">
                                  <MessageSquare className="inline h-3 w-3 mr-1" />
                                  {conv.message_count} tin nhắn
                                </p>
                                {conv.last_message_at && (
                                  <p className="text-xs text-gray-400 dark:text-gray-500">
                                    {format(new Date(conv.last_message_at), 'dd/MM/yyyy HH:mm', {
                                      locale: vi,
                                    })}
                                  </p>
                                )}
                              </div>
                              <DropdownMenu>
                                <DropdownMenuTrigger asChild>
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    className="h-8 w-8 p-0 opacity-0 group-hover:opacity-100 hover:bg-purple-200 dark:hover:bg-purple-800"
                                    onClick={(e) => e.stopPropagation()}
                                  >
                                    <MoreVertical className="h-4 w-4" />
                                  </Button>
                                </DropdownMenuTrigger>
                                <DropdownMenuContent align="end" className="border-2 border-purple-200 dark:border-purple-800">
                                  <DropdownMenuItem
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      handlePinConversation(conv.id, conv.is_pinned);
                                    }}
                                  >
                                    <Pin className="h-4 w-4 mr-2" />
                                    {conv.is_pinned ? 'Bỏ ghim' : 'Ghim'}
                                  </DropdownMenuItem>
                                  <DropdownMenuItem
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      handleArchiveConversation(conv.id);
                                    }}
                                  >
                                    <Archive className="h-4 w-4 mr-2" />
                                    Lưu trữ
                                  </DropdownMenuItem>
                                  <DropdownMenuSeparator />
                                  <DropdownMenuItem
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      handleDeleteConversation(conv.id);
                                    }}
                                    className="text-red-600 dark:text-red-400"
                                  >
                                    <Trash2 className="h-4 w-4 mr-2" />
                                    Xóa
                                  </DropdownMenuItem>
                                </DropdownMenuContent>
                              </DropdownMenu>
                            </div>
                          ))}
                        </div>
                      )}
                    </ScrollArea>
                  </CardContent>
                </Card>
              </div>

              {/* Main Chat Area with Modern Design */}
              <div className="col-span-9">
                <Card className="h-full flex flex-col shadow-2xl border-2 border-blue-200 dark:border-blue-800 bg-gradient-to-br from-white to-blue-50 dark:from-gray-900 dark:to-blue-950/30 overflow-hidden">
                  {selectedConversationId ? (
                    <>
                      {/* Messages Area with Gradient Background */}
                      <CardContent className="flex-1 p-6 overflow-hidden bg-gradient-to-br from-blue-50/50 to-purple-50/50 dark:from-gray-900/50 dark:to-purple-950/20">
                        <ScrollArea className="h-full pr-4">
                          {loadingMessages ? (
                            <div className="flex items-center justify-center h-full">
                              <div className="relative">
                                <Loader2 className="h-12 w-12 animate-spin text-blue-500" />
                                <Zap className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 h-6 w-6 text-yellow-400 animate-pulse" />
                              </div>
                            </div>
                          ) : messages?.length === 0 ? (
                            <div className="flex flex-col items-center justify-center h-full text-center">
                              <div className="relative mb-6">
                                <div className="absolute inset-0 bg-gradient-to-r from-purple-500 to-blue-500 rounded-full blur-2xl opacity-30 animate-pulse"></div>
                                <div className="relative h-24 w-24 rounded-full bg-gradient-to-br from-purple-500 via-blue-500 to-pink-500 flex items-center justify-center shadow-2xl">
                                  <Bot className="h-12 w-12 text-white" />
                                </div>
                                <Sparkles className="absolute -top-2 -right-2 h-8 w-8 text-yellow-400 animate-bounce" />
                              </div>
                              <h3 className="text-2xl font-bold mb-3 bg-gradient-to-r from-purple-600 to-blue-600 bg-clip-text text-transparent">
                                Bắt đầu cuộc trò chuyện
                              </h3>
                              <p className="text-base text-gray-600 dark:text-gray-400 max-w-md font-medium">
                                Hỏi tôi bất cứ điều gì về dữ liệu của bạn: hợp đồng, khách thuê,
                                tòa nhà, báo cáo tài chính...
                              </p>
                            </div>
                          ) : (
                            <div className="space-y-6 py-4">
                              {messages?.map((msg) => (
                                <div
                                  key={msg.id}
                                  className={cn(
                                    'flex gap-4 animate-in fade-in slide-in-from-bottom-4 duration-300',
                                    msg.role === 'user' ? 'justify-end' : 'justify-start'
                                  )}
                                >
                                  {msg.role === 'assistant' && (
                                    <div className="relative group">
                                      <div className="absolute -inset-1 bg-gradient-to-r from-purple-500 to-blue-500 rounded-full blur opacity-30 group-hover:opacity-50 transition duration-200"></div>
                                      <div className="relative h-10 w-10 rounded-full bg-gradient-to-br from-purple-500 to-blue-500 flex items-center justify-center flex-shrink-0 shadow-lg">
                                        <Bot className="h-5 w-5 text-white" />
                                      </div>
                                    </div>
                                  )}
                                  <div
                                    className={cn(
                                      'max-w-[75%] rounded-2xl p-5 shadow-lg border-2 backdrop-blur-sm transition-all duration-200 hover:scale-102 hover:shadow-xl',
                                      msg.role === 'user'
                                        ? 'bg-gradient-to-br from-purple-500 to-blue-500 text-white border-purple-400 shadow-purple-200 dark:shadow-purple-900'
                                        : 'bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 border-gray-200 dark:border-gray-700'
                                    )}
                                  >
                                    <p className="text-sm whitespace-pre-wrap leading-relaxed font-medium">{msg.content}</p>
                                    <p className={cn(
                                      "text-xs mt-2 flex items-center gap-1",
                                      msg.role === 'user' ? 'text-blue-100' : 'text-gray-500 dark:text-gray-400'
                                    )}>
                                      <Zap className="h-3 w-3" />
                                      {format(new Date(msg.created_at), 'HH:mm', { locale: vi })}
                                    </p>
                                  </div>
                                  {msg.role === 'user' && (
                                    <div className="h-10 w-10 rounded-full bg-gradient-to-br from-orange-400 to-pink-500 flex items-center justify-center flex-shrink-0 shadow-lg font-bold text-white text-sm">
                                      ME
                                    </div>
                                  )}
                                </div>
                              ))}
                              <div ref={messagesEndRef} />
                            </div>
                          )}
                        </ScrollArea>
                      </CardContent>

                      {/* Input Area with Gradient */}
                      <div className="border-t-2 border-blue-200 dark:border-blue-800 p-4 bg-gradient-to-r from-purple-50 to-blue-50 dark:from-purple-950/30 dark:to-blue-950/30">
                        <div className="flex gap-3">
                          <Textarea
                            placeholder="Nhập tin nhắn của bạn... ✨"
                            value={messageInput}
                            onChange={(e) => setMessageInput(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter' && !e.shiftKey) {
                                e.preventDefault();
                                handleSendMessage();
                              }
                            }}
                            className="min-h-[70px] max-h-[200px] resize-none border-2 border-purple-200 focus:border-purple-500 rounded-xl text-base bg-white dark:bg-gray-900"
                            disabled={sendMessage.isPending}
                          />
                          <Button
                            onClick={handleSendMessage}
                            disabled={!messageInput.trim() || sendMessage.isPending}
                            size="lg"
                            className="bg-gradient-to-r from-purple-500 to-blue-500 hover:from-purple-600 hover:to-blue-600 text-white shadow-lg transform hover:scale-110 transition-all h-[70px] w-16"
                          >
                            {sendMessage.isPending ? (
                              <Loader2 className="h-5 w-5 animate-spin" />
                            ) : (
                              <Send className="h-5 w-5" />
                            )}
                          </Button>
                        </div>
                        <p className="text-xs text-gray-500 dark:text-gray-400 mt-2 font-medium">
                          <Zap className="inline h-3 w-3 mr-1" />
                          Nhấn Enter để gửi, Shift+Enter để xuống dòng
                        </p>
                      </div>
                    </>
                  ) : (
                    <CardContent className="flex-1 flex items-center justify-center bg-gradient-to-br from-purple-50/50 via-blue-50/50 to-pink-50/50 dark:from-purple-950/20 dark:via-blue-950/20 dark:to-pink-950/20">
                      <div className="text-center max-w-md">
                        <div className="relative inline-block mb-6">
                          <div className="absolute inset-0 bg-gradient-to-r from-purple-500 via-blue-500 to-pink-500 rounded-full blur-3xl opacity-40 animate-pulse"></div>
                          <div className="relative h-32 w-32 rounded-full bg-gradient-to-br from-purple-500 via-blue-500 to-pink-500 flex items-center justify-center mx-auto shadow-2xl">
                            <Bot className="h-16 w-16 text-white" />
                          </div>
                          <Sparkles className="absolute top-0 right-0 h-12 w-12 text-yellow-400 animate-spin-slow" />
                          <Stars className="absolute bottom-0 left-0 h-10 w-10 text-pink-400 animate-bounce" />
                        </div>
                        <h3 className="text-3xl font-bold mb-3 bg-gradient-to-r from-purple-600 via-blue-600 to-pink-600 bg-clip-text text-transparent">
                          Chào mừng đến với Trợ lý AI
                        </h3>
                        <p className="text-gray-600 dark:text-gray-400 mb-6 text-lg font-medium">
                          Chọn một cuộc trò chuyện từ danh sách bên trái hoặc tạo cuộc trò
                          chuyện mới để bắt đầu
                        </p>
                        <Button
                          onClick={handleNewConversation}
                          disabled={createConversation.isPending}
                          size="lg"
                          className="bg-gradient-to-r from-purple-500 via-blue-500 to-pink-500 hover:from-purple-600 hover:via-blue-600 hover:to-pink-600 text-white shadow-2xl transform hover:scale-110 transition-all text-base px-8 py-6"
                        >
                          {createConversation.isPending ? (
                            <Loader2 className="h-5 w-5 mr-2 animate-spin" />
                          ) : (
                            <Plus className="h-5 w-5 mr-2" />
                          )}
                          Tạo cuộc trò chuyện mới
                        </Button>
                      </div>
                    </CardContent>
                  )}
                </Card>
              </div>
            </div>
          </TabsContent>

          {/* Knowledge Base Tab */}
          <TabsContent value="knowledge" className="h-full mt-0">
            <Card className="h-full flex flex-col shadow-2xl border-2 border-teal-200 dark:border-teal-800 bg-gradient-to-br from-white to-teal-50 dark:from-gray-900 dark:to-teal-950/30">
              <CardHeader className="bg-gradient-to-r from-teal-100 to-blue-100 dark:from-teal-900/30 dark:to-blue-900/30">
                <div className="flex items-center justify-between">
                  <div>
                    <CardTitle className="text-2xl font-bold bg-gradient-to-r from-teal-600 to-blue-600 bg-clip-text text-transparent flex items-center gap-2">
                      <Book className="h-6 w-6 text-teal-600" />
                      Kho kiến thức
                    </CardTitle>
                    <CardDescription className="text-base font-medium mt-1">
                      Quản lý thông tin tham khảo để AI có thể hỗ trợ tốt hơn
                    </CardDescription>
                  </div>
                  <Dialog open={showAddKnowledge} onOpenChange={setShowAddKnowledge}>
                    <DialogTrigger asChild>
                      <Button className="bg-gradient-to-r from-teal-500 to-blue-500 hover:from-teal-600 hover:to-blue-600 text-white shadow-lg transform hover:scale-110 transition-transform">
                        <Plus className="h-4 w-4 mr-2" />
                        Thêm kiến thức
                      </Button>
                    </DialogTrigger>
                    <DialogContent className="border-2 border-teal-200 dark:border-teal-800">
                      <DialogHeader>
                        <DialogTitle className="text-xl font-bold bg-gradient-to-r from-teal-600 to-blue-600 bg-clip-text text-transparent">
                          Thêm kiến thức mới
                        </DialogTitle>
                        <DialogDescription className="text-base">
                          Thêm thông tin mà bạn muốn AI ghi nhớ và sử dụng trong các cuộc trò chuyện
                        </DialogDescription>
                      </DialogHeader>
                      <div className="space-y-4 mt-4">
                        <div className="space-y-2">
                          <Label htmlFor="knowledge-content" className="font-semibold">Nội dung</Label>
                          <Textarea
                            id="knowledge-content"
                            placeholder="Ví dụ: Chính sách giảm giá cho khách thuê dài hạn là 10%..."
                            value={knowledgeContent}
                            onChange={(e) => setKnowledgeContent(e.target.value)}
                            rows={6}
                            className="border-2 border-teal-200 focus:border-teal-500 rounded-xl"
                          />
                        </div>
                        <div className="space-y-2">
                          <Label htmlFor="entity-type" className="font-semibold">Loại (tùy chọn)</Label>
                          <Input
                            id="entity-type"
                            placeholder="Ví dụ: policy, guideline, faq..."
                            value={knowledgeEntityType}
                            onChange={(e) => setKnowledgeEntityType(e.target.value)}
                            className="border-2 border-teal-200 focus:border-teal-500 rounded-xl"
                          />
                        </div>
                        <div className="flex justify-end gap-2">
                          <Button
                            variant="outline"
                            onClick={() => {
                              setShowAddKnowledge(false);
                              setKnowledgeContent('');
                              setKnowledgeEntityType('');
                            }}
                            className="border-2 border-gray-300"
                          >
                            Hủy
                          </Button>
                          <Button
                            onClick={handleAddKnowledge}
                            disabled={!knowledgeContent.trim() || createKnowledgeEntry.isPending}
                            className="bg-gradient-to-r from-teal-500 to-blue-500 hover:from-teal-600 hover:to-blue-600 text-white"
                          >
                            {createKnowledgeEntry.isPending ? (
                              <Loader2 className="h-4 w-4 animate-spin mr-2" />
                            ) : (
                              <Plus className="h-4 w-4 mr-2" />
                            )}
                            Thêm
                          </Button>
                        </div>
                      </div>
                    </DialogContent>
                  </Dialog>
                </div>
              </CardHeader>
              <CardContent className="flex-1 overflow-hidden p-6">
                <ScrollArea className="h-full">
                  {loadingKnowledge ? (
                    <div className="flex items-center justify-center py-12">
                      <div className="relative">
                        <Loader2 className="h-12 w-12 animate-spin text-teal-500" />
                        <Brain className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 h-6 w-6 text-blue-400 animate-pulse" />
                      </div>
                    </div>
                  ) : !knowledgeBase || knowledgeBase.length === 0 ? (
                    <div className="text-center py-12">
                      <div className="relative inline-block mb-6">
                        <div className="absolute inset-0 bg-gradient-to-r from-teal-500 to-blue-500 rounded-full blur-2xl opacity-30 animate-pulse"></div>
                        <div className="relative h-24 w-24 rounded-full bg-gradient-to-br from-teal-500 to-blue-500 flex items-center justify-center mx-auto shadow-2xl">
                          <Book className="h-12 w-12 text-white" />
                        </div>
                        <Sparkles className="absolute -top-2 -right-2 h-8 w-8 text-yellow-400 animate-bounce" />
                      </div>
                      <h3 className="text-2xl font-bold mb-3 bg-gradient-to-r from-teal-600 to-blue-600 bg-clip-text text-transparent">
                        Chưa có kiến thức nào
                      </h3>
                      <p className="text-base text-gray-600 dark:text-gray-400 mb-6 font-medium">
                        Thêm thông tin tham khảo để AI có thể hỗ trợ bạn tốt hơn
                      </p>
                      <Button
                        onClick={() => setShowAddKnowledge(true)}
                        className="bg-gradient-to-r from-teal-500 to-blue-500 hover:from-teal-600 hover:to-blue-600 text-white shadow-lg transform hover:scale-110 transition-all"
                      >
                        <Plus className="h-4 w-4 mr-2" />
                        Thêm kiến thức đầu tiên
                      </Button>
                    </div>
                  ) : (
                    <div className="space-y-4">
                      {knowledgeBase.map((entry) => (
                        <Card key={entry.id} className="border-2 border-teal-200 dark:border-teal-800 hover:border-teal-400 dark:hover:border-teal-600 transition-all duration-200 hover:shadow-lg transform hover:scale-102 bg-gradient-to-br from-white to-teal-50/50 dark:from-gray-800 dark:to-teal-950/20">
                          <CardContent className="p-5">
                            <div className="flex items-start justify-between gap-4">
                              <div className="flex-1 min-w-0">
                                <p className="text-base whitespace-pre-wrap break-words font-medium text-gray-800 dark:text-gray-200">
                                  {entry.content}
                                </p>
                                <div className="flex items-center gap-4 mt-3 text-xs">
                                  {entry.entity_type && (
                                    <span className="inline-flex items-center px-3 py-1 rounded-full bg-gradient-to-r from-teal-500 to-blue-500 text-white font-bold shadow-md">
                                      {entry.entity_type}
                                    </span>
                                  )}
                                  <span className="text-gray-500 dark:text-gray-400 font-medium">
                                    {format(new Date(entry.created_at), 'dd/MM/yyyy HH:mm', {
                                      locale: vi,
                                    })}
                                  </span>
                                  {entry.access_count > 0 && (
                                    <span className="inline-flex items-center gap-1 text-teal-600 dark:text-teal-400 font-bold">
                                      <Zap className="h-3 w-3" />
                                      Đã sử dụng: {entry.access_count} lần
                                    </span>
                                  )}
                                </div>
                              </div>
                              <Button
                                variant="ghost"
                                size="icon"
                                onClick={() => handleDeleteKnowledge(entry.id)}
                                disabled={deleteKnowledgeEntry.isPending}
                                className="hover:bg-red-100 dark:hover:bg-red-900/30 text-red-500 hover:text-red-700"
                              >
                                {deleteKnowledgeEntry.isPending ? (
                                  <Loader2 className="h-4 w-4 animate-spin" />
                                ) : (
                                  <X className="h-4 w-4" />
                                )}
                              </Button>
                            </div>
                          </CardContent>
                        </Card>
                      ))}
                    </div>
                  )}
                </ScrollArea>
              </CardContent>
            </Card>
          </TabsContent>

          {/* Settings Tab */}
          <TabsContent value="settings" className="h-full mt-0">
            <Card className="h-full shadow-2xl border-2 border-orange-200 dark:border-orange-800 bg-gradient-to-br from-white to-orange-50 dark:from-gray-900 dark:to-orange-950/30">
              <CardContent className="p-6">
                <APIKeysSettings />
              </CardContent>
            </Card>
          </TabsContent>
          </Tabs>
        </div>
      </div>
    </MainLayout>
  );
};

export default AIAssistantPage;
