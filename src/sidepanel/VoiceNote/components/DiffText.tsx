/**
 * 内联 Diff 展示组件
 * 显示删除线（红色）和新增文本（绿色），5秒后自动消失
 */

import React, { useState, useEffect } from 'react';
import { DiffSegment } from '../types';

interface DiffTextProps {
  segments: DiffSegment[];
  /** 自动消失延迟（毫秒） */
  autoFadeMs?: number;
  /** 消失后的回调 */
  onFadeComplete?: () => void;
}

export const DiffText: React.FC<DiffTextProps> = ({
  segments,
  autoFadeMs = 5000,
  onFadeComplete,
}) => {
  const [showDiff, setShowDiff] = useState(true);
  const [isFading, setIsFading] = useState(false);

  useEffect(() => {
    // 开始淡出
    const fadeTimer = setTimeout(() => {
      setIsFading(true);
    }, autoFadeMs);

    // 完全隐藏 diff 标记
    const hideTimer = setTimeout(() => {
      setShowDiff(false);
      onFadeComplete?.();
    }, autoFadeMs + 600);

    return () => {
      clearTimeout(fadeTimer);
      clearTimeout(hideTimer);
    };
  }, [autoFadeMs, onFadeComplete]);

  if (!showDiff) {
    // diff 消失后只显示最终文本（insert + equal）
    return (
      <span className="transcript-text">
        {segments.filter(s => s.type !== 'delete').map(s => s.text).join('')}
      </span>
    );
  }

  return (
    <span className={`transcript-text diff-container ${isFading ? 'diff-container--fading' : ''}`}>
      {segments.map((seg, i) => {
        switch (seg.type) {
          case 'delete':
            return (
              <del key={i} className="diff-delete" aria-label="删除的文本">
                {seg.text}
              </del>
            );
          case 'insert':
            return (
              <ins key={i} className="diff-insert" aria-label="新增的文本">
                {seg.text}
              </ins>
            );
          default:
            return <span key={i}>{seg.text}</span>;
        }
      })}
    </span>
  );
};
