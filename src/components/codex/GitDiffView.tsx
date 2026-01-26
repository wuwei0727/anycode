import React, { useMemo } from 'react';
import { DiffView, DiffModeEnum } from '@git-diff-view/react';
import { generateDiffFile } from '@git-diff-view/file';

export interface GitDiffViewProps {
  filePath: string;
  oldText: string;
  newText: string;
  theme: 'light' | 'dark';
  fontSize?: number;
}

function inferLang(filePath: string): string {
  const ext = (filePath.split('.').pop() || '').toLowerCase();
  const map: Record<string, string> = {
    ts: 'typescript',
    tsx: 'typescript',
    js: 'javascript',
    jsx: 'javascript',
    mjs: 'javascript',
    cjs: 'javascript',
    json: 'json',
    md: 'markdown',
    css: 'css',
    scss: 'scss',
    less: 'less',
    html: 'html',
    xml: 'xml',
    yml: 'yaml',
    yaml: 'yaml',
    toml: 'toml',
    rs: 'rust',
    py: 'python',
    go: 'go',
    java: 'java',
    kt: 'kotlin',
    swift: 'swift',
    c: 'c',
    h: 'c',
    cpp: 'cpp',
    hpp: 'cpp',
    cs: 'csharp',
    sh: 'bash',
    bat: 'bat',
    sql: 'sql',
  };
  return map[ext] || ext || 'text';
}

export const GitDiffView: React.FC<GitDiffViewProps> = ({
  filePath,
  oldText,
  newText,
  theme,
  fontSize = 12,
}) => {
  const diffFile = useMemo(() => {
    const lang = inferLang(filePath);
    const file = generateDiffFile(filePath, oldText || '', filePath, newText || '', lang, lang);
    file.initTheme(theme);
    file.init();
    file.buildSplitDiffLines();
    return file;
  }, [filePath, oldText, newText, theme]);

  return (
    <DiffView
      diffFile={diffFile}
      diffViewMode={DiffModeEnum.Split}
      diffViewTheme={theme}
      diffViewHighlight
      diffViewWrap
      diffViewFontSize={fontSize}
    />
  );
};

export default GitDiffView;

