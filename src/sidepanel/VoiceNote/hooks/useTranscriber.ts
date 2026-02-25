/**
 * 转写服务 Hook
 * 集成 ITranscriber 服务，处理 ASR 事件
 */

import { useEffect, useRef, useCallback, useMemo, useState } from 'react';
import { ITranscriber, TranscriberCallbacks, createTranscriber, ConnectionStatus } from '../services';

interface UseTranscriberOptions {
    /** 自定义转写器实例（可选，默认根据配置自动创建） */
    transcriber?: ITranscriber;
    /** 事件回调 */
    callbacks: TranscriberCallbacks;
}

interface UseTranscriberReturn {
    /** 预连接：提前建立 WebSocket 连接 */
    preconnect: () => void;
    /** 开始转写 */
    start: () => Promise<void>;
    /** 停止转写 */
    stop: () => void;
    /** 暂停转写 */
    pause: () => void;
    /** 继续转写 */
    resume: () => void;
    /** 是否正在运行 */
    isRunning: boolean;
    /** 获取 Transcriber 实例（用于发送音频等高级操作） */
    transcriber: ITranscriber;
    /** 连接状态 */
    connectionStatus: ConnectionStatus;
}

export function useTranscriber(options: UseTranscriberOptions): UseTranscriberReturn {
    const { callbacks, transcriber: customTranscriber } = options;

    // 使用传入的转写器或根据配置创建（通过工厂函数）
    const transcriber = useMemo<ITranscriber>(
        () => customTranscriber || createTranscriber(),
        [customTranscriber]
    );

    const isRunningRef = useRef(false);
    const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>('disconnected');

    // 使用 ref 缓存回调，避免每次渲染都创建新对象导致无限循环
    const callbacksRef = useRef(callbacks);
    callbacksRef.current = callbacks;

    // 包装回调以拦截状态变更（只创建一次）
    const wrappedCallbacks = useMemo<TranscriberCallbacks>(() => ({
        onPartial: (text) => callbacksRef.current.onPartial(text),
        onFinal: (text) => callbacksRef.current.onFinal(text),
        onRevise: (blockIndex, text) => callbacksRef.current.onRevise(blockIndex, text),
        onError: (error) => callbacksRef.current.onError?.(error),
        onStatusChange: (status: ConnectionStatus) => {
            setConnectionStatus(status);
            callbacksRef.current.onStatusChange?.(status);
        }
    }), []); // 空依赖，只创建一次

    // 设置回调（只在 transcriber 变化时执行）
    useEffect(() => {
        transcriber.setCallbacks(wrappedCallbacks);
    }, [transcriber, wrappedCallbacks]);

    // 清理
    useEffect(() => {
        return () => {
            transcriber.dispose();
        };
    }, [transcriber]);

    const preconnect = useCallback(() => {
        transcriber.preconnect?.().catch(err => {
            console.warn('[useTranscriber] 预连接失败（不影响后续使用）:', err);
        });
    }, [transcriber]);

    const start = useCallback(async () => {
        if (isRunningRef.current) return;
        setConnectionStatus('connecting'); // 立即更新
        await transcriber.start();
        isRunningRef.current = true;
    }, [transcriber]);

    const stop = useCallback(() => {
        transcriber.stop();
        isRunningRef.current = false;
        setConnectionStatus('disconnected');
    }, [transcriber]);

    const pause = useCallback(() => {
        transcriber.pause();
    }, [transcriber]);

    const resume = useCallback(() => {
        transcriber.resume();
    }, [transcriber]);

    return {
        preconnect,
        start,
        stop,
        pause,
        resume,
        isRunning: isRunningRef.current,
        transcriber,
        connectionStatus,
    };
}
