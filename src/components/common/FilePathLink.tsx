/**
 * FilePathLink - 可点击的文件路径链接组件
 *
 * 用于在 Widget 中显示可点击的文件路径，点击后在 IDE 中打开文件。
 * 支持：
 * - 点击跳转到 IDE
 * - 右键菜单（复制路径、在文件管理器中打开等）
 * - 悬停显示完整路径
 * - 视觉反馈
 */

import React, { useState, useCallback } from "react";
import { ExternalLink, Copy, FolderOpen, Check } from "lucide-react";
import { cn } from "@/lib/utils";
import { api } from "@/lib/api";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

export interface FilePathLinkProps {
  /** 文件路径（可能是相对路径或绝对路径） */
  filePath: string;
  /** 项目根目录路径 */
  projectPath?: string;
  /** 行号（可选） */
  lineNumber?: number;
  /** 列号（可选） */
  columnNumber?: number;
  /** 显示文本（可选，默认显示文件名） */
  displayText?: string;
  /** 是否显示完整路径 */
  showFullPath?: boolean;
  /** 自定义类名 */
  className?: string;
  /** 点击回调（可选，用于额外处理） */
  onClick?: () => void;
}

/**
 * 从路径中提取文件名
 */
function getFileName(filePath: string): string {
  const parts = filePath.split(/[/\\]/);
  return parts[parts.length - 1] || filePath;
}

/**
 * FilePathLink 组件
 */
export const FilePathLink: React.FC<FilePathLinkProps> = ({
  filePath,
  projectPath,
  lineNumber,
  columnNumber,
  displayText,
  showFullPath = false,
  className,
  onClick,
}) => {
  const [isClicked, setIsClicked] = useState(false);
  const [copied, setCopied] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);

  // 显示的文本
  const displayName = displayText || (showFullPath ? filePath : getFileName(filePath));

  // 在 IDE 中打开文件
  const handleOpenInIDE = useCallback(async (e?: React.MouseEvent) => {
    e?.preventDefault();
    e?.stopPropagation();
    
    setIsClicked(true);
    setTimeout(() => setIsClicked(false), 200);

    try {
      console.log("[FilePathLink] 打开文件:", { filePath, projectPath, lineNumber, columnNumber });
      
      const result = await api.openFileInIDE({
        filePath,
        projectPath,
        line: lineNumber,
        column: columnNumber,
      });

      console.log("[FilePathLink] 打开结果:", result);

      if (!result.success) {
        console.error("无法打开文件:", result.message, result.error);
        // 可以在这里添加 toast 通知
      }
    } catch (error) {
      console.error("打开文件失败:", error);
    }

    onClick?.();
  }, [filePath, projectPath, lineNumber, columnNumber, onClick]);

  // 复制路径
  const handleCopyPath = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(filePath);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (error) {
      console.error("复制失败:", error);
    }
  }, [filePath]);

  // 复制绝对路径
  const handleCopyAbsolutePath = useCallback(async () => {
    const absolutePath = projectPath ? `${projectPath}/${filePath}` : filePath;
    try {
      await navigator.clipboard.writeText(absolutePath);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (error) {
      console.error("复制失败:", error);
    }
  }, [filePath, projectPath]);

  // 在文件管理器中打开
  const handleOpenInExplorer = useCallback(async () => {
    try {
      // 获取文件所在目录
      const dirPath = filePath.replace(/[/\\][^/\\]*$/, "");
      const fullDirPath = projectPath ? `${projectPath}/${dirPath}` : dirPath;
      await api.openDirectoryInExplorer(fullDirPath);
    } catch (error) {
      console.error("打开文件管理器失败:", error);
    }
  }, [filePath, projectPath]);

  // 处理右键点击
  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setMenuOpen(true);
  }, []);

  // 构建 tooltip 内容
  const tooltipContent = (
    <div className="text-xs space-y-1">
      <div className="font-medium">{filePath}</div>
      {lineNumber && (
        <div className="text-muted-foreground">
          行 {lineNumber}{columnNumber ? `, 列 ${columnNumber}` : ""}
        </div>
      )}
      <div className="text-muted-foreground mt-1">点击在 IDE 中打开 | 右键更多选项</div>
    </div>
  );

  return (
    <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                onClick={handleOpenInIDE}
                onContextMenu={handleContextMenu}
                className={cn(
                  "inline-flex items-center gap-1 font-mono text-sm",
                  "text-primary hover:text-primary/80",
                  "hover:underline cursor-pointer",
                  "transition-all duration-150",
                  "rounded px-0.5 -mx-0.5",
                  "hover:bg-primary/5",
                  isClicked && "scale-95 bg-primary/10",
                  className
                )}
              >
                <span className="truncate max-w-[300px]" title={filePath}>
                  {displayName}
                </span>
                <ExternalLink className="h-3 w-3 opacity-50 flex-shrink-0" />
              </button>
            </DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent side="top" align="start">
            {tooltipContent}
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>

      <DropdownMenuContent className="w-56">
        <DropdownMenuItem onClick={() => handleOpenInIDE()}>
          <ExternalLink className="mr-2 h-4 w-4" />
          在 IDE 中打开
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={handleCopyPath}>
          {copied ? (
            <Check className="mr-2 h-4 w-4 text-green-500" />
          ) : (
            <Copy className="mr-2 h-4 w-4" />
          )}
          复制路径
        </DropdownMenuItem>
        <DropdownMenuItem onClick={handleCopyAbsolutePath}>
          <Copy className="mr-2 h-4 w-4" />
          复制绝对路径
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={handleOpenInExplorer}>
          <FolderOpen className="mr-2 h-4 w-4" />
          在文件管理器中打开
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
};

export default FilePathLink;
