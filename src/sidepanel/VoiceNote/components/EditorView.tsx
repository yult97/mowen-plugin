/**
 * 编辑区组件
 * 录音结束后的可编辑文本区域
 */

import React, { useRef, useEffect, useState } from 'react';

interface EditorViewProps {
    /** 初始内容 */
    content: string;
    /** 内容变化回调 */
    onChange: (content: string) => void;
    /** 是否禁用 */
    disabled?: boolean;
    /** 录音时长（用于显示） */
    duration?: number;
}

/** 格式化时长 */
function formatDuration(seconds?: number): string {
    if (!seconds) return '';
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}分${secs}秒`;
}

export const EditorView: React.FC<EditorViewProps> = ({
    content,
    onChange,
    disabled = false,
    duration,
}) => {
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const [charCount, setCharCount] = useState(0);

    // 自动聚焦
    useEffect(() => {
        if (!disabled && textareaRef.current) {
            textareaRef.current.focus();
            // 光标移到末尾
            textareaRef.current.setSelectionRange(content.length, content.length);
        }
    }, [disabled]);

    // 自动调整高度 & 统计字数
    useEffect(() => {
        const textarea = textareaRef.current;
        if (textarea) {
            textarea.style.height = 'auto';
            textarea.style.height = `${Math.min(textarea.scrollHeight, 400)}px`;
        }
        setCharCount(content.length);
    }, [content]);

    return (
        <div className="voice-note-editor">
            {/* 编辑区头部信息 */}
            <div className="editor-header">
                <span className="editor-title">📝 编辑笔记</span>
                <div className="editor-meta">
                    {duration && (
                        <span className="editor-duration">录音 {formatDuration(duration)}</span>
                    )}
                    <span className="editor-char-count">{charCount} 字</span>
                </div>
            </div>

            {/* 编辑区 */}
            <textarea
                ref={textareaRef}
                className="editor-textarea"
                value={content}
                onChange={(e) => onChange(e.target.value)}
                disabled={disabled}
                placeholder="编辑您的笔记内容..."
            />

            {/* 提示信息 */}
            <div className="editor-tips">
                <span>💡 您可以修改、补充或删除内容后保存</span>
            </div>
        </div>
    );
};
