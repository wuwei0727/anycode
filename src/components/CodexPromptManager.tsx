import React, { useState, useEffect, useCallback, useMemo } from "react";
import MDEditor from "@uiw/react-md-editor";
import { motion, AnimatePresence } from "framer-motion";
import {
  ArrowLeft,
  Save,
  Loader2,
  AlertCircle,
  Plus,
  Trash2,
  Power,
  PowerOff,
  FileText,
  Edit2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Toast, ToastContainer } from "@/components/ui/toast";
import { api, CodexPromptTemplate, AgentsMdStatus } from "@/lib/api";
import { cn } from "@/lib/utils";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ProjectSelectDialog } from "@/components/dialogs/ProjectSelectDialog";

interface CodexPromptManagerProps {
  onBack: () => void;
  className?: string;
}

type ViewMode = "list" | "edit";

export const CodexPromptManager: React.FC<CodexPromptManagerProps> = ({
  onBack,
  className,
}) => {
  const [viewMode, setViewMode] = useState<ViewMode>("list");
  const [templates, setTemplates] = useState<CodexPromptTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<{ message: string; type: "success" | "error" } | null>(null);
  
  // Edit mode state
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editContent, setEditContent] = useState("");
  const [originalContent, setOriginalContent] = useState("");
  
  // New template dialog
  const [showNewDialog, setShowNewDialog] = useState(false);
  const [newTemplateName, setNewTemplateName] = useState("");

  // Rename template dialog
  const [renameDialog, setRenameDialog] = useState<{ oldId: string; newId: string } | null>(null);

  const renameValidationError = useMemo(() => {
    if (!renameDialog) return null;
    const nextId = renameDialog.newId.trim();
    if (!nextId) return "请输入名称";
    if (!/^[a-zA-Z0-9_-]+$/.test(nextId)) {
      return "名称只能包含字母、数字、横线和下划线";
    }
    if (templates.some((t) => t.id === nextId && t.id !== renameDialog.oldId)) {
      return "该名称已存在";
    }
    return null;
  }, [renameDialog, templates]);
  
  // Delete confirmation dialog
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);
  
  // Project selection dialog state
  const [showProjectSelect, setShowProjectSelect] = useState(false);
  const [pendingPromptId, setPendingPromptId] = useState<string | null>(null);
  const [selectedProjectPath, setSelectedProjectPath] = useState<string | null>(null);
  
  // Overwrite confirmation dialog (for project-level activation)
  const [overwriteConfirm, setOverwriteConfirm] = useState<{
    id: string;
    status: AgentsMdStatus;
  } | null>(null);
  
  // Restore backup confirmation dialog (for project-level deactivation)
  const [restoreConfirm, setRestoreConfirm] = useState<{
    hasBackup: boolean;
  } | null>(null);

  const hasChanges = editContent !== originalContent;

  // Load templates
  const loadTemplates = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const list = await api.listCodexPrompts();
      setTemplates(list);
    } catch (err) {
      console.error("Failed to load templates:", err);
      setError("加载提示词模板失败");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadTemplates();
  }, [loadTemplates]);

  // Edit a template
  const handleEdit = async (id: string) => {
    try {
      setLoading(true);
      const content = await api.getCodexPrompt(id);
      setEditingId(id);
      setEditContent(content);
      setOriginalContent(content);
      setViewMode("edit");
    } catch (err) {
      console.error("Failed to load template:", err);
      setToast({ message: "加载模板失败", type: "error" });
    } finally {
      setLoading(false);
    }
  };

  // Save template
  const handleSave = async () => {
    if (!editingId) return;
    
    try {
      setSaving(true);
      await api.saveCodexPrompt(editingId, editContent);
      setOriginalContent(editContent);
      setToast({ message: "保存成功", type: "success" });
      
      // If this is the active template, also update AGENTS.md
      const template = templates.find(t => t.id === editingId);
      if (template?.isActive) {
        await api.activateCodexPrompt(editingId);
      }
    } catch (err) {
      console.error("Failed to save template:", err);
      setToast({ message: "保存失败", type: "error" });
    } finally {
      setSaving(false);
    }
  };

  // Create new template
  const handleCreate = async () => {
    const name = newTemplateName.trim();
    if (!name) return;
    
    // Validate name (alphanumeric, dash, underscore only)
    if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
      setToast({ message: "名称只能包含字母、数字、横线和下划线", type: "error" });
      return;
    }
    
    // Check if already exists
    if (templates.some(t => t.id === name)) {
      setToast({ message: "该名称已存在", type: "error" });
      return;
    }
    
    try {
      setSaving(true);
      await api.saveCodexPrompt(name, `# ${name}\n\n在此编写你的提示词...`);
      setShowNewDialog(false);
      setNewTemplateName("");
      await loadTemplates();
      setToast({ message: "创建成功", type: "success" });
      
      // Auto open for editing
      handleEdit(name);
    } catch (err) {
      console.error("Failed to create template:", err);
      setToast({ message: "创建失败", type: "error" });
    } finally {
      setSaving(false);
    }
  };

  // Rename template (ID / filename)
  const handleRename = async () => {
    if (!renameDialog) return;

    const oldId = renameDialog.oldId;
    const nextId = renameDialog.newId.trim();

    if (nextId === oldId) {
      setRenameDialog(null);
      return;
    }

    if (renameValidationError) {
      setToast({ message: renameValidationError, type: "error" });
      return;
    }
    
    try {
      setSaving(true);
      await api.renameCodexPrompt(oldId, nextId);

      // If currently editing this template, keep the editor open on the new ID.
      if (editingId === oldId) {
        setEditingId(nextId);
      }

      setRenameDialog(null);
      await loadTemplates();
      setToast({ message: `已重命名为 ${nextId}`, type: "success" });
    } catch (err) {
      console.error("Failed to rename template:", err);
      setToast({ message: "重命名失败", type: "error" });
    } finally {
      setSaving(false);
    }
  };

  // Delete template
  const handleDelete = async (id: string) => {
    try {
      setSaving(true);
      await api.deleteCodexPrompt(id);
      setDeleteConfirm(null);
      await loadTemplates();
      setToast({ message: "删除成功", type: "success" });
    } catch (err) {
      console.error("Failed to delete template:", err);
      setToast({ message: "删除失败", type: "error" });
    } finally {
      setSaving(false);
    }
  };

  // Activate template
  const handleActivate = async (id: string) => {
    // Show project selection dialog
    setPendingPromptId(id);
    setShowProjectSelect(true);
  };
  
  // Handle project selection for activation
  const handleProjectSelected = async (projectPath: string) => {
    if (!pendingPromptId) return;
    
    setSelectedProjectPath(projectPath);
    setShowProjectSelect(false);
    
    try {
      setSaving(true);
      // Check if AGENTS.md exists in project
      const status = await api.checkProjectAgentsMd(projectPath);
      
      if (status.exists) {
        // Show overwrite confirmation dialog
        setOverwriteConfirm({ id: pendingPromptId, status });
      } else {
        // No existing file, activate directly
        const result = await api.activateCodexPromptToProject(pendingPromptId, projectPath, false);
        if (result.success) {
          await loadTemplates();
          setToast({ message: result.message, type: "success" });
        } else {
          setToast({ message: result.message, type: "error" });
        }
        setPendingPromptId(null);
        setSelectedProjectPath(null);
      }
    } catch (err) {
      console.error("Failed to activate template:", err);
      setToast({ message: "激活失败", type: "error" });
      setPendingPromptId(null);
      setSelectedProjectPath(null);
    } finally {
      setSaving(false);
    }
  };
  
  // Confirm overwrite and activate
  const handleConfirmOverwrite = async (backup: boolean) => {
    if (!overwriteConfirm || !selectedProjectPath) return;
    
    try {
      setSaving(true);
      const result = await api.activateCodexPromptToProject(
        overwriteConfirm.id,
        selectedProjectPath,
        backup
      );
      setOverwriteConfirm(null);
      
      if (result.success) {
        await loadTemplates();
        setToast({ message: result.message, type: "success" });
      } else {
        setToast({ message: result.message, type: "error" });
      }
      setPendingPromptId(null);
      setSelectedProjectPath(null);
    } catch (err) {
      console.error("Failed to activate template:", err);
      setToast({ message: "激活失败", type: "error" });
    } finally {
      setSaving(false);
    }
  };

  // Deactivate template
  const handleDeactivate = async () => {
    // Show project selection dialog for deactivation
    setPendingPromptId("__deactivate__");
    setShowProjectSelect(true);
  };
  
  // Handle project selection for deactivation
  const handleProjectSelectedForDeactivate = async (projectPath: string) => {
    setSelectedProjectPath(projectPath);
    setShowProjectSelect(false);
    
    try {
      setSaving(true);
      // Check if backup exists
      const status = await api.checkProjectAgentsMd(projectPath);
      
      if (status.hasBackup) {
        // Show restore confirmation dialog
        setRestoreConfirm({ hasBackup: true });
      } else {
        // No backup, deactivate directly
        await api.deactivateCodexPromptFromProject(projectPath, false);
        await loadTemplates();
        setToast({ message: "已停用", type: "success" });
        setPendingPromptId(null);
        setSelectedProjectPath(null);
      }
    } catch (err) {
      console.error("Failed to deactivate template:", err);
      setToast({ message: "停用失败", type: "error" });
      setPendingPromptId(null);
      setSelectedProjectPath(null);
    } finally {
      setSaving(false);
    }
  };
  
  // Confirm restore and deactivate
  const handleConfirmRestore = async (restore: boolean) => {
    if (!selectedProjectPath) return;
    
    try {
      setSaving(true);
      await api.deactivateCodexPromptFromProject(selectedProjectPath, restore);
      setRestoreConfirm(null);
      await loadTemplates();
      setToast({ 
        message: restore ? "已恢复备份" : "已清空 AGENTS.md", 
        type: "success" 
      });
      setPendingPromptId(null);
      setSelectedProjectPath(null);
    } catch (err) {
      console.error("Failed to deactivate template:", err);
      setToast({ message: "停用失败", type: "error" });
    } finally {
      setSaving(false);
    }
  };

  // Back from edit mode
  const handleBackFromEdit = () => {
    if (hasChanges) {
      const confirmLeave = window.confirm("您有未保存的更改。确定要离开吗？");
      if (!confirmLeave) return;
    }
    setViewMode("list");
    setEditingId(null);
    setEditContent("");
    setOriginalContent("");
    loadTemplates();
  };

  // Render list view
  const renderListView = () => (
    <div className="flex flex-col h-full">
      {/* Header */}
      <motion.div
        initial={{ opacity: 0, y: -20 }}
        animate={{ opacity: 1, y: 0 }}
        className="flex items-center justify-between p-4 border-b border-border"
      >
        <div className="flex items-center space-x-3">
          <Button variant="ghost" size="icon" onClick={onBack} className="h-8 w-8">
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <div>
            <h2 className="text-lg font-semibold">Codex 提示词管理</h2>
            <p className="text-xs text-muted-foreground">
              点击激活按钮选择目标项目
            </p>
          </div>
        </div>
        <Button onClick={() => setShowNewDialog(true)} size="sm">
          <Plus className="mr-2 h-4 w-4" />
          新建模板
        </Button>
      </motion.div>

      {/* Template List */}
      <div className="flex-1 overflow-y-auto p-4">
        {loading ? (
          <div className="flex items-center justify-center h-full">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : error ? (
          <div className="flex items-center justify-center h-full">
            <div className="text-center space-y-2">
              <AlertCircle className="h-8 w-8 text-destructive mx-auto" />
              <p className="text-sm text-muted-foreground">{error}</p>
            </div>
          </div>
        ) : templates.length === 0 ? (
          <div className="flex items-center justify-center h-full">
            <div className="text-center space-y-3">
              <FileText className="h-12 w-12 text-muted-foreground/50 mx-auto" />
              <p className="text-sm text-muted-foreground">暂无提示词模板</p>
              <Button onClick={() => setShowNewDialog(true)} variant="outline" size="sm">
                <Plus className="mr-2 h-4 w-4" />
                创建第一个模板
              </Button>
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            {templates.map((template) => (
              <motion.div
                key={template.id}
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                className={cn(
                  "p-4 rounded-lg border transition-all",
                  template.isActive
                    ? "border-primary bg-primary/5"
                    : "border-border hover:border-primary/50"
                )}
              >
                <div className="flex items-start justify-between">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => setRenameDialog({ oldId: template.id, newId: template.id })}
                        className="p-0 bg-transparent border-0 appearance-none font-medium truncate text-left hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 rounded-sm disabled:opacity-50 disabled:cursor-not-allowed"
                        title="点击重命名"
                        disabled={saving}
                      >
                        {template.name}
                      </button>
                      {template.isActive && (
                        <span className="px-2 py-0.5 text-xs rounded-full bg-primary/20 text-primary">
                          已激活
                        </span>
                      )}
                    </div>
                    {template.description && (
                      <p className="text-sm text-muted-foreground mt-1 truncate">
                        {template.description}
                      </p>
                    )}
                    <p className="text-xs text-muted-foreground mt-2">
                      更新于 {new Date(template.updatedAt * 1000).toLocaleString()}
                    </p>
                  </div>
                  <div className="flex items-center gap-2 ml-4">
                    {template.isActive ? (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={handleDeactivate}
                        disabled={saving}
                      >
                        <PowerOff className="h-4 w-4 mr-1" />
                        停用
                      </Button>
                    ) : (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => handleActivate(template.id)}
                        disabled={saving}
                      >
                        <Power className="h-4 w-4 mr-1" />
                        激活
                      </Button>
                    )}
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => handleEdit(template.id)}
                    >
                      <Edit2 className="h-4 w-4 mr-1" />
                      编辑
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 text-destructive hover:text-destructive"
                      onClick={() => setDeleteConfirm(template.id)}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              </motion.div>
            ))}
          </div>
        )}
      </div>
    </div>
  );

  // Render edit view
  const renderEditView = () => (
    <div className="flex flex-col h-full">
      {/* Header */}
      <motion.div
        initial={{ opacity: 0, y: -20 }}
        animate={{ opacity: 1, y: 0 }}
        className="flex items-center justify-between p-4 border-b border-border"
      >
        <div className="flex items-center space-x-3">
          <Button variant="ghost" size="icon" onClick={handleBackFromEdit} className="h-8 w-8">
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <div>
            <h2 className="text-lg font-semibold">编辑: {editingId}</h2>
            <p className="text-xs text-muted-foreground">
              {templates.find(t => t.id === editingId)?.isActive ? "当前已激活" : "未激活"}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => editingId && setRenameDialog({ oldId: editingId, newId: editingId })}
            disabled={saving || !editingId}
          >
            <Edit2 className="mr-2 h-4 w-4" />
            重命名
          </Button>
          <Button
            onClick={handleSave}
            disabled={!hasChanges || saving}
            size="sm"
          >
            {saving ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Save className="mr-2 h-4 w-4" />
            )}
            {saving ? "保存中..." : "保存"}
          </Button>
        </div>
      </motion.div>

      {/* Editor */}
      <div className="flex-1 p-4 overflow-hidden">
        <div className="h-full rounded-lg border border-border overflow-hidden" data-color-mode="dark">
          <MDEditor
            value={editContent}
            onChange={(val) => setEditContent(val || "")}
            preview="edit"
            height="100%"
            visibleDragbar={false}
          />
        </div>
      </div>
    </div>
  );

  return (
    <div className={cn("flex flex-col h-full bg-background", className)}>
      <div className="w-full max-w-6xl mx-auto flex flex-col h-full px-4">
        <AnimatePresence mode="wait">
          {viewMode === "list" ? renderListView() : renderEditView()}
        </AnimatePresence>
      </div>

      {/* New Template Dialog */}
      <Dialog open={showNewDialog} onOpenChange={setShowNewDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>新建提示词模板</DialogTitle>
            <DialogDescription>
              输入模板名称（只能包含字母、数字、横线和下划线）
            </DialogDescription>
          </DialogHeader>
          <Input
            value={newTemplateName}
            onChange={(e) => setNewTemplateName(e.target.value)}
            placeholder="例如: my-prompt"
            onKeyDown={(e) => e.key === "Enter" && handleCreate()}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowNewDialog(false)}>
              取消
            </Button>
            <Button onClick={handleCreate} disabled={!newTemplateName.trim() || saving}>
              {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Plus className="mr-2 h-4 w-4" />}
              创建
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation Dialog */}
      <Dialog open={!!deleteConfirm} onOpenChange={() => setDeleteConfirm(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>确认删除</DialogTitle>
            <DialogDescription>
              确定要删除模板 "{deleteConfirm}" 吗？此操作无法撤销。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteConfirm(null)}>
              取消
            </Button>
            <Button
              variant="destructive"
              onClick={() => deleteConfirm && handleDelete(deleteConfirm)}
              disabled={saving}
            >
              {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Trash2 className="mr-2 h-4 w-4" />}
              删除
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Rename Dialog */}
      <Dialog open={!!renameDialog} onOpenChange={(open) => !open && setRenameDialog(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>重命名提示词模板</DialogTitle>
            <DialogDescription>
              名称只能包含字母、数字、横线和下划线
              {renameDialog?.oldId ? `（当前：${renameDialog.oldId}）` : ""}
            </DialogDescription>
          </DialogHeader>
          <Input
            value={renameDialog?.newId ?? ""}
            onChange={(e) =>
              setRenameDialog((prev) => (prev ? { ...prev, newId: e.target.value } : prev))
            }
            placeholder="例如: my-prompt"
            onKeyDown={(e) => {
              if (
                e.key === "Enter" &&
                !saving &&
                !renameValidationError &&
                (renameDialog?.newId ?? "").trim() &&
                (renameDialog?.newId ?? "").trim() !== (renameDialog?.oldId ?? "")
              ) {
                handleRename();
              }
            }}
            disabled={saving}
            aria-invalid={!!renameValidationError}
            className={renameValidationError ? "border-destructive focus:border-destructive focus-visible:ring-destructive" : ""}
          />
          {renameValidationError && (
            <p className="text-xs text-destructive">{renameValidationError}</p>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setRenameDialog(null)} disabled={saving}>
              取消
            </Button>
            <Button
              onClick={handleRename}
              disabled={
                saving ||
                !!renameValidationError ||
                !(renameDialog?.newId ?? "").trim() ||
                (renameDialog?.newId ?? "").trim() === (renameDialog?.oldId ?? "")
              }
            >
              {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Edit2 className="mr-2 h-4 w-4" />}
              确认
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Overwrite Confirmation Dialog */}
      <Dialog open={!!overwriteConfirm} onOpenChange={() => setOverwriteConfirm(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>文件已存在</DialogTitle>
            <DialogDescription>
              项目目录中已存在 AGENTS.md 文件。
              {overwriteConfirm?.status.contentPreview && (
                <div className="mt-2 p-2 bg-muted rounded text-xs font-mono max-h-24 overflow-y-auto">
                  {overwriteConfirm.status.contentPreview}
                </div>
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="flex-col sm:flex-row gap-2">
            <Button variant="outline" onClick={() => setOverwriteConfirm(null)}>
              取消
            </Button>
            <Button
              variant="secondary"
              onClick={() => handleConfirmOverwrite(true)}
              disabled={saving}
            >
              {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              备份并覆盖
            </Button>
            <Button
              variant="destructive"
              onClick={() => handleConfirmOverwrite(false)}
              disabled={saving}
            >
              {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              直接覆盖
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Restore Backup Confirmation Dialog */}
      <Dialog open={!!restoreConfirm} onOpenChange={() => setRestoreConfirm(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>停用提示词</DialogTitle>
            <DialogDescription>
              检测到存在备份文件，是否恢复原有配置？
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="flex-col sm:flex-row gap-2">
            <Button variant="outline" onClick={() => setRestoreConfirm(null)}>
              取消
            </Button>
            <Button
              variant="secondary"
              onClick={() => handleConfirmRestore(true)}
              disabled={saving}
            >
              {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              恢复备份
            </Button>
            <Button
              variant="destructive"
              onClick={() => handleConfirmRestore(false)}
              disabled={saving}
            >
              {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              清空文件
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Project Selection Dialog */}
      <ProjectSelectDialog
        open={showProjectSelect}
        onClose={() => {
          setShowProjectSelect(false);
          setPendingPromptId(null);
        }}
        onSelect={(path) => {
          if (pendingPromptId === "__deactivate__") {
            handleProjectSelectedForDeactivate(path);
          } else {
            handleProjectSelected(path);
          }
        }}
        title={pendingPromptId === "__deactivate__" ? "选择要停用的项目" : "选择目标项目"}
        description={pendingPromptId === "__deactivate__" 
          ? "选择要停用提示词的项目目录" 
          : "选择要激活提示词的目标项目目录"
        }
      />

      {/* Toast */}
      <ToastContainer>
        {toast && (
          <Toast
            message={toast.message}
            type={toast.type}
            onDismiss={() => setToast(null)}
          />
        )}
      </ToastContainer>
    </div>
  );
};
