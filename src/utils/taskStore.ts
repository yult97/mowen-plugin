import { SaveProgress, NoteCreateResult } from '../types';

const TASK_PREFIX = 'mowen_task_';
const TASK_TTL_MS = 30 * 60 * 1000; // 30 minutes

export type TaskStatus = 'idle' | 'processing' | 'success' | 'failed';

export interface TaskState {
    tabId: number;
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

            return task;
        } catch (e) {
            console.error('TaskStore.get failed:', e);
            return null;
        }
    },

    /**
     * Initialize or overwrite a task
     */
    async init(tabId: number): Promise<void> {
        const state: TaskState = {
            tabId,
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
    async updateProgress(tabId: number, progress: SaveProgress): Promise<void> {
        const task = await this.get(tabId);
        if (!task) return; // Task might be cleared or expired

        task.progress = { ...task.progress, ...progress };
        task.lastUpdate = Date.now();
        await this.save(tabId, task);
    },

    /**
     * Complete task
     */
    async complete(tabId: number, result: NoteCreateResult): Promise<void> {
        const task = await this.get(tabId);
        // Even if task is null (expired?), we might want to record the result if it just finished?
        // But for simplicity, if it's gone, it's gone.
        // However, usually it won't be gone while running unless user manually cleared it.

        // Create new state if missing to ensure result is saved
        const state: TaskState = task || {
            tabId,
            status: 'processing',
            startTime: Date.now(),
            lastUpdate: Date.now(),
        };

        state.status = result.success ? 'success' : 'failed';
        state.lastUpdate = Date.now();
        state.result = {
            success: result.success,
            // Map result fields to storage friendly format
            notes: result.success ? (result as any).notes : undefined,
            error: result.error,
            errorCode: result.errorCode
        };
        // Clear progress on completion to save space, or keep it? Keep it for "100%" visualization if needed.

        await this.save(tabId, state);
    },

    /**
     * Clear task (Manual close)
     */
    async clear(tabId: number): Promise<void> {
        const key = `${TASK_PREFIX}${tabId}`;
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
