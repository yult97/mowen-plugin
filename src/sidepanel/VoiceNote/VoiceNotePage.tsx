/**
 * AI 语音笔记主页面
 */

import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useVoiceNoteState, useAudioRecorder, useTranscriber } from './hooks';
import { StatusBar, TranscriptView, EditorView, ActionBar, FinalizingView, Snackbar, AudioPlayer } from './components';
import { MowenNoteSaver, INoteSaver, TranscriberCallbacks } from './services';
import { pcmChunksToWavUrl } from './services/pcmToWav';
import { pcmChunksToMp3Blob } from './services/pcmToMp3';
import type { AudioSource } from './hooks/useAudioRecorder';
import './styles.css';

interface VoiceNotePageProps {
    /** 返回上一页回调 */
    onBack?: () => void;
}

/** 权限引导组件 */
const PermissionGuide: React.FC<{ onRetry: () => void }> = ({ onRetry }) => (
    <div className="permission-guide">
        <div className="permission-icon">🎤</div>
        <h3>需要麦克风权限</h3>
        <p>请在浏览器中允许访问麦克风，以使用语音笔记功能</p>
        <button className="btn btn--primary" onClick={onRetry}>
            重新请求权限
        </button>
    </div>
);

export const VoiceNotePage: React.FC<VoiceNotePageProps> = ({ onBack }) => {
    const { state, actions } = useVoiceNoteState();
    const [editContent, setEditContent] = useState('');
    const [successMessage, setSuccessMessage] = useState<string | null>(null);
    const [showPermissionGuide, setShowPermissionGuide] = useState(false);
    const [audioUrl, setAudioUrl] = useState('');
    const audioUrlRef = useRef(''); // 用于清理旧的 Object URL
    const [audioSource, setAudioSource] = useState<AudioSource>('mic');

    // Snackbar 状态管理
    const [snackbar, setSnackbar] = useState<{
        visible: boolean;
        message: string;
        type: 'info' | 'error';
    }>({ visible: false, message: '', type: 'info' });

    // 创建保存服务实例（使用真实的墨问 API）
    const noteSaver = useMemo<INoteSaver>(() => new MowenNoteSaver(), []);

    // 转写回调（使用 useMemo 避免重复创建）
    const transcriberCallbacks = useMemo<TranscriberCallbacks>(() => ({
        onPartial: actions.updatePartial,
        onFinal: actions.addFinal,
        onRevise: actions.revise,
        onError: (error) => {
            console.error('[Transcriber Error]', error);
            setSnackbar({
                visible: true,
                message: error.message || '转写服务异常，请稍后重试',
                type: 'error',
            });
        },
    }), [actions]);

    // 转写服务 Hook（必须在 audioRecorder 之前初始化，因为 audioRecorder 的回调需要使用它）
    const transcriber = useTranscriber({
        callbacks: transcriberCallbacks,
    });

    const handleAudioData = useCallback((data: Blob | ArrayBuffer) => {
        // sendAudioChunk 是可选方法，Mock 模式下不存在
        transcriber.transcriber.sendAudioChunk?.(data);
    }, [transcriber.transcriber]);

    // 麦克风录音 Hook
    const audioRecorder = useAudioRecorder({
        timeslice: 160, // 与 ASR 默认分片对齐，减少首字等待
        onDataAvailable: handleAudioData,
        audioSource,
    });

    // 页面挂载时预连接 WebSocket，减少录音启动延迟
    useEffect(() => {
        transcriber.preconnect();
    }, [transcriber.preconnect]);

    useEffect(() => {
        if (audioSource === 'tab') {
            chrome.runtime.sendMessage({ type: 'ENSURE_OFFSCREEN_READY' }).catch(() => {});
        }
    }, [audioSource]);

    // 同步录音时长到状态
    useEffect(() => {
        if (audioRecorder.state.isRecording && !audioRecorder.state.isPaused) {
            actions.updateDuration(audioRecorder.state.duration);
        }
    }, [audioRecorder.state.duration, audioRecorder.state.isRecording, audioRecorder.state.isPaused, actions]);

    // 整理完成自动跳转到编辑态
    useEffect(() => {
        if (state.status === 'finalizing') {
            const timer = setTimeout(() => {
                // 合并 Final + 最后 Partial 作为编辑内容
                const content = [
                    ...state.transcript.finalTextBlocks,
                    state.transcript.partialText,
                ].filter(Boolean).join('\n\n');
                setEditContent(content);
                actions.finalizeComplete();
            }, 800);

            return () => clearTimeout(timer);
        }
    }, [state.status, state.transcript, actions]);

    // 保存成功后显示提示
    useEffect(() => {
        if (state.status === 'done') {
            setSuccessMessage('已保存');
            const timer = setTimeout(() => {
                setSuccessMessage(null);
            }, 1500);

            return () => clearTimeout(timer);
        }
    }, [state.status]);

    // 录音态：定期将 PCM chunks 合成 WAV URL 供播放器使用
    useEffect(() => {
        if (!audioRecorder.state.isRecording || audioRecorder.audioChunks.length === 0) return;

        // 每 2 秒更新一次，避免频繁合成
        const timer = setTimeout(async () => {
            try {
                const url = await pcmChunksToWavUrl(audioRecorder.audioChunks);
                // 清理旧 URL
                if (audioUrlRef.current) URL.revokeObjectURL(audioUrlRef.current);
                audioUrlRef.current = url;
                setAudioUrl(url);
            } catch (e) {
                console.error('[VoiceNotePage] 生成音频 URL 失败:', e);
            }
        }, 2000);

        return () => clearTimeout(timer);
    }, [audioRecorder.state.isRecording, audioRecorder.audioChunks.length]);

    // 暂停时立即生成最新的 WAV URL，确保用户可以回放
    useEffect(() => {
        if (state.status === 'paused' && audioRecorder.audioChunks.length > 0) {
            pcmChunksToWavUrl(audioRecorder.audioChunks).then(url => {
                if (audioUrlRef.current) URL.revokeObjectURL(audioUrlRef.current);
                audioUrlRef.current = url;
                setAudioUrl(url);
            }).catch(e => {
                console.error('[VoiceNotePage] 暂停时生成音频 URL 失败:', e);
            });
        }
    }, [state.status]);

    // 进入编辑态时：生成完整的 WAV URL
    useEffect(() => {
        if (state.status === 'editing' && audioRecorder.audioChunks.length > 0 && !audioUrl) {
            pcmChunksToWavUrl(audioRecorder.audioChunks).then(url => {
                if (audioUrlRef.current) URL.revokeObjectURL(audioUrlRef.current);
                audioUrlRef.current = url;
                setAudioUrl(url);
            });
        }
    }, [state.status, audioRecorder.audioChunks]);

    // 组件卸载时清理 Object URL
    useEffect(() => {
        return () => {
            if (audioUrlRef.current) URL.revokeObjectURL(audioUrlRef.current);
        };
    }, []);

    // 处理权限错误
    useEffect(() => {
        if (audioRecorder.permissionStatus === 'denied') {
            setShowPermissionGuide(true);
        }
    }, [audioRecorder.permissionStatus]);

    // ============ 操作处理 ============

    const handleStart = useCallback(async () => {
        try {
            // 并行发起转写连接，减少首字等待
            const startTranscriberPromise = transcriber.start();
            await audioRecorder.start();
            actions.startRecording();
            await startTranscriberPromise;
            setShowPermissionGuide(false);
        } catch (error) {
            console.error('启动录音失败:', error);
            audioRecorder.stop();
            transcriber.stop();
            actions.reset();
            if (audioRecorder.permissionStatus === 'denied') {
                setShowPermissionGuide(true);
            }
        }
    }, [audioRecorder, transcriber, actions]);

    const handlePause = useCallback(() => {
        audioRecorder.pause();
        transcriber.pause();
        actions.pause();
    }, [audioRecorder, transcriber, actions]);

    const handleResume = useCallback(() => {
        audioRecorder.resume();
        transcriber.resume();
        actions.resume();
    }, [audioRecorder, transcriber, actions]);

    const handleStop = useCallback(() => {
        audioRecorder.stop();
        transcriber.stop();
        actions.stop();
    }, [audioRecorder, transcriber, actions]);

    const handleContinue = useCallback(async () => {
        try {
            // 设置初始时长，确保继续补录时时长累加
            audioRecorder.setInitialDuration(state.duration);
            const startTranscriberPromise = transcriber.start();
            await audioRecorder.start();
            await startTranscriberPromise;
            actions.continueRecording();
        } catch (error) {
            console.error('继续录音失败:', error);
            audioRecorder.stop();
            transcriber.stop();
        }
    }, [audioRecorder, transcriber, actions, state.duration]);

    const handleSave = useCallback(async () => {
        actions.save();
        try {
            // 使用 getAudioChunks() 获取最新的音频数据，避免闭包问题
            const chunks = audioRecorder.getAudioChunks();
            console.log('[VoiceNotePage] 准备保存，audioChunks 状态:', {
                chunksCount: chunks.length,
                totalSize: chunks.reduce((sum, b) => sum + b.size, 0),
            });
            const audioBlob = await pcmChunksToMp3Blob(chunks);
            console.log('[VoiceNotePage] 生成上传音频 Blob:', {
                blobSize: audioBlob?.size,
                blobType: audioBlob?.type,
            });
            const result = await noteSaver.save({
                content: editContent,
                audioBlob: audioBlob || undefined,
                duration: state.duration,
            });
            if (result.success) {
                actions.saveSuccess();
            } else {
                actions.saveFailure();
                setSnackbar({
                    visible: true,
                    message: result.error || '保存失败，请重试',
                    type: 'error',
                });
            }
        } catch (error) {
            console.error('保存失败:', error);
            actions.saveFailure();
            setSnackbar({
                visible: true,
                message: '保存失败，请重试',
                type: 'error',
            });
        }
    }, [noteSaver, editContent, audioRecorder, state.duration, actions]);

    const handleCancel = useCallback(() => {
        audioRecorder.stop();
        transcriber.stop();
        audioRecorder.clearAudioChunks();
        audioRecorder.setInitialDuration(0);
        if (audioUrlRef.current) URL.revokeObjectURL(audioUrlRef.current);
        audioUrlRef.current = '';
        setAudioUrl('');
        actions.reset();
        onBack?.();
    }, [audioRecorder, transcriber, actions, onBack]);

    /** 左上角返回按钮：非 idle 回到准备就绪页面，idle 退出 */
    const handleBack = useCallback(() => {
        if (state.status === 'idle') {
            onBack?.();
        } else {
            audioRecorder.stop();
            transcriber.stop();
            audioRecorder.clearAudioChunks();
            audioRecorder.setInitialDuration(0);
            if (audioUrlRef.current) URL.revokeObjectURL(audioUrlRef.current);
            audioUrlRef.current = '';
            setAudioUrl('');
            actions.reset();
        }
    }, [state.status, audioRecorder, transcriber, actions, onBack]);


    const handleRetryPermission = useCallback(async () => {
        const granted = await audioRecorder.requestPermission();
        if (granted) {
            setShowPermissionGuide(false);
        }
    }, [audioRecorder]);

    // ============ 渲染 ============

    const isEditing = state.status === 'editing' || state.status === 'saving' || state.status === 'done';
    const isRecordingOrPaused = state.status === 'recording' || state.status === 'paused';

    // 录音态状态文字
    const recordingStatusText = state.status === 'recording' ? '录音中' : state.status === 'paused' ? '已暂停' : '';
    const recordingStatusDot = state.status === 'recording' ? 'recording' : state.status === 'paused' ? 'paused' : '';

    // 显示权限引导
    if (showPermissionGuide) {
        return (
            <div className="voice-note-page">
                <header className="voice-note-header">
                    <button className="back-button" onClick={handleBack}>
                        ←
                    </button>
                    <h1 className="page-title">AI 语音笔记</h1>
                </header>
                <PermissionGuide onRetry={handleRetryPermission} />
            </div>
        );
    }

    return (
        <div className="voice-note-page">
            {/* 顶部栏 */}
            <header className="voice-note-header">
                <button className="back-button" onClick={handleBack}>
                    ←
                </button>
                <h1 className="page-title">AI 语音笔记</h1>
            </header>

            {/* 状态条（录音态由 AudioPlayer 内嵌显示） */}
            {!isRecordingOrPaused && (
                <StatusBar
                    status={state.status}
                    duration={state.duration}
                    connectionStatus={transcriber.connectionStatus}
                />
            )}

            {/* 主内容区 */}
            <main className="voice-note-content">
                {state.status === 'finalizing' ? (
                    <FinalizingView />
                ) : isEditing ? (
                    <>
                        {audioUrl && (
                            <AudioPlayer audioUrl={audioUrl} />
                        )}
                        <EditorView
                            content={editContent}
                            onChange={setEditContent}
                            disabled={state.status === 'saving'}
                            duration={state.duration}
                        />
                    </>
                ) : (
                    <>
                        {state.status === 'idle' && (
                            <div className="audio-source-toggle" role="radiogroup" aria-label="音频来源">
                                <button
                                    className={`toggle-btn ${audioSource === 'mic' ? 'active' : ''}`}
                                    onClick={() => setAudioSource('mic')}
                                    role="radio"
                                    aria-checked={audioSource === 'mic'}
                                >
                                    <svg className="toggle-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                        <rect x="9" y="1" width="6" height="12" rx="3" />
                                        <path d="M5 10a7 7 0 0 0 14 0" />
                                        <line x1="12" y1="17" x2="12" y2="21" />
                                        <line x1="8" y1="21" x2="16" y2="21" />
                                    </svg>
                                    麦克风
                                </button>
                                <button
                                    className={`toggle-btn ${audioSource === 'tab' ? 'active' : ''}`}
                                    onClick={() => setAudioSource('tab')}
                                    role="radio"
                                    aria-checked={audioSource === 'tab'}
                                >
                                    <svg className="toggle-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                        <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                                        <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
                                        <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
                                    </svg>
                                    系统声音
                                </button>
                            </div>
                        )}
                        {isRecordingOrPaused && (
                            <AudioPlayer
                                audioUrl={audioUrl}
                                isRecording={true}
                                isPaused={state.status === 'paused'}
                                recordingDuration={state.duration}
                                statusText={recordingStatusText}
                                statusDot={recordingStatusDot}
                            />
                        )}
                        <TranscriptView
                            transcript={state.transcript}
                            status={state.status}
                            onStartRecording={handleStart}
                            onClearRevision={actions.clearRevision}
                        />
                    </>
                )}
            </main>

            {/* 成功提示 */}
            {successMessage && (
                <div className="success-toast">{successMessage}</div>
            )}

            {/* Snackbar 提示 */}
            <Snackbar
                visible={snackbar.visible}
                message={snackbar.message}
                type={snackbar.type}
                onClose={() => setSnackbar(prev => ({ ...prev, visible: false }))}
            />

            {/* 底部操作区 */}
            <ActionBar
                status={state.status}
                onStart={handleStart}
                onPause={handlePause}
                onResume={handleResume}
                onStop={handleStop}
                onContinue={handleContinue}
                onSave={handleSave}
                onCancel={handleCancel}
            />
        </div>
    );
};

export default VoiceNotePage;
