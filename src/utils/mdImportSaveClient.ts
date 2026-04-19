import { ExtractResult, NoteCreateResult, SaveProgress } from '../types';
import { generateId } from './helpers';
import { TaskState, TaskStore } from './taskStore';

interface SaveTaskCompleteMessage {
  type: 'SAVE_NOTE_COMPLETE';
  tabId: number;
  taskId: string;
  result: NoteCreateResult;
}

interface SaveTaskProgressMessage {
  type: 'SAVE_NOTE_PROGRESS';
  tabId: number;
  taskId: string;
  progress: {
    type: 'uploading_images' | 'creating_note';
    uploadedImages?: number;
    totalImages?: number;
    currentPart?: number;
    totalParts?: number;
  };
}

interface SaveTaskPausedMessage {
  type: 'SAVE_NOTE_PAUSED';
  tabId: number;
  taskId: string;
}

interface SaveTaskResumedMessage {
  type: 'SAVE_NOTE_RESUMED';
  tabId: number;
  taskId: string;
}

export interface MdImportTaskSubscription {
  onProgress?: (progress: SaveProgress) => void;
  onPaused?: () => void;
  onResumed?: () => void;
  onComplete?: (result: NoteCreateResult) => void;
}

export interface MdImportSaveRequest {
  extractResult: ExtractResult;
  isPublic: boolean;
  includeImages: boolean;
  maxImages: number;
  createIndexNote: boolean;
  enableAutoTag?: boolean;
}

export async function getMdImportTabId(): Promise<number> {
  const currentTab = await chrome.tabs.getCurrent();
  if (currentTab?.id) {
    return currentTab.id;
  }

  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (activeTab?.id) {
    return activeTab.id;
  }

  throw new Error('无法确定当前导入页标签页');
}

export async function startMdImportSave(request: MdImportSaveRequest): Promise<{ tabId: number; taskId: string }> {
  const tabId = await getMdImportTabId();
  const taskId = generateId();

  const response = await chrome.runtime.sendMessage({
    type: 'SAVE_MARKDOWN_NOTE',
    payload: {
      ...request,
      taskId,
      tabId,
    },
  });

  if (!response?.success) {
    throw new Error(response?.error || '保存请求发送失败');
  }

  return { tabId, taskId };
}

export function subscribeMdImportTask(
  tabId: number,
  taskId: string,
  callbacks: MdImportTaskSubscription
): () => void {
  const listener = (
    message:
      | SaveTaskCompleteMessage
      | SaveTaskProgressMessage
      | SaveTaskPausedMessage
      | SaveTaskResumedMessage
  ) => {
    if (message.tabId !== tabId || message.taskId !== taskId) {
      return;
    }

    if (message.type === 'SAVE_NOTE_PROGRESS' && callbacks.onProgress) {
      callbacks.onProgress({
        ...message.progress,
        status: message.progress.type === 'uploading_images' ? 'uploading_images' : 'creating_note',
      });
      return;
    }

    if (message.type === 'SAVE_NOTE_PAUSED') {
      callbacks.onPaused?.();
      return;
    }

    if (message.type === 'SAVE_NOTE_RESUMED') {
      callbacks.onResumed?.();
      return;
    }

    if (message.type === 'SAVE_NOTE_COMPLETE') {
      callbacks.onComplete?.(message.result);
    }
  };

  chrome.runtime.onMessage.addListener(listener);
  return () => chrome.runtime.onMessage.removeListener(listener);
}

export async function restoreMdImportTask(tabId: number, taskId?: string): Promise<TaskState | null> {
  const task = await TaskStore.get(tabId);
  if (!task) {
    return null;
  }

  if (taskId && task.taskId !== taskId) {
    return null;
  }

  return task;
}

export async function clearMdImportTask(tabId: number, taskId?: string): Promise<void> {
  await TaskStore.clear(tabId, taskId);
}

export async function pauseMdImportTask(tabId: number, taskId: string): Promise<void> {
  await chrome.runtime.sendMessage({
    type: 'PAUSE_SAVE',
    payload: { tabId, taskId },
  });
}

export async function resumeMdImportTask(tabId: number, taskId: string): Promise<void> {
  await chrome.runtime.sendMessage({
    type: 'RESUME_SAVE',
    payload: { tabId, taskId },
  });
}

export async function cancelMdImportTask(tabId: number, taskId: string): Promise<void> {
  await chrome.runtime.sendMessage({
    type: 'CANCEL_SAVE',
    payload: { tabId, taskId },
  });
}
