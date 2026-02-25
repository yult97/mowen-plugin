/**
 * 录音脉冲圆环组件
 * 核心视觉焦点：呼吸光圈 + 声波扩散 + 精致麦克风图标
 * 支持点击触发录音
 */

import React from 'react';
import { VoiceNoteState } from '../types';

interface RecordingPulseProps {
    /** 当前录音状态 */
    status: VoiceNoteState;
    /** 点击回调 */
    onClick?: () => void;
}

/** 麦克风 SVG 图标 */
const MicrophoneIcon: React.FC<{ className?: string }> = ({ className }) => (
    <svg
        className={className}
        width="48"
        height="48"
        viewBox="0 0 24 24"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
    >
        {/* 麦克风主体 */}
        <rect
            x="9"
            y="2"
            width="6"
            height="11"
            rx="3"
            fill="url(#micGradient)"
        />
        {/* 麦克风支架 */}
        <path
            d="M5 10V11C5 14.866 8.13401 18 12 18C15.866 18 19 14.866 19 11V10"
            stroke="url(#micStrokeGradient)"
            strokeWidth="2"
            strokeLinecap="round"
        />
        {/* 麦克风底座 */}
        <path
            d="M12 18V22M8 22H16"
            stroke="url(#micStrokeGradient)"
            strokeWidth="2"
            strokeLinecap="round"
        />
        {/* 渐变定义 */}
        <defs>
            <linearGradient id="micGradient" x1="12" y1="2" x2="12" y2="13" gradientUnits="userSpaceOnUse">
                <stop stopColor="#C4454A" />
                <stop offset="1" stopColor="#A83538" />
            </linearGradient>
            <linearGradient id="micStrokeGradient" x1="12" y1="10" x2="12" y2="22" gradientUnits="userSpaceOnUse">
                <stop stopColor="#BF4045" />
                <stop offset="1" stopColor="#8B2D31" />
            </linearGradient>
        </defs>
    </svg>
);

export const RecordingPulse: React.FC<RecordingPulseProps> = ({ status, onClick }) => {
    const isRecording = status === 'recording';
    const isPaused = status === 'paused';
    const isActive = isRecording || isPaused;
    const isClickable = status === 'idle' && onClick;

    return (
        <div
            className={`recording-pulse ${isActive ? 'recording-pulse--active' : ''} ${isClickable ? 'recording-pulse--clickable' : ''}`}
            onClick={isClickable ? onClick : undefined}
            role={isClickable ? 'button' : undefined}
            tabIndex={isClickable ? 0 : undefined}
            onKeyDown={isClickable ? (e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    onClick?.();
                }
            } : undefined}
        >
            {/* 外层声波扩散纹（仅录音时显示） */}
            {isRecording && (
                <>
                    <div className="pulse-wave pulse-wave--1" />
                    <div className="pulse-wave pulse-wave--2" />
                    <div className="pulse-wave pulse-wave--3" />
                </>
            )}

            {/* 呼吸光圈 */}
            <div className={`pulse-ring ${isRecording ? 'pulse-ring--recording' : ''} ${isPaused ? 'pulse-ring--paused' : ''}`}>
                {/* 内层光晕 */}
                <div className="pulse-glow" />

                {/* 麦克风图标 */}
                <div className="pulse-icon">
                    <MicrophoneIcon />
                </div>
            </div>

            {/* 底部装饰光效 */}
            <div className="pulse-reflection" />
        </div>
    );
};

export default RecordingPulse;
