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

type PatchLine =
  | { kind: 'context'; text: string }
  | { kind: 'add'; text: string }
  | { kind: 'del'; text: string };

type PatchHunk = {
  oldStart?: number;
  newStart?: number;
  lines: PatchLine[];
};

type PatchApplyDirection = 'forward' | 'reverse';

const parseUnifiedHunkHeader = (line: string): { oldStart?: number; newStart?: number } => {
  // Standard unified diff format: @@ -a,b +c,d @@
  const m = line.match(/^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/);
  if (!m) return {};
  const oldStart = Number(m[1]);
  const newStart = Number(m[2]);
  return {
    oldStart: Number.isFinite(oldStart) ? oldStart : undefined,
    newStart: Number.isFinite(newStart) ? newStart : undefined,
  };
};

const splitTextToLines = (text: string): { lines: string[]; hasTrailingNewline: boolean } => {
  const normalized = (text || '').replace(/\r\n/g, '\n');
  const hasTrailingNewline = normalized.endsWith('\n');
  const parts = normalized.split('\n');
  if (parts.length > 0 && parts[parts.length - 1] === '') parts.pop();
  return { lines: parts, hasTrailingNewline };
};

const parsePatchHunks = (patchText: string): PatchHunk[] => {
  if (!patchText) return [];
  const lines = patchText.split(/\r?\n/);

  const hunks: PatchHunk[] = [];
  let current: PatchHunk | null = null;
  let inHunk = false;

  const pushCurrent = () => {
    if (current && current.lines.length > 0) hunks.push(current);
    current = null;
    inHunk = false;
  };

  const ensureHunk = () => {
    if (!current) current = { lines: [] };
  };

  for (const raw of lines) {
    const line = raw ?? '';

    if (line.startsWith('@@')) {
      pushCurrent();
      current = { ...parseUnifiedHunkHeader(line), lines: [] };
      inHunk = true;
      continue;
    }

    if (isApplyPatchHeaderLine(line) || isDiffHeaderLine(line)) {
      continue;
    }

    if (line.startsWith('\\ No newline')) continue;

    if (line.startsWith('+') && !line.startsWith('+++')) {
      ensureHunk();
      current!.lines.push({ kind: 'add', text: line.slice(1) });
      inHunk = true;
      continue;
    }

    if (line.startsWith('-') && !line.startsWith('---')) {
      ensureHunk();
      current!.lines.push({ kind: 'del', text: line.slice(1) });
      inHunk = true;
      continue;
    }

    if (line.startsWith(' ')) {
      ensureHunk();
      current!.lines.push({ kind: 'context', text: line.slice(1) });
      inHunk = true;
      continue;
    }

    // Some patch formats omit the leading space for context lines inside a hunk.
    if (inHunk) {
      ensureHunk();
      current!.lines.push({ kind: 'context', text: line });
    }
  }

  pushCurrent();
  return hunks;
};

const matchesSeqAt = (lines: string[], seq: string[], at: number): boolean => {
  if (seq.length === 0) return true;
  if (at < 0) return false;
  if (at + seq.length > lines.length) return false;
  for (let j = 0; j < seq.length; j++) {
    if (lines[at + j] !== seq[j]) return false;
  }
  return true;
};

const findSeqWithGuess = (lines: string[], seq: string[], cursor: number, guess: number | null): number => {
  if (seq.length === 0) return Math.max(0, Math.min(cursor, lines.length));

  const maxStart = lines.length - seq.length;
  if (maxStart < 0) return -1;

  const clampedCursor = Math.max(0, Math.min(cursor, maxStart));

  if (guess !== null && Number.isFinite(guess)) {
    const g = Math.max(0, Math.min(guess, maxStart));
    const start = Math.max(0, g - 50);
    const end = Math.min(maxStart, g + 50);
    for (let i = start; i <= end; i++) {
      if (matchesSeqAt(lines, seq, i)) return i;
    }
  }

  for (let i = clampedCursor; i <= maxStart; i++) {
    if (matchesSeqAt(lines, seq, i)) return i;
  }

  for (let i = 0; i < clampedCursor; i++) {
    if (matchesSeqAt(lines, seq, i)) return i;
  }

  return -1;
};

const buildHunkSequences = (
  hunk: PatchHunk,
  direction: PatchApplyDirection
): { expected: string[]; replacement: string[] } => {
  const expected: string[] = [];
  const replacement: string[] = [];

  for (const line of hunk.lines) {
    if (line.kind === 'context') {
      expected.push(line.text);
      replacement.push(line.text);
      continue;
    }

    if (direction === 'forward') {
      if (line.kind === 'del') expected.push(line.text);
      if (line.kind === 'add') replacement.push(line.text);
    } else {
      if (line.kind === 'add') expected.push(line.text);
      if (line.kind === 'del') replacement.push(line.text);
    }
  }

  return { expected, replacement };
};

/**
 * Best-effort apply unified/apply_patch-like diffs onto a text blob.
 *
 * - `forward`: old -> new
 * - `reverse`: new -> old
 *
 * Returns `null` when the patch can't be applied cleanly.
 */
export const tryApplyPatchToText = (
  baseText: string,
  patchText: string,
  direction: PatchApplyDirection = 'forward'
): string | null => {
  if (!patchText || typeof patchText !== 'string') return null;
  if (!patchText.trim()) return null;

  const hunks = parsePatchHunks(patchText);
  if (hunks.length === 0) return null;

  const { lines: baseLines, hasTrailingNewline } = splitTextToLines(baseText || '');
  const out = baseLines.slice();

  let cursor = 0;
  for (const hunk of hunks) {
    const { expected, replacement } = buildHunkSequences(hunk, direction);

    const guessLine = direction === 'forward' ? hunk.oldStart : hunk.newStart;
    const guess = typeof guessLine === 'number' ? Math.max(0, guessLine - 1) : null;

    const start = findSeqWithGuess(out, expected, cursor, guess);
    if (start < 0) return null;

    out.splice(start, expected.length, ...replacement);
    cursor = start + replacement.length;
  }

  return out.join('\n') + (hasTrailingNewline ? '\n' : '');
};
