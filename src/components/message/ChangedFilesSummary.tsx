import React, { useMemo, useState } from "react";
import { ChevronDown, ChevronUp, Columns2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { FilePathLink } from "@/components/common/FilePathLink";

export interface ChangedFileEntry {
  filePath: string;
  added: number;
  removed: number;
}

export interface ChangedFilesSummaryProps {
  files: ChangedFileEntry[];
  projectPath?: string;
  className?: string;
  title?: string;
  defaultExpanded?: boolean;
  onViewDiff?: (filePath: string) => void;
}

function getFileName(filePath: string): string {
  return filePath.split(/[/\\]/).pop() || filePath;
}

export const ChangedFilesSummary: React.FC<ChangedFilesSummaryProps> = ({
  files,
  projectPath,
  className,
  title,
  defaultExpanded = true,
  onViewDiff,
}) => {
  const [isExpanded, setIsExpanded] = useState(defaultExpanded);

  const stats = useMemo(() => {
    let added = 0;
    let removed = 0;
    files.forEach((f) => {
      added += f.added;
      removed += f.removed;
    });
    return { changed: files.length, added, removed };
  }, [files]);

  if (!files || files.length === 0) return null;

  const headerText = useMemo(() => {
    if (title) return title;
    const fileLabel = stats.changed === 1 ? "file" : "files";
    // When there's only one file, the per-row badges already show the exact +/-.
    // Avoid repeating the same numbers twice in the header.
    const showTotals = stats.changed !== 1;
    return (
      `${stats.changed} ${fileLabel} changed` +
      (showTotals && stats.added ? ` +${stats.added}` : "") +
      (showTotals && stats.removed ? ` -${stats.removed}` : "")
    );
  }, [stats.added, stats.changed, stats.removed, title]);

  return (
    <div className={cn("rounded-lg border border-border/60 overflow-hidden bg-muted/10", className)}>
      <button
        type="button"
        onClick={() => setIsExpanded((v) => !v)}
        className={cn(
          "w-full px-3 py-2 text-left",
          "flex items-center gap-2",
          "bg-muted/30 hover:bg-muted/50 transition-colors select-none"
        )}
      >
        <span className="text-sm font-medium text-foreground/85 truncate">{headerText}</span>
        <span className="ml-auto text-muted-foreground">
          {isExpanded ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
        </span>
      </button>

      {isExpanded && (
        <div className="divide-y divide-border/50 bg-background/30">
          {files.map((f) => (
            <div key={f.filePath} className="px-3 py-2 flex items-center gap-3 min-w-0">
              <div className="flex-1 min-w-0">
                <FilePathLink
                  filePath={f.filePath}
                  projectPath={projectPath}
                  displayText={getFileName(f.filePath)}
                  className="text-xs"
                />
              </div>
              <div className="flex items-center gap-2 text-xs font-mono">
                {f.added > 0 && (
                  <span className="text-green-600 dark:text-green-400 bg-green-500/10 px-1.5 py-0.5 rounded">
                    +{f.added}
                  </span>
                )}
                {f.removed > 0 && (
                  <span className="text-red-600 dark:text-red-400 bg-red-500/10 px-1.5 py-0.5 rounded">
                    -{f.removed}
                  </span>
                )}
              </div>

              {onViewDiff && (
                <button
                  type="button"
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    onViewDiff(f.filePath);
                  }}
                  className={cn(
                    "inline-flex items-center gap-1 rounded-md border border-border/60",
                    "bg-background/60 hover:bg-background px-2 py-1 text-[11px] text-muted-foreground",
                    "transition-colors select-none"
                  )}
                  title="查看左右对比 (Before/After)"
                >
                  <Columns2 className="h-3.5 w-3.5" />
                  对比
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

export default ChangedFilesSummary;
