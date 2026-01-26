import React, { memo, useEffect, useRef, useState, useCallback, useMemo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { getClaudeSyntaxTheme } from "@/lib/claudeSyntaxTheme";
import { useTheme } from "@/contexts/ThemeContext";
import { cn } from "@/lib/utils";
import { copyTextToClipboard } from "@/lib/clipboard";
import { useTypewriter } from "@/hooks/useTypewriter";
import { linkifyFileReferences, parseFileReference } from "@/lib/fileLinkify";
import { FilePathLink } from "@/components/common/FilePathLink";

interface FilePathLinkAdapterProps {
  filePath: string;
  projectPath?: string;
  lineNumber?: number;
  columnNumber?: number;
}

const FilePathLinkAdapter: React.FC<FilePathLinkAdapterProps> = ({
  filePath,
  projectPath,
  lineNumber,
  columnNumber,
}) => {
  const displayText = filePath.split(/[/\\]/).pop() || filePath;
  return (
    <span className="inline-flex items-center px-1.5 py-0.5 rounded-md bg-muted/50 border border-border/50">
      <FilePathLink
        filePath={filePath}
        projectPath={projectPath}
        lineNumber={lineNumber}
        columnNumber={columnNumber}
        displayText={displayText}
        className="text-xs"
      />
    </span>
  );
};

interface CodeBlockRendererProps {
  language: string;
  code: string;
  syntaxTheme: any;
}

const CodeBlockRenderer: React.FC<CodeBlockRendererProps> = ({ language, code, syntaxTheme }) => {
  const [copyState, setCopyState] = useState<'idle' | 'success' | 'error'>('idle');
  const resetTimerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (resetTimerRef.current) {
        window.clearTimeout(resetTimerRef.current);
      }
    };
  }, []);

  const handleCopy = async (event: React.MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();

    if (!code) {
      return;
    }

    if (resetTimerRef.current) {
      window.clearTimeout(resetTimerRef.current);
    }

    try {
      await copyTextToClipboard(code);
      console.log('[CodeBlock] Copied to clipboard:', code.substring(0, 50) + '...');
      setCopyState('success');
    } catch (error) {
      console.error('[CodeBlock] Copy failed:', error);
      setCopyState('error');
    } finally {
      resetTimerRef.current = window.setTimeout(() => setCopyState('idle'), 2000);
    }
  };

  const buttonLabel =
    copyState === 'success' ? '已复制!' : copyState === 'error' ? '复制失败' : '复制';

  return (
    <div className="relative group my-1.5 rounded-lg overflow-hidden bg-muted/20">
      <div className="flex items-center justify-between px-3 py-1.5 bg-muted/30 backdrop-blur-sm">
        <div className="flex items-center gap-2 flex-1 min-w-0">
          <span className="text-xs font-mono text-muted-foreground opacity-70 truncate">
            {language}
          </span>
        </div>
        <button
          onClick={handleCopy}
          className={cn(
            "text-xs px-2 py-0.5 rounded-md transition-all duration-200 opacity-0 group-hover:opacity-100 flex-shrink-0 ml-2",
            "bg-background/50 hover:bg-background hover:shadow-sm",
            copyState === 'success' && "text-emerald-600 bg-emerald-500/10",
            copyState === 'error' && "text-destructive bg-destructive/10"
          )}
        >
          {buttonLabel}
        </button>
      </div>

      <div className="relative">
        <SyntaxHighlighter
          style={syntaxTheme}
          language={language}
          PreTag="div"
          showLineNumbers={true}
          wrapLines={true}
          customStyle={{
            margin: 0,
            padding: '0.75rem',
            background: 'transparent',
            lineHeight: '1.5',
            fontSize: '0.8rem',
          }}
          lineNumberStyle={{
            minWidth: '2.5em',
            paddingRight: '1em',
            color: 'var(--color-muted-foreground)',
            opacity: 0.5,
            textAlign: 'right',
          }}
          codeTagProps={{
            style: {
              fontFamily: 'var(--font-mono)',
              fontVariantLigatures: 'none',
            }
          }}
        >
          {code}
        </SyntaxHighlighter>
      </div>
    </div>
  );
};

interface MessageContentProps {
  /** Markdown内容 */
  content: string;
  /** 自定义类名 */
  className?: string;
  /** 项目路径（用于文件路径点击打开 IDE） */
  projectPath?: string;
  /** 是否正在流式输出 */
  isStreaming?: boolean;
  /** 是否启用打字机效果 */
  enableTypewriter?: boolean;
  /** 打字机速度（毫秒/字符） */
  typewriterSpeed?: number;
  /** 打字机效果完成回调 */
  onTypewriterComplete?: () => void;
}

/**
 * 消息内容渲染组件
 * 支持Markdown + 代码高亮 + 打字机效果
 */
const MessageContentComponent: React.FC<MessageContentProps> = ({
  content,
  className,
  projectPath,
  isStreaming = false,
  enableTypewriter = true,
  typewriterSpeed = 8,
  onTypewriterComplete
}) => {
  const { theme } = useTheme();
  const syntaxTheme = getClaudeSyntaxTheme(theme === 'dark');

  // 判断是否应该启用打字机效果
  const shouldEnableTypewriter = enableTypewriter && isStreaming;

  // 使用打字机效果
  const {
    displayedText,
    isTyping,
    skipToEnd
  } = useTypewriter(content, {
    enabled: shouldEnableTypewriter,
    speed: typewriterSpeed,
    isStreaming,
    onComplete: onTypewriterComplete
  });

  // 决定显示的内容：打字机效果启用时使用 displayedText，否则直接显示全部
  const textToDisplay = shouldEnableTypewriter ? displayedText : content;
  const normalizedTextToDisplay = useMemo(() => {
    if (shouldEnableTypewriter) return textToDisplay;

    const normalizeTitle = (line: string) => {
      const t = line.trim();
      const title = t.replace(/^\*\*(.+)\*\*$/, "$1").trim();

      // 仅提升常见“分节标题”到 Markdown Heading，避免误伤普通加粗
      const knownTitles = new Set(["涉及文件", "下一步可选", "为什么这样改", "Why", "Next steps", "Files"]);
      if (knownTitles.has(title)) {
        return `### ${title}`;
      }
      return line;
    };

    return textToDisplay
      .split(/\r?\n/)
      .map(normalizeTitle)
      .join("\n");
  }, [shouldEnableTypewriter, textToDisplay]);

  // 双击跳过打字机效果
  const handleDoubleClick = useCallback(() => {
    if (isTyping) {
      skipToEnd();
    }
  }, [isTyping, skipToEnd]);

  return (
    <div
      className={cn(
        "prose prose-sm dark:prose-invert max-w-none",
        "prose-headings:font-semibold prose-headings:tracking-tight",
        "prose-p:leading-relaxed prose-p:text-foreground/90",
        "prose-p:my-2 prose-ul:my-2 prose-ol:my-2 prose-li:my-1",
        "prose-a:text-primary prose-a:no-underline prose-a:border-b prose-a:border-primary/30 hover:prose-a:border-primary prose-a:transition-colors",
        "prose-blockquote:border-l-4 prose-blockquote:border-primary/20 prose-blockquote:bg-muted/30 prose-blockquote:py-1 prose-blockquote:px-4 prose-blockquote:rounded-r-lg prose-blockquote:not-italic",
        "prose-ul:list-disc prose-ul:pl-6 prose-ol:list-decimal prose-ol:pl-6 prose-li:marker:text-muted-foreground",
        "prose-hr:border-border/50 prose-hr:my-8",
        className
      )}
      onDoubleClick={handleDoubleClick}
      title={isTyping ? "双击跳过打字效果" : undefined}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          // 段落：把普通文本里的文件路径转成可点击
          p({ node, children, ...props }) {
            const linked = React.Children.toArray(children).flatMap((child) => {
              if (typeof child === "string") {
                return linkifyFileReferences(child, {
                  projectPath,
                  className: "text-xs",
                });
              }
              return child;
            });
            return <p {...props}>{linked}</p>;
          },

          // 列表项：同上（避免文件路径出现在 li 的纯文本里时漏掉）
          li({ node, children, ...props }) {
            const linked = React.Children.toArray(children).flatMap((child) => {
              if (typeof child === "string") {
                return linkifyFileReferences(child, {
                  projectPath,
                  className: "text-xs",
                });
              }
              return child;
            });
            return <li {...props}>{linked}</li>;
          },

          // 代码块渲染
          code(props: any) {
            const { inline, className, children, ...rest } = props;
            const match = /language-(\w+)/.exec(className || '');
            const language = match ? match[1] : '';

            if (inline || !language) {
              const codeText = String(children ?? '').replace(/\n$/, '');
              const fileRef = parseFileReference(codeText);
              if (fileRef) {
                return (
                  <span className="inline-flex items-center">
                    <FilePathLinkAdapter
                      filePath={fileRef.filePath}
                      projectPath={projectPath}
                      lineNumber={fileRef.lineNumber}
                      columnNumber={fileRef.columnNumber}
                    />
                  </span>
                );
              }
              return (
                <code
                  className={cn(
                    "px-1.5 py-0.5 rounded-md bg-muted/50 border border-border/50 text-xs font-mono text-foreground/80",
                    className
                  )}
                  {...rest}
                >
                  {children}
                </code>
              );
            }

            const code = String(children).replace(/\n$/, '');
            return (
              <CodeBlockRenderer
                language={language}
                code={code}
                syntaxTheme={syntaxTheme}
              />
            );
          },

          // 链接渲染
          a({ node, children, href, ...props }) {
            return (
              <a
                href={href}
                target="_blank"
                rel="noopener noreferrer"
                className="font-medium text-primary hover:text-primary/80 transition-colors"
                {...props}
              >
                {children}
              </a>
            );
          },

          // 表格渲染
          table({ node, children, ...props }) {
            return (
              <div className="overflow-x-auto my-6 rounded-lg border border-border/50 shadow-sm">
                <table className="min-w-full divide-y divide-border/50 bg-card/30" {...props}>
                  {children}
                </table>
              </div>
            );
          },

          thead({ node, children, ...props }) {
            return (
              <thead className="bg-muted/50" {...props}>
                {children}
              </thead>
            );
          },

          th({ node, children, ...props }) {
            return (
              <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider" {...props}>
                {children}
              </th>
            );
          },

          td({ node, children, ...props }) {
            return (
              <td className="px-4 py-3 text-sm text-foreground/80 whitespace-nowrap" {...props}>
                {children}
              </td>
            );
          },
        }}
      >
        {normalizedTextToDisplay}
      </ReactMarkdown>

      {/* 流式输出光标指示器 - 只在打字中或流式输出时显示 */}
      {(isStreaming || isTyping) && (
        <span
          className={cn(
            "inline-block w-1.5 h-4 ml-1 rounded-full",
            isTyping
              ? "bg-primary animate-pulse"
              : "bg-primary/50 animate-pulse"
          )}
        />
      )}
    </div>
  );
};

MessageContentComponent.displayName = "MessageContent";

export const MessageContent = memo(MessageContentComponent);
