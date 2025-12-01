import { useState } from 'react';
import { Key, Plus, Trash2, Eye, EyeOff, ExternalLink, AlertCircle, CheckCircle2 } from 'lucide-react';
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

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <h3 className="text-lg font-semibold">Cấu hình API Keys</h3>
          <p className="text-sm text-muted-foreground mt-1">
            Thêm API keys để sử dụng các AI providers khác nhau
          </p>
        </div>
        <Dialog open={showAddDialog} onOpenChange={setShowAddDialog}>
          <DialogTrigger asChild>
            <Button>
              <Plus className="h-4 w-4 mr-2" />
              Thêm API Key
            </Button>
          </DialogTrigger>
          <DialogContent className="max-w-2xl">
            <DialogHeader>
              <DialogTitle>Thêm API Key mới</DialogTitle>
              <DialogDescription>
                Chọn AI provider và nhập API key để bắt đầu sử dụng
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4 mt-4">
              <div className="space-y-2">
                <Label>Provider</Label>
                <Select value={selectedProvider} onValueChange={(v) => setSelectedProvider(v as AIProvider)}>
                  <SelectTrigger>
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
                <Alert>
                  <AlertCircle className="h-4 w-4" />
                  <AlertDescription className="space-y-2">
                    <div>
                      <strong>Format:</strong> {selectedProviderConfig.keyExample}
                    </div>
                    <div className="flex items-center gap-2">
                      <strong>Lấy API key:</strong>
                      <a
                        href={selectedProviderConfig.docsUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-primary hover:underline inline-flex items-center gap-1"
                      >
                        {selectedProviderConfig.name} Dashboard
                        <ExternalLink className="h-3 w-3" />
                      </a>
                    </div>
                    <div className="mt-2">
                      <strong>Models có sẵn:</strong>
                      <ul className="list-disc list-inside text-sm mt-1">
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
                <Label htmlFor="api-key">API Key</Label>
                <Input
                  id="api-key"
                  type="password"
                  placeholder={`Nhập ${selectedProviderConfig?.name} API key...`}
                  value={apiKeyInput}
                  onChange={(e) => setApiKeyInput(e.target.value)}
                />
              </div>

              <div className="flex justify-end gap-2">
                <Button variant="outline" onClick={() => setShowAddDialog(false)}>
                  Hủy
                </Button>
                <Button
                  onClick={handleSaveKey}
                  disabled={!apiKeyInput.trim() || saveApiKey.isPending}
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

      {/* API Keys List */}
      {isLoading ? (
        <div className="flex items-center justify-center py-12">
          <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
        </div>
      ) : !apiKeys || apiKeys.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-12">
            <Key className="h-16 w-16 text-muted-foreground mb-4" />
            <h3 className="text-lg font-semibold mb-2">Chưa có API key nào</h3>
            <p className="text-sm text-muted-foreground text-center mb-4 max-w-md">
              Thêm API key để bắt đầu sử dụng AI Assistant với các provider khác nhau
            </p>
            <Button onClick={() => setShowAddDialog(true)}>
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
              <Card key={providerConfig.provider}>
                <CardContent className="p-6">
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex-1">
                      <div className="flex items-center gap-3 mb-2">
                        <h4 className="text-lg font-semibold">{providerConfig.name}</h4>
                        {activeKey && (
                          <span className="inline-flex items-center gap-1 px-2 py-1 rounded-md bg-green-500/10 text-green-600 text-xs">
                            <CheckCircle2 className="h-3 w-3" />
                            Đã cấu hình
                          </span>
                        )}
                      </div>
                      <p className="text-sm text-muted-foreground mb-3">
                        {providerConfig.description}
                      </p>

                      {activeKey ? (
                        <div className="space-y-3">
                          <div className="flex items-center gap-2 text-sm">
                            <span className="text-muted-foreground">API Key:</span>
                            <code className="px-2 py-1 rounded bg-muted font-mono text-xs">
                              {showKeys[activeKey.id] ? activeKey.api_key : maskApiKey(activeKey.api_key)}
                            </code>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-6 w-6"
                              onClick={() => setShowKeys(prev => ({
                                ...prev,
                                [activeKey.id]: !prev[activeKey.id]
                              }))}
                            >
                              {showKeys[activeKey.id] ? (
                                <EyeOff className="h-3 w-3" />
                              ) : (
                                <Eye className="h-3 w-3" />
                              )}
                            </Button>
                          </div>

                          <div className="flex items-center gap-4">
                            <div className="flex items-center gap-2">
                              <Switch
                                checked={activeKey.is_active}
                                onCheckedChange={(checked) =>
                                  toggleApiKey.mutate({ id: activeKey.id, is_active: checked })
                                }
                              />
                              <Label className="text-sm">Kích hoạt</Label>
                            </div>

                            <Button
                              variant="ghost"
                              size="sm"
                              className="text-destructive hover:text-destructive"
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
                            <p className="text-xs text-muted-foreground">
                              Sử dụng lần cuối: {new Date(activeKey.last_used_at).toLocaleString('vi-VN')}
                              {' • '}
                              Tổng requests: {activeKey.total_requests}
                            </p>
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
