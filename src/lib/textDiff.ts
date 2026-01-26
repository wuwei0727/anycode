/**
 * 文本差异对比工具
 * 用于计算和显示原始文本与优化后文本之间的差异
 */

export type DiffType = 'unchanged' | 'added' | 'removed';

export interface DiffSegment {
  type: DiffType;
  text: string;
}

/**
 * 计算两个文本之间的差异
 * 使用简化的 LCS (Longest Common Subsequence) 算法
 * @param original 原始文本
 * @param enhanced 优化后的文本
 * @returns 差异片段数组
 */
export function computeDiff(original: string, enhanced: string): DiffSegment[] {
  // 如果两个文本相同，直接返回
  if (original === enhanced) {
    return original ? [{ type: 'unchanged', text: original }] : [];
  }

  // 如果原始文本为空
  if (!original) {
    return enhanced ? [{ type: 'added', text: enhanced }] : [];
  }

  // 如果优化后文本为空
  if (!enhanced) {
    return [{ type: 'removed', text: original }];
  }

  // 按单词分割进行比较（保留空格）
  const originalWords = tokenize(original);
  const enhancedWords = tokenize(enhanced);

  // 计算 LCS
  const lcs = computeLCS(originalWords, enhancedWords);

  // 根据 LCS 生成差异
  return generateDiffFromLCS(originalWords, enhancedWords, lcs);
}

/**
 * 将文本分割为 token（单词和空格）
 */
function tokenize(text: string): string[] {
  // 按单词边界分割，保留空格和标点
  const tokens: string[] = [];
  let current = '';
  
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    
    if (/\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = '';
      }
      tokens.push(char);
    } else if (/[.,!?;:'"()[\]{}]/.test(char)) {
      if (current) {
        tokens.push(current);
        current = '';
      }
      tokens.push(char);
    } else {
      current += char;
    }
  }
  
  if (current) {
    tokens.push(current);
  }
  
  return tokens;
}

/**
 * 计算最长公共子序列 (LCS)
 */
function computeLCS(a: string[], b: string[]): number[][] {
  const m = a.length;
  const n = b.length;
  
  // 创建 DP 表
  const dp: number[][] = Array(m + 1).fill(null).map(() => Array(n + 1).fill(0));
  
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }
  
  return dp;
}

/**
 * 根据 LCS 生成差异片段
 */
function generateDiffFromLCS(
  original: string[],
  enhanced: string[],
  dp: number[][]
): DiffSegment[] {
  const result: DiffSegment[] = [];
  let i = original.length;
  let j = enhanced.length;
  
  // 临时存储，用于合并连续的相同类型片段
  const tempResult: DiffSegment[] = [];
  
  // 回溯 LCS
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && original[i - 1] === enhanced[j - 1]) {
      // 相同的 token
      tempResult.unshift({ type: 'unchanged', text: original[i - 1] });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      // 新增的 token
      tempResult.unshift({ type: 'added', text: enhanced[j - 1] });
      j--;
    } else if (i > 0) {
      // 删除的 token
      tempResult.unshift({ type: 'removed', text: original[i - 1] });
      i--;
    }
  }
  
  // 合并连续的相同类型片段
  for (const segment of tempResult) {
    const last = result[result.length - 1];
    if (last && last.type === segment.type) {
      last.text += segment.text;
    } else {
      result.push({ ...segment });
    }
  }
  
  return result;
}

/**
 * 计算差异统计信息
 */
export function computeDiffStats(diff: DiffSegment[]): {
  addedCount: number;
  removedCount: number;
  unchangedCount: number;
  changePercentage: number;
} {
  let addedCount = 0;
  let removedCount = 0;
  let unchangedCount = 0;
  
  for (const segment of diff) {
    const length = segment.text.length;
    switch (segment.type) {
      case 'added':
        addedCount += length;
        break;
      case 'removed':
        removedCount += length;
        break;
      case 'unchanged':
        unchangedCount += length;
        break;
    }
  }
  
  const total = addedCount + removedCount + unchangedCount;
  const changePercentage = total > 0 
    ? Math.round(((addedCount + removedCount) / total) * 100) 
    : 0;
  
  return {
    addedCount,
    removedCount,
    unchangedCount,
    changePercentage,
  };
}

/**
 * 将差异片段转换为 HTML 字符串（用于渲染）
 */
export function diffToHtml(diff: DiffSegment[]): string {
  return diff.map(segment => {
    const escapedText = escapeHtml(segment.text);
    switch (segment.type) {
      case 'added':
        return `<span class="diff-added">${escapedText}</span>`;
      case 'removed':
        return `<span class="diff-removed">${escapedText}</span>`;
      default:
        return escapedText;
    }
  }).join('');
}

/**
 * 转义 HTML 特殊字符
 */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
    .replace(/\n/g, '<br/>');
}
