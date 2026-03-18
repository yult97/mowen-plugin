import { SaveProgress, NoteCreateResult } from '../types';

const TASK_PREFIX = 'mowen_task_';
const TASK_TTL_MS = 30 * 60 * 1000; // 30 minutes

export type TaskStatus = 'idle' | 'processing' | 'paused' | 'cancelled' | 'success' | 'failed';

export interface TaskState {
    tabId: number;
    taskId: string;
    status: TaskStatus;
    startTime: number;
    lastUpdate: number;

    // Progress info
    progress?: SaveProgress;

    // Result info
    result?: {
        success: boolean;
        notes?: any[]; // Simplified for storage
        error?: string;
        errorCode?: string;
    };
}

export const TaskStore = {
    /**
     * Get task state for a specific tab
     */
    async get(tabId: number): Promise<TaskState | null> {
        try {
            const key = `${TASK_PREFIX}${tabId}`;
            const data = await chrome.storage.session.get(key);
            const task = data[key] as TaskState;

            if (!task) return null;

            // Check TTL
            if (Date.now() - task.lastUpdate > TASK_TTL_MS) {
                await this.clear(tabId);
                return null;
            }

            // Legacy task state without taskId is considered stale.
            if (!task.taskId) {
                await this.clear(tabId);
                return null;
            }

            return task;
        } catch (e) {
            console.error('TaskStore.get failed:', e);
            return null;
        }
    },

    /**
     * Initialize or overwrite a task
     */
    async init(tabId: number, taskId: string): Promise<void> {
        const state: TaskState = {
            tabId,
            taskId,
            status: 'processing',
            startTime: Date.now(),
            lastUpdate: Date.now(),
            progress: { status: 'creating', uploadedImages: 0, totalImages: 0, currentPart: 0, totalParts: 0 }
        };
        await this.save(tabId, state);
    },

    /**
     * Update progress
     */
    async updateProgress(tabId: number, taskId: string, progress: SaveProgress): Promise<void> {
        const task = await this.get(tabId);
        if (!task) return; // Task might be cleared or expired
        if (task.taskId !== taskId) return;

        task.progress = { ...task.progress, ...progress };
        if (progress.status === 'paused') {
            task.status = 'paused';
        } else if (progress.status === 'cancelled') {
            task.status = 'cancelled';
        } else if (task.status !== 'processing') {
            task.status = 'processing';
        }
        task.lastUpdate = Date.now();
        await this.save(tabId, task);
    },

    /**
     * Complete task
     */
    async complete(tabId: number, taskId: string, result: NoteCreateResult): Promise<void> {
        const task = await this.get(tabId);
        if (!task || task.taskId !== taskId) return;

        task.status = result.errorCode === 'CANCELLED'
            ? 'cancelled'
            : (result.success ? 'success' : 'failed');
        task.lastUpdate = Date.now();
        task.result = {
            success: result.success,
            // Map result fields to storage friendly format
            notes: result.success ? (result as any).notes : undefined,
            error: result.error,
            errorCode: result.errorCode
        };
        await this.save(tabId, task);
    },

    async setPaused(tabId: number, taskId: string, progress?: SaveProgress): Promise<void> {
        const task = await this.get(tabId);
        if (!task || task.taskId !== taskId) return;

        task.status = 'paused';
        task.lastUpdate = Date.now();
        task.progress = {
            ...task.progress,
            ...(progress || {}),
            status: 'paused',
        };
        await this.save(tabId, task);
    },

    /**
     * Clear task (Manual close)
     */
    async clear(tabId: number, taskId?: string): Promise<void> {
        const key = `${TASK_PREFIX}${tabId}`;
        if (taskId) {
            const existingTask = await this.get(tabId);
            if (!existingTask || existingTask.taskId !== taskId) return;
        }
        await chrome.storage.session.remove(key);
    },

    /**
     * Private save helper
     */
    async save(tabId: number, state: TaskState): Promise<void> {
        const key = `${TASK_PREFIX}${tabId}`;
        await chrome.storage.session.set({ [key]: state });
    }
};
