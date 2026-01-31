/**
 * Codex diff helpers
 * Extracts before/after snippets from patch-like diffs
 */

export interface PatchDiff {
  oldText: string;
  newText: string;
}

export interface PatchFileChunk {
  filePath: string;
  patchText: string;
}

export const extractFilePathFromPatchText = (patchText: string): string | null => {
  if (!patchText || typeof patchText !== 'string') return null;

  const lines = patchText.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const m1 = trimmed.match(/^\*\*\*\s+(?:Update|Add|Create|Delete)\s+File:\s+(.+)$/i);
    if (m1) return m1[1]?.trim() || null;

    // Unified diff headers
    const m2 = trimmed.match(/^\+\+\+\s+b\/(.+)$/);
    if (m2) return m2[1]?.trim() || null;
    const m3 = trimmed.match(/^---\s+a\/(.+)$/);
    if (m3) return m3[1]?.trim() || null;

    const m4 = trimmed.match(/^diff --git a\/(.+?) b\/(.+)$/);
    if (m4) return m4[2]?.trim() || null;
  }

  return null;
};

/**
 * Splits a multi-file patch into per-file chunks.
 *
 * Supports:
 * - apply_patch format (*** Begin Patch / *** Update File:)
 * - unified diff format (diff --git a/... b/...)
 */
export const splitPatchIntoFileChunks = (patchText: string): PatchFileChunk[] => {
  if (!patchText || typeof patchText !== 'string') return [];

  const lines = patchText.split(/\r?\n/);

  // 1) apply_patch format (supports multiple "*** Update File:" blocks).
  const headerRe = /^\*\*\*\s+(Update|Add|Create|Delete)\s+File:\s+(.+)$/i;
  const hasApplyPatchHeaders = lines.some((l) => headerRe.test(l.trim()));
  if (hasApplyPatchHeaders) {
    const beginLine = lines.find((l) => l.trim().startsWith('*** Begin Patch'))?.trim() || null;
    const endLine = lines.find((l) => l.trim().startsWith('*** End Patch'))?.trim() || null;

    const chunks: Array<{ filePath: string; bodyLines: string[] }> = [];
    let current: { filePath: string; bodyLines: string[] } | null = null;

    for (const rawLine of lines) {
      const line = rawLine ?? '';
      const trimmed = line.trim();

      const m = trimmed.match(headerRe);
      if (m) {
        if (current) chunks.push(current);
        current = { filePath: (m[2] || '').trim(), bodyLines: [trimmed] };
        continue;
      }

      if (!current) continue;
      if (endLine && trimmed === endLine) continue;
      if (beginLine && trimmed === beginLine) continue;
      current.bodyLines.push(line);
    }

    if (current) chunks.push(current);

    return chunks
      .map((c) => {
        const fp = c.filePath.trim();
        if (!fp) return null;
        const outLines: string[] = [];
        if (beginLine) outLines.push(beginLine);
        outLines.push(...c.bodyLines);
        if (endLine) outLines.push(endLine);
        return { filePath: fp, patchText: outLines.join('\n') };
      })
      .filter(Boolean) as PatchFileChunk[];
  }

  // 2) unified diff format (supports multiple "diff --git" blocks).
  const diffGitRe = /^diff --git a\/(.+?) b\/(.+)$/;
  const hasDiffGit = lines.some((l) => diffGitRe.test(l));
  if (hasDiffGit) {
    const chunks: PatchFileChunk[] = [];
    let current: { filePath: string; lines: string[] } | null = null;

    for (const line of lines) {
      const m = line.match(diffGitRe);
      if (m) {
        if (current) chunks.push({ filePath: current.filePath, patchText: current.lines.join('\n') });
        current = { filePath: (m[2] || '').trim(), lines: [line] };
        continue;
      }
      if (!current) continue;
      current.lines.push(line);
    }
    if (current) chunks.push({ filePath: current.filePath, patchText: current.lines.join('\n') });
    return chunks.filter((c) => c.filePath.trim().length > 0);
  }

  // 3) Single-file patch fallback.
  const single = extractFilePathFromPatchText(patchText);
  return single ? [{ filePath: single, patchText }] : [];
};

const isDiffHeaderLine = (line: string): boolean => {
  return (
    line.startsWith('diff ') ||
    line.startsWith('index ') ||
    line.startsWith('new file') ||
    line.startsWith('deleted file') ||
    line.startsWith('old mode') ||
    line.startsWith('new mode') ||
    line.startsWith('--- ') ||
    line.startsWith('+++ ') ||
    line.startsWith('@@') ||
    line.startsWith('\\ No newline')
  );
};

const isApplyPatchHeaderLine = (line: string): boolean => {
  return (
    line.startsWith('*** Begin Patch') ||
    line.startsWith('*** End Patch') ||
    line.startsWith('*** Update File:') ||
    line.startsWith('*** Add File:') ||
    line.startsWith('*** Create File:') ||
    line.startsWith('*** Delete File:')
  );
};

/**
 * Best-effort extraction of old/new snippets from unified diff / apply_patch text.
 * Returns null if no diff-like lines are found.
 */
export const extractOldNewFromPatchText = (patchText: string): PatchDiff | null => {
  if (!patchText || typeof patchText !== 'string') return null;

  const lines = patchText.split(/\r?\n/);
  const oldLines: string[] = [];
  const newLines: string[] = [];
  let inHunk = false;
  let sawChange = false;

  for (const line of lines) {
    if (!line) {
      // Empty line: only treat as context if we're already inside a hunk
      if (inHunk) {
        oldLines.push('');
        newLines.push('');
      }
      continue;
    }

    if (isApplyPatchHeaderLine(line) || isDiffHeaderLine(line)) {
      if (line.startsWith('@@')) inHunk = true;
      continue;
    }

    if (line.startsWith('+') && !line.startsWith('+++')) {
      newLines.push(line.slice(1));
      sawChange = true;
      inHunk = true;
      continue;
    }

    if (line.startsWith('-') && !line.startsWith('---')) {
      oldLines.push(line.slice(1));
      sawChange = true;
      inHunk = true;
      continue;
    }

    if (line.startsWith(' ')) {
      const ctx = line.slice(1);
      oldLines.push(ctx);
      newLines.push(ctx);
      inHunk = true;
      continue;
    }

    if (inHunk) {
      // Some patch formats omit the leading space for context lines
      oldLines.push(line);
      newLines.push(line);
    }
  }

  if (!sawChange && oldLines.length === 0 && newLines.length === 0) return null;

  return {
    oldText: oldLines.join('\n'),
    newText: newLines.join('\n'),
  };
};
