/**
 * 语音笔记状态机 Hook
 * 使用 useReducer 管理 7 个状态的转换
 */

import { useReducer, useCallback } from 'react';
import { VoiceNoteState, VoiceNoteAction, TranscriptState } from '../types';
import { computeCharDiff } from '../utils/diffUtils';

/** 完整状态 */
interface VoiceNoteFullState {
    /** 当前状态 */
    status: VoiceNoteState;
    /** 转写状态 */
    transcript: TranscriptState;
    /** 录音时长（秒） */
    duration: number;
    /** 错误信息 */
    error?: string;
    /** 补录时的 block 索引偏移量（后端新 session 从 0 开始，需要加偏移） */
    blockIndexOffset: number;
}

/** 初始状态 */
const initialState: VoiceNoteFullState = {
    status: 'idle',
    transcript: {
        finalTextBlocks: [],
        partialText: '',
        revisionMark: null,
    },
    duration: 0,
    error: undefined,
    blockIndexOffset: 0,
};

/** 状态转换 Reducer */
function voiceNoteReducer(
    state: VoiceNoteFullState,
    action: VoiceNoteAction | TranscriptAction | DurationAction
): VoiceNoteFullState {
    // 处理转写相关动作
    if ('transcriptType' in action) {
        return handleTranscriptAction(state, action as TranscriptAction);
    }

    // 处理时长更新
    if (action.type === 'UPDATE_DURATION') {
        return { ...state, duration: (action as DurationAction).duration };
    }

    // 处理状态机转换
    switch (action.type) {
        case 'START_RECORDING':
            if (state.status !== 'idle' && state.status !== 'editing') return state;
            return { ...state, status: 'recording', error: undefined };

        case 'PAUSE':
            if (state.status !== 'recording') return state;
            return { ...state, status: 'paused' };

        case 'RESUME':
            if (state.status !== 'paused') return state;
            return { ...state, status: 'recording' };

        case 'STOP':
            if (state.status !== 'recording' && state.status !== 'paused') return state;
            return { ...state, status: 'finalizing' };

        case 'FINALIZE_COMPLETE':
            if (state.status !== 'finalizing') return state;
            return { ...state, status: 'editing' };

        case 'CONTINUE_RECORDING':
            if (state.status !== 'editing') return state;
            // 记录当前 blocks 数量作为偏移，补录时后端 blockIndex 从 0 重新开始
            return {
                ...state,
                status: 'recording',
                blockIndexOffset: state.transcript.finalTextBlocks.length,
            };

        case 'SAVE':
            if (state.status !== 'editing') return state;
            return { ...state, status: 'saving' };

        case 'SAVE_SUCCESS':
            if (state.status !== 'saving') return state;
            return { ...state, status: 'done' };

        case 'SAVE_FAILURE':
            if (state.status !== 'saving') return state;
            return { ...state, status: 'editing', error: '保存失败，请重试' };

        case 'RESET':
            return initialState;

        default:
            return state;
    }
}

// ============ 转写相关动作 ============

type TranscriptAction =
    | { transcriptType: 'PARTIAL'; text: string }
    | { transcriptType: 'FINAL'; text: string }
    | { transcriptType: 'REVISE'; blockIndex: number; newText: string }
    | { transcriptType: 'CLEAR_REVISION' };

type DurationAction = { type: 'UPDATE_DURATION'; duration: number };

function handleTranscriptAction(
    state: VoiceNoteFullState,
    action: TranscriptAction
): VoiceNoteFullState {
    const { transcript } = state;

    switch (action.transcriptType) {
        case 'PARTIAL':
            // 火山引擎返回的是当前 utterance 的累积文本，直接替换 partialText
            return {
                ...state,
                transcript: { ...transcript, partialText: action.text },
            };

        case 'FINAL': {
            // 火山引擎 definite=true 的完整 utterance 文本
            const finalText = action.text || transcript.partialText;
            if (!finalText) {
                return state;
            }
            // 检查最近 3 个 blocks 是否有完全重复（防止暂停恢复后的重复）
            const recentBlocks = transcript.finalTextBlocks.slice(-3);
            if (recentBlocks.includes(finalText)) {
                return state;
            }

            // 判断 partialText 与 finalText 的关系
            const currentPartial = transcript.partialText;
            let newPartialText = '';
            if (currentPartial !== '') {
                // partial 与 final 有关联（前缀关系）则清空，否则保留（新 utterance 已开始）
                const isRelated = finalText.startsWith(currentPartial) ||
                    currentPartial.startsWith(finalText);
                if (!isRelated) {
                    newPartialText = currentPartial;
                }
            }

            const newFinalTextBlocks = [...transcript.finalTextBlocks, finalText];

            return {
                ...state,
                transcript: {
                    ...transcript,
                    finalTextBlocks: newFinalTextBlocks,
                    partialText: newPartialText,
                },
            };
        }

        case 'REVISE': {
            // 补录时后端 blockIndex 从 0 开始，需要加上偏移量
            const adjustedIndex = action.blockIndex + state.blockIndexOffset;
            const newBlocks = [...transcript.finalTextBlocks];
            const originalText = newBlocks[adjustedIndex] || '';

            if (adjustedIndex >= 0 && adjustedIndex < newBlocks.length) {
                newBlocks[adjustedIndex] = action.newText;
            }

            // 计算 diff segments
            const diffSegments = computeCharDiff(originalText, action.newText);

            return {
                ...state,
                transcript: {
                    ...transcript,
                    finalTextBlocks: newBlocks,
                    revisionMark: {
                        blockIndex: adjustedIndex,
                        timestamp: Date.now(),
                        originalText,
                        diffSegments,
                    },
                },
            };
        }

        case 'CLEAR_REVISION':
            return {
                ...state,
                transcript: { ...transcript, revisionMark: null },
            };

        default:
            return state;
    }
}

// ============ Hook 导出 ============

export function useVoiceNoteState() {
    const [state, dispatch] = useReducer(voiceNoteReducer, initialState);

    // 状态机动作
    const startRecording = useCallback(() => dispatch({ type: 'START_RECORDING' }), []);
    const pause = useCallback(() => dispatch({ type: 'PAUSE' }), []);
    const resume = useCallback(() => dispatch({ type: 'RESUME' }), []);
    const stop = useCallback(() => dispatch({ type: 'STOP' }), []);
    const finalizeComplete = useCallback(() => dispatch({ type: 'FINALIZE_COMPLETE' }), []);
    const continueRecording = useCallback(() => dispatch({ type: 'CONTINUE_RECORDING' }), []);
    const save = useCallback(() => dispatch({ type: 'SAVE' }), []);
    const saveSuccess = useCallback(() => dispatch({ type: 'SAVE_SUCCESS' }), []);
    const saveFailure = useCallback(() => dispatch({ type: 'SAVE_FAILURE' }), []);
    const reset = useCallback(() => dispatch({ type: 'RESET' }), []);

    // 转写动作
    const updatePartial = useCallback((text: string) =>
        dispatch({ transcriptType: 'PARTIAL', text } as TranscriptAction), []);
    const addFinal = useCallback((text: string) =>
        dispatch({ transcriptType: 'FINAL', text } as TranscriptAction), []);
    const revise = useCallback((blockIndex: number, newText: string) =>
        dispatch({ transcriptType: 'REVISE', blockIndex, newText } as TranscriptAction), []);
    const clearRevision = useCallback(() =>
        dispatch({ transcriptType: 'CLEAR_REVISION' } as TranscriptAction), []);

    // 时长更新
    const updateDuration = useCallback((duration: number) =>
        dispatch({ type: 'UPDATE_DURATION', duration } as DurationAction), []);

    return {
        state,
        actions: {
            startRecording,
            pause,
            resume,
            stop,
            finalizeComplete,
            continueRecording,
            save,
            saveSuccess,
            saveFailure,
            reset,
            updatePartial,
            addFinal,
            revise,
            clearRevision,
            updateDuration,
        },
    };
}
