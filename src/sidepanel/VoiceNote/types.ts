/**
 * AI 语音笔记 - 类型定义
 */

// ============ 状态机 ============

/** 语音笔记状态 */
export type VoiceNoteState =
  | 'idle'        // 未开始
  | 'recording'   // 录音中 + 流式转写中
  | 'paused'      // 暂停
  | 'finalizing'  // 结束后整理
  | 'editing'     // 编辑态
  | 'saving'      // 保存中
  | 'done';       // 已保存（短暂提示态）

/** 状态机动作 */
export type VoiceNoteAction =
  | { type: 'START_RECORDING' }
  | { type: 'PAUSE' }
  | { type: 'RESUME' }
  | { type: 'STOP' }
  | { type: 'FINALIZE_COMPLETE' }
  | { type: 'CONTINUE_RECORDING' }
  | { type: 'SAVE' }
  | { type: 'SAVE_SUCCESS' }
  | { type: 'SAVE_FAILURE' }
  | { type: 'RESET' };

// ============ 转写数据模型 ============

/** Diff 片段 */
export interface DiffSegment {
  type: 'equal' | 'delete' | 'insert';
  text: string;
}

/** 转写状态 */
export interface TranscriptState {
  /** 确认文本（按段落存储） */
  finalTextBlocks: string[];
  /** 当前临时吐字（仅一段） */
  partialText: string;
  /** 修订标记（用于触发高亮/提示） */
  revisionMark: RevisionMark | null;
}

/** 修订标记 */
export interface RevisionMark {
  /** 被修订的段落索引 */
  blockIndex: number;
  /** 修订发生时间戳 */
  timestamp: number;
  /** 原始文本（纠错前） */
  originalText?: string;
  /** Diff 片段（用于内联展示） */
  diffSegments?: DiffSegment[];
}

// ============ ASR 事件 ============

/** ASR 事件类型 */
export type ASREvent =
  | { type: 'partial'; text: string }           // 覆盖更新吐字
  | { type: 'final'; text: string }             // 追加确认文本
  | { type: 'revise'; blockIndex: number; newText: string };  // 替换某段文本

// ============ 保存相关 ============

/** 保存结果 */
export interface SaveResult {
  success: boolean;
  error?: string;
  noteId?: string;
}

/** 语音笔记保存数据 */
export interface VoiceNoteSaveData {
  /** 最终文本内容 */
  content: string;
  /** 音频 Blob（可选，用于上传） */
  audioBlob?: Blob;
  /** 录音时长（秒） */
  duration?: number;
}

// ============ 录音相关 ============

/** 录音器状态 */
export interface RecorderState {
  /** 是否正在录音 */
  isRecording: boolean;
  /** 是否暂停 */
  isPaused: boolean;
  /** 录音时长（秒） */
  duration: number;
  /** 错误信息 */
  error?: string;
}

/** 麦克风权限状态 */
export type MicPermissionStatus = 'granted' | 'denied' | 'prompt' | 'error';
