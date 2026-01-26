import { useState, useEffect, useMemo } from "react";
import { FolderOpen, Check, FolderSearch, Search } from "lucide-react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useProject } from "@/contexts/ProjectContext";
import { cn } from "@/lib/utils";

export interface ProjectSelectDialogProps {
  open: boolean;
  onClose: () => void;
  onSelect: (projectPath: string) => void;
  title?: string;
  description?: string;
}

export function ProjectSelectDialog({
  open,
  onClose,
  onSelect,
  title = "选择项目",
  description = "选择要激活提示词的目标项目",
}: ProjectSelectDialogProps) {
  const { unifiedProjects, loading: projectsLoading } = useProject();
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [customPath, setCustomPath] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");

  // Reset state when dialog opens
  useEffect(() => {
    if (open) {
      setSelectedPath(null);
      setCustomPath(null);
      setSearchQuery("");
    }
  }, [open]);

  // Filter projects based on search query
  const filteredProjects = useMemo(() => {
    if (!searchQuery.trim()) {
      return unifiedProjects;
    }
    const query = searchQuery.toLowerCase();
    return unifiedProjects.filter(
      (project) =>
        project.name.toLowerCase().includes(query) ||
        project.path.toLowerCase().includes(query)
    );
  }, [unifiedProjects, searchQuery]);

  const handleBrowse = async () => {
    try {
      const selected = await openDialog({
        directory: true,
        multiple: false,
        title: "选择项目目录",
      });
      if (selected && typeof selected === "string") {
        setCustomPath(selected);
        setSelectedPath(selected);
      }
    } catch (err) {
      console.error("选择目录失败:", err);
    }
  };

  const handleProjectClick = (path: string) => {
    setSelectedPath(path);
    setCustomPath(null);
  };

  const handleConfirm = () => {
    if (selectedPath) {
      onSelect(selectedPath);
      onClose();
    }
  };

  return (
    <Dialog open={open} onOpenChange={(isOpen) => !isOpen && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FolderOpen className="w-5 h-5" />
            {title}
          </DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>

        {/* Search box */}
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input
            placeholder="搜索项目名称或路径..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-9"
          />
        </div>

        {/* Custom path display */}
        {customPath && (
          <div className="p-3 bg-primary/10 rounded-lg border border-primary/20">
            <div className="text-xs text-muted-foreground mb-1">自定义路径</div>
            <div className="text-sm font-mono truncate" title={customPath}>
              {customPath}
            </div>
          </div>
        )}

        {/* Project list */}
        <div className="border rounded-lg">
          <ScrollArea className="h-[240px]">
            {projectsLoading ? (
              <div className="flex items-center justify-center h-full text-muted-foreground">
                加载项目列表...
              </div>
            ) : filteredProjects.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-full text-muted-foreground p-4">
                <FolderSearch className="w-8 h-8 mb-2 opacity-50" />
                <p className="text-sm">{searchQuery ? "未找到匹配的项目" : "暂无项目"}</p>
                <p className="text-xs">请使用下方"浏览..."按钮选择目录</p>
              </div>
            ) : (
              <div className="p-1">
                {filteredProjects.map((project) => (
                  <button
                    key={project.path}
                    onClick={() => handleProjectClick(project.path)}
                    className={cn(
                      "w-full text-left p-3 rounded-md transition-colors",
                      "hover:bg-muted/50",
                      selectedPath === project.path && !customPath
                        ? "bg-primary/10 border border-primary/30"
                        : "border border-transparent"
                    )}
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex-1 min-w-0">
                        <div className="font-medium truncate">
                          {project.name}
                        </div>
                        <div
                          className="text-xs text-muted-foreground truncate"
                          title={project.path}
                        >
                          {project.path}
                        </div>
                      </div>
                      {selectedPath === project.path && !customPath && (
                        <Check className="w-4 h-4 text-primary flex-shrink-0 ml-2" />
                      )}
                    </div>
                  </button>
                ))}
              </div>
            )}
          </ScrollArea>
        </div>

        <DialogFooter className="flex-row gap-2 sm:justify-between">
          <Button variant="outline" onClick={handleBrowse} className="flex-1">
            <FolderOpen className="w-4 h-4 mr-2" />
            浏览...
          </Button>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={onClose}>
              取消
            </Button>
            <Button onClick={handleConfirm} disabled={!selectedPath}>
              确认
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
