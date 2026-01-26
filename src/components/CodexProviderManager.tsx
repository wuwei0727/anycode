import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import CodeMirror from '@uiw/react-codemirror';
import { StreamLanguage } from '@codemirror/language';
import { toml } from '@codemirror/legacy-modes/mode/toml';
import { json } from '@codemirror/lang-json';
import { vscodeDark } from '@uiw/codemirror-theme-vscode';
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import { SortableContext, arrayMove, useSortable, rectSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { Toast } from '@/components/ui/toast';
import CodexProviderForm from './CodexProviderForm';
import { api, type CodexConfigFileProvider } from '@/lib/api';
import { cn } from '@/lib/utils';
import { Check, Copy, Edit, Eye, FileCode, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { extractBaseUrlFromConfig, extractModelFromConfig } from '@/config/codexProviderPresets';

interface CodexProviderManagerProps {
  onBack?: () => void;
}

type CodexProviderFormData = {
  name: string;
  description?: string;
  configToml: string;
  authJson: string;
  setAsCurrent: boolean;
};

function sortJsonValue(value: any): any {
  if (Array.isArray(value)) return value.map(sortJsonValue);
  if (value && typeof value === 'object') {
    return Object.keys(value)
      .sort()
      .reduce<Record<string, any>>((acc, key) => {
        acc[key] = sortJsonValue(value[key]);
        return acc;
      }, {});
  }
  return value;
}

function normalizeJsonText(text: string): string {
  try {
    const parsed = JSON.parse(text || '{}');
    return JSON.stringify(sortJsonValue(parsed));
  } catch {
    return (text || '').trim();
  }
}

const CODEX_VENDOR_ORDER_STORAGE_KEY = 'vendors:order:codex';
const CODEX_VENDOR_CURRENT_STORAGE_KEY = 'vendors:current:codex';

function toProviderId(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

function readStoredOrder(storageKey: string): string[] {
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((v): v is string => typeof v === 'string');
  } catch {
    return [];
  }
}

function writeStoredOrder(storageKey: string, ids: string[]) {
  try {
    localStorage.setItem(storageKey, JSON.stringify(ids));
  } catch {
    // ignore storage failures (e.g. private mode)
  }
}

function readStoredCurrentId(storageKey: string): string | null {
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return typeof parsed === 'string' ? parsed : null;
  } catch {
    return null;
  }
}

function writeStoredCurrentId(storageKey: string, id: string | null) {
  try {
    if (id) {
      localStorage.setItem(storageKey, JSON.stringify(id));
    } else {
      localStorage.removeItem(storageKey);
    }
  } catch {
    // ignore storage failures (e.g. private mode)
  }
}

function applyOrder<T extends { id: string }>(items: T[], order: string[]): T[] {
  const index = new Map(order.map((id, i) => [id, i]));
  return [...items].sort((a, b) => {
    const ai = index.get(a.id);
    const bi = index.get(b.id);
    if (ai == null && bi == null) return 0;
    if (ai == null) return 1;
    if (bi == null) return -1;
    return ai - bi;
  });
}

const CARD_ICON_BUTTON_CLASS =
  "h-9 w-9 sm:h-10 sm:w-10 rounded-2xl border border-zinc-200 bg-white shadow-sm hover:bg-zinc-50";
const CURRENT_BADGE_CLASS =
  "rounded-full bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200 px-3 py-1 text-xs font-semibold";

type SortableCodexProviderCardProps = {
  provider: CodexConfigFileProvider;
  current: boolean;
  switchingId: string | null;
  deletingId: string | null;
  onPreview: (provider: CodexConfigFileProvider) => void;
  onEdit: (provider: CodexConfigFileProvider) => void;
  onCopy: (provider: CodexConfigFileProvider) => void;
  onDelete: (provider: CodexConfigFileProvider) => void;
  onApply: (provider: CodexConfigFileProvider) => void;
};

function SortableCodexProviderCard({
  provider,
  current,
  switchingId,
  deletingId,
  onPreview,
  onEdit,
  onCopy,
  onDelete,
  onApply,
}: SortableCodexProviderCardProps) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useSortable({
    id: provider.id,
    animateLayoutChanges: () => false,
  });

  const style: CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition: undefined,
  };

  const baseUrl = extractBaseUrlFromConfig(provider.configToml || '');
  const model = extractModelFromConfig(provider.configToml || '');

  return (
    <Card
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
      className={cn(
        "rounded-3xl border border-zinc-200 bg-white shadow-sm px-4 py-4 sm:px-5",
        isDragging && "opacity-40"
      )}
    >
      <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
        <div className="min-w-0">
          <div className="flex items-center gap-3 min-w-0">
            <h3 className="text-base font-semibold truncate">{provider.name}</h3>
            {current && <span className={CURRENT_BADGE_CLASS}>当前</span>}
          </div>
          {provider.description && <p className="mt-1 text-xs text-zinc-600">{provider.description}</p>}
          <div className="mt-2 space-y-1 text-xs text-zinc-600">
            {baseUrl && (
              <p className="break-all">
                <span className="font-semibold text-zinc-800">API地址：</span>{' '}
                <span className="font-mono">{baseUrl}</span>
              </p>
            )}
            {model && (
              <p>
                <span className="font-semibold text-zinc-800">模型：</span>{' '}
                <span className="font-mono">{model}</span>
              </p>
            )}
          </div>
        </div>

        <div
          className="w-full xl:w-auto shrink-0 flex flex-col gap-3"
          onPointerDown={(event) => event.stopPropagation()}
        >
          <div className="-mx-1 px-1 overflow-x-auto">
            <div className="flex items-center justify-end gap-2 flex-nowrap whitespace-nowrap">
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    variant="outline"
                    size="icon-lg"
                    onClick={() => onPreview(provider)}
                    className={cn(CARD_ICON_BUTTON_CLASS)}
                    aria-label="查看"
                  >
                    <Eye className="h-5 w-5" aria-hidden="true" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>查看</TooltipContent>
              </Tooltip>

              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    variant="outline"
                    size="icon-lg"
                    onClick={() => onEdit(provider)}
                    className={cn(CARD_ICON_BUTTON_CLASS)}
                    aria-label="编辑"
                  >
                    <Edit className="h-5 w-5" aria-hidden="true" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>编辑</TooltipContent>
              </Tooltip>

              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    variant="outline"
                    size="icon-lg"
                    onClick={() => onCopy(provider)}
                    className={cn(CARD_ICON_BUTTON_CLASS)}
                    aria-label="复制 JSON"
                  >
                    <Copy className="h-5 w-5" aria-hidden="true" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>复制 JSON</TooltipContent>
              </Tooltip>

              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    variant="outline"
                    size="icon-lg"
                    onClick={() => onDelete(provider)}
                    disabled={deletingId === provider.id}
                    className={cn(CARD_ICON_BUTTON_CLASS, "text-red-500")}
                    aria-label="删除"
                  >
                    {deletingId === provider.id ? (
                      <RefreshCw className="h-5 w-5 animate-spin" aria-hidden="true" />
                    ) : (
                      <Trash2 className="h-5 w-5" aria-hidden="true" />
                    )}
                  </Button>
                </TooltipTrigger>
                <TooltipContent>删除</TooltipContent>
              </Tooltip>
            </div>
          </div>

          <Button
            type="button"
            variant="outline"
            onClick={() => onApply(provider)}
            disabled={switchingId === provider.id || current}
            className={cn(
              "h-auto rounded-2xl border border-zinc-200 bg-white px-3 py-2 text-sm font-semibold shadow-sm inline-flex items-center justify-center gap-2 whitespace-nowrap hover:bg-zinc-50 w-full lg:w-auto",
              current && "text-zinc-500"
            )}
          >
            {switchingId === provider.id ? (
              <RefreshCw className="h-4 w-4 animate-spin" aria-hidden="true" />
            ) : (
              <Check className="h-4 w-4" aria-hidden="true" />
            )}
            {current ? '已选择' : '切换到此配置'}
          </Button>
        </div>
      </div>
    </Card>
  );
}

export default function CodexProviderManager(_props: CodexProviderManagerProps) {
  const [providers, setProviders] = useState<CodexConfigFileProvider[]>([]);
  const [currentConfigToml, setCurrentConfigToml] = useState<string>('');
  const [currentAuthJson, setCurrentAuthJson] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [currentProviderId, setCurrentProviderId] = useState<string | null>(null);
  const [activeDragId, setActiveDragId] = useState<string | null>(null);

  const [showCurrentConfig, setShowCurrentConfig] = useState(false);
  const [currentConfigTab, setCurrentConfigTab] = useState<'config' | 'auth'>('config');
  const [showForm, setShowForm] = useState(false);
  const [formInitialConfig, setFormInitialConfig] = useState<string>('');
  const [formInitialAuth, setFormInitialAuth] = useState<string>('');
  const [editingProvider, setEditingProvider] = useState<CodexConfigFileProvider | null>(null);

  const [previewProvider, setPreviewProvider] = useState<CodexConfigFileProvider | null>(null);
  const [previewTab, setPreviewTab] = useState<'config' | 'auth'>('config');
  const [switching, setSwitching] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);

  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [providerToDelete, setProviderToDelete] = useState<CodexConfigFileProvider | null>(null);

  const [toastMessage, setToastMessage] = useState<{ message: string; type: 'success' | 'error' } | null>(null);

  const tomlExtensions = useMemo(() => [StreamLanguage.define(toml)], []);
  const jsonExtensions = useMemo(() => [json()], []);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 0 } }));

  const handleDragStart = (event: DragStartEvent) => {
    setActiveDragId(String(event.active.id));
  };

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    setActiveDragId(null);
    if (!over || active.id === over.id) return;

    setProviders((items) => {
      const oldIndex = items.findIndex((item) => item.id === active.id);
      const newIndex = items.findIndex((item) => item.id === over.id);
      if (oldIndex < 0 || newIndex < 0) return items;
      const next = arrayMove(items, oldIndex, newIndex);
      writeStoredOrder(CODEX_VENDOR_ORDER_STORAGE_KEY, next.map((p) => p.id));
      return next;
    });
  };

  const handleDragCancel = () => {
    setActiveDragId(null);
  };

  const loadData = async () => {
    try {
      setLoading(true);
      const [list, currentToml, currentAuth] = await Promise.all([
        api.getCodexConfigFileProviders(),
        api.readCodexConfigToml(),
        api.readCodexAuthJsonText(),
      ]);
      const storedOrder = readStoredOrder(CODEX_VENDOR_ORDER_STORAGE_KEY);
      const orderedList = applyOrder(list, storedOrder);
      setProviders(orderedList);
      writeStoredOrder(CODEX_VENDOR_ORDER_STORAGE_KEY, orderedList.map((p) => p.id));
      setCurrentConfigToml(currentToml);
      setCurrentAuthJson(currentAuth);
      const storedCurrentId = readStoredCurrentId(CODEX_VENDOR_CURRENT_STORAGE_KEY);
      const storedCurrent = storedCurrentId ? orderedList.find((p) => p.id === storedCurrentId) : null;
      let resolvedCurrentId: string | null = null;
      if (storedCurrent && doesProviderMatchCurrent(storedCurrent, currentToml, currentAuth)) {
        resolvedCurrentId = storedCurrent.id;
      } else {
        const matched = orderedList.find((p) => doesProviderMatchCurrent(p, currentToml, currentAuth));
        resolvedCurrentId = matched?.id ?? null;
      }
      setCurrentProviderId(resolvedCurrentId);
      writeStoredCurrentId(CODEX_VENDOR_CURRENT_STORAGE_KEY, resolvedCurrentId);
    } catch (error) {
      console.error('Failed to load Codex config providers:', error);
      setToastMessage({ message: '加载 Codex 代理商失败', type: 'error' });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, []);

  const doesProviderMatchCurrent = (
    provider: CodexConfigFileProvider,
    configToml: string,
    authJson: string
  ) => {
    const configMatches = (configToml || '').trim() === (provider.configToml || '').trim();
    const providerAuth = (provider.authJson || '').trim();
    const authMatches = providerAuth ? normalizeJsonText(authJson) === normalizeJsonText(provider.authJson) : true;
    return configMatches && authMatches;
  };

  const isCurrentProvider = (provider: CodexConfigFileProvider) =>
    currentProviderId ? provider.id === currentProviderId : false;

  const handleAddProvider = async () => {
    try {
      setEditingProvider(null);
      const [currentToml, currentAuth] = await Promise.all([
        api.readCodexConfigToml(),
        api.readCodexAuthJsonText(),
      ]);
      setFormInitialConfig(currentToml);
      setFormInitialAuth(currentAuth);
      setShowForm(true);
    } catch (error) {
      console.error('Failed to read current config.toml:', error);
      setToastMessage({ message: '读取当前 Codex 配置失败', type: 'error' });
    }
  };

  const handleEditProvider = (provider: CodexConfigFileProvider) => {
    setEditingProvider(provider);
    setFormInitialConfig(provider.configToml);
    setFormInitialAuth(provider.authJson?.trim() ? provider.authJson : currentAuthJson);
    setShowForm(true);
  };

  const copyToClipboard = async (text: string, successMessage: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setToastMessage({ message: successMessage, type: 'success' });
    } catch (error) {
      console.error('Failed to copy:', error);
      setToastMessage({ message: '复制失败', type: 'error' });
    }
  };

  const getEffectiveAuthJson = (provider: CodexConfigFileProvider) =>
    provider.authJson?.trim() ? provider.authJson : currentAuthJson;

  const getVendorJson = (provider: CodexConfigFileProvider) => ({
    id: provider.id,
    name: provider.name,
    desc: provider.description,
    apiBase: extractBaseUrlFromConfig(provider.configToml || ''),
    model: extractModelFromConfig(provider.configToml || ''),
    current: isCurrentProvider(provider),
    files: {
      a: provider.configToml || '',
      b: getEffectiveAuthJson(provider) || '',
    },
  });

  const handleCopyVendor = async (provider: CodexConfigFileProvider) => {
    await copyToClipboard(JSON.stringify(getVendorJson(provider), null, 2), '已复制 JSON');
  };

  const handleFormSubmit = async (data: CodexProviderFormData) => {
    try {
      if (data.setAsCurrent) {
        // Write both config.toml and auth.json first so validation happens before persisting the preset.
        await api.writeCodexConfigFiles(data.configToml, data.authJson);
      }

      if (editingProvider) {
        const updated: CodexConfigFileProvider = {
          ...editingProvider,
          name: data.name,
          description: data.description,
          configToml: data.configToml,
          authJson: data.authJson,
        };
        await api.updateCodexConfigFileProvider(updated);
        if (data.setAsCurrent) {
          setCurrentProviderId(updated.id);
          writeStoredCurrentId(CODEX_VENDOR_CURRENT_STORAGE_KEY, updated.id);
        }
        setToastMessage({
          message: data.setAsCurrent
            ? '已更新并写入 ~/.codex/config.toml 和 ~/.codex/auth.json'
            : '已更新代理商（未写入本地文件）',
          type: 'success',
        });
      } else {
        await api.addCodexConfigFileProvider({
          name: data.name,
          description: data.description,
          configToml: data.configToml,
          authJson: data.authJson,
        });
        if (data.setAsCurrent) {
          const nextId = toProviderId(data.name);
          setCurrentProviderId(nextId);
          writeStoredCurrentId(CODEX_VENDOR_CURRENT_STORAGE_KEY, nextId);
        }
        setToastMessage({
          message: data.setAsCurrent
            ? '已添加并写入 ~/.codex/config.toml 和 ~/.codex/auth.json'
            : '已添加代理商（未写入本地文件）',
          type: 'success',
        });
      }

      setShowForm(false);
      setEditingProvider(null);
      await loadData();
    } catch (error) {
      console.error('Failed to save provider:', error);
      setToastMessage({ message: '保存失败：config.toml 或 auth.json 格式不正确', type: 'error' });
    }
  };

  const handleApplyProvider = async (provider: CodexConfigFileProvider) => {
    try {
      setSwitching(provider.id);
      const message = await api.writeCodexConfigFiles(provider.configToml, getEffectiveAuthJson(provider));
      setToastMessage({ message, type: 'success' });
      setCurrentProviderId(provider.id);
      writeStoredCurrentId(CODEX_VENDOR_CURRENT_STORAGE_KEY, provider.id);
      await loadData();
    } catch (error) {
      console.error('Failed to apply provider:', error);
      setToastMessage({ message: '切换失败：config.toml 或 auth.json 格式不正确', type: 'error' });
    } finally {
      setSwitching(null);
    }
  };

  const handleDeleteProvider = (provider: CodexConfigFileProvider) => {
    setProviderToDelete(provider);
    setDeleteDialogOpen(true);
  };

  const confirmDeleteProvider = async () => {
    if (!providerToDelete) return;
    const wasCurrent = isCurrentProvider(providerToDelete);
    try {
      setDeleting(providerToDelete.id);
      await api.deleteCodexConfigFileProvider(providerToDelete.id);
      setToastMessage({ message: '代理商已删除', type: 'success' });
      setDeleteDialogOpen(false);
      setProviderToDelete(null);
      if (wasCurrent) {
        const remaining = await api.getCodexConfigFileProviders();
        if (remaining.length > 0) {
          await handleApplyProvider(remaining[0]);
          return;
        }
        setCurrentProviderId(null);
        writeStoredCurrentId(CODEX_VENDOR_CURRENT_STORAGE_KEY, null);
      }
      await loadData();
    } catch (error) {
      console.error('Failed to delete provider:', error);
      setToastMessage({ message: '删除失败', type: 'error' });
    } finally {
      setDeleting(null);
    }
  };

  const cancelDeleteProvider = () => {
    setDeleteDialogOpen(false);
    setProviderToDelete(null);
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <div className="text-center">
          <RefreshCw className="h-8 w-8 animate-spin text-muted-foreground mx-auto mb-4" />
          <p className="text-sm text-muted-foreground">正在加载代理商配置...</p>
        </div>
      </div>
    );
  }

  const currentProvider = currentProviderId
    ? providers.find((provider) => provider.id === currentProviderId) ?? null
    : null;
  const currentBaseUrl = extractBaseUrlFromConfig(currentConfigToml || '');
  const currentModel = extractModelFromConfig(currentConfigToml || '');
  const activeProvider = activeDragId ? providers.find((provider) => provider.id === activeDragId) : null;

  return (
    <TooltipProvider>
      <div className="space-y-6">
        {/* Header */}
        <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div className="min-w-0">
            <h1 className="text-3xl sm:text-4xl font-extrabold tracking-tight">Codex 代理商管理</h1>
            <p className="text-base sm:text-lg text-zinc-700 mt-2">
              将写入 <span className="font-mono">~/.codex/config.toml</span> +{" "}
              <span className="font-mono">~/.codex/auth.json</span>
            </p>
          </div>

          <div className="flex w-full flex-col gap-3 sm:flex-row lg:w-auto">
            <Button
              type="button"
              variant="outline"
              onClick={handleAddProvider}
              className="h-auto rounded-2xl border border-zinc-200 bg-white px-5 py-3 font-semibold shadow-sm hover:bg-zinc-50 inline-flex items-center gap-2 whitespace-nowrap"
            >
              <Plus className="h-5 w-5" aria-hidden="true" />
              添加代理商
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                setCurrentConfigTab('config');
                setShowCurrentConfig(true);
              }}
              className="h-auto rounded-2xl border border-zinc-200 bg-white px-5 py-3 font-semibold shadow-sm hover:bg-zinc-50 inline-flex items-center gap-2 whitespace-nowrap"
            >
              <Eye className="h-5 w-5" aria-hidden="true" />
              查看当前配置
            </Button>
          </div>
        </div>

        {/* List */}
        <div className="rounded-[32px] border border-zinc-200 bg-white shadow-sm p-4 sm:p-6">
          {providers.length === 0 ? (
            <div className="flex items-center justify-center py-14">
              <div className="text-center">
                <FileCode className="h-12 w-12 text-zinc-400 mx-auto mb-4" />
                <h3 className="text-lg font-semibold mb-2 text-zinc-900">暂无代理商配置</h3>
                <p className="text-sm text-zinc-600 mb-6">
                  点击“添加代理商”，可基于当前 <span className="font-mono">config.toml</span> /{" "}
                  <span className="font-mono">auth.json</span> 创建新配置。
                </p>
                <Button
                  type="button"
                  variant="outline"
                  onClick={handleAddProvider}
                  className="h-auto rounded-2xl border border-zinc-200 bg-white px-5 py-3 font-semibold shadow-sm hover:bg-zinc-50 inline-flex items-center gap-2 whitespace-nowrap"
                >
                  <Plus className="h-5 w-5" aria-hidden="true" />
                  添加第一个代理商
                </Button>
              </div>
            </div>
          ) : (
            <DndContext
              sensors={sensors}
              collisionDetection={closestCenter}
              onDragStart={handleDragStart}
              onDragEnd={handleDragEnd}
              onDragCancel={handleDragCancel}
            >
              <SortableContext items={providers.map((p) => p.id)} strategy={rectSortingStrategy}>
                <div className="grid gap-4 sm:gap-5 xl:grid-cols-3 2xl:grid-cols-5">
                  {providers.map((provider) => (
                    <SortableCodexProviderCard
                      key={provider.id}
                      provider={provider}
                      current={isCurrentProvider(provider)}
                      switchingId={switching}
                      deletingId={deleting}
                      onPreview={(p) => {
                        setPreviewTab('config');
                        setPreviewProvider(p);
                      }}
                      onEdit={handleEditProvider}
                      onCopy={handleCopyVendor}
                      onDelete={handleDeleteProvider}
                      onApply={handleApplyProvider}
                    />
                  ))}
                </div>
              </SortableContext>
              <DragOverlay dropAnimation={null}>
                {activeProvider ? (
                  <Card className="rounded-3xl border border-zinc-200 bg-white shadow-lg px-4 py-4 sm:px-5">
                    <div className="min-w-0">
                      <div className="flex items-center gap-3 min-w-0">
                        <h3 className="text-base font-semibold truncate">{activeProvider.name}</h3>
                        {isCurrentProvider(activeProvider) && <span className={CURRENT_BADGE_CLASS}>当前</span>}
                      </div>
                      {activeProvider.description && (
                        <p className="mt-1 text-xs text-zinc-600">{activeProvider.description}</p>
                      )}
                      <div className="mt-2 space-y-1 text-xs text-zinc-600">
                        {extractBaseUrlFromConfig(activeProvider.configToml || '') && (
                          <p className="break-all">
                            <span className="font-semibold text-zinc-800">API地址：</span>{' '}
                            <span className="font-mono">
                              {extractBaseUrlFromConfig(activeProvider.configToml || '')}
                            </span>
                          </p>
                        )}
                        {extractModelFromConfig(activeProvider.configToml || '') && (
                          <p>
                            <span className="font-semibold text-zinc-800">模型：</span>{' '}
                            <span className="font-mono">
                              {extractModelFromConfig(activeProvider.configToml || '')}
                            </span>
                          </p>
                        )}
                      </div>
                    </div>
                  </Card>
                ) : null}
              </DragOverlay>
            </DndContext>
          )}
        </div>

      {/* Current Config Dialog */}
      <Dialog open={showCurrentConfig} onOpenChange={setShowCurrentConfig}>
        <DialogContent className="w-[92vw] max-w-[1000px] max-h-[92vh] p-0 overflow-hidden flex flex-col sm:rounded-2xl">
          <DialogHeader className="px-6 pt-6 pb-4 border-b">
            <DialogTitle>当前 Codex 配置</DialogTitle>
            <DialogDescription>
              展示当前写入到 <span className="font-mono">~/.codex/config.toml</span> 与{' '}
              <span className="font-mono">~/.codex/auth.json</span> 的内容（只读）。
            </DialogDescription>
          </DialogHeader>
          <div className="flex-1 min-h-0 p-6 pt-4 flex flex-col gap-4 overflow-hidden">
            <div className="rounded-xl border border-zinc-200 bg-zinc-50 p-4">
              <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                <div className="min-w-0 space-y-2 text-sm text-zinc-700">
                  <div className="flex items-center gap-2">
                    <p className="font-semibold text-zinc-900">当前代理商</p>
                    {currentProvider ? (
                      <span className="rounded-full bg-white text-zinc-900 ring-1 ring-zinc-200 px-3 py-1 text-xs font-semibold">
                        {currentProvider.name}
                      </span>
                    ) : (
                      <span className="rounded-full bg-white text-zinc-600 ring-1 ring-zinc-200 px-3 py-1 text-xs font-semibold">
                        未匹配到预设
                      </span>
                    )}
                  </div>
                  {currentModel && (
                    <p>
                      <span className="font-semibold text-zinc-900">模型：</span>{' '}
                      <span className="font-mono">{currentModel}</span>
                    </p>
                  )}
                  {currentBaseUrl && (
                    <p className="break-all">
                      <span className="font-semibold text-zinc-900">API地址：</span>{' '}
                      <span className="font-mono">{currentBaseUrl}</span>
                    </p>
                  )}
                  {currentProvider?.description && (
                    <p className="break-words">
                      <span className="font-semibold text-zinc-900">备注：</span> {currentProvider.description}
                    </p>
                  )}
                </div>

                <div className="flex flex-wrap items-center justify-end gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => copyToClipboard(currentConfigToml || '', '已复制 config.toml')}
                    className="h-auto rounded-2xl border border-zinc-200 bg-white px-4 py-3 font-semibold shadow-sm hover:bg-zinc-50 whitespace-nowrap"
                  >
                    <Copy className="h-4 w-4" aria-hidden="true" />
                    复制 config.toml
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => copyToClipboard(currentAuthJson || '', '已复制 auth.json')}
                    className="h-auto rounded-2xl border border-zinc-200 bg-white px-4 py-3 font-semibold shadow-sm hover:bg-zinc-50 whitespace-nowrap"
                  >
                    <Copy className="h-4 w-4" aria-hidden="true" />
                    复制 auth.json
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() =>
                      copyToClipboard(
                        JSON.stringify(
                          {
                            provider: 'codex',
                            selectedVendorId: currentProvider?.id ?? null,
                            files: {
                              a: {
                                filename: 'config.toml',
                                pathHint: '~/.codex/config.toml',
                                content: currentConfigToml || '',
                              },
                              b: {
                                filename: 'auth.json',
                                pathHint: '~/.codex/auth.json',
                                content: currentAuthJson || '',
                              },
                            },
                          },
                          null,
                          2
                        ),
                        '已复制 JSON'
                      )
                    }
                    className="h-auto rounded-2xl border border-zinc-200 bg-white px-4 py-3 font-semibold shadow-sm hover:bg-zinc-50 whitespace-nowrap"
                  >
                    <Copy className="h-4 w-4" aria-hidden="true" />
                    复制 JSON
                  </Button>
                </div>
              </div>
            </div>

            <Tabs
              value={currentConfigTab}
              onValueChange={(v) => setCurrentConfigTab(v as 'config' | 'auth')}
              className="flex-1 min-h-0 flex flex-col"
            >
              <TabsList className="shrink-0">
                <TabsTrigger value="config">config.toml</TabsTrigger>
                <TabsTrigger value="auth">auth.json</TabsTrigger>
              </TabsList>

              <TabsContent value="config" className="mt-0 flex-1 min-h-0">
                <div className="flex items-center justify-between gap-3 mb-2">
                  <div className="flex items-center gap-2 text-sm font-semibold text-zinc-900">
                    <FileCode className="h-4 w-4" aria-hidden="true" />
                    config.toml
                    <span className="text-xs text-zinc-600">(将写入 ~/.codex/config.toml)</span>
                  </div>
                </div>
                <div className="rounded-md border overflow-hidden max-w-full h-full [&_.cm-editor]:max-w-full [&_.cm-editor]:w-full [&_.cm-editor]:h-full [&_.cm-scroller]:overflow-auto">
                  <CodeMirror
                    value={currentConfigToml}
                    height="100%"
                    theme={vscodeDark}
                    extensions={tomlExtensions}
                    editable={false}
                    className="h-full"
                    basicSetup={{
                      lineNumbers: true,
                      foldGutter: true,
                      highlightActiveLine: true,
                      highlightActiveLineGutter: true,
                    }}
                  />
                </div>
              </TabsContent>

              <TabsContent value="auth" className="mt-0 flex-1 min-h-0">
                <div className="flex items-center justify-between gap-3 mb-2">
                  <div className="flex items-center gap-2 text-sm font-semibold text-zinc-900">
                    <FileCode className="h-4 w-4" aria-hidden="true" />
                    auth.json
                    <span className="text-xs text-zinc-600">(将写入 ~/.codex/auth.json)</span>
                  </div>
                </div>
                <div className="rounded-md border overflow-hidden max-w-full h-full [&_.cm-editor]:max-w-full [&_.cm-editor]:w-full [&_.cm-editor]:h-full [&_.cm-scroller]:overflow-auto">
                  <CodeMirror
                    value={currentAuthJson}
                    height="100%"
                    theme={vscodeDark}
                    extensions={jsonExtensions}
                    editable={false}
                    className="h-full"
                    basicSetup={{
                      lineNumbers: true,
                      foldGutter: true,
                      highlightActiveLine: true,
                      highlightActiveLineGutter: true,
                    }}
                  />
                </div>
              </TabsContent>
            </Tabs>
          </div>
        </DialogContent>
      </Dialog>

      {/* Preview Provider Dialog */}
      <Dialog open={!!previewProvider} onOpenChange={(open) => !open && setPreviewProvider(null)}>
        <DialogContent className="w-[92vw] max-w-[1000px] max-h-[92vh] p-0 overflow-hidden flex flex-col sm:rounded-2xl">
          <DialogHeader className="px-6 pt-6 pb-4 border-b">
            <DialogTitle>查看：{previewProvider?.name}</DialogTitle>
            <DialogDescription>仅查看，不会写入本地文件。</DialogDescription>
          </DialogHeader>
          <div className="flex-1 min-h-0 p-6 pt-4 flex flex-col gap-4 overflow-hidden">
            {previewProvider &&
              (() => {
                const baseUrl = extractBaseUrlFromConfig(previewProvider.configToml || '');
                const model = extractModelFromConfig(previewProvider.configToml || '');
                const current = isCurrentProvider(previewProvider);
                return (
                  <div className="rounded-xl border border-zinc-200 bg-zinc-50 p-4">
                    <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                      <div className="min-w-0 space-y-2 text-sm text-zinc-700">
                        <div className="flex items-center gap-2">
                          <p className="font-semibold text-zinc-900">基本信息</p>
                          {current && <span className={CURRENT_BADGE_CLASS}>当前</span>}
                        </div>
                        <p className="break-words">
                          <span className="font-semibold text-zinc-900">名称：</span> {previewProvider.name}
                        </p>
                        {model && (
                          <p>
                            <span className="font-semibold text-zinc-900">模型：</span>{' '}
                            <span className="font-mono">{model}</span>
                          </p>
                        )}
                        {baseUrl && (
                          <p className="break-all">
                            <span className="font-semibold text-zinc-900">API地址：</span>{' '}
                            <span className="font-mono">{baseUrl}</span>
                          </p>
                        )}
                        {previewProvider.description && (
                          <p className="break-words">
                            <span className="font-semibold text-zinc-900">备注：</span> {previewProvider.description}
                          </p>
                        )}
                      </div>

                      <div className="flex flex-wrap items-center justify-end gap-2">
                        <Button
                          type="button"
                          variant="outline"
                          onClick={() => baseUrl && copyToClipboard(baseUrl, '已复制 API 地址')}
                          disabled={!baseUrl}
                          className="h-auto rounded-2xl border border-zinc-200 bg-white px-4 py-3 font-semibold shadow-sm hover:bg-zinc-50 whitespace-nowrap"
                        >
                          <Copy className="h-4 w-4" aria-hidden="true" />
                          复制 API
                        </Button>
                        <Button
                          type="button"
                          variant="outline"
                          onClick={() => handleCopyVendor(previewProvider)}
                          className="h-auto rounded-2xl border border-zinc-200 bg-white px-4 py-3 font-semibold shadow-sm hover:bg-zinc-50 whitespace-nowrap"
                        >
                          <Copy className="h-4 w-4" aria-hidden="true" />
                          复制 JSON
                        </Button>
                        <Button
                          type="button"
                          variant="outline"
                          onClick={() => handleApplyProvider(previewProvider)}
                          disabled={current || switching === previewProvider.id}
                          className="h-auto rounded-2xl border border-zinc-200 bg-white px-4 py-3 font-semibold shadow-sm hover:bg-zinc-50 whitespace-nowrap"
                        >
                          {switching === previewProvider.id ? (
                            <RefreshCw className="h-4 w-4 animate-spin" aria-hidden="true" />
                          ) : (
                            <Check className="h-4 w-4" aria-hidden="true" />
                          )}
                          设为当前
                        </Button>
                      </div>
                    </div>
                  </div>
                );
              })()}

            <Tabs
              value={previewTab}
              onValueChange={(v) => setPreviewTab(v as 'config' | 'auth')}
              className="flex-1 min-h-0 flex flex-col"
            >
              <TabsList className="shrink-0">
                <TabsTrigger value="config">config.toml</TabsTrigger>
                <TabsTrigger value="auth">auth.json</TabsTrigger>
              </TabsList>

              <TabsContent value="config" className="mt-0 flex-1 min-h-0">
                <div className="flex items-center justify-between gap-3 mb-2">
                  <div className="flex items-center gap-2 text-sm font-semibold text-zinc-900">
                    <FileCode className="h-4 w-4" aria-hidden="true" />
                    config.toml
                    <span className="text-xs text-zinc-600">(将写入 ~/.codex/config.toml)</span>
                  </div>
                </div>
                <div className="rounded-md border overflow-hidden max-w-full h-full [&_.cm-editor]:max-w-full [&_.cm-editor]:w-full [&_.cm-editor]:h-full [&_.cm-scroller]:overflow-auto">
                  <CodeMirror
                    value={previewProvider?.configToml || ''}
                    height="100%"
                    theme={vscodeDark}
                    extensions={tomlExtensions}
                    editable={false}
                    className="h-full"
                    basicSetup={{
                      lineNumbers: true,
                      foldGutter: true,
                      highlightActiveLine: true,
                      highlightActiveLineGutter: true,
                    }}
                  />
                </div>
              </TabsContent>

              <TabsContent value="auth" className="mt-0 flex-1 min-h-0">
                <div className="flex items-center justify-between gap-3 mb-2">
                  <div className="flex items-center gap-2 text-sm font-semibold text-zinc-900">
                    <FileCode className="h-4 w-4" aria-hidden="true" />
                    auth.json
                    <span className="text-xs text-zinc-600">(将写入 ~/.codex/auth.json)</span>
                  </div>
                </div>
                <div className="rounded-md border overflow-hidden max-w-full h-full [&_.cm-editor]:max-w-full [&_.cm-editor]:w-full [&_.cm-editor]:h-full [&_.cm-scroller]:overflow-auto">
                  <CodeMirror
                    value={previewProvider ? getEffectiveAuthJson(previewProvider) : ''}
                    height="100%"
                    theme={vscodeDark}
                    extensions={jsonExtensions}
                    editable={false}
                    className="h-full"
                    basicSetup={{
                      lineNumbers: true,
                      foldGutter: true,
                      highlightActiveLine: true,
                      highlightActiveLineGutter: true,
                    }}
                  />
                </div>
              </TabsContent>
            </Tabs>
          </div>
        </DialogContent>
      </Dialog>

      {/* Add/Edit Dialog */}
      <Dialog open={showForm} onOpenChange={(open) => !open && setShowForm(false)}>
        <DialogContent className="w-[92vw] max-w-[1000px] max-h-[92vh] p-0 overflow-hidden flex flex-col sm:rounded-2xl">
          <DialogHeader className="px-6 pt-6 pb-4 border-b">
            <DialogTitle>{editingProvider ? '编辑 Codex 代理商' : '添加 Codex 代理商'}</DialogTitle>
            <DialogDescription>上方填写信息，下方编辑两个配置文件内容。</DialogDescription>
          </DialogHeader>
          <div className="flex-1 min-h-0 overflow-y-auto p-6 pt-4">
            <CodexProviderForm
              initialData={editingProvider || undefined}
              initialConfigToml={formInitialConfig}
              initialAuthJson={formInitialAuth}
              onSubmit={handleFormSubmit}
              onCancel={() => {
                setShowForm(false);
                setEditingProvider(null);
              }}
            />
          </div>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation */}
      <AlertDialog
        open={deleteDialogOpen}
        onOpenChange={(open) => {
          setDeleteDialogOpen(open);
          if (!open) setProviderToDelete(null);
        }}
      >
        <AlertDialogContent className="max-w-md">
          <AlertDialogHeader>
            <AlertDialogTitle>确认删除 “{providerToDelete?.name}” ?</AlertDialogTitle>
            <AlertDialogDescription>删除后不可恢复，请谨慎操作。</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel asChild>
              <Button type="button" variant="outline" onClick={cancelDeleteProvider} className="whitespace-nowrap">
                取消
              </Button>
            </AlertDialogCancel>
            <AlertDialogAction asChild>
              <Button
                type="button"
                variant="destructive"
                onClick={confirmDeleteProvider}
                disabled={!!deleting}
                className="whitespace-nowrap"
              >
                {deleting ? (
                  <>
                    <RefreshCw className="h-4 w-4 mr-2 animate-spin" aria-hidden="true" />
                    删除中...
                  </>
                ) : (
                  '删除'
                )}
              </Button>
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

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
      </div>
    </TooltipProvider>
  );
}
