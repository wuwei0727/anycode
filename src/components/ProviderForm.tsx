import { useEffect, useMemo, useState } from 'react';
import CodeMirror from '@uiw/react-codemirror';
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
import { type ClaudeSettingsFileProvider } from '@/lib/api';
import { FileCode, Loader2, Save, Sparkles, X } from 'lucide-react';

type ClaudeProviderFormData = {
  name: string;
  description?: string;
  settingsJson: string;
  claudeJson: string;
  setAsCurrent: boolean;
};

function safeParseJson(text: string): any | null {
  try {
    return JSON.parse(text || '{}');
  } catch {
    return null;
  }
}

function extractEnvValue(settingsJson: string, key: string): string {
  const parsed = safeParseJson(settingsJson);
  const env = parsed?.env;
  if (!env || typeof env !== 'object' || Array.isArray(env)) return '';
  return typeof env[key] === 'string' ? env[key] : String(env[key] ?? '');
}

function setEnvValue(settingsJson: string, key: string, value: string): string {
  const parsed = safeParseJson(settingsJson);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return settingsJson;

  const next: Record<string, any> = { ...parsed };
  const currentEnv = next.env;
  const env: Record<string, any> =
    currentEnv && typeof currentEnv === 'object' && !Array.isArray(currentEnv) ? { ...currentEnv } : {};

  if (value.trim()) {
    env[key] = value;
  } else {
    delete env[key];
  }
  next.env = env;

  return JSON.stringify(next, null, 2);
}

interface ProviderFormProps {
  initialData?: ClaudeSettingsFileProvider;
  initialSettingsJson: string;
  initialClaudeJson: string;
  onSubmit: (formData: ClaudeProviderFormData) => Promise<void>;
  onCancel: () => void;
}

export default function ProviderForm({
  initialData,
  initialSettingsJson,
  initialClaudeJson,
  onSubmit,
  onCancel,
}: ProviderFormProps) {
  const [name, setName] = useState('');
  const [model, setModel] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [description, setDescription] = useState('');
  const [settingsJson, setSettingsJson] = useState('');
  const [claudeJson, setClaudeJson] = useState('');
  const [activeTab, setActiveTab] = useState<'settings' | 'claudeJson'>('settings');
  const [setAsCurrent, setSetAsCurrent] = useState(true);

  const [saving, setSaving] = useState(false);
  const [toastMessage, setToastMessage] = useState<{ message: string; type: 'success' | 'error' } | null>(null);

  const isEditing = !!initialData;

  useEffect(() => {
    if (initialData) {
      const initialSettingsText = initialData.settingsJson || '';
      setName(initialData.name || '');
      setBaseUrl(extractEnvValue(initialSettingsText, 'ANTHROPIC_BASE_URL') || 'https://api.anthropic.com');
      setModel(extractEnvValue(initialSettingsText, 'ANTHROPIC_MODEL'));
      setDescription(initialData.description || '');
      setSettingsJson(initialSettingsText);
      setClaudeJson(initialData.claudeJson?.trim() ? initialData.claudeJson : (initialClaudeJson || ''));
      setSetAsCurrent(true);
      return;
    }

    const initialSettingsText = initialSettingsJson || '';
    setName('');
    setBaseUrl(extractEnvValue(initialSettingsText, 'ANTHROPIC_BASE_URL') || 'https://api.anthropic.com');
    setModel(extractEnvValue(initialSettingsText, 'ANTHROPIC_MODEL'));
    setDescription('');
    setSettingsJson(initialSettingsText);
    setClaudeJson(initialClaudeJson || '');
    setSetAsCurrent(true);
  }, [initialData, initialSettingsJson, initialClaudeJson]);

  const jsonExtensions = useMemo(() => [json()], []);

  const validate = (): string | null => {
    if (!name.trim()) return '请输入代理商名称';
    if (!baseUrl.trim()) return '请输入 API 地址';
    return null;
  };

  const handleFormat = () => {
    try {
      if (activeTab === 'settings') {
        const parsed = JSON.parse(settingsJson || '{}');
        const formatted = JSON.stringify(parsed, null, 2);
        setSettingsJson(formatted);
        setBaseUrl(extractEnvValue(formatted, 'ANTHROPIC_BASE_URL') || 'https://api.anthropic.com');
        setModel(extractEnvValue(formatted, 'ANTHROPIC_MODEL'));
        setToastMessage({ message: '已格式化 settings.json', type: 'success' });
        return;
      }

      const parsed = JSON.parse(claudeJson || '{}');
      setClaudeJson(JSON.stringify(parsed, null, 2));
      setToastMessage({ message: '已格式化 .claude.json', type: 'success' });
    } catch (error) {
      console.error('Failed to format JSON:', error);
      setToastMessage({ message: 'JSON 格式不正确，无法格式化', type: 'error' });
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
        settingsJson,
        claudeJson,
        setAsCurrent,
      });
    } catch (error) {
      console.error('Failed to save Claude settings preset:', error);
      setToastMessage({ message: '保存失败', type: 'error' });
    } finally {
      setSaving(false);
    }
  };

  return (
	    <form onSubmit={handleSubmit} className="space-y-4">
	      <Card className="p-4 space-y-4">
	        <div className="grid gap-4 md:grid-cols-2">
	          <div className="space-y-2">
	            <Label htmlFor="claude-provider-name">代理商名称 *</Label>
	            <Input
	              id="claude-provider-name"
	              value={name}
	              onChange={(e) => setName(e.target.value)}
	              placeholder="例如：家庭网络 / 代理B"
	              disabled={saving}
	              required
	            />
	          </div>

	          <div className="space-y-2">
	            <Label htmlFor="claude-provider-model">模型</Label>
	            <Input
	              id="claude-provider-model"
	              value={model}
	              onChange={(e) => {
	                const nextModel = e.target.value;
	                setModel(nextModel);
	                setSettingsJson((prev) => setEnvValue(prev, 'ANTHROPIC_MODEL', nextModel));
	              }}
	              placeholder="可选，例如：claude-3-5-sonnet-latest"
	              disabled={saving}
	            />
	          </div>
	        </div>

	        <div className="space-y-2">
	          <Label htmlFor="claude-provider-base-url">API 地址 *</Label>
	          <Input
	            id="claude-provider-base-url"
	            value={baseUrl}
	            onChange={(e) => {
	              const nextUrl = e.target.value;
	              setBaseUrl(nextUrl);
	              setSettingsJson((prev) => setEnvValue(prev, 'ANTHROPIC_BASE_URL', nextUrl));
	            }}
	            placeholder="例如：https://your-anthropic-proxy.com"
	            disabled={saving}
	            required
	            className="font-mono"
	          />
	        </div>

	        <div className="space-y-2">
	          <Label htmlFor="claude-provider-desc">备注</Label>
	          <Input
	            id="claude-provider-desc"
	            value={description}
	            onChange={(e) => setDescription(e.target.value)}
	            placeholder="可选，例如：适用于移动热点"
	            disabled={saving}
	          />
	        </div>

        <div className="space-y-2 pt-2 border-t">
          <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as 'settings' | 'claudeJson')} className="w-full">
            <TabsList className="w-full">
              <TabsTrigger value="settings">settings.json</TabsTrigger>
              <TabsTrigger value="claudeJson">.claude.json</TabsTrigger>
            </TabsList>

            <TabsContent value="settings" className="mt-3">
              <div className="flex items-center justify-between gap-3">
                <Label className="flex items-center gap-2">
                  <FileCode className="h-4 w-4" aria-hidden="true" />
                  settings.json
                  <span className="text-xs text-muted-foreground">(将写入 ~/.claude/settings.json)</span>
                </Label>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={handleFormat}
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
                  value={settingsJson}
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
                    setSettingsJson(value);
                    setBaseUrl(extractEnvValue(value, 'ANTHROPIC_BASE_URL') || 'https://api.anthropic.com');
                    setModel(extractEnvValue(value, 'ANTHROPIC_MODEL'));
                  }}
                />
              </div>
            </TabsContent>

            <TabsContent value="claudeJson" className="mt-3">
              <div className="flex items-center justify-between gap-3">
                <Label className="flex items-center gap-2">
                  <FileCode className="h-4 w-4" aria-hidden="true" />
                  .claude.json
                  <span className="text-xs text-muted-foreground">(将写入 ~/.claude.json)</span>
                </Label>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={handleFormat}
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
                  value={claudeJson}
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
                  onChange={(value) => setClaudeJson(value)}
                />
              </div>
            </TabsContent>
          </Tabs>

          <p className="text-xs text-muted-foreground">
            点击“添加/更新”后会保存到代理商列表；勾选“设为当前配置”时会写入 ~/.claude/settings.json 和 ~/.claude.json。
          </p>
        </div>
      </Card>

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
