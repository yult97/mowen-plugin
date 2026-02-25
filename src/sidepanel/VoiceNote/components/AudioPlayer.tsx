/**
 * 音频播放器组件
 * 支持录音态实时更新和编辑态完整回放
 */

import React, { useRef, useState, useEffect, useCallback } from 'react';

interface AudioPlayerProps {
    /** WAV Blob URL */
    audioUrl: string;
    /** 是否正在录音（录音态下禁用 seek，显示实时时长） */
    isRecording?: boolean;
    /** 是否处于暂停状态（暂停时允许回放已录制内容） */
    isPaused?: boolean;
    /** 录音时长（秒），录音态下用于显示 */
    recordingDuration?: number;
    /** 录音状态文字（如"录音中"、"已暂停"） */
    statusText?: string;
    /** 录音状态点样式（如"recording"、"paused"） */
    statusDot?: string;
}

/** 格式化秒数为 mm:ss */
function formatTime(seconds: number): string {
    if (!isFinite(seconds) || seconds < 0) return '00:00';
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
}

export const AudioPlayer: React.FC<AudioPlayerProps> = ({
    audioUrl,
    isRecording = false,
    isPaused = false,
    recordingDuration = 0,
    statusText,
    statusDot,
}) => {
    const audioRef = useRef<HTMLAudioElement>(null);
    const [isPlaying, setIsPlaying] = useState(false);
    const [currentTime, setCurrentTime] = useState(0);
    const [duration, setDuration] = useState(0);
    const progressTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

    // audioUrl 变化时重置状态
    useEffect(() => {
        setIsPlaying(false);
        setCurrentTime(0);
        if (audioRef.current) {
            audioRef.current.pause();
            audioRef.current.load();
        }
    }, [audioUrl]);

    // 清理定时器
    useEffect(() => {
        return () => {
            if (progressTimerRef.current) {
                clearInterval(progressTimerRef.current);
            }
        };
    }, []);
    // 监听 audio 事件
    const handleLoadedMetadata = useCallback(() => {
        if (audioRef.current && isFinite(audioRef.current.duration)) {
            setDuration(audioRef.current.duration);
        }
    }, []);

    const handleEnded = useCallback(() => {
        setIsPlaying(false);
        setCurrentTime(0);
        if (progressTimerRef.current) {
            clearInterval(progressTimerRef.current);
            progressTimerRef.current = null;
        }
    }, []);

    // 播放/暂停
    const togglePlay = useCallback(() => {
        const audio = audioRef.current;
        if (!audio || !audioUrl) return;

        if (isPlaying) {
            audio.pause();
            setIsPlaying(false);
            if (progressTimerRef.current) {
                clearInterval(progressTimerRef.current);
                progressTimerRef.current = null;
            }
        } else {
            audio.play().then(() => {
                setIsPlaying(true);
                // 用定时器更新进度（比 timeupdate 事件更平滑）
                progressTimerRef.current = setInterval(() => {
                    if (audioRef.current) {
                        setCurrentTime(audioRef.current.currentTime);
                    }
                }, 100);
            }).catch(() => {
                // 播放失败（如用户未交互）
            });
        }
    }, [isPlaying, audioUrl]);

    // 暂停时允许播放和 seek，录音中禁用
    const playbackDisabled = isRecording && !isPaused;

    // 恢复录音时停止播放
    useEffect(() => {
        if (isRecording && !isPaused && isPlaying) {
            audioRef.current?.pause();
            setIsPlaying(false);
            if (progressTimerRef.current) {
                clearInterval(progressTimerRef.current);
                progressTimerRef.current = null;
            }
        }
    }, [isRecording, isPaused, isPlaying]);

    // 进度条点击 seek
    const handleProgressClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
        if (playbackDisabled || !audioRef.current || !duration) return;
        const rect = e.currentTarget.getBoundingClientRect();
        const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
        const newTime = ratio * duration;
        audioRef.current.currentTime = newTime;
        setCurrentTime(newTime);
    }, [playbackDisabled, duration]);

    const displayDuration = isRecording ? recordingDuration : duration;
    const progress = displayDuration > 0 ? (currentTime / displayDuration) * 100 : 0;

    // 非录音态且无音频时不渲染
    if (!audioUrl && !isRecording) return null;

    return (
        <div className="audio-player">
            {/* 录音态：内嵌状态栏 */}
            {isRecording && statusText && (
                <div className="audio-player-status">
                    <span className={`status-dot status-dot--${statusDot || 'recording'}`} />
                    <span className="audio-player-status-text">{statusText}</span>
                    <span className="audio-player-status-timer">{formatTime(recordingDuration)}</span>
                </div>
            )}

            <audio
                ref={audioRef}
                src={audioUrl}
                preload="metadata"
                onLoadedMetadata={handleLoadedMetadata}
                onEnded={handleEnded}
            />

            {/* 播放按钮 + 进度条 */}
            <div className="audio-player-controls">
                <button
                    className={`audio-player-btn ${isPlaying ? 'audio-player-btn--playing' : ''}`}
                    onClick={togglePlay}
                    disabled={playbackDisabled || !audioUrl}
                    aria-label={isPlaying ? '暂停播放' : '播放录音'}
                >
                    {isPlaying ? (
                        <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
                            <rect x="3" y="2" width="4" height="12" rx="1" />
                            <rect x="9" y="2" width="4" height="12" rx="1" />
                        </svg>
                    ) : (
                        <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
                            <path d="M4 2.5v11l9-5.5L4 2.5z" />
                        </svg>
                    )}
                </button>

                <div className="audio-player-track">
                    <div
                        className={`audio-player-progress ${playbackDisabled ? 'audio-player-progress--disabled' : ''}`}
                        onClick={handleProgressClick}
                    >
                        <div
                            className="audio-player-progress-fill"
                            style={{ width: `${Math.min(100, progress)}%` }}
                        />
                    </div>
                    <div className="audio-player-time">
                        <span>{formatTime(currentTime)}</span>
                        <span>{formatTime(displayDuration)}</span>
                    </div>
                </div>
            </div>
        </div>
    );
};
