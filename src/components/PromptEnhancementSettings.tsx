import React, { useState, useEffect } from "react";
import {
  Plus,
  Trash2,
  Edit,
  Save,
  Loader2,
  CheckCircle,
  AlertCircle,
  Sparkles
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  loadConfig,
  addProvider,
  updateProvider,
  deleteProvider,
  testAPIConnection,
  PRESET_PROVIDERS,
  detectApiFormat,
  type PromptEnhancementProvider,
} from "@/lib/promptEnhancementService";
import { getDefaultProviderId, setDefaultProviderId } from "@/lib/defaultProviderManager";
import { cn } from "@/lib/utils";
import { PromptContextConfigSettings } from "@/components/PromptContextConfigSettings";
import { AcemcpConfigSettings } from "@/components/AcemcpConfigSettings";
import { AuggieEnhancementSettings } from "@/components/AuggieEnhancementSettings";
import { Separator } from "@/components/ui/separator";
import { Star } from "lucide-react";

interface PromptEnhancementSettingsProps {
  className?: string;
}

export const PromptEnhancementSettings: React.FC<PromptEnhancementSettingsProps> = ({
  className
}) => {
  const [providers, setProviders] = useState<PromptEnhancementProvider[]>([]);
  const [editingProvider, setEditingProvider] = useState<PromptEnhancementProvider | null>(null);
  const [showDialog, setShowDialog] = useState(false);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<{ providerId: string; success: boolean; message: string } | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<{ show: boolean; provider: PromptEnhancementProvider | null }>({ show: false, provider: null });
  // 🆕 默认提供商状态
  const [defaultProvider, setDefaultProvider] = useState<string | null>(null);

  useEffect(() => {
    loadProviders();
    // 加载默认提供商
    setDefaultProvider(getDefaultProviderId());
  }, []);

  const loadProviders = () => {
    const config = loadConfig();
    setProviders(config.providers);
  };

  // 🆕 设置默认提供商
  const handleSetDefault = (providerId: string) => {
    const newDefault = providerId === defaultProvider ? null : providerId;
    setDefaultProviderId(newDefault);
    setDefaultProvider(newDefault);
  };

  const handleAdd = () => {
    setEditingProvider({
      id: Date.now().toString(),
      name: '',
      apiUrl: '',
      apiKey: '',
      model: '',
      // ⚡ 不设置默认值，让用户决定是否需要
      enabled: true,
    });
    setShowDialog(true);
  };

  const handleEdit = (provider: PromptEnhancementProvider) => {
    setEditingProvider({ ...provider });
    setShowDialog(true);
  };

  const handleSave = () => {
    if (!editingProvider || !editingProvider.name || !editingProvider.apiUrl || !editingProvider.apiKey) {
      return;
    }

    const existing = providers.find(p => p.id === editingProvider.id);
    if (existing) {
      updateProvider(editingProvider.id, editingProvider);
    } else {
      addProvider(editingProvider);
    }

    loadProviders();
    setShowDialog(false);
    setEditingProvider(null);
  };

  const handleDelete = (provider: PromptEnhancementProvider) => {
    // ⚡ 显示自定义确认对话框，而不是浏览器 confirm
    setDeleteConfirm({ show: true, provider });
  };

  const confirmDelete = () => {
    if (deleteConfirm.provider) {
      deleteProvider(deleteConfirm.provider.id);
      loadProviders();
    }
    setDeleteConfirm({ show: false, provider: null });
  };

  const cancelDelete = () => {
    setDeleteConfirm({ show: false, provider: null });
  };

  const handleTest = async (provider: PromptEnhancementProvider) => {
    setTestingId(provider.id);
    setTestResult(null);

    const result = await testAPIConnection(provider);
    setTestResult({ providerId: provider.id, ...result });
    setTestingId(null);

    setTimeout(() => setTestResult(null), 5000);
  };

  const handleToggle = (id: string, enabled: boolean) => {
    updateProvider(id, { enabled });
    loadProviders();
  };

  const handleUsePreset = (presetKey: keyof typeof PRESET_PROVIDERS) => {
    const preset = PRESET_PROVIDERS[presetKey];
    setEditingProvider({
      id: Date.now().toString(),
      name: preset.name,
      apiUrl: preset.apiUrl,
      apiKey: '',
      model: preset.model,
      enabled: true,
      apiFormat: preset.apiFormat,
      // ⚡ 不设置 temperature 和 maxTokens，让用户自己决定
    });
    setShowDialog(true);
  };

  return (
    <div className={cn("space-y-6", className)}>
      {/* 🆕 Auggie 配置 */}
      <AuggieEnhancementSettings />

      <Separator />

      {/* Acemcp 配置 */}
      <AcemcpConfigSettings />

      <Separator />

      {/* 上下文配置 */}
      <PromptContextConfigSettings />

      <Separator />

      {/* API 提供商配置 */}
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-lg font-semibold">提示词优化API配置</h3>
            <p className="text-sm text-muted-foreground">
              配置第三方AI服务用于优化提示词（OpenAI、Deepseek、通义千问等）
            </p>
          </div>
          <Button onClick={handleAdd} size="sm">
            <Plus className="h-4 w-4 mr-2" />
            添加提供商
          </Button>
        </div>

      {/* 预设模板快速添加 */}
      <Card className="p-4 bg-muted/30">
        <h4 className="text-sm font-medium mb-3">快速添加预设模板：</h4>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" onClick={() => handleUsePreset('openai')}>
            <Sparkles className="h-3 w-3 mr-1" />
            OpenAI
          </Button>
          <Button variant="outline" size="sm" onClick={() => handleUsePreset('deepseek')}>
            <Sparkles className="h-3 w-3 mr-1" />
            Deepseek
          </Button>
          <Button variant="outline" size="sm" onClick={() => handleUsePreset('qwen')}>
            <Sparkles className="h-3 w-3 mr-1" />
            通义千问
          </Button>
          <Button variant="outline" size="sm" onClick={() => handleUsePreset('siliconflow')}>
            <Sparkles className="h-3 w-3 mr-1" />
            SiliconFlow
          </Button>
          <Button variant="outline" size="sm" onClick={() => handleUsePreset('gemini')}>
            <Sparkles className="h-3 w-3 mr-1" />
            Google Gemini
          </Button>
          <Button variant="outline" size="sm" onClick={() => handleUsePreset('anthropic')}>
            <Sparkles className="h-3 w-3 mr-1" />
            Anthropic Claude
          </Button>
          <Button variant="outline" size="sm" onClick={() => handleUsePreset('auggie')}>
            <Sparkles className="h-3 w-3 mr-1" />
            Auggie (Augment)
          </Button>
        </div>
      </Card>

      {/* 提供商列表 */}
      {providers.length === 0 ? (
        <Card className="p-8 text-center border-dashed">
          <Sparkles className="h-12 w-12 mx-auto mb-4 text-muted-foreground" />
          <h4 className="font-medium mb-2">暂无配置的提供商</h4>
          <p className="text-sm text-muted-foreground mb-4">
            添加第三方AI服务以使用提示词优化功能
          </p>
          <Button onClick={handleAdd}>
            <Plus className="h-4 w-4 mr-2" />
            添加第一个提供商
          </Button>
        </Card>
      ) : (
        <div className="space-y-2">
          {providers.map((provider) => (
            <Card key={provider.id} className="p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="flex-1">
                  <div className="flex items-center gap-2 mb-1">
                    <h4 className="font-medium">{provider.name}</h4>
                    <Badge variant={provider.enabled ? "default" : "outline"} className="text-xs">
                      {provider.enabled ? "已启用" : "已禁用"}
                    </Badge>
                    {defaultProvider === provider.id && (
                      <Badge variant="secondary" className="text-xs bg-yellow-100 text-yellow-800 dark:bg-yellow-900/40 dark:text-yellow-200">
                        <Star className="h-3 w-3 mr-1 fill-current" />
                        默认
                      </Badge>
                    )}
                  </div>
                  <div className="text-sm text-muted-foreground space-y-1">
                    <div>模型: {provider.model}</div>
                    <div className="truncate">API: {provider.apiUrl}</div>
                    <div className="flex items-center gap-2">
                      <span>格式: {
                        provider.apiFormat
                          ? (provider.apiFormat === 'gemini' ? 'Gemini' :
                             provider.apiFormat === 'anthropic' ? 'Anthropic' : 'OpenAI')
                          : `自动 (${
                              detectApiFormat(provider.apiUrl) === 'gemini' ? 'Gemini' :
                              detectApiFormat(provider.apiUrl) === 'anthropic' ? 'Anthropic' : 'OpenAI'
                            })`
                      }</span>
                      {provider.temperature !== undefined && <span>| 温度: {provider.temperature}</span>}
                      {provider.maxTokens !== undefined && <span>| Token: {provider.maxTokens}</span>}
                    </div>
                  </div>
                </div>
                
                <div className="flex items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => handleTest(provider)}
                    disabled={testingId === provider.id}
                  >
                    {testingId === provider.id ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : (
                      "测试"
                    )}
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => handleToggle(provider.id, !provider.enabled)}
                  >
                    {provider.enabled ? "禁用" : "启用"}
                  </Button>
                  {/* 🆕 设为默认按钮 */}
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => handleSetDefault(provider.id)}
                    disabled={!provider.enabled}
                    title={defaultProvider === provider.id ? "取消默认" : "设为默认"}
                  >
                    <Star className={cn(
                      "h-3 w-3",
                      defaultProvider === provider.id ? "fill-yellow-500 text-yellow-500" : ""
                    )} />
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => handleEdit(provider)}
                  >
                    <Edit className="h-3 w-3" />
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => handleDelete(provider)}
                  >
                    <Trash2 className="h-3 w-3" />
                  </Button>
                </div>
              </div>
              
              {/* 测试结果 */}
              {testResult && testResult.providerId === provider.id && testingId === null && (
                <div className={cn(
                  "mt-3 p-2 rounded-md text-sm flex items-center gap-2",
                  testResult.success ? "bg-green-50 text-green-700" : "bg-red-50 text-red-700"
                )}>
                  {testResult.success ? (
                    <CheckCircle className="h-4 w-4" />
                  ) : (
                    <AlertCircle className="h-4 w-4" />
                  )}
                  {testResult.message}
                </div>
              )}
            </Card>
          ))}
        </div>
      )}
      </div>

      {/* 编辑对话框 */}
      <Dialog open={showDialog} onOpenChange={setShowDialog}>
        <DialogContent className="sm:max-w-[500px]">
          <DialogHeader>
            <DialogTitle>
              {editingProvider && providers.find(p => p.id === editingProvider.id) ? '编辑提供商' : '添加提供商'}
            </DialogTitle>
          </DialogHeader>

          {editingProvider && (
            <div className="space-y-4">
              <div>
                <Label>提供商名称</Label>
                <Input
                  value={editingProvider.name}
                  onChange={(e) => setEditingProvider({ ...editingProvider, name: e.target.value })}
                  placeholder="例如: OpenAI GPT-4"
                />
              </div>

              <div>
                <Label>API 地址</Label>
                <Input
                  value={editingProvider.apiUrl}
                  onChange={(e) => setEditingProvider({ ...editingProvider, apiUrl: e.target.value })}
                  placeholder="例如: https://api.openai.com 或 http://localhost:3001"
                />
                <p className="text-xs text-muted-foreground mt-1">
                  支持简化输入，系统会自动补全 /v1/chat/completions 等端点路径
                </p>
              </div>

              <div>
                <Label>API Key</Label>
                <Input
                  type="password"
                  value={editingProvider.apiKey}
                  onChange={(e) => setEditingProvider({ ...editingProvider, apiKey: e.target.value })}
                  placeholder="sk-..."
                />
              </div>

              <div>
                <Label>模型名称</Label>
                <Input
                  value={editingProvider.model}
                  onChange={(e) => setEditingProvider({ ...editingProvider, model: e.target.value })}
                  placeholder="gpt-4o"
                />
              </div>

              <div>
                <Label>API 格式</Label>
                <Select
                  value={editingProvider.apiFormat || 'auto'}
                  onValueChange={(value) => setEditingProvider({
                    ...editingProvider,
                    apiFormat: value === 'auto' ? undefined : value as 'openai' | 'gemini' | 'anthropic'
                  })}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="auto">
                      自动检测 {editingProvider.apiUrl ? `(${
                        detectApiFormat(editingProvider.apiUrl) === 'gemini' ? 'Gemini' :
                        detectApiFormat(editingProvider.apiUrl) === 'anthropic' ? 'Anthropic' : 'OpenAI'
                      })` : ''}
                    </SelectItem>
                    <SelectItem value="openai">OpenAI 格式 (/v1/chat/completions)</SelectItem>
                    <SelectItem value="anthropic">Anthropic 格式 (/v1/messages)</SelectItem>
                    <SelectItem value="gemini">Google Gemini 格式</SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground mt-1">
                  系统会根据 URL 自动识别 API 格式，也可手动指定
                </p>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <Label>温度 (可选，0-2)</Label>
                  <Input
                    type="number"
                    min="0"
                    max="2"
                    step="0.1"
                    value={editingProvider.temperature || ''}
                    onChange={(e) => setEditingProvider({ 
                      ...editingProvider, 
                      temperature: e.target.value ? parseFloat(e.target.value) : undefined 
                    })}
                    placeholder="留空使用API默认值"
                  />
                </div>
                <div>
                  <Label>最大 Tokens (可选)</Label>
                  <Input
                    type="number"
                    value={editingProvider.maxTokens || ''}
                    onChange={(e) => setEditingProvider({ 
                      ...editingProvider, 
                      maxTokens: e.target.value ? parseInt(e.target.value) : undefined 
                    })}
                    placeholder="留空使用API默认值"
                  />
                </div>
              </div>
            </div>
          )}

          <DialogFooter>
            <Button variant="outline" onClick={() => {
              setShowDialog(false);
              setEditingProvider(null);
            }}>
              取消
            </Button>
            <Button onClick={handleSave}>
              <Save className="h-4 w-4 mr-2" />
              保存
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 删除确认对话框 */}
      <Dialog open={deleteConfirm.show} onOpenChange={(open) => !open && cancelDelete()}>
        <DialogContent className="sm:max-w-[400px]">
          <DialogHeader>
            <DialogTitle>确认删除</DialogTitle>
          </DialogHeader>

          <div className="py-4">
            <p className="text-sm text-muted-foreground">
              确定要删除提供商 <span className="font-medium text-foreground">{deleteConfirm.provider?.name}</span> 吗？
            </p>
            <p className="text-sm text-muted-foreground mt-2">
              此操作无法撤销。
            </p>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={cancelDelete}>
              取消
            </Button>
            <Button variant="destructive" onClick={confirmDelete}>
              <Trash2 className="h-4 w-4 mr-2" />
              确认删除
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};

