import { useState } from 'react';
import { Bot, Plus, Search, Archive, Pin, Trash2, MoreVertical, Send, Loader2 } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import { Badge } from '@/components/ui/badge';
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
} from '@/hooks/useAIAssistant';
import { cn } from '@/lib/utils';
import { format } from 'date-fns';
import { vi } from 'date-fns/locale';

const AIAssistantPage = () => {
  const [selectedConversationId, setSelectedConversationId] = useState<string | undefined>();
  const [messageInput, setMessageInput] = useState('');
  const [searchQuery, setSearchQuery] = useState('');

  // Hooks
  const { data: conversations, isLoading: loadingConversations } = useConversations();
  const { data: messages, isLoading: loadingMessages } = useMessages(selectedConversationId);
  const { data: stats } = useConversationStats();
  const createConversation = useCreateConversation();
  const sendMessage = useSendMessage();
  const updateConversation = useUpdateConversation();
  const deleteConversation = useDeleteConversation();

  // Filter conversations by search
  const filteredConversations = conversations?.filter((conv) =>
    conv.title.toLowerCase().includes(searchQuery.toLowerCase())
  );

  // Handle new conversation
  const handleNewConversation = async () => {
    const result = await createConversation.mutateAsync({
      title: 'Cuộc trò chuyện mới',
    });
    setSelectedConversationId(result.id);
  };

  // Handle send message
  const handleSendMessage = async () => {
    if (!messageInput.trim()) return;

    const message = messageInput;
    setMessageInput('');

    await sendMessage.mutateAsync({
      conversation_id: selectedConversationId,
      message,
      include_context: true,
    });
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

  return (
    <div className="container mx-auto p-6 max-w-full h-[calc(100vh-4rem)]">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <div className="h-10 w-10 rounded-lg bg-gradient-to-br from-purple-500 to-blue-500 flex items-center justify-center">
            <Bot className="h-5 w-5 text-white" />
          </div>
          <div>
            <h1 className="text-2xl font-bold">Trợ lý AI</h1>
            <p className="text-sm text-muted-foreground">
              Trợ lý cá nhân với bộ nhớ dài hạn
            </p>
          </div>
        </div>

        {/* Stats */}
        {stats && (
          <div className="flex gap-4">
            <div className="text-center">
              <p className="text-2xl font-bold">{stats.total_conversations}</p>
              <p className="text-xs text-muted-foreground">Cuộc trò chuyện</p>
            </div>
            <Separator orientation="vertical" className="h-12" />
            <div className="text-center">
              <p className="text-2xl font-bold">{stats.total_messages}</p>
              <p className="text-xs text-muted-foreground">Tin nhắn</p>
            </div>
            <Separator orientation="vertical" className="h-12" />
            <div className="text-center">
              <p className="text-2xl font-bold">
                {(stats.total_tokens_used / 1000).toFixed(1)}K
              </p>
              <p className="text-xs text-muted-foreground">Tokens</p>
            </div>
          </div>
        )}
      </div>

      {/* Main Layout */}
      <div className="grid grid-cols-12 gap-6 h-[calc(100%-5rem)]">
        {/* Sidebar - Conversation List */}
        <Card className="col-span-3 flex flex-col">
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <CardTitle className="text-base">Cuộc trò chuyện</CardTitle>
              <Button size="sm" onClick={handleNewConversation}>
                <Plus className="h-4 w-4" />
              </Button>
            </div>
            <div className="relative mt-2">
              <Search className="absolute left-2 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Tìm kiếm..."
                className="pl-8"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
              />
            </div>
          </CardHeader>
          <CardContent className="flex-1 p-0">
            <ScrollArea className="h-full">
              {loadingConversations ? (
                <div className="flex items-center justify-center py-8">
                  <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                </div>
              ) : filteredConversations?.length === 0 ? (
                <div className="text-center py-8 px-4">
                  <p className="text-sm text-muted-foreground">
                    Chưa có cuộc trò chuyện nào
                  </p>
                  <Button
                    variant="outline"
                    size="sm"
                    className="mt-2"
                    onClick={handleNewConversation}
                  >
                    <Plus className="h-4 w-4 mr-2" />
                    Tạo mới
                  </Button>
                </div>
              ) : (
                <div className="space-y-1 p-2">
                  {filteredConversations?.map((conv) => (
                    <div
                      key={conv.id}
                      className={cn(
                        'group flex items-start gap-2 p-3 rounded-lg cursor-pointer hover:bg-accent transition-colors',
                        selectedConversationId === conv.id && 'bg-accent'
                      )}
                      onClick={() => setSelectedConversationId(conv.id)}
                    >
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          {conv.is_pinned && (
                            <Pin className="h-3 w-3 text-primary" />
                          )}
                          <p className="text-sm font-medium truncate">
                            {conv.title}
                          </p>
                        </div>
                        <p className="text-xs text-muted-foreground mt-1">
                          {conv.message_count} tin nhắn
                        </p>
                        {conv.last_message_at && (
                          <p className="text-xs text-muted-foreground">
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
                            className="h-8 w-8 p-0 opacity-0 group-hover:opacity-100"
                          >
                            <MoreVertical className="h-4 w-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem
                            onClick={() => handlePinConversation(conv.id, conv.is_pinned)}
                          >
                            <Pin className="h-4 w-4 mr-2" />
                            {conv.is_pinned ? 'Bỏ ghim' : 'Ghim'}
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            onClick={() => handleArchiveConversation(conv.id)}
                          >
                            <Archive className="h-4 w-4 mr-2" />
                            Lưu trữ
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem
                            onClick={() => handleDeleteConversation(conv.id)}
                            className="text-destructive"
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

        {/* Main Chat Area */}
        <Card className="col-span-9 flex flex-col">
          {selectedConversationId ? (
            <>
              {/* Messages */}
              <CardContent className="flex-1 p-6 overflow-hidden">
                <ScrollArea className="h-full pr-4">
                  {loadingMessages ? (
                    <div className="flex items-center justify-center h-full">
                      <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
                    </div>
                  ) : messages?.length === 0 ? (
                    <div className="flex flex-col items-center justify-center h-full text-center">
                      <Bot className="h-16 w-16 text-muted-foreground mb-4" />
                      <h3 className="text-lg font-semibold mb-2">
                        Bắt đầu cuộc trò chuyện
                      </h3>
                      <p className="text-sm text-muted-foreground max-w-md">
                        Hỏi tôi bất cứ điều gì về dữ liệu của bạn: hợp đồng, khách thuê,
                        tòa nhà, báo cáo tài chính...
                      </p>
                    </div>
                  ) : (
                    <div className="space-y-4">
                      {messages?.map((msg) => (
                        <div
                          key={msg.id}
                          className={cn(
                            'flex gap-3',
                            msg.role === 'user' ? 'justify-end' : 'justify-start'
                          )}
                        >
                          {msg.role === 'assistant' && (
                            <div className="h-8 w-8 rounded-full bg-gradient-to-br from-purple-500 to-blue-500 flex items-center justify-center flex-shrink-0">
                              <Bot className="h-4 w-4 text-white" />
                            </div>
                          )}
                          <div
                            className={cn(
                              'max-w-[70%] rounded-lg p-4',
                              msg.role === 'user'
                                ? 'bg-primary text-primary-foreground'
                                : 'bg-muted'
                            )}
                          >
                            <p className="text-sm whitespace-pre-wrap">{msg.content}</p>
                            <p className="text-xs opacity-70 mt-2">
                              {format(new Date(msg.created_at), 'HH:mm', { locale: vi })}
                            </p>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </ScrollArea>
              </CardContent>

              {/* Input Area */}
              <div className="border-t p-4">
                <div className="flex gap-2">
                  <Textarea
                    placeholder="Nhập tin nhắn của bạn..."
                    value={messageInput}
                    onChange={(e) => setMessageInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault();
                        handleSendMessage();
                      }
                    }}
                    className="min-h-[60px] max-h-[200px] resize-none"
                  />
                  <Button
                    onClick={handleSendMessage}
                    disabled={!messageInput.trim() || sendMessage.isPending}
                    size="lg"
                  >
                    {sendMessage.isPending ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Send className="h-4 w-4" />
                    )}
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground mt-2">
                  Nhấn Enter để gửi, Shift+Enter để xuống dòng
                </p>
              </div>
            </>
          ) : (
            <CardContent className="flex-1 flex items-center justify-center">
              <div className="text-center">
                <Bot className="h-20 w-20 text-muted-foreground mx-auto mb-4" />
                <h3 className="text-xl font-semibold mb-2">
                  Chào mừng đến với Trợ lý AI
                </h3>
                <p className="text-muted-foreground mb-6 max-w-md">
                  Chọn một cuộc trò chuyện từ danh sách bên trái hoặc tạo cuộc trò
                  chuyện mới để bắt đầu
                </p>
                <Button onClick={handleNewConversation}>
                  <Plus className="h-4 w-4 mr-2" />
                  Tạo cuộc trò chuyện mới
                </Button>
              </div>
            </CardContent>
          )}
        </Card>
      </div>
    </div>
  );
};

export default AIAssistantPage;