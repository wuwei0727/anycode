/**
 * 选中翻译设置组件
 * 
 * 配置翻译提供商、默认语言等设置
 */

import React, { useState, useEffect } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../ui/card';
import { Button } from '../ui/button';
import { Switch } from '../ui/switch';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { Badge } from '../ui/badge';
import { Alert, AlertDescription } from '../ui/alert';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../ui/tabs';
import { Loader2, Languages, Settings, CheckCircle, XCircle, AlertTriangle } from 'lucide-react';
import { selectionTranslationService } from '@/lib/selection-translation-service';
import type {
  SelectionTranslationSettings as SettingsType,
  TranslationProviderType,
  DeepLXConfig,
  BaiduTranslationConfig,
  TencentTranslationConfig,
} from '@/types/selection-translation';

interface SelectionTranslationSettingsProps {
  onClose?: () => void;
}

export const SelectionTranslationSettings: React.FC<SelectionTranslationSettingsProps> = ({
  onClose,
}) => {
  const [settings, setSettings] = useState<SettingsType | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState<TranslationProviderType | null>(null);
  const [testResult, setTestResult] = useState<{ type: TranslationProviderType; success: boolean; message: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [activeProviderTab, setActiveProviderTab] = useState('deeplx');

  // 加载设置
  useEffect(() => {
    loadSettings();
  }, []);

  const loadSettings = async () => {
    try {
      setLoading(true);
      setError(null);
      await selectionTranslationService.init();
      const data = await selectionTranslationService.getSettings();
      setSettings(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载设置失败');
    } finally {
      setLoading(false);
    }
  };

  // 保存设置
  const handleSave = async () => {
    if (!settings) return;

    try {
      setSaving(true);
      setError(null);
      setSuccess(null);
      await selectionTranslationService.updateSettings(settings);
      setSuccess('设置保存成功！');
      setTimeout(() => setSuccess(null), 3000);
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存设置失败');
    } finally {
      setSaving(false);
    }
  };

  // 测试提供商连接
  const handleTestProvider = async (type: TranslationProviderType) => {
    if (!settings) return;
    
    try {
      setTesting(type);
      setTestResult(null);
      
      // 获取当前编辑中的配置（而不是已保存的配置）
      const currentConfig = settings.providers.find(p => p.type === type);
      if (!currentConfig) {
        setTestResult({
          type,
          success: false,
          message: '未找到提供商配置',
        });
        return;
      }
      
      // 使用临时配置测试，这样可以测试未保存的配置
      const result = await selectionTranslationService.testProviderWithConfig(currentConfig);
      setTestResult({
        type,
        success: result.success,
        message: result.success ? `翻译成功: ${result.translatedText}` : (result.error || '测试失败'),
      });
    } catch (err) {
      setTestResult({
        type,
        success: false,
        message: err instanceof Error ? err.message : '测试失败',
      });
    } finally {
      setTesting(null);
    }
  };

  // 更新提供商配置
  const updateProviderConfig = (type: TranslationProviderType, updates: Partial<any>) => {
    if (!settings) return;

    const newProviders = settings.providers.map(p => {
      if (p.type === type) {
        return { ...p, ...updates };
      }
      return p;
    });

    setSettings({ ...settings, providers: newProviders });
  };

  // 获取提供商配置
  const getProviderConfig = <T extends DeepLXConfig | BaiduTranslationConfig | TencentTranslationConfig>(
    type: TranslationProviderType
  ): T | undefined => {
    return settings?.providers.find(p => p.type === type) as T | undefined;
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center p-8">
        <Loader2 className="h-6 w-6 animate-spin mr-2" />
        <span>加载设置中...</span>
      </div>
    );
  }

  if (!settings) {
    return (
      <Alert>
        <AlertTriangle className="h-4 w-4" />
        <AlertDescription>无法加载设置</AlertDescription>
      </Alert>
    );
  }

  const deeplxConfig = getProviderConfig<DeepLXConfig>('deeplx');
  const baiduConfig = getProviderConfig<BaiduTranslationConfig>('baidu');
  const tencentConfig = getProviderConfig<TencentTranslationConfig>('tencent');

  return (
    <div className="space-y-6 p-4 max-w-4xl mx-auto">
      {/* 头部 */}
      <div className="flex items-center justify-between">
        <div className="flex items-center space-x-2">
          <Languages className="h-6 w-6" />
          <h2 className="text-2xl font-bold">选中翻译设置</h2>
        </div>
        {onClose && (
          <Button variant="outline" onClick={onClose}>
            关闭
          </Button>
        )}
      </div>

      {/* 基本设置 */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center space-x-2">
            <Settings className="h-5 w-5" />
            <span>基本设置</span>
          </CardTitle>
          <CardDescription>
            配置选中翻译功能的基本选项
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between">
            <Label htmlFor="enabled" className="text-sm font-medium">
              启用选中翻译
            </Label>
            <Switch
              id="enabled"
              checked={settings.enabled}
              onCheckedChange={(enabled) => setSettings({ ...settings, enabled })}
            />
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>默认翻译提供商</Label>
              <Select
                value={settings.defaultProvider}
                onValueChange={(value: TranslationProviderType) =>
                  setSettings({ ...settings, defaultProvider: value })
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="deeplx">DeepLX</SelectItem>
                  <SelectItem value="baidu">百度翻译</SelectItem>
                  <SelectItem value="tencent">腾讯翻译</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label>默认目标语言</Label>
              <Select
                value={settings.defaultTargetLang}
                onValueChange={(value) =>
                  setSettings({ ...settings, defaultTargetLang: value })
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="zh">中文</SelectItem>
                  <SelectItem value="en">英文</SelectItem>
                  <SelectItem value="ja">日文</SelectItem>
                  <SelectItem value="ko">韩文</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* 提供商配置 */}
      <Card>
        <CardHeader>
          <CardTitle>翻译提供商配置</CardTitle>
          <CardDescription>
            配置各翻译服务的API密钥和参数
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Tabs value={activeProviderTab} onValueChange={setActiveProviderTab}>
            <TabsList className="grid w-full grid-cols-3">
              <TabsTrigger value="deeplx">DeepLX</TabsTrigger>
              <TabsTrigger value="baidu">百度翻译</TabsTrigger>
              <TabsTrigger value="tencent">腾讯翻译</TabsTrigger>
            </TabsList>

            {/* DeepLX 配置 */}
            <TabsContent value="deeplx" className="space-y-4">
              <div className="flex items-center justify-between">
                <Label>启用 DeepLX</Label>
                <Switch
                  checked={deeplxConfig?.enabled ?? false}
                  onCheckedChange={(enabled) =>
                    updateProviderConfig('deeplx', { enabled })
                  }
                />
              </div>
              <div className="space-y-2">
                <Label>API 端点</Label>
                <Input
                  value={deeplxConfig?.endpoint ?? ''}
                  onChange={(e) =>
                    updateProviderConfig('deeplx', { endpoint: e.target.value })
                  }
                  placeholder="https://api.deeplx.org/xxx/translate"
                />
                <p className="text-xs text-muted-foreground">
                  DeepLX 翻译API的完整URL地址
                </p>
              </div>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => handleTestProvider('deeplx')}
                  disabled={testing === 'deeplx' || !deeplxConfig?.enabled}
                >
                  {testing === 'deeplx' && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                  测试连接
                </Button>
                {testResult?.type === 'deeplx' && (
                  <Badge variant={testResult.success ? 'default' : 'destructive'}>
                    {testResult.success ? <CheckCircle className="h-3 w-3 mr-1" /> : <XCircle className="h-3 w-3 mr-1" />}
                    {testResult.success ? '成功' : '失败'}
                  </Badge>
                )}
              </div>
              {testResult?.type === 'deeplx' && (
                <p className={`text-xs ${testResult.success ? 'text-green-600' : 'text-red-600'}`}>
                  {testResult.message}
                </p>
              )}
            </TabsContent>

            {/* 百度翻译配置 */}
            <TabsContent value="baidu" className="space-y-4">
              <div className="flex items-center justify-between">
                <Label>启用百度翻译</Label>
                <Switch
                  checked={baiduConfig?.enabled ?? false}
                  onCheckedChange={(enabled) =>
                    updateProviderConfig('baidu', { enabled })
                  }
                />
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label>APP ID</Label>
                  <Input
                    value={baiduConfig?.appId ?? ''}
                    onChange={(e) =>
                      updateProviderConfig('baidu', { appId: e.target.value })
                    }
                    placeholder="请输入百度翻译APP ID"
                  />
                </div>
                <div className="space-y-2">
                  <Label>密钥</Label>
                  <Input
                    type="password"
                    value={baiduConfig?.secretKey ?? ''}
                    onChange={(e) =>
                      updateProviderConfig('baidu', { secretKey: e.target.value })
                    }
                    placeholder="请输入百度翻译密钥"
                  />
                </div>
              </div>
              <p className="text-xs text-muted-foreground">
                前往 <a href="https://fanyi-api.baidu.com/" target="_blank" className="text-blue-600 underline">百度翻译开放平台</a> 获取API密钥
              </p>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => handleTestProvider('baidu')}
                  disabled={testing === 'baidu' || !baiduConfig?.enabled}
                >
                  {testing === 'baidu' && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                  测试连接
                </Button>
                {testResult?.type === 'baidu' && (
                  <Badge variant={testResult.success ? 'default' : 'destructive'}>
                    {testResult.success ? <CheckCircle className="h-3 w-3 mr-1" /> : <XCircle className="h-3 w-3 mr-1" />}
                    {testResult.success ? '成功' : '失败'}
                  </Badge>
                )}
              </div>
              {testResult?.type === 'baidu' && (
                <p className={`text-xs ${testResult.success ? 'text-green-600' : 'text-red-600'}`}>
                  {testResult.message}
                </p>
              )}
            </TabsContent>

            {/* 腾讯翻译配置 */}
            <TabsContent value="tencent" className="space-y-4">
              <div className="flex items-center justify-between">
                <Label>启用腾讯翻译</Label>
                <Switch
                  checked={tencentConfig?.enabled ?? false}
                  onCheckedChange={(enabled) =>
                    updateProviderConfig('tencent', { enabled })
                  }
                />
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label>SecretId</Label>
                  <Input
                    value={tencentConfig?.secretId ?? ''}
                    onChange={(e) =>
                      updateProviderConfig('tencent', { secretId: e.target.value })
                    }
                    placeholder="请输入腾讯云SecretId"
                  />
                </div>
                <div className="space-y-2">
                  <Label>SecretKey</Label>
                  <Input
                    type="password"
                    value={tencentConfig?.secretKey ?? ''}
                    onChange={(e) =>
                      updateProviderConfig('tencent', { secretKey: e.target.value })
                    }
                    placeholder="请输入腾讯云SecretKey"
                  />
                </div>
              </div>
              <div className="space-y-2">
                <Label>地域</Label>
                <Select
                  value={tencentConfig?.region ?? 'ap-guangzhou'}
                  onValueChange={(value) =>
                    updateProviderConfig('tencent', { region: value })
                  }
                >
                  <SelectTrigger className="w-48">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="ap-guangzhou">广州</SelectItem>
                    <SelectItem value="ap-shanghai">上海</SelectItem>
                    <SelectItem value="ap-beijing">北京</SelectItem>
                    <SelectItem value="ap-hongkong">香港</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <p className="text-xs text-muted-foreground">
                前往 <a href="https://console.cloud.tencent.com/cam/capi" target="_blank" className="text-blue-600 underline">腾讯云控制台</a> 获取API密钥
              </p>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => handleTestProvider('tencent')}
                  disabled={testing === 'tencent' || !tencentConfig?.enabled}
                >
                  {testing === 'tencent' && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                  测试连接
                </Button>
                {testResult?.type === 'tencent' && (
                  <Badge variant={testResult.success ? 'default' : 'destructive'}>
                    {testResult.success ? <CheckCircle className="h-3 w-3 mr-1" /> : <XCircle className="h-3 w-3 mr-1" />}
                    {testResult.success ? '成功' : '失败'}
                  </Badge>
                )}
              </div>
              {testResult?.type === 'tencent' && (
                <p className={`text-xs ${testResult.success ? 'text-green-600' : 'text-red-600'}`}>
                  {testResult.message}
                </p>
              )}
            </TabsContent>
          </Tabs>
        </CardContent>
      </Card>

      {/* 保存按钮 - 带内联提示 */}
      <div className="flex items-center justify-end gap-4">
        {error && (
          <span className="text-sm text-red-600 flex items-center gap-1">
            <XCircle className="h-4 w-4" />
            {error}
          </span>
        )}
        {success && (
          <span className="text-sm text-green-600 flex items-center gap-1">
            <CheckCircle className="h-4 w-4" />
            {success}
          </span>
        )}
        <Button onClick={handleSave} disabled={saving}>
          {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          保存设置
        </Button>
      </div>

      {/* 使用说明 */}
      <Card>
        <CardHeader>
          <CardTitle>使用说明</CardTitle>
        </CardHeader>
        <CardContent>
          <ul className="text-sm text-muted-foreground space-y-2 list-disc list-inside">
            <li>在聊天界面选中任意文本，会自动显示翻译按钮</li>
            <li>点击翻译按钮即可翻译选中的文本</li>
            <li>系统会自动检测源语言，并翻译为目标语言</li>
            <li>如果源语言和目标语言相同，会自动切换翻译方向</li>
            <li>DeepLX 是免费服务，百度和腾讯需要申请API密钥</li>
          </ul>
        </CardContent>
      </Card>
    </div>
  );
};

export default SelectionTranslationSettings;
