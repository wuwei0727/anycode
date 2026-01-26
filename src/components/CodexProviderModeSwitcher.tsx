import { useState, useEffect } from 'react';
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Building2,
  Users,
  Terminal,
  RefreshCw,
  Check,
  AlertCircle,
  Key,
  Settings2,
  ArrowRight,
  Shield,
  Zap,
} from 'lucide-react';
import { api, type CodexProviderMode } from '@/lib/api';
import { Toast } from '@/components/ui/toast';

interface CodexProviderModeSwitcherProps {
  onModeChanged?: () => void;
}

export default function CodexProviderModeSwitcher({ onModeChanged }: CodexProviderModeSwitcherProps) {
  const [modeStatus, setModeStatus] = useState<CodexProviderMode | null>(null);
  const [loading, setLoading] = useState(true);
  const [switching, setSwitching] = useState(false);
  const [showThirdPartyDialog, setShowThirdPartyDialog] = useState(false);
  const [showOfficialDialog, setShowOfficialDialog] = useState(false);
  const [toastMessage, setToastMessage] = useState<{ message: string; type: 'success' | 'error' } | null>(null);

  // Third-party form state
  const [apiKey, setApiKey] = useState('');
  const [modelProvider, setModelProvider] = useState('hotaruapi');
  const [model, setModel] = useState('gpt-5.2');
  const [reasoningEffort, setReasoningEffort] = useState('xhigh');

  useEffect(() => {
    loadModeStatus();
  }, []);

  const loadModeStatus = async () => {
    try {
      setLoading(true);
      const status = await api.getCodexProviderMode();
      setModeStatus(status);
      
      // Pre-fill form with current values if available
      if (status?.currentProvider) setModelProvider(status.currentProvider);
      if (status?.currentModel) setModel(status.currentModel);
    } catch (error) {
      console.error('Failed to load mode status:', error);
      // Set default mode status on error
      setModeStatus({
        mode: 'unknown',
        hasOfficialTokens: false,
        hasThirdPartyBackup: false,
      });
    } finally {
      setLoading(false);
    }
  };

  const handleSwitchToOfficial = async () => {
    try {
      setSwitching(true);
      const message = await api.switchToOfficialMode();
      setToastMessage({ message, type: 'success' });
      setShowOfficialDialog(false);
      await loadModeStatus();
      onModeChanged?.();
    } catch (error) {
      console.error('Failed to switch to official mode:', error);
      setToastMessage({ message: '切换到官方模式失败', type: 'error' });
    } finally {
      setSwitching(false);
    }
  };

  const handleOpenTerminal = async () => {
    try {
      const message = await api.openCodexAuthTerminal();
      setToastMessage({ message, type: 'success' });
    } catch (error) {
      console.error('Failed to open terminal:', error);
      setToastMessage({ message: '打开终端失败，请手动运行 codex auth login', type: 'error' });
    }
  };

  const handleSwitchToThirdParty = async () => {
    if (!apiKey.trim() && !modeStatus?.hasThirdPartyBackup) {
      setToastMessage({ message: '请输入 API Key 或确保有备份可用', type: 'error' });
      return;
    }

    try {
      setSwitching(true);
      const message = await api.switchToThirdPartyMode(
        apiKey.trim() || undefined,
        modelProvider || undefined,
        model || undefined,
        reasoningEffort || undefined
      );
      setToastMessage({ message, type: 'success' });
      setShowThirdPartyDialog(false);
      setApiKey(''); // Clear sensitive data
      await loadModeStatus();
      onModeChanged?.();
    } catch (error) {
      console.error('Failed to switch to third-party mode:', error);
      setToastMessage({ message: '切换到第三方模式失败', type: 'error' });
    } finally {
      setSwitching(false);
    }
  };

  const handleRefreshStatus = async () => {
    await loadModeStatus();
    const isAuthenticated = await api.checkCodexAuthStatus();
    if (isAuthenticated) {
      setToastMessage({ message: '认证状态有效', type: 'success' });
    } else {
      setToastMessage({ message: '未检测到有效认证', type: 'error' });
    }
  };

  if (loading) {
    return (
      <Card className="p-6">
        <div className="flex items-center justify-center">
          <RefreshCw className="h-5 w-5 animate-spin text-muted-foreground mr-2" />
          <span className="text-sm text-muted-foreground">加载模式状态...</span>
        </div>
      </Card>
    );
  }

  const isOfficial = modeStatus?.mode === 'official';
  const isThirdParty = modeStatus?.mode === 'third_party';

  return (
    <>
      <Card className="p-6">
        <div className="space-y-6">
          {/* Header */}
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <Settings2 className="h-5 w-5 text-primary" />
              <div>
                <h3 className="font-semibold">服务商模式切换</h3>
                <p className="text-xs text-muted-foreground">
                  在官方 OpenAI 和第三方 API 代理之间切换
                </p>
              </div>
            </div>
            <Button variant="ghost" size="sm" onClick={handleRefreshStatus}>
              <RefreshCw className="h-4 w-4" />
            </Button>
          </div>

          {/* Current Status */}
          <div className="flex items-center gap-2 p-3 bg-muted/50 rounded-lg">
            <span className="text-sm font-medium">当前模式：</span>
            {isOfficial && (
              <Badge variant="default" className="bg-blue-600">
                <Building2 className="h-3 w-3 mr-1" />
                官方 OpenAI
              </Badge>
            )}
            {isThirdParty && (
              <Badge variant="secondary" className="bg-green-600 text-white">
                <Users className="h-3 w-3 mr-1" />
                第三方代理
              </Badge>
            )}
            {!isOfficial && !isThirdParty && (
              <Badge variant="outline">
                <AlertCircle className="h-3 w-3 mr-1" />
                未知
              </Badge>
            )}
            {isThirdParty && modeStatus?.currentProvider && (
              <span className="text-xs text-muted-foreground ml-2">
                ({modeStatus.currentProvider} / {modeStatus.currentModel})
              </span>
            )}
          </div>

          {/* Mode Cards */}
          <div className="grid grid-cols-2 gap-4">
            {/* Official Mode Card */}
            <Card 
              className={`p-4 cursor-pointer transition-all hover:shadow-md ${
                isOfficial ? 'ring-2 ring-blue-500 bg-blue-50/50 dark:bg-blue-950/20' : ''
              }`}
              onClick={() => !isOfficial && setShowOfficialDialog(true)}
            >
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Building2 className="h-5 w-5 text-blue-600" />
                    <span className="font-medium">官方 OpenAI</span>
                  </div>
                  {isOfficial && <Check className="h-4 w-4 text-blue-600" />}
                </div>
                <p className="text-xs text-muted-foreground">
                  使用官方 OpenAI OAuth 登录，需要在终端完成认证
                </p>
                <div className="flex items-center gap-1 text-xs">
                  <Shield className="h-3 w-3 text-blue-500" />
                  <span className="text-blue-600">官方认证</span>
                </div>
                {modeStatus?.hasOfficialTokens && !isOfficial && (
                  <Badge variant="outline" className="text-xs">
                    有备份可用
                  </Badge>
                )}
              </div>
            </Card>

            {/* Third-Party Mode Card */}
            <Card 
              className={`p-4 cursor-pointer transition-all hover:shadow-md ${
                isThirdParty ? 'ring-2 ring-green-500 bg-green-50/50 dark:bg-green-950/20' : ''
              }`}
              onClick={() => !isThirdParty && setShowThirdPartyDialog(true)}
            >
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Users className="h-5 w-5 text-green-600" />
                    <span className="font-medium">第三方代理</span>
                  </div>
                  {isThirdParty && <Check className="h-4 w-4 text-green-600" />}
                </div>
                <p className="text-xs text-muted-foreground">
                  使用第三方 API 代理，需要配置 API Key 和端点
                </p>
                <div className="flex items-center gap-1 text-xs">
                  <Zap className="h-3 w-3 text-green-500" />
                  <span className="text-green-600">灵活配置</span>
                </div>
                {modeStatus?.hasThirdPartyBackup && !isThirdParty && (
                  <Badge variant="outline" className="text-xs">
                    有备份可用
                  </Badge>
                )}
              </div>
            </Card>
          </div>

          {/* Current Config Info */}
          {isThirdParty && modeStatus?.currentApiKeyMasked && (
            <div className="p-3 bg-muted/30 rounded-lg space-y-2">
              <div className="flex items-center gap-2 text-sm">
                <Key className="h-4 w-4 text-muted-foreground" />
                <span className="font-medium">API Key:</span>
                <code className="text-xs bg-muted px-2 py-1 rounded">
                  {modeStatus.currentApiKeyMasked}
                </code>
              </div>
            </div>
          )}
        </div>
      </Card>

      {/* Official Mode Dialog */}
      <Dialog open={showOfficialDialog} onOpenChange={setShowOfficialDialog}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Building2 className="h-5 w-5 text-blue-600" />
              切换到官方模式
            </DialogTitle>
            <DialogDescription>
              切换到官方 OpenAI 服务需要通过终端完成 OAuth 认证
            </DialogDescription>
          </DialogHeader>
          
          <div className="space-y-4 py-4">
            <div className="p-4 bg-amber-50 dark:bg-amber-950/30 rounded-lg border border-amber-200 dark:border-amber-800">
              <div className="flex items-start gap-3">
                <AlertCircle className="h-5 w-5 text-amber-600 mt-0.5" />
                <div className="space-y-1">
                  <p className="text-sm font-medium text-amber-800 dark:text-amber-200">
                    操作说明
                  </p>
                  <ul className="text-xs text-amber-700 dark:text-amber-300 space-y-1">
                    <li>1. 当前第三方配置将被备份</li>
                    <li>2. 第三方 config.toml 配置将被注释</li>
                    <li>3. 需要在终端运行 <code className="bg-amber-100 dark:bg-amber-900 px-1 rounded">codex auth login</code></li>
                  </ul>
                </div>
              </div>
            </div>

            {modeStatus?.hasOfficialTokens && (
              <div className="p-3 bg-green-50 dark:bg-green-950/30 rounded-lg border border-green-200 dark:border-green-800">
                <div className="flex items-center gap-2">
                  <Check className="h-4 w-4 text-green-600" />
                  <span className="text-sm text-green-700 dark:text-green-300">
                    检测到官方认证备份，将自动恢复
                  </span>
                </div>
              </div>
            )}
          </div>

          <DialogFooter className="flex-col sm:flex-row gap-2">
            <Button
              variant="outline"
              onClick={() => setShowOfficialDialog(false)}
              disabled={switching}
            >
              取消
            </Button>
            <Button
              variant="outline"
              onClick={handleOpenTerminal}
              disabled={switching}
            >
              <Terminal className="h-4 w-4 mr-2" />
              打开终端登录
            </Button>
            <Button
              onClick={handleSwitchToOfficial}
              disabled={switching}
              className="bg-blue-600 hover:bg-blue-700"
            >
              {switching ? (
                <RefreshCw className="h-4 w-4 mr-2 animate-spin" />
              ) : (
                <ArrowRight className="h-4 w-4 mr-2" />
              )}
              确认切换
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Third-Party Mode Dialog */}
      <Dialog open={showThirdPartyDialog} onOpenChange={setShowThirdPartyDialog}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Users className="h-5 w-5 text-green-600" />
              切换到第三方代理
            </DialogTitle>
            <DialogDescription>
              配置第三方 API 代理服务
            </DialogDescription>
          </DialogHeader>
          
          <div className="space-y-4 py-4">
            {modeStatus?.hasThirdPartyBackup && (
              <div className="p-3 bg-green-50 dark:bg-green-950/30 rounded-lg border border-green-200 dark:border-green-800">
                <div className="flex items-center gap-2">
                  <Check className="h-4 w-4 text-green-600" />
                  <span className="text-sm text-green-700 dark:text-green-300">
                    检测到第三方配置备份，可不填 API Key 直接恢复
                  </span>
                </div>
              </div>
            )}

            <div className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="apiKey">API Key</Label>
                <Input
                  id="apiKey"
                  type="password"
                  placeholder={modeStatus?.hasThirdPartyBackup ? "留空使用备份配置" : "输入 API Key"}
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                />
                <p className="text-xs text-muted-foreground">
                  将写入 ~/.codex/auth.json
                </p>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="modelProvider">服务商标识</Label>
                  <Input
                    id="modelProvider"
                    placeholder="例如: hotaruapi"
                    value={modelProvider}
                    onChange={(e) => setModelProvider(e.target.value)}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="model">模型名称</Label>
                  <Input
                    id="model"
                    placeholder="例如: gpt-5.2"
                    value={model}
                    onChange={(e) => setModel(e.target.value)}
                  />
                </div>
              </div>

              <div className="space-y-2">
                <Label htmlFor="reasoningEffort">推理强度</Label>
                <Input
                  id="reasoningEffort"
                  placeholder="例如: xhigh"
                  value={reasoningEffort}
                  onChange={(e) => setReasoningEffort(e.target.value)}
                />
                <p className="text-xs text-muted-foreground">
                  配置将写入 ~/.codex/config.toml
                </p>
              </div>
            </div>

            <div className="p-3 bg-muted/50 rounded-lg">
              <p className="text-xs font-medium mb-2">配置预览 (config.toml):</p>
              <pre className="text-xs text-muted-foreground bg-muted p-2 rounded overflow-x-auto">
{`model_provider = "${modelProvider}"
model = "${model}"
model_reasoning_effort = "${reasoningEffort}"`}
              </pre>
            </div>
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setShowThirdPartyDialog(false)}
              disabled={switching}
            >
              取消
            </Button>
            <Button
              onClick={handleSwitchToThirdParty}
              disabled={switching}
              className="bg-green-600 hover:bg-green-700"
            >
              {switching ? (
                <RefreshCw className="h-4 w-4 mr-2 animate-spin" />
              ) : (
                <ArrowRight className="h-4 w-4 mr-2" />
              )}
              确认切换
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Toast */}
      {toastMessage && (
        <div className="fixed bottom-0 left-0 right-0 z-50 flex justify-center p-4 pointer-events-none">
          <div className="pointer-events-auto">
            <Toast
              message={toastMessage.message}
              type={toastMessage.type}
              onDismiss={() => setToastMessage(null)}
            />
          </div>
        </div>
      )}
    </>
  );
}
