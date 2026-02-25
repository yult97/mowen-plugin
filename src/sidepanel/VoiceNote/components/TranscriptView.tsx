/**
 * 转写展示区组件
 * 显示 Final 文本 + Partial 吐字 + 修订提示
 */

import React, { useEffect, useState, useRef } from 'react';
import { TranscriptState, VoiceNoteState } from '../types';
import { RevisionTag } from './RevisionTag';
import { RecordingPulse } from './RecordingPulse';
import { DiffText } from './DiffText';

interface TranscriptViewProps {
    /** 转写状态 */
    transcript: TranscriptState;
    /** 录音状态 */
    status?: VoiceNoteState;
    /** 开始录音回调（点击脉冲圆环触发） */
    onStartRecording?: () => void;
    /** 清除修订标记回调 */
    onClearRevision: () => void;
}

export const TranscriptView: React.FC<TranscriptViewProps> = ({
    transcript,
    status = 'idle',
    onStartRecording,
    onClearRevision,
}) => {
    const { finalTextBlocks, partialText, revisionMark } = transcript;
    const [highlightedIndex, setHighlightedIndex] = useState<number | null>(null);
    const [showRevisionTag, setShowRevisionTag] = useState(false);
    const containerRef = useRef<HTMLDivElement>(null);

    // 处理修订高亮动画
    useEffect(() => {
        if (revisionMark) {
            // 立即显示高亮和标签
            setHighlightedIndex(revisionMark.blockIndex);
            setShowRevisionTag(true);

            // 0.8s 后移除高亮效果
            const highlightTimer = setTimeout(() => {
                setHighlightedIndex(null);
            }, 800);

            // 3s 后清除修订状态
            const clearTimer = setTimeout(() => {
                setShowRevisionTag(false);
                onClearRevision();
            }, 3000);

            return () => {
                clearTimeout(highlightTimer);
                clearTimeout(clearTimer);
            };
        }
    }, [revisionMark, onClearRevision]);

    // 自动滚动到底部
    useEffect(() => {
        if (containerRef.current) {
            containerRef.current.scrollTop = containerRef.current.scrollHeight;
        }
    }, [finalTextBlocks, partialText]);

    return (
        <div className="voice-note-transcript" ref={containerRef}>
            {/* Final 文本区 */}
            <div className="transcript-final">
                {finalTextBlocks.map((block, index) => (
                    <div
                        key={index}
                        className={`transcript-block ${highlightedIndex === index ? 'transcript-block--highlighted' : ''
                            } ${revisionMark?.blockIndex === index ? 'transcript-block--revised' : ''
                            }`}
                    >
                        {revisionMark?.blockIndex === index && revisionMark.diffSegments ? (
                            <DiffText segments={revisionMark.diffSegments} />
                        ) : (
                            <span className="transcript-text">{block}</span>
                        )}
                        {showRevisionTag && revisionMark?.blockIndex === index && (
                            <RevisionTag />
                        )}
                    </div>
                ))}
            </div>

            {/* Partial 吐字区 */}
            {partialText && (
                <div className="transcript-partial">
                    <span className="partial-text">{partialText}</span>
                    <span className="partial-cursor">|</span>
                </div>
            )}

            {/* 空状态：使用 RecordingPulse 组件，点击可开始录音 */}
            {finalTextBlocks.length === 0 && !partialText && (
                <div className="transcript-empty">
                    <RecordingPulse status={status} onClick={onStartRecording} />
                    <span>点击麦克风或下方按钮开始录音</span>
                </div>
            )}
        </div>
    );
};
