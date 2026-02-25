/**
 * 状态条组件
 * 显示录音状态、时长等信息
 */

import React from 'react';
import { VoiceNoteState } from '../types';
import { ConnectionStatus } from '../services';

interface StatusBarProps {
    /** 当前状态 */
    status: VoiceNoteState;
    /** 录音时长（秒） */
    duration: number;
    /** 连接状态 */
    connectionStatus?: ConnectionStatus;
}

/** 格式化时长 mm:ss */
function formatDuration(seconds: number): string {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
}

/** 获取状态显示配置 */
function getStatusConfig(status: VoiceNoteState, connectionStatus?: ConnectionStatus) {
    if (connectionStatus === 'connecting') return { dot: 'loading', text: '连接中...' };
    if (connectionStatus === 'reconnecting') return { dot: 'warning', text: '网络波动...' };
    if (connectionStatus === 'error') return { dot: 'error', text: '连接异常' };

    switch (status) {
        case 'recording':
            return { dot: 'recording', text: '录音中' };
        case 'paused':
            return { dot: 'paused', text: '已暂停' };
        case 'finalizing':
            return { dot: 'loading', text: '整理中...' };
        case 'editing':
            return { dot: 'editing', text: '编辑中' };
        case 'saving':
            return { dot: 'loading', text: '保存中...' };
        case 'done':
            return { dot: 'done', text: '已保存' };
        default:
            return { dot: 'idle', text: '准备就绪' };
    }
}

export const StatusBar: React.FC<StatusBarProps> = ({ status, duration, connectionStatus }) => {
    const config = getStatusConfig(status, connectionStatus);
    const showTimer = status === 'recording' || status === 'paused';

    return (
        <div className="voice-note-status-bar">
            <span className={`status-dot status-dot--${config.dot}`} />
            <span className="status-text">{config.text}</span>
            {showTimer && (
                <span className="status-timer">{formatDuration(duration)}</span>
            )}
        </div>
    );
};
