import { DiffSegment } from '../types';

/**
 * 计算两个字符串的字级别 diff
 * 使用 Myers diff 算法的简化版本
 */
export function computeCharDiff(original: string, corrected: string): DiffSegment[] {
  // 如果完全相同，返回单个 equal 段
  if (original === corrected) {
    return [{ type: 'equal', text: original }];
  }

  // 如果其中一个为空
  if (!original) return [{ type: 'insert', text: corrected }];
  if (!corrected) return [{ type: 'delete', text: original }];

  // 计算 LCS（最长公共子序列）
  const m = original.length;
  const n = corrected.length;

  // DP 表
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (original[i - 1] === corrected[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  // 回溯生成 diff segments
  const rawDiff: Array<{ type: 'equal' | 'delete' | 'insert'; char: string }> = [];
  let i = m, j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && original[i - 1] === corrected[j - 1]) {
      rawDiff.unshift({ type: 'equal', char: original[i - 1] });
      i--; j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      rawDiff.unshift({ type: 'insert', char: corrected[j - 1] });
      j--;
    } else {
      rawDiff.unshift({ type: 'delete', char: original[i - 1] });
      i--;
    }
  }

  // 合并连续相同类型的字符为段
  const segments: DiffSegment[] = [];
  for (const item of rawDiff) {
    const last = segments[segments.length - 1];
    if (last && last.type === item.type) {
      last.text += item.char;
    } else {
      segments.push({ type: item.type, text: item.char });
    }
  }

  return segments;
}
