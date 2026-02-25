/**
 * 基于 Content Script 的麦克风录音 Hook
 * 通过向当前页面的 Content Script 发送消息，在普通网页上下文中录音
 * 可以正常请求麦克风权限，绕过 SidePanel 的限制
 */

import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import { MicPermissionStatus, RecorderState } from '../types';

export type AudioSource = 'mic' | 'tab';

interface UseAudioRecorderOptions {
    /** 时间切片（毫秒），用于流式处理 */
    timeslice?: number;
    /** 音频数据回调 */
    onDataAvailable?: (data: Blob | ArrayBuffer) => void;
    /** 初始时长（秒），用于继续补录时累加 */
    initialDuration?: number;
    /** 音频源：麦克风或标签页 */
    audioSource?: AudioSource;
}

interface UseAudioRecorderReturn {
    /** 录音状态 */
    state: RecorderState;
    /** 麦克风权限状态 */
    permissionStatus: MicPermissionStatus;
    /** 开始录音 */
    start: () => Promise<void>;
    /** 停止录音 */
    stop: () => void;
    /** 暂停录音 */
    pause: () => void;
    /** 继续录音 */
    resume: () => void;
    /** 获取录音 Blob */
    getRecordingBlob: () => Blob | null;
    /** 获取最新的音频 chunks（避免闭包问题） */
    getAudioChunks: () => Blob[];
    /** 请求麦克风权限 */
    requestPermission: () => Promise<boolean>;
    /** 实时累积的 PCM 音频 chunks（用于播放器） */
    audioChunks: Blob[];
    /** 清空累积的音频 chunks */
    clearAudioChunks: () => void;
    /** 设置初始时长（用于继续补录前设置累加基准） */
    setInitialDuration: (duration: number) => void;
}

/**
 * 获取当前活动 Tab ID
 */
async function getCurrentTabId(): Promise<number | undefined> {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab?.id;
}

/**
 * 向 Content Script 发送消息
 */
async function sendToContentScript(type: string, payload?: Record<string, unknown>): Promise<{
    success: boolean;
    data?: string;
    state?: string;
    error?: string;
}> {
    const tabId = await getCurrentTabId();
    if (!tabId) {
        throw new Error('无法获取当前页面，请确保在网页上使用此功能');
    }

    return chrome.tabs.sendMessage(tabId, { type, ...payload });
}

function base64ToPcmBuffer(base64: string): ArrayBuffer {
    const binary = atob(base64);
    const buffer = new ArrayBuffer(binary.length);
    const bytes = new Uint8Array(buffer);
    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
    }
    return buffer;
}

export function useAudioRecorder(
    options: UseAudioRecorderOptions = {}
): UseAudioRecorderReturn {
    const { timeslice = 1000, onDataAvailable, initialDuration = 0, audioSource = 'mic' } = options;
    const initialDurationRef = useRef(initialDuration);
    const [state, setState] = useState<RecorderState>({
        isRecording: false,
        isPaused: false,
        duration: 0,
        error: undefined,
    });

    const [permissionStatus, setPermissionStatus] = useState<MicPermissionStatus>('prompt');
    const audioChunksRef = useRef<Blob[]>([]);
    const [audioChunksVersion, setAudioChunksVersion] = useState(0);
    const recordingBlobRef = useRef<Blob | null>(null);
    const durationTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
    const startTimeRef = useRef<number>(0);
    // 使用 useMemo 确保每次 version 变化时返回最新的数组引用
    const audioChunks = useMemo(() => audioChunksRef.current, [audioChunksVersion]);

    const clearAudioChunks = useCallback(() => {
        audioChunksRef.current = [];
        setAudioChunksVersion(version => version + 1);
    }, []);

    const setInitialDuration = useCallback((duration: number) => {
        initialDurationRef.current = duration;
    }, []);

    // 监听来自 Content Script 的音频数据
    useEffect(() => {
        const handleMessage = (message: { type: string; data?: string; format?: string }) => {
            const expectedType = audioSource === 'tab' ? 'TAB_AUDIO_DATA' : 'MIC_AUDIO_DATA';
            if (message.type === expectedType && message.data) {
                try {
                    const pcmBuffer = base64ToPcmBuffer(message.data);
                    const blob = new Blob([pcmBuffer], { type: 'audio/pcm' });
                    audioChunksRef.current.push(blob);
                    if (audioChunksRef.current.length === 1 || audioChunksRef.current.length % 4 === 0) {
                        setAudioChunksVersion(version => version + 1);
                    }
                    onDataAvailable?.(pcmBuffer);
                } catch (e) {
                    console.error('[useAudioRecorder] 解码音频数据失败:', e);
                }
            }
        };

        chrome.runtime.onMessage.addListener(handleMessage);
        return () => chrome.runtime.onMessage.removeListener(handleMessage);
    }, [onDataAvailable, audioSource]);

    // 组件卸载时清理
    useEffect(() => {
        return () => {
            if (durationTimerRef.current) {
                clearInterval(durationTimerRef.current);
            }
        };
    }, []);

    // 请求麦克风权限（通过快速开始/停止录音测试）
    const requestPermission = useCallback(async (): Promise<boolean> => {
        if (audioSource === 'tab') {
            setPermissionStatus('granted');
            return true;
        }

        try {
            const response = await sendToContentScript('START_MIC_RECORDING', {
                options: { timeslice: 1000 }
            });

            if (response?.success) {
                // 立即停止，只是测试权限
                await sendToContentScript('STOP_MIC_RECORDING');
                setPermissionStatus('granted');
                return true;
            } else {
                setPermissionStatus('denied');
                setState(prev => ({
                    ...prev,
                    error: response?.error || '无法获取麦克风权限',
                }));
                return false;
            }
        } catch (error) {
            console.error('[VoiceNote] 权限请求失败:', error);
            setPermissionStatus('error');
            setState(prev => ({
                ...prev,
                error: '请确保在网页上使用此功能，不支持在 chrome:// 页面上录音',
            }));
            return false;
        }
    }, [audioSource]);

    // 开始录音
    const start = useCallback(async () => {
        try {
            let response: { success: boolean; error?: string; data?: string };

            if (audioSource === 'tab') {
                const tabId = await getCurrentTabId();
                if (!tabId) throw new Error('无法获取当前页面');
                response = await chrome.runtime.sendMessage({
                    type: 'START_TAB_RECORDING',
                    tabId,
                });
            } else {
                response = await sendToContentScript('START_MIC_RECORDING', {
                    options: { timeslice }
                });
            }

            if (!response?.success) {
                throw new Error(response?.error || '开始录音失败');
            }

            setPermissionStatus('granted');
            recordingBlobRef.current = null;

            // 启动计时器（支持从 initialDuration 累加）
            const baseDuration = initialDurationRef.current;
            startTimeRef.current = Date.now();
            durationTimerRef.current = setInterval(() => {
                setState(prev => ({
                    ...prev,
                    duration: baseDuration + Math.floor((Date.now() - startTimeRef.current) / 1000),
                }));
            }, 1000);

            setState({
                isRecording: true,
                isPaused: false,
                duration: baseDuration,
                error: undefined,
            });
        } catch (error) {
            console.error('[VoiceNote] 开始录音失败:', error);
            const err = error as Error;

            let errorMessage = audioSource === 'tab'
                ? '开始录制系统声音失败，请确保当前页面有音频播放'
                : '开始录音失败，请检查麦克风是否正常工作';

            if (err.message.includes('Permission') || err.message.includes('NotAllowed')) {
                errorMessage = '麦克风权限被拒绝，请在浏览器设置中允许访问麦克风';
                setPermissionStatus('denied');
            } else if (err.message.includes('无法获取当前页面') || err.message.includes('Receiving end')) {
                errorMessage = '请在网页上使用此功能，不支持在 chrome:// 或扩展页面上录音';
            } else if (err.message) {
                errorMessage = err.message;
            }

            setState(prev => ({
                ...prev,
                error: errorMessage,
            }));
        }
    }, [timeslice, audioSource]);

    // 停止录音
    const stop = useCallback(async () => {
        if (durationTimerRef.current) {
            clearInterval(durationTimerRef.current);
            durationTimerRef.current = null;
        }

        try {
            let response: { success: boolean; data?: string; error?: string };

            if (audioSource === 'tab') {
                response = await chrome.runtime.sendMessage({ type: 'STOP_TAB_RECORDING' });
            } else {
                response = await sendToContentScript('STOP_MIC_RECORDING');
            }

            if (response?.success && response.data) {
                const pcmBuffer = base64ToPcmBuffer(response.data);
                recordingBlobRef.current = new Blob([pcmBuffer], { type: 'audio/pcm' });
            }
        } catch (error) {
            console.error('[VoiceNote] 停止录音失败:', error);
        }

        setState(prev => ({
            ...prev,
            isRecording: false,
            isPaused: false,
        }));
    }, [audioSource]);

    // 暂停录音
    const pause = useCallback(async () => {
        if (durationTimerRef.current) {
            clearInterval(durationTimerRef.current);
            durationTimerRef.current = null;
        }

        try {
            if (audioSource === 'tab') {
                await chrome.runtime.sendMessage({ type: 'PAUSE_TAB_RECORDING' });
            } else {
                await sendToContentScript('PAUSE_MIC_RECORDING');
            }
        } catch (error) {
            console.error('[VoiceNote] 暂停录音失败:', error);
        }

        setState(prev => ({ ...prev, isPaused: true }));
    }, [audioSource]);

    // 继续录音
    const resume = useCallback(async () => {
        const currentDuration = state.duration;
        const resumeTime = Date.now();

        durationTimerRef.current = setInterval(() => {
            setState(prev => ({
                ...prev,
                duration: currentDuration + Math.floor((Date.now() - resumeTime) / 1000),
            }));
        }, 1000);

        try {
            if (audioSource === 'tab') {
                await chrome.runtime.sendMessage({ type: 'RESUME_TAB_RECORDING' });
            } else {
                await sendToContentScript('RESUME_MIC_RECORDING');
            }
        } catch (error) {
            console.error('[VoiceNote] 继续录音失败:', error);
        }

        setState(prev => ({ ...prev, isPaused: false }));
    }, [state.duration, audioSource]);

    // 获取录音 Blob
    const getRecordingBlob = useCallback((): Blob | null => {
        return recordingBlobRef.current;
    }, []);

    // 获取最新的音频 chunks（避免闭包问题）
    const getAudioChunks = useCallback((): Blob[] => {
        return audioChunksRef.current;
    }, []);

    return {
        state,
        permissionStatus,
        start,
        stop,
        pause,
        resume,
        getRecordingBlob,
        getAudioChunks,
        requestPermission,
        audioChunks,
        clearAudioChunks,
        setInitialDuration,
    };
}
