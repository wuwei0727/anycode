import { useEffect, useMemo, useState } from 'react';
import CodeMirror from '@uiw/react-codemirror';
import { StreamLanguage } from '@codemirror/language';
import { toml } from '@codemirror/legacy-modes/mode/toml';
import { json } from '@codemirror/lang-json';
import { vscodeDark } from '@uiw/codemirror-theme-vscode';

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Toast } from '@/components/ui/toast';
import { cn } from '@/lib/utils';
import { type CodexConfigFileProvider } from '@/lib/api';
import { Eye, EyeOff, FileCode, Loader2, Save, Sparkles, X } from 'lucide-react';
import {
  extractBaseUrlFromConfig,
  extractApiKeyFromAuth,
  extractModelFromConfig,
  setBaseUrlInConfig,
  setModelInConfig,
} from '@/config/codexProviderPresets';

type CodexProviderFormData = {
  name: string;
  description?: string;
  configToml: string;
  authJson: string;
  setAsCurrent: boolean;
};

const AUTH_KEY_CANDIDATES = ['OPENAI_API_KEY', 'OPENAI_KEY', 'API_KEY'] as const;

function safeParseAuthJson(text: string): Record<string, any> | null {
  const trimmed = text.trim();
  if (!trimmed) return {};
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    return {};
  } catch {
    return null;
  }
}

function extractApiKeyFromAuthText(authJsonText: string): string {
  const parsed = safeParseAuthJson(authJsonText);
  if (!parsed) return '';
  return extractApiKeyFromAuth(parsed);
}

function setApiKeyInAuthText(authJsonText: string, apiKey: string): string {
  const parsed = safeParseAuthJson(authJsonText);
  const next: Record<string, any> = parsed ? { ...parsed } : {};
  const trimmedKey = apiKey.trim();

  let targetKey: string = AUTH_KEY_CANDIDATES[0];
  for (const key of AUTH_KEY_CANDIDATES) {
    if (Object.prototype.hasOwnProperty.call(next, key)) {
      targetKey = key;
      break;
    }
  }

  if (trimmedKey) {
    next[targetKey] = apiKey;
  } else {
    for (const key of AUTH_KEY_CANDIDATES) {
      if (Object.prototype.hasOwnProperty.call(next, key)) {
        delete next[key];
      }
    }
  }

  return JSON.stringify(next, null, 2);
}

interface CodexProviderFormProps {
  initialData?: CodexConfigFileProvider;
  initialConfigToml: string;
  initialAuthJson: string;
  onSubmit: (formData: CodexProviderFormData) => Promise<void>;
  onCancel: () => void;
}

export default function CodexProviderForm({
  initialData,
  initialConfigToml,
  initialAuthJson,
  onSubmit,
  onCancel,
}: CodexProviderFormProps) {
  const [name, setName] = useState('');
  const [model, setModel] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [description, setDescription] = useState('');
  const [configToml, setConfigToml] = useState('');
  const [authJson, setAuthJson] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [showApiKey, setShowApiKey] = useState(false);
  const [activeTab, setActiveTab] = useState<'config' | 'auth'>('config');
  const [setAsCurrent, setSetAsCurrent] = useState(true);

  const [saving, setSaving] = useState(false);
  const [toastMessage, setToastMessage] = useState<{ message: string; type: 'success' | 'error' } | null>(null);

  const isEditing = !!initialData;

  useEffect(() => {
    if (initialData) {
      const initialConfigText = initialData.configToml || '';
      const initialAuthText = initialData.authJson?.trim() ? initialData.authJson : (initialAuthJson || '');
      setName(initialData.name || '');
      setModel(extractModelFromConfig(initialConfigText));
      setBaseUrl(extractBaseUrlFromConfig(initialConfigText));
      setDescription(initialData.description || '');
      setConfigToml(initialConfigText);
      setAuthJson(initialAuthText);
      setApiKey(extractApiKeyFromAuthText(initialAuthText));
      setSetAsCurrent(true);
      return;
    }

    const initialConfigText = initialConfigToml || '';
    const initialAuthText = initialAuthJson || '';
    setName('');
    setModel(extractModelFromConfig(initialConfigText));
    setBaseUrl(extractBaseUrlFromConfig(initialConfigText));
    setDescription('');
    setConfigToml(initialConfigText);
    setAuthJson(initialAuthText);
    setApiKey(extractApiKeyFromAuthText(initialAuthText));
    setSetAsCurrent(true);
  }, [initialData, initialConfigToml, initialAuthJson]);

  const tomlExtensions = useMemo(() => [StreamLanguage.define(toml)], []);
  const jsonExtensions = useMemo(() => [json()], []);

  const validate = (): string | null => {
    if (!name.trim()) return '请输入代理商名称';
    if (!baseUrl.trim()) return '请输入 API 地址';
    return null;
  };

  const handleFormatAuth = () => {
    try {
      const parsed = JSON.parse(authJson || '{}');
      setAuthJson(JSON.stringify(parsed, null, 2));
      setApiKey(extractApiKeyFromAuth(parsed));
      setToastMessage({ message: '已格式化 auth.json', type: 'success' });
    } catch (error) {
      console.error('Failed to format auth.json:', error);
      setToastMessage({ message: 'auth.json 格式不正确，无法格式化', type: 'error' });
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    const err = validate();
    if (err) {
      setToastMessage({ message: err, type: 'error' });
      return;
    }

    try {
      setSaving(true);
      setToastMessage(null);
      await onSubmit({
        name: name.trim(),
        description: description.trim() || undefined,
        configToml,
        authJson,
        setAsCurrent,
      });
    } catch (error) {
      console.error('Failed to save Codex config preset:', error);
      setToastMessage({ message: '保存失败', type: 'error' });
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <Card className="p-4 space-y-4">
        <div className="space-y-2 pb-3 border-b">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <label className="flex items-center gap-2 text-sm text-muted-foreground">
              <Checkbox checked={setAsCurrent} onCheckedChange={(v) => setSetAsCurrent(!!v)} disabled={saving} />
              设为当前配置
            </label>

            <div className="flex justify-end gap-3">
              <Button type="button" variant="outline" onClick={onCancel} disabled={saving} className="whitespace-nowrap">
                <X className="h-4 w-4 mr-2" aria-hidden="true" />
                取消
              </Button>
              <Button
                type="submit"
                disabled={saving}
                className={cn("transition-all duration-200 whitespace-nowrap", saving && "scale-95 opacity-80")}
              >
                {saving ? (
                  <>
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" aria-hidden="true" />
                    {isEditing ? '更新中...' : '添加中...'}
                  </>
                ) : (
                  <>
                    <Save className="h-4 w-4 mr-2" aria-hidden="true" />
                    {isEditing ? '更新配置' : '添加配置'}
                  </>
                )}
              </Button>
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            上方输入会同步到下方文件内容；点击“添加/更新”保存到代理商列表，勾选“设为当前配置”会写入 ~/.codex/config.toml 和 ~/.codex/auth.json。
          </p>
        </div>

        <div className="grid gap-4 md:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="codex-provider-name">代理商名称 *</Label>
            <Input
              id="codex-provider-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="例如：公司内网 / 代理A"
              disabled={saving}
              required
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="codex-provider-model">模型</Label>
            <Input
              id="codex-provider-model"
              value={model}
              onChange={(e) => {
                const nextModel = e.target.value;
                setModel(nextModel);
                setConfigToml((prev) => setModelInConfig(prev, nextModel));
              }}
              placeholder="可选，例如：gpt-5-codex"
              disabled={saving}
            />
          </div>
        </div>

        <div className="space-y-2">
          <Label htmlFor="codex-provider-base-url">API 地址 *</Label>
          <Input
            id="codex-provider-base-url"
            value={baseUrl}
            onChange={(e) => {
              const nextUrl = e.target.value;
              setBaseUrl(nextUrl);
              setConfigToml((prev) => setBaseUrlInConfig(prev, nextUrl));
            }}
            placeholder="例如：https://your-api-endpoint.com/v1"
            disabled={saving}
            required
            className="font-mono"
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="codex-provider-api-key">API Key</Label>
          <div className="relative">
            <Input
              id="codex-provider-api-key"
              type={showApiKey ? "text" : "password"}
              value={apiKey}
              onChange={(e) => {
                const nextKey = e.target.value;
                setApiKey(nextKey);
                setAuthJson((prev) => setApiKeyInAuthText(prev, nextKey));
              }}
              placeholder="sk-..."
              disabled={saving}
              className="font-mono pr-10"
            />
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="absolute right-1 top-1 h-8 w-8 p-0"
              onClick={() => setShowApiKey(!showApiKey)}
              disabled={saving}
            >
              {showApiKey ? (
                <EyeOff className="h-3 w-3" aria-hidden="true" />
              ) : (
                <Eye className="h-3 w-3" aria-hidden="true" />
              )}
            </Button>
          </div>
        </div>

        <div className="space-y-2">
          <Label htmlFor="codex-provider-desc">备注</Label>
          <Input
            id="codex-provider-desc"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="可选，例如：用于办公室网络"
            disabled={saving}
          />
        </div>

        <div className="space-y-2 pt-2 border-t">
          <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as 'config' | 'auth')} className="w-full">
            <TabsList className="w-full">
              <TabsTrigger value="config">config.toml</TabsTrigger>
              <TabsTrigger value="auth">auth.json</TabsTrigger>
            </TabsList>

            <TabsContent value="config" className="mt-3">
              <Label className="flex items-center gap-2">
                <FileCode className="h-4 w-4" aria-hidden="true" />
                config.toml
                <span className="text-xs text-muted-foreground">(将写入 ~/.codex/config.toml)</span>
              </Label>
              <div
                className={cn(
                  "mt-2 rounded-md border overflow-hidden max-w-full",
                  "[&_.cm-editor]:max-w-full [&_.cm-editor]:w-full",
                  "[&_.cm-scroller]:overflow-auto",
                  saving && "opacity-80"
                )}
              >
                <CodeMirror
                  value={configToml}
                  height="60vh"
                  theme={vscodeDark}
                  extensions={tomlExtensions}
                  editable={!saving}
                  basicSetup={{
                    lineNumbers: true,
                    foldGutter: true,
                    highlightActiveLine: true,
                    highlightActiveLineGutter: true,
                  }}
                  onChange={(value) => {
                    setConfigToml(value);
                    setBaseUrl(extractBaseUrlFromConfig(value));
                    setModel(extractModelFromConfig(value));
                  }}
                />
              </div>
            </TabsContent>

            <TabsContent value="auth" className="mt-3">
              <div className="flex items-center justify-between gap-3">
                <Label className="flex items-center gap-2">
                  <FileCode className="h-4 w-4" aria-hidden="true" />
                  auth.json
                  <span className="text-xs text-muted-foreground">(将写入 ~/.codex/auth.json)</span>
                </Label>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={handleFormatAuth}
                  disabled={saving}
                  className="text-xs"
                >
                  <Sparkles className="h-3 w-3 mr-1" aria-hidden="true" />
                  格式化
                </Button>
              </div>
              <div
                className={cn(
                  "mt-2 rounded-md border overflow-hidden max-w-full",
                  "[&_.cm-editor]:max-w-full [&_.cm-editor]:w-full",
                  "[&_.cm-scroller]:overflow-auto",
                  saving && "opacity-80"
                )}
              >
                <CodeMirror
                  value={authJson}
                  height="60vh"
                  theme={vscodeDark}
                  extensions={jsonExtensions}
                  editable={!saving}
                  basicSetup={{
                    lineNumbers: true,
                    foldGutter: true,
                    highlightActiveLine: true,
                    highlightActiveLineGutter: true,
                  }}
                  onChange={(value) => {
                    setAuthJson(value);
                    const parsed = safeParseAuthJson(value);
                    if (parsed) {
                      setApiKey(extractApiKeyFromAuth(parsed));
                    }
                  }}
                />
              </div>
            </TabsContent>
          </Tabs>

        </div>
      </Card>

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
    </form>
  );
}
