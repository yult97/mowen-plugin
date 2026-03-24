import { NoteCreateResult, SaveProgress } from '../types';
import { TaskStore } from '../utils/taskStore';

export type RunningTaskStatus = 'running' | 'pause_requested' | 'paused' | 'cancelling';

export interface RunningSaveTask {
  taskId: string;
  controller: AbortController;
  status: RunningTaskStatus;
  waiters: Array<() => void>;
}

interface SaveTaskPausedMessage {
  type: 'SAVE_NOTE_PAUSED';
  tabId: number;
  taskId: string;
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

export const runningTasks = new Map<number, RunningSaveTask>();

export function notifyTaskWaiters(task: RunningSaveTask): void {
  const pendingWaiters = task.waiters.splice(0);
  for (const resolve of pendingWaiters) {
    resolve();
  }
}

export function getRunningTask(tabId: number, taskId: string): RunningSaveTask | null {
  const task = runningTasks.get(tabId);
  if (!task || task.taskId !== taskId) {
    return null;
  }

  return task;
}

/**
 * 在保存流程的安全点检查任务是否需要暂停或取消。
 * 只有通过这里的阶段才允许进入下一次图片上传或笔记创建。
 */
export async function waitForTaskRunnable(
  tabId: number,
  taskId: string,
  progress?: SaveProgress
): Promise<'running' | 'cancelled'> {
  while (true) {
    const task = getRunningTask(tabId, taskId);
    if (!task) {
      return 'cancelled';
    }

    if (task.status === 'cancelling' || task.controller.signal.aborted) {
      return 'cancelled';
    }

    if (task.status === 'pause_requested') {
      task.status = 'paused';
      await TaskStore.setPaused(tabId, taskId, progress);
      chrome.runtime.sendMessage({
        type: 'SAVE_NOTE_PAUSED',
        tabId,
        taskId,
      } as SaveTaskPausedMessage).catch(() => { });
    }

    if (task.status === 'paused') {
      await new Promise<void>((resolve) => {
        const latestTask = getRunningTask(tabId, taskId);
        if (!latestTask || latestTask.status !== 'paused') {
          resolve();
          return;
        }
        latestTask.waiters.push(resolve);
      });
      continue;
    }

    return 'running';
  }
}

export function sendProgressUpdate(progress: {
  type: 'uploading_images' | 'creating_note';
  uploadedImages?: number;
  totalImages?: number;
  currentPart?: number;
  totalParts?: number;
}, tabId: number, taskId: string, formatErrorForLog: (error: unknown) => string): void {
  chrome.runtime.sendMessage({
    type: 'SAVE_NOTE_PROGRESS',
    tabId,
    taskId,
    progress,
  } as SaveTaskProgressMessage).catch(() => {
    // Popup might be closed, ignore error
  });

  TaskStore.updateProgress(tabId, taskId, {
    ...progress,
    status: progress.type === 'uploading_images' ? 'uploading_images' : 'creating_note',
  }).catch((error) => console.error(`Failed to persist progress: ${formatErrorForLog(error)}`));
}

export async function finalizeSaveTask(
  tabId: number,
  taskId: string,
  result: NoteCreateResult,
  formatErrorForLog: (error: unknown) => string,
  options: { clearTask?: boolean } = {}
): Promise<NoteCreateResult> {
  const currentTask = runningTasks.get(tabId);
  if (currentTask?.taskId === taskId) {
    runningTasks.delete(tabId);
  }

  try {
    if (options.clearTask) {
      await TaskStore.clear(tabId, taskId);
    } else {
      await TaskStore.complete(tabId, taskId, result);
    }
  } catch (storageError) {
    console.error(`[墨问 Background] Failed to finalize task state: ${formatErrorForLog(storageError)}`);
  }

  return result;
}
