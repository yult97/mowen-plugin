import { Settings, DEFAULT_SETTINGS } from '../types';

const STORAGE_KEY = 'mowen_settings';

export async function getSettings(): Promise<Settings> {
  try {
    const result = await chrome.storage.sync.get(STORAGE_KEY);
    if (result[STORAGE_KEY]) {
      return { ...DEFAULT_SETTINGS, ...result[STORAGE_KEY] };
    }
  } catch (e) {
    // Fallback to local storage
    try {
      const result = await chrome.storage.local.get(STORAGE_KEY);
      if (result[STORAGE_KEY]) {
        return { ...DEFAULT_SETTINGS, ...result[STORAGE_KEY] };
      }
    } catch (localErr) {
      console.error('Failed to get settings:', localErr);
    }
  }
  return DEFAULT_SETTINGS;
}

export async function saveSettings(settings: Partial<Settings>): Promise<void> {
  const current = await getSettings();
  const updated = { ...current, ...settings };

  try {
    await chrome.storage.sync.set({ [STORAGE_KEY]: updated });
  } catch (e) {
    // Fallback to local storage
    await chrome.storage.local.set({ [STORAGE_KEY]: updated });
  }
}

export function clampMaxImages(value: number): number {
  if (isNaN(value) || value < 0) return 0;
  if (value > 200) return 200;
  return Math.floor(value);
}
