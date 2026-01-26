import React from "react";
import { FileText } from "lucide-react";
import { cn } from "@/lib/utils";
import { FilePathLink } from "@/components/common/FilePathLink";

export interface FilesTouchedSectionProps {
  title?: string;
  files: string[];
  projectPath?: string;
  className?: string;
}

function getFileName(filePath: string): string {
  return filePath.split(/[/\\]/).pop() || filePath;
}

export const FilesTouchedSection: React.FC<FilesTouchedSectionProps> = ({
  title = "涉及文件",
  files,
  projectPath,
  className,
}) => {
  if (!files || files.length === 0) return null;

  return (
    <div className={cn("space-y-2", className)}>
      <div className="text-sm font-semibold text-foreground/90">{title}</div>
      <div className="flex flex-wrap gap-2">
        {files.map((fp) => (
          <div
            key={fp}
            className="inline-flex items-center gap-1.5 rounded-full border border-border/60 bg-muted/20 px-2.5 py-1"
          >
            <FileText className="h-3.5 w-3.5 text-muted-foreground/80" />
            <FilePathLink
              filePath={fp}
              projectPath={projectPath}
              displayText={getFileName(fp)}
              className="text-xs"
            />
          </div>
        ))}
      </div>
    </div>
  );
};

export default FilesTouchedSection;

