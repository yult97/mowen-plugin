/**
 * 底部操作按钮组
 */

import React from 'react';
import { VoiceNoteState } from '../types';

interface ActionBarProps {
    /** 当前状态 */
    status: VoiceNoteState;
    /** 开始录音 */
    onStart: () => void;
    /** 暂停 */
    onPause: () => void;
    /** 继续 */
    onResume: () => void;
    /** 结束 */
    onStop: () => void;
    /** 继续补录 */
    onContinue: () => void;
    /** 保存 */
    onSave: () => void;
    /** 取消/返回 */
    onCancel: () => void;
}

export const ActionBar: React.FC<ActionBarProps> = ({
    status,
    onStart,
    onPause,
    onResume,
    onStop,
    onContinue,
    onSave,
    onCancel,
}) => {
    // 根据状态渲染不同按钮组
    const renderButtons = () => {
        switch (status) {
            case 'idle':
                return (
                    <>
                        <button className="btn btn--secondary" onClick={onCancel}>
                            取消
                        </button>
                        <button className="btn btn--primary" onClick={onStart}>
                            开始录音
                        </button>
                    </>
                );

            case 'recording':
                return (
                    <>
                        <button className="btn btn--secondary" onClick={onPause}>
                            暂停
                        </button>
                        <button className="btn btn--primary" onClick={onStop}>
                            结束
                        </button>
                    </>
                );

            case 'paused':
                return (
                    <>
                        <button className="btn btn--secondary" onClick={onStop}>
                            结束
                        </button>
                        <button className="btn btn--primary" onClick={onResume}>
                            继续
                        </button>
                    </>
                );

            case 'finalizing':
                return (
                    <button className="btn btn--primary" disabled>
                        整理中...
                    </button>
                );

            case 'editing':
                return (
                    <>
                        <button className="btn btn--secondary" onClick={onContinue}>
                            继续补录
                        </button>
                        <button className="btn btn--primary" onClick={onSave}>
                            保存到墨问
                        </button>
                    </>
                );

            case 'saving':
                return (
                    <button className="btn btn--primary btn--loading" disabled>
                        <span className="loading-spinner" />
                        保存中...
                    </button>
                );

            case 'done':
                return (
                    <button className="btn btn--primary" onClick={onCancel}>
                        完成
                    </button>
                );

            default:
                return null;
        }
    };

    return (
        <div className="voice-note-action-bar">
            {renderButtons()}
        </div>
    );
};
