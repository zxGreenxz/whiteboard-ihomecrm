import { useState } from 'react';
import { Key, Plus, Trash2, Eye, EyeOff, ExternalLink, AlertCircle, CheckCircle2, Sparkles, Zap, Lock } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Switch } from '@/components/ui/switch';
import { useApiKeys, useSaveApiKey, useDeleteApiKey, useToggleApiKey } from '@/hooks/useAIAssistant';
import { AI_PROVIDERS, AIProvider, AIApiKey } from '@/types/ai';
import { cn } from '@/lib/utils';

export function APIKeysSettings() {
  const [showAddDialog, setShowAddDialog] = useState(false);
  const [selectedProvider, setSelectedProvider] = useState<AIProvider>('openai');
  const [apiKeyInput, setApiKeyInput] = useState('');
  const [showKeys, setShowKeys] = useState<Record<string, boolean>>({});

  const { data: apiKeys, isLoading } = useApiKeys();
  const saveApiKey = useSaveApiKey();
  const deleteApiKey = useDeleteApiKey();
  const toggleApiKey = useToggleApiKey();

  const selectedProviderConfig = AI_PROVIDERS.find(p => p.provider === selectedProvider);

  const handleSaveKey = async () => {
    if (!apiKeyInput.trim()) return;

    const config = AI_PROVIDERS.find(p => p.provider === selectedProvider);
    if (config && !config.keyPattern.test(apiKeyInput)) {
      alert(`API key không đúng định dạng. Ví dụ: ${config.keyExample}`);
      return;
    }

    try {
      await saveApiKey.mutateAsync({
        provider: selectedProvider,
        api_key: apiKeyInput,
      });
      setApiKeyInput('');
      setShowAddDialog(false);
    } catch (error) {
      console.error('Error saving API key:', error);
    }
  };

  const maskApiKey = (key: string) => {
    if (key.length <= 8) return key;
    return key.substring(0, 4) + '...' + key.substring(key.length - 4);
  };

  const getProviderConfig = (provider: AIProvider) => {
    return AI_PROVIDERS.find(p => p.provider === provider);
  };

  // Get gradient colors for each provider
  const getProviderColors = (provider: AIProvider) => {
    const colors = {
      openai: 'from-emerald-500 to-teal-500',
      gemini: 'from-blue-500 to-indigo-500',
      deepseek: 'from-purple-500 to-pink-500',
      anthropic: 'from-orange-500 to-red-500',
    };
    return colors[provider] || 'from-gray-500 to-gray-700';
  };

  return (
    <div className="space-y-6">
      {/* Header with Gradient */}
      <div className="relative overflow-hidden rounded-2xl bg-gradient-to-r from-orange-500 via-pink-500 to-purple-500 p-6 shadow-2xl">
        <div className="absolute inset-0 bg-gradient-to-r from-orange-500/50 via-pink-500/50 to-purple-500/50 animate-pulse"></div>
        <div className="relative z-10 flex items-start justify-between">
          <div className="text-white">
            <div className="flex items-center gap-3 mb-2">
              <div className="relative">
                <div className="absolute -inset-1 bg-white rounded-lg blur opacity-75"></div>
                <div className="relative h-12 w-12 rounded-lg bg-white/20 backdrop-blur-lg flex items-center justify-center border border-white/30">
                  <Key className="h-6 w-6 text-white" />
                </div>
              </div>
              <h3 className="text-2xl font-bold">Cấu hình API Keys</h3>
            </div>
            <p className="text-orange-100 font-medium flex items-center gap-2">
              <Lock className="h-4 w-4" />
              Thêm API keys để sử dụng các AI providers khác nhau
            </p>
          </div>
          <Dialog open={showAddDialog} onOpenChange={setShowAddDialog}>
            <DialogTrigger asChild>
              <Button className="bg-white text-purple-600 hover:bg-white/90 shadow-xl transform hover:scale-110 transition-all font-bold">
                <Plus className="h-4 w-4 mr-2" />
                Thêm API Key
              </Button>
            </DialogTrigger>
            <DialogContent className="max-w-2xl border-2 border-orange-200 dark:border-orange-800">
              <DialogHeader>
                <DialogTitle className="text-2xl font-bold bg-gradient-to-r from-orange-600 to-pink-600 bg-clip-text text-transparent">
                  Thêm API Key mới
                </DialogTitle>
                <DialogDescription className="text-base">
                  Chọn AI provider và nhập API key để bắt đầu sử dụng
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-4 mt-4">
                <div className="space-y-2">
                  <Label className="font-semibold">Provider</Label>
                  <Select value={selectedProvider} onValueChange={(v) => setSelectedProvider(v as AIProvider)}>
                    <SelectTrigger className="border-2 border-orange-200 focus:border-orange-500">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {AI_PROVIDERS.map((provider) => (
                        <SelectItem key={provider.provider} value={provider.provider}>
                          <div className="flex flex-col">
                            <span className="font-medium">{provider.name}</span>
                            <span className="text-xs text-muted-foreground">{provider.description}</span>
                          </div>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                {selectedProviderConfig && (
                  <Alert className="border-2 border-orange-200 dark:border-orange-800 bg-gradient-to-br from-orange-50/50 to-pink-50/50 dark:from-orange-950/20 dark:to-pink-950/20">
                    <AlertCircle className="h-4 w-4 text-orange-500" />
                    <AlertDescription className="space-y-2">
                      <div>
                        <strong>Format:</strong> <code className="bg-white dark:bg-gray-800 px-2 py-1 rounded">{selectedProviderConfig.keyExample}</code>
                      </div>
                      <div className="flex items-center gap-2">
                        <strong>Lấy API key:</strong>
                        <a
                          href={selectedProviderConfig.docsUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-orange-600 dark:text-orange-400 hover:underline inline-flex items-center gap-1 font-semibold"
                        >
                          {selectedProviderConfig.name} Dashboard
                          <ExternalLink className="h-3 w-3" />
                        </a>
                      </div>
                      <div className="mt-2">
                        <strong>Models có sẵn:</strong>
                        <ul className="list-disc list-inside text-sm mt-1 space-y-1">
                          {selectedProviderConfig.models.map((model) => (
                            <li key={model.id}>
                              <span className="font-medium">{model.name}</span> - {model.description}
                              <span className="text-muted-foreground ml-2">
                                (${model.costPer1MInput}/{model.costPer1MOutput} per 1M tokens)
                              </span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    </AlertDescription>
                  </Alert>
                )}

                <div className="space-y-2">
                  <Label htmlFor="api-key" className="font-semibold">API Key</Label>
                  <Input
                    id="api-key"
                    type="password"
                    placeholder={`Nhập ${selectedProviderConfig?.name} API key...`}
                    value={apiKeyInput}
                    onChange={(e) => setApiKeyInput(e.target.value)}
                    className="border-2 border-orange-200 focus:border-orange-500"
                  />
                </div>

                <div className="flex justify-end gap-2">
                  <Button variant="outline" onClick={() => setShowAddDialog(false)} className="border-2">
                    Hủy
                  </Button>
                  <Button
                    onClick={handleSaveKey}
                    disabled={!apiKeyInput.trim() || saveApiKey.isPending}
                    className="bg-gradient-to-r from-orange-500 to-pink-500 hover:from-orange-600 hover:to-pink-600 text-white shadow-lg"
                  >
                    {saveApiKey.isPending ? (
                      <span className="flex items-center gap-2">
                        <span className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
                        Đang lưu...
                      </span>
                    ) : (
                      'Lưu'
                    )}
                  </Button>
                </div>
              </div>
            </DialogContent>
          </Dialog>
        </div>
      </div>

      {/* API Keys List */}
      {isLoading ? (
        <div className="flex items-center justify-center py-12">
          <div className="relative">
            <div className="h-12 w-12 animate-spin rounded-full border-4 border-orange-500 border-t-transparent" />
            <Zap className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 h-6 w-6 text-yellow-400 animate-pulse" />
          </div>
        </div>
      ) : !apiKeys || apiKeys.length === 0 ? (
        <Card className="border-2 border-orange-200 dark:border-orange-800 shadow-2xl bg-gradient-to-br from-white to-orange-50 dark:from-gray-900 dark:to-orange-950/30">
          <CardContent className="flex flex-col items-center justify-center py-12">
            <div className="relative mb-6">
              <div className="absolute inset-0 bg-gradient-to-r from-orange-500 to-pink-500 rounded-full blur-2xl opacity-30 animate-pulse"></div>
              <div className="relative h-24 w-24 rounded-full bg-gradient-to-br from-orange-500 to-pink-500 flex items-center justify-center shadow-2xl">
                <Key className="h-12 w-12 text-white" />
              </div>
              <Sparkles className="absolute -top-2 -right-2 h-8 w-8 text-yellow-400 animate-bounce" />
            </div>
            <h3 className="text-2xl font-bold mb-2 bg-gradient-to-r from-orange-600 to-pink-600 bg-clip-text text-transparent">
              Chưa có API key nào
            </h3>
            <p className="text-base text-gray-600 dark:text-gray-400 text-center mb-6 max-w-md font-medium">
              Thêm API key để bắt đầu sử dụng AI Assistant với các provider khác nhau
            </p>
            <Button
              onClick={() => setShowAddDialog(true)}
              className="bg-gradient-to-r from-orange-500 to-pink-500 hover:from-orange-600 hover:to-pink-600 text-white shadow-2xl transform hover:scale-110 transition-all"
            >
              <Plus className="h-4 w-4 mr-2" />
              Thêm API Key đầu tiên
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4">
          {AI_PROVIDERS.map((providerConfig) => {
            const providerKeys = apiKeys.filter(k => k.provider === providerConfig.provider);
            const activeKey = providerKeys.find(k => k.is_active);

            return (
              <Card
                key={providerConfig.provider}
                className={cn(
                  'border-2 shadow-xl transition-all duration-200 hover:shadow-2xl transform hover:scale-102 overflow-hidden',
                  activeKey
                    ? 'border-green-300 dark:border-green-800 bg-gradient-to-br from-white to-green-50 dark:from-gray-900 dark:to-green-950/30'
                    : 'border-gray-300 dark:border-gray-700 bg-gradient-to-br from-white to-gray-50 dark:from-gray-900 dark:to-gray-950'
                )}
              >
                <CardContent className="p-6">
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex-1">
                      <div className="flex items-center gap-3 mb-2">
                        <div className={cn(
                          'h-10 w-10 rounded-lg flex items-center justify-center shadow-lg bg-gradient-to-br',
                          getProviderColors(providerConfig.provider)
                        )}>
                          <Key className="h-5 w-5 text-white" />
                        </div>
                        <h4 className={cn(
                          'text-xl font-bold bg-gradient-to-r bg-clip-text text-transparent',
                          getProviderColors(providerConfig.provider)
                        )}>
                          {providerConfig.name}
                        </h4>
                        {activeKey && (
                          <span className="inline-flex items-center gap-1 px-3 py-1 rounded-full bg-gradient-to-r from-green-500 to-emerald-500 text-white text-xs font-bold shadow-md">
                            <CheckCircle2 className="h-3 w-3" />
                            Đã cấu hình
                          </span>
                        )}
                      </div>
                      <p className="text-sm text-gray-600 dark:text-gray-400 mb-4 font-medium">
                        {providerConfig.description}
                      </p>

                      {activeKey ? (
                        <div className="space-y-4">
                          <div className="flex items-center gap-2 text-sm bg-white dark:bg-gray-800 p-3 rounded-xl border-2 border-gray-200 dark:border-gray-700">
                            <span className="text-gray-600 dark:text-gray-400 font-semibold">API Key:</span>
                            <code className="flex-1 px-3 py-2 rounded-lg bg-gradient-to-r from-gray-100 to-gray-200 dark:from-gray-700 dark:to-gray-800 font-mono text-xs border border-gray-300 dark:border-gray-600">
                              {showKeys[activeKey.id] ? activeKey.api_key : maskApiKey(activeKey.api_key)}
                            </code>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-8 w-8 hover:bg-gray-200 dark:hover:bg-gray-700"
                              onClick={() => setShowKeys(prev => ({
                                ...prev,
                                [activeKey.id]: !prev[activeKey.id]
                              }))}
                            >
                              {showKeys[activeKey.id] ? (
                                <EyeOff className="h-4 w-4" />
                              ) : (
                                <Eye className="h-4 w-4" />
                              )}
                            </Button>
                          </div>

                          <div className="flex items-center gap-4">
                            <div className="flex items-center gap-2 bg-white dark:bg-gray-800 px-4 py-2 rounded-xl border-2 border-gray-200 dark:border-gray-700">
                              <Switch
                                checked={activeKey.is_active}
                                onCheckedChange={(checked) =>
                                  toggleApiKey.mutate({ id: activeKey.id, is_active: checked })
                                }
                              />
                              <Label className="text-sm font-semibold cursor-pointer">Kích hoạt</Label>
                            </div>

                            <Button
                              variant="ghost"
                              size="sm"
                              className="text-red-600 hover:text-red-700 dark:text-red-400 dark:hover:text-red-300 hover:bg-red-100 dark:hover:bg-red-900/30 font-semibold"
                              onClick={() => {
                                if (confirm(`Xóa API key cho ${providerConfig.name}?`)) {
                                  deleteApiKey.mutate(activeKey.id);
                                }
                              }}
                            >
                              <Trash2 className="h-4 w-4 mr-2" />
                              Xóa
                            </Button>
                          </div>

                          {activeKey.last_used_at && (
                            <div className="flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400 bg-white dark:bg-gray-800 p-3 rounded-xl border border-gray-200 dark:border-gray-700">
                              <Zap className="h-3 w-3 text-yellow-500" />
                              <span className="font-medium">
                                Sử dụng lần cuối: {new Date(activeKey.last_used_at).toLocaleString('vi-VN')}
                              </span>
                              <span className="text-gray-400">•</span>
                              <span className="font-bold text-green-600 dark:text-green-400">
                                Tổng requests: {activeKey.total_requests}
                              </span>
                            </div>
                          )}
                        </div>
                      ) : (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => {
                            setSelectedProvider(providerConfig.provider);
                            setShowAddDialog(true);
                          }}
                          className={cn(
                            'border-2 hover:shadow-lg transform hover:scale-105 transition-all font-semibold bg-gradient-to-r text-white',
                            getProviderColors(providerConfig.provider)
                          )}
                        >
                          <Plus className="h-4 w-4 mr-2" />
                          Thêm API key
                        </Button>
                      )}
                    </div>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
