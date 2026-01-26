import React from "react";
import { FilePathLink } from "@/components/common/FilePathLink";

export interface FileReference {
  filePath: string;
  lineNumber?: number;
  columnNumber?: number;
}

const KNOWN_FILE_EXTENSIONS = new Set([
  // text / docs
  "md",
  "txt",
  "log",
  "rst",
  "adoc",

  // web
  "js",
  "jsx",
  "ts",
  "tsx",
  "vue",
  "svelte",
  "html",
  "css",
  "scss",
  "less",

  // backend / general
  "java",
  "kt",
  "kts",
  "go",
  "py",
  "rb",
  "php",
  "cs",
  "cpp",
  "c",
  "h",
  "hpp",
  "rs",
  "swift",

  // config
  "json",
  "yaml",
  "yml",
  "toml",
  "ini",
  "env",
  "properties",
  "conf",
  "config",
  "xml",
  "gradle",

  // misc
  "sql",
  "sh",
  "bash",
  "bat",
  "ps1",
]);

function stripWrapperPunctuation(input: string): { prefix: string; core: string; suffix: string } {
  const trimmed = input.trim();
  if (!trimmed) return { prefix: "", core: "", suffix: "" };

  const leadingMatch = trimmed.match(/^[\(\[\{<"'`]+/);
  const trailingMatch = trimmed.match(/[\)\]\}>\"'`,\.!?;]+$/);

  const prefix = leadingMatch?.[0] || "";
  const suffix = trailingMatch?.[0] || "";
  const core = trimmed.slice(prefix.length, trimmed.length - suffix.length);

  return { prefix, core, suffix };
}

function normalizeDiffPrefix(filePath: string): string {
  // 常见 diff 前缀: a/xxx, b/xxx
  if ((filePath.startsWith("a/") || filePath.startsWith("b/")) && filePath.length > 2) {
    return filePath.slice(2);
  }
  return filePath;
}

function isLikelyFilePath(filePath: string): boolean {
  if (!filePath) return false;
  if (filePath.includes("://")) return false;
  if (/\s/.test(filePath)) return false;

  // 必须有扩展名
  const extMatch = filePath.match(/\.([A-Za-z0-9]{1,8})$/);
  if (!extMatch) return false;

  const ext = extMatch[1].toLowerCase();
  const hasSeparator = filePath.includes("/") || filePath.includes("\\");
  const isWindowsAbs = /^[A-Za-z]:[\\/]/.test(filePath);

  // 有路径分隔符/Windows 盘符 → 放宽扩展名限制
  if (hasSeparator || isWindowsAbs) return true;

  // 仅文件名时 → 仅允许常见扩展名，避免把 Foo.Bar 误判为文件
  return KNOWN_FILE_EXTENSIONS.has(ext);
}

export function parseFileReference(input: string): FileReference | null {
  const raw = input.trim();
  if (!raw) return null;
  if (raw.includes("://")) return null;

  // 先剥离尾部标点，避免如 "src/a.ts:12)," 这种情况
  const { core } = stripWrapperPunctuation(raw);
  if (!core) return null;

  let filePath = core;
  let lineNumber: number | undefined;
  let columnNumber: number | undefined;

  // 格式 1: path#L10C2
  const hashMatch = filePath.match(/^(.*)#L(\d+)(?:C(\d+))?$/);
  if (hashMatch) {
    filePath = hashMatch[1];
    lineNumber = Number.parseInt(hashMatch[2], 10);
    if (hashMatch[3]) {
      columnNumber = Number.parseInt(hashMatch[3], 10);
    }
  } else {
    // 格式 2: path:10:2
    const colonMatch = filePath.match(/^(.*):(\d+)(?::(\d+))?$/);
    if (colonMatch) {
      filePath = colonMatch[1];
      lineNumber = Number.parseInt(colonMatch[2], 10);
      if (colonMatch[3]) {
        columnNumber = Number.parseInt(colonMatch[3], 10);
      }
    }
  }

  filePath = filePath.trim();
  if (!filePath) return null;
  filePath = normalizeDiffPrefix(filePath);

  if (!isLikelyFilePath(filePath)) return null;
  if (lineNumber !== undefined && !Number.isFinite(lineNumber)) return null;
  if (columnNumber !== undefined && !Number.isFinite(columnNumber)) return null;

  return {
    filePath,
    lineNumber,
    columnNumber,
  };
}

export function linkifyFileReferences(
  text: string,
  opts: {
    projectPath?: string;
    className?: string;
    showFullPath?: boolean;
  } = {}
): React.ReactNode[] {
  if (!text) return [];

  // 按空白分割，但保留空白段，保证换行/缩进不丢
  const parts = text.split(/(\s+)/);
  const nodes: React.ReactNode[] = [];

  parts.forEach((part, index) => {
    if (!part) return;
    if (/^\s+$/.test(part)) {
      nodes.push(part);
      return;
    }

    const { prefix, core, suffix } = stripWrapperPunctuation(part);
    const ref = parseFileReference(core);

    if (!ref) {
      nodes.push(part);
      return;
    }

    if (prefix) nodes.push(prefix);

    const displayText = opts.showFullPath
      ? ref.filePath
      : ref.filePath.split(/[/\\]/).pop() || ref.filePath;

    nodes.push(
      <FilePathLink
        key={`file-ref-${index}-${ref.filePath}-${ref.lineNumber ?? ""}-${ref.columnNumber ?? ""}`}
        filePath={ref.filePath}
        projectPath={opts.projectPath}
        lineNumber={ref.lineNumber}
        columnNumber={ref.columnNumber}
        displayText={displayText}
        className={opts.className}
      />
    );

    if (suffix) nodes.push(suffix);
  });

  return nodes;
}

