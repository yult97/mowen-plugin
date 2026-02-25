import React, { useState, useEffect, useRef } from 'react';
import { Settings, ExtractResult, SaveProgress, DEFAULT_SETTINGS } from '../types';
import { getSettings } from '../utils/storage';
import { TaskStore, TaskState } from '../utils/taskStore';
import { injectContentScript } from '../utils/contentScriptHelper';
import {
  Settings as SettingsIcon,
  X,
  FileText,
  Image,
  Scissors,
  Globe,
  Lock,
  Unlock,
  Check,
  RefreshCw,
  ExternalLink,
  AlertCircle,
  Key,
  BookOpen,
  Tag,
  Mic,
} from 'lucide-react';
import TutorialModal from '../components/TutorialModal';
import { VoiceNotePage } from '../sidepanel/VoiceNote';

// Card 4 state machine: P0-P5
type PreviewState = 'P0_Idle' | 'P1_PreviewLoading' | 'P2_PreviewReady' | 'P3_Saving' | 'P4_Success' | 'P5_Failed';

interface PopupProps {
  isSidePanel?: boolean;
}

const Popup: React.FC<PopupProps> = ({ isSidePanel = false }) => {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [extractResult, setExtractResult] = useState<ExtractResult | null>(null);
  const [isPublic, setIsPublic] = useState(false);
  const [includeImages, setIncludeImages] = useState(true);
  const [enableAutoTag, setEnableAutoTag] = useState(false);
  const [progress, setProgress] = useState<SaveProgress>({ status: 'idle' });
  const [currentUrl, setCurrentUrl] = useState('');
  const [currentDomain, setCurrentDomain] = useState('');
  const [isClippable, setIsClippable] = useState(true);
  const [previewState, setPreviewState] = useState<PreviewState>('P0_Idle');
  const [loading, setLoading] = useState(true);
  const [showCancelConfirm, setShowCancelConfirm] = useState(false);
  const [showTutorial, setShowTutorial] = useState(false);
  const [showVoiceNote, setShowVoiceNote] = useState(false);

  // State to trigger auto-fetch preview
  const [autoFetchTrigger, setAutoFetchTrigger] = useState(0);

  // Use ref to track preview state inside event listeners
  const previewStateRef = useRef<PreviewState>('P0_Idle');

  useEffect(() => {
    previewStateRef.current = previewState;
  }, [previewState]);

  useEffect(() => {
    initializePopup();

    // Listen for storage changes (e.g., settings updated in Options page OR task progress)
    const handleStorageChange = async (changes: { [key: string]: chrome.storage.StorageChange }, areaName: string) => {
      // 1. Handle Task State Changes (Session Storage)
      if (areaName === 'session') {
        // We need to know current tab ID to filter relevant updates
        const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!activeTab?.id) return;

        const taskKey = `mowen_task_${activeTab.id}`;
        if (changes[taskKey]) {
          const newValue = changes[taskKey].newValue as TaskState | undefined;

          if (!newValue) {
            // Task cleared?
            return;
          }

          console.log('[墨问 Popup] 🔄 Storage update:', newValue.status);

          if (newValue.status === 'processing' && newValue.progress) {
            setPreviewState('P3_Saving');
            setProgress({
              ...newValue.progress,
              status: newValue.progress.status === 'uploading_images' ? 'uploading_images' : 'creating_note'
            } as SaveProgress);
          } else if (newValue.status === 'success' && newValue.result?.success) {
            setPreviewState('P4_Success');
            setProgress({
              status: 'success',
              notes: newValue.result.notes,
            });
          } else if (newValue.status === 'failed') {
            setPreviewState('P5_Failed');
            setProgress({
              status: 'failed',
              error: newValue.result?.error || '保存失败',
              errorCode: newValue.result?.errorCode,
            });
          }
        }
      }

      // 2. Handle Settings Changes (Sync/Local Storage)
      if (areaName === 'sync' || areaName === 'local') {
        if (changes['mowen_settings']) {
          const { oldValue, newValue } = changes['mowen_settings'];

          if (newValue) {
            console.log('[墨问 Popup] Settings changed, checking for updates...');

            // Always update global settings object to keep it fresh
            setSettings((prev) => ({ ...prev, ...newValue }));

            // Conditionally update UI states only if they changed
            // This prevents resetting user's temporary toggle state if other unrelated settings change
            if (newValue.defaultPublic !== oldValue?.defaultPublic) {
              setIsPublic(newValue.defaultPublic ?? DEFAULT_SETTINGS.defaultPublic);
            }

            if (newValue.defaultIncludeImages !== oldValue?.defaultIncludeImages) {
              setIncludeImages(newValue.defaultIncludeImages ?? DEFAULT_SETTINGS.defaultIncludeImages);
            }

            if (newValue.enableAutoTag !== oldValue?.enableAutoTag) {
              setEnableAutoTag(newValue.enableAutoTag ?? DEFAULT_SETTINGS.enableAutoTag);
            }
          }
        }
      }
    };

    // Listen for tab activation (switching tabs)
    const handleTabChange = async (activeInfo: chrome.tabs.TabActiveInfo) => {
      console.log('[墨问 Popup] Tab switched to:', activeInfo.tabId);

      // Try to restore persisted task state for the new active tab FIRST!
      const restored = await checkPersistedState(activeInfo.tabId);
      if (restored) {
        console.log('[墨问 Popup] ♻️ Restored persisted task state for tab:', activeInfo.tabId);
        await updateCurrentTab();
        return; // Do NOT reset state if we have a running/completed task
      }

      // No persisted state found, reset and auto-fetch as usual
      console.log('[墨问 Popup] No persisted state, auto-fetching preview...');
      setPreviewState('P1_PreviewLoading');
      setExtractResult(null);
      setProgress({ status: 'idle' });
      await updateCurrentTab();
      // Trigger auto-fetch
      setAutoFetchTrigger(prev => prev + 1);
    };

    // Listen for tab updates (URL change OR page reload completion)
    const handleTabUpdate = async (tabId: number, changeInfo: chrome.tabs.TabChangeInfo) => {
      const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (activeTab?.id !== tabId) return; // Only care about active tab

      // Reset on URL change
      if (changeInfo.url) {
        console.log('[墨问 Popup] URL changed, auto-fetching preview...');
        setPreviewState('P1_PreviewLoading');
        setExtractResult(null);
        setProgress({ status: 'idle' });
        await updateCurrentTab();
        setAutoFetchTrigger(prev => prev + 1);
      }

      // Auto-fetch when page finishes loading (catches refresh)
      if (changeInfo.status === 'complete') {
        console.log('[墨问 Popup] Page load complete, auto-fetching preview...');
        setPreviewState('P1_PreviewLoading');
        setExtractResult(null);
        setProgress({ status: 'idle' });
        await updateCurrentTab();
        // Minimal initial delay, rely on PING retries for reliability
        setTimeout(() => {
          setAutoFetchTrigger(prev => prev + 1);
        }, 500);
      }
    };

    // Listen for save completion messages from background
    const handleSaveComplete = (message: { type: string; result?: any }) => {
      if (message.type === 'SAVE_NOTE_COMPLETE' && message.result) {
        if (message.result.success) {
          setProgress({
            status: 'success',
            notes: message.result.notes,
          });
          setPreviewState('P4_Success');
        } else {
          setProgress({
            status: 'failed',
            error: message.result.error || '保存失败',
            errorCode: message.result.errorCode,
          });
          setPreviewState('P5_Failed');
        }
      }
    };

    // Listen for save progress messages from background
    const handleSaveProgress = (message: { type: string; progress?: any }) => {
      if (message.type === 'SAVE_NOTE_PROGRESS' && message.progress) {
        setProgress((prev) => ({
          ...prev,
          status: 'creating',
          ...message.progress,
        }));
      }
    };

    // Listen for content updates from lazy execution observer
    const handleContentUpdate = (message: { type: string; data?: ExtractResult }) => {
      if (message.type === 'CONTENT_UPDATED' && message.data) {
        // Guard: Don't interrupt saving or success state
        if (previewStateRef.current === 'P3_Saving' || previewStateRef.current === 'P4_Success') {
          console.log('[墨问 Popup] 🛑 Ignoring content update during save/success state');
          return;
        }
        console.log('[墨问 Popup] 🔄 Received live content update:', message.data.title, 'images:', message.data.images?.length || 0);
        setExtractResult(message.data);
        setPreviewState('P2_PreviewReady');
      }
    };

    // Listen for content script ready notification (after page refresh)
    const handleContentScriptReady = (message: { type: string }) => {
      if (message.type === 'CONTENT_SCRIPT_READY') {
        console.log('[墨问 Popup] 🚀 Content script ready, triggering extraction...');
        // Immediately trigger fetch - no need to wait or poll
        setPreviewState('P1_PreviewLoading');
        setAutoFetchTrigger(prev => prev + 1);
      }
    };

    // Handle TAB_ACTIVATED from background (Side Panel 切换 Tab 时刷新)
    const handleTabActivated = async (message: { type: string; payload?: { tabId: number; windowId: number } }) => {
      if (message.type === 'TAB_ACTIVATED' && message.payload) {
        console.log('[墨问 Popup] 🔄 TAB_ACTIVATED received, refreshing for tab:', message.payload.tabId);

        // 清理旧内容，重新加载新 Tab 的内容
        setExtractResult(null);
        setPreviewState('P1_PreviewLoading');
        setProgress({ status: 'idle' });
        await updateCurrentTab();
        // 触发自动获取预览
        setAutoFetchTrigger(prev => prev + 1);
      }
    };

    // UNIFIED message handler - prevents conflicts between multiple listeners
    const handleRuntimeMessage = (message: { type: string; result?: any; progress?: any; data?: ExtractResult; payload?: any }) => {
      console.log('[墨问 Popup] Received message:', message.type);

      // Handle all message types in one listener
      handleSaveComplete(message);
      handleSaveProgress(message);
      handleContentUpdate(message);
      handleContentScriptReady(message);
      handleTabActivated(message);
    };

    // Add listeners
    chrome.storage.onChanged.addListener(handleStorageChange);
    chrome.tabs.onActivated.addListener(handleTabChange);
    chrome.tabs.onUpdated.addListener(handleTabUpdate);
    chrome.runtime.onMessage.addListener(handleRuntimeMessage);

    // Cleanup listeners on unmount
    return () => {
      chrome.storage.onChanged.removeListener(handleStorageChange);
      chrome.tabs.onActivated.removeListener(handleTabChange);
      chrome.tabs.onUpdated.removeListener(handleTabUpdate);
      chrome.runtime.onMessage.removeListener(handleRuntimeMessage);
    };
  }, []);

  // Auto-fetch preview when trigger changes (after tab switch, refresh, etc.)
  useEffect(() => {
    if (autoFetchTrigger === 0) return; // Skip initial render

    const doAutoFetch = async () => {
      console.log('[墨问 Popup] Auto-fetching preview...');

      try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab?.id) {
          setPreviewState('P0_Idle');
          return;
        }

        // Check if page is clippable
        if (tab.url) {
          try {
            const url = new URL(tab.url);
            if (!checkClippability(url)) {
              console.log('[墨问 Popup] Page not clippable');
              setPreviewState('P0_Idle');
              return;
            }
          } catch {
            setPreviewState('P0_Idle');
            return;
          }
        }

        // Helper to inject content script (Removed: imported from utils)

        // Retry helper for PING (now just a backup, primary is event-driven)
        const waitForContentScript = async (tabId: number, maxAttempts = 3): Promise<boolean> => {
          for (let i = 0; i < maxAttempts; i++) {
            try {
              const pingRes = await Promise.race([
                chrome.tabs.sendMessage(tabId, { type: 'PING' }),
                new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Timeout')), 500))
              ]) as { success: boolean };

              if (pingRes?.success) {
                return true;
              }
            } catch (e) {
              // Ignore error, wait and retry
            }
            // Short wait between retries
            await new Promise(resolve => setTimeout(resolve, 200));
          }
          return false;
        };

        // Quick PING check (event-driven CONTENT_SCRIPT_READY is primary)
        let isReady = await waitForContentScript(tab.id, 2);

        // If not ready, try inject as last resort
        if (!isReady) {
          console.log('[墨问 Popup] Content script not responding, attempting injection...');
          await injectContentScript(tab.id);
          isReady = await waitForContentScript(tab.id, 2);
        }

        if (!isReady) {
          console.log('[墨问 Popup] Content script still not ready after injection and retries');
          setPreviewState('P0_Idle');
          return;
        }

        // Try to get content from content script
        // OPTIMIZATION: Use START_EXTRACTION instead of EXTRACT_CONTENT to wake up the script if needed
        try {
          const response = await Promise.race([
            chrome.tabs.sendMessage(tab.id, { type: 'START_EXTRACTION' }),
            new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Timeout')), 10000))
          ]) as { success: boolean; data?: any; error?: string };

          if (response?.success && response?.data) {
            console.log('[墨问 Popup] Auto-fetch success, images:', response.data.images?.length || 0);
            setExtractResult(response.data);
            setPreviewState('P2_PreviewReady');
          } else {
            console.log('[墨问 Popup] Auto-fetch failed:', response?.error);
            setPreviewState('P0_Idle');
          }
        } catch (error) {
          console.log('[墨问 Popup] Auto-fetch error:', error);
          setPreviewState('P0_Idle');
        }

      } catch (error) {
        console.error('[墨问 Popup] Auto-fetch exception:', error);
        setPreviewState('P0_Idle');
      }
    };

    doAutoFetch();
  }, [autoFetchTrigger]);

  const updateCurrentTab = async () => {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab?.url) {
        const newUrl = tab.url;
        setCurrentUrl(newUrl);
        try {
          const url = new URL(newUrl);
          setCurrentDomain(url.hostname);
          // Check if page is clippable
          setIsClippable(checkClippability(url));
        } catch {
          setCurrentDomain('');
          setIsClippable(false);
        }
      }
    } catch (error) {
      console.error('Failed to update current tab:', error);
    }
  };

  const initializePopup = async () => {
    try {
      console.log('[墨问 Popup] 🚀 Initializing popup...');

      // Load settings
      const loadedSettings = await getSettings();
      setSettings(loadedSettings);
      setIsPublic(loadedSettings.defaultPublic);
      setIncludeImages(loadedSettings.defaultIncludeImages);
      setEnableAutoTag(loadedSettings.enableAutoTag);
      console.log('[墨问 Popup] enableAutoTag loaded:', loadedSettings.enableAutoTag);

      // Get current tab info and determine clippability
      await updateCurrentTab();

      // Check for persisted task state first (RESUME)
      const [currentTab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (currentTab?.id) {
        const restored = await checkPersistedState(currentTab.id);
        if (restored) {
          setLoading(false);
          return; // Skip rest of initialization if restored
        }
      }

      // Check if current page is clippable directly from URL
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      let canClip = false;
      if (tab?.url) {
        try {
          const url = new URL(tab.url);
          canClip = checkClippability(url);
        } catch {
          canClip = false;
        }
      }

      setLoading(false);

      // Auto-load cached content when popup opens (if page is clippable)
      console.log('[墨问 Popup] 📖 Auto-loading cached content on popup open...');
      console.log('[墨问 Popup] Clippable:', canClip, 'URL:', tab?.url);

      if (canClip && tab?.id) {
        // Immediately try to get cached content without showing loading UI
        try {
          // Helper to inject content script (Removed: imported from utils)

          // Check if content script is ready first
          let pingResponse: { success: boolean; status: string } | undefined;
          try {
            pingResponse = await Promise.race([
              chrome.tabs.sendMessage(tab.id, { type: 'PING' }),
              new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Timeout')), 1000))
            ]) as { success: boolean; status: string } | undefined;
          } catch (pingErr) {
            console.log('[墨问 Popup] ⚠️ Content script not responding, attempting injection...');
            // Content script not available, try to inject it
            const injected = await injectContentScript(tab.id);
            if (injected) {
              // Retry PING after injection
              try {
                pingResponse = await Promise.race([
                  chrome.tabs.sendMessage(tab.id, { type: 'PING' }),
                  new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Timeout')), 1500))
                ]) as { success: boolean; status: string } | undefined;
              } catch {
                console.log('[墨问 Popup] ❌ Content script still not responding after injection');
              }
            }
          }

          if (pingResponse?.success) {
            console.log('[墨问 Popup] ✅ Content script ready, checking for cached content...');

            // Try to get cached content
            const cachedResponse = await Promise.race([
              chrome.tabs.sendMessage(tab.id, { type: 'GET_CACHED_CONTENT' }),
              new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Cache check timeout')), 2000))
            ]) as { success: boolean; data?: ExtractResult; fromCache?: boolean; extracting?: boolean } | undefined;

            // If we have cached content, use it immediately and show preview state
            if (cachedResponse?.success && cachedResponse?.data) {
              console.log('[墨问 Popup] ✅ Loaded cached content, word count:', cachedResponse.data.wordCount);
              setExtractResult(cachedResponse.data);
              setPreviewState('P2_PreviewReady');
            } else if (cachedResponse?.extracting) {
              console.log('[墨问 Popup] ⏳ Content is being extracted, will wait...');
              // Wait a bit and try again
              const tabId = tab.id; // Capture tab.id for closure
              setTimeout(async () => {
                if (!tabId) return;
                try {
                  const retryResponse = await chrome.tabs.sendMessage(tabId, { type: 'GET_CACHED_CONTENT' }) as { success: boolean; data?: ExtractResult; fromCache?: boolean } | undefined;
                  if (retryResponse?.success && retryResponse?.data) {
                    console.log('[墨问 Popup] ✅ Got content after waiting');
                    setExtractResult(retryResponse.data);
                    setPreviewState('P2_PreviewReady');
                  } else {
                    // Still nothing? Trigger active fetch
                    console.log('[墨问 Popup] ⚠️ Still no content, triggering active fetch');
                    setAutoFetchTrigger(prev => prev + 1);
                  }
                } catch (err) {
                  console.log('[墨问 Popup] ⚠️ Could not get cached content after retry');
                }
              }, 2000);
            } else {
              console.log('[墨问 Popup] ℹ️ No cached content available, triggering active fetch');
              // OPTIMIZATION: Manual trigger since we removed auto-extraction
              setAutoFetchTrigger(prev => prev + 1);
            }
          }
        } catch (error) {
          console.log('[墨问 Popup] ⚠️ Could not load cached content:', error);
          // Not a critical error, user can still manually trigger extraction
          // Trigger auto fetch just in case
          setAutoFetchTrigger(prev => prev + 1);
        }
      } else {
        console.log('[墨问 Popup] ⚠️ Page not clippable or no tab ID, skipping auto-load');
      }
    } catch (error) {
      console.error('[墨问 Popup] ❌ Failed to initialize popup:', error);
      setLoading(false);
    }
  };

  /**
   * 检查并恢复持久化的任务状态
   * 只恢复仍在处理中的任务；成功/失败状态在显示后立即清理，
   * 避免用户关闭插件再打开时看到旧的结果页面
   */
  const checkPersistedState = async (tabId: number) => {
    try {
      console.log('[墨问 Popup] 🔍 Checking persisted state for tab:', tabId);
      const state = await TaskStore.get(tabId);

      if (!state) {
        console.log('[墨问 Popup] No persisted state found');
        return false;
      }

      console.log('[墨问 Popup] ♻️ Found persisted state:', state.status);

      if (state.status === 'processing' && state.progress) {
        // 恢复进度显示 - 任务仍在进行中
        setPreviewState('P3_Saving');
        setProgress({
          ...state.progress,
          status: state.progress.status === 'uploading_images' ? 'uploading_images' : 'creating_note'
        } as SaveProgress);
        return true;
      } else if (state.status === 'success' || state.status === 'failed') {
        // 成功/失败状态：不再恢复，直接清理
        // 用户期望重新打开插件时是干净的预览页面
        console.log('[墨问 Popup] 🧹 Clearing completed task state, user should see fresh preview');
        await TaskStore.clear(tabId);
        return false; // 返回 false 让 initializePopup 继续正常流程
      }
    } catch (e) {
      console.error('[墨问 Popup] Failed to restore state:', e);
    }
    return false;
  };

  const checkClippability = (url: URL): boolean => {
    // Cannot clip chrome:// pages, extensions, etc.
    const invalidProtocols = ['chrome:', 'chrome-extension:', 'about:', 'data:', 'file:'];
    return !invalidProtocols.some(protocol => url.protocol.startsWith(protocol));
  };

  const handleGetPreview = async () => {
    if (!isClippable) return;

    setPreviewState('P1_PreviewLoading');
    setExtractResult(null);

    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) {
        throw new Error('No active tab');
      }

      // Helper to inject content script (Removed: imported from utils)

      // Check if content script is ready by sending a ping
      let isContentScriptReady = false;
      let pingError: Error | null = null;

      try {
        const pingResponse = await Promise.race([
          chrome.tabs.sendMessage(tab.id, { type: 'PING' }),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Timeout')), 2000))
        ]) as { success: boolean; status: string } | undefined;
        isContentScriptReady = pingResponse?.success === true;
      } catch (error) {
        pingError = error instanceof Error ? error : new Error('Unknown error');
        isContentScriptReady = false;

        // Try to inject content script
        console.log('[墨问 Popup] ⚠️ Content script not ready, attempting injection...');
        const injected = await injectContentScript(tab.id);
        if (injected) {
          // Retry PING after injection
          try {
            const retryPing = await Promise.race([
              chrome.tabs.sendMessage(tab.id, { type: 'PING' }),
              new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Timeout')), 1500))
            ]) as { success: boolean; status: string } | undefined;
            isContentScriptReady = retryPing?.success === true;
            if (isContentScriptReady) {
              console.log('[墨问 Popup] ✅ Content script injected successfully');
              pingError = null;
            }
          } catch {
            console.log('[墨问 Popup] ❌ Content script still not responding after injection');
          }
        }
      }

      // If content script is not ready, show helpful error
      if (!isContentScriptReady) {
        console.log('[墨问] Content script not ready:', pingError?.message);

        // Try to check if we can reload the page or provide guidance
        if (pingError?.message.includes('Receiving end does not exist') ||
          pingError?.message.includes('Could not establish connection')) {
          throw new Error('页面脚本未加载,请刷新页面后重试');
        } else if (pingError?.message.includes('Timeout')) {
          throw new Error('页面响应超时,请刷新页面或稍后重试');
        } else {
          throw new Error('无法连接到页面,请刷新页面后重试');
        }
      }

      // First, try to get cached content (fast path)
      const cachedResponse = await Promise.race([
        chrome.tabs.sendMessage(tab.id, { type: 'GET_CACHED_CONTENT' }),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Cache check timeout')), 1000))
      ]) as { success: boolean; data?: ExtractResult; fromCache?: boolean; extracting?: boolean } | undefined;

      // If we have cached content, use it immediately
      if (cachedResponse?.success && cachedResponse?.data && cachedResponse?.fromCache) {
        console.log('[墨问] Using cached content, word count:', cachedResponse.data.wordCount);
        setExtractResult(cachedResponse.data);
        setPreviewState('P2_PreviewReady');
        return;
      }

      // If extraction is in progress, wait a bit and try again
      if (cachedResponse?.extracting) {
        console.log('[墨问] Extraction in progress, waiting...');
        await new Promise(resolve => setTimeout(resolve, 2000));

        // Try again to get cached content
        const retryResponse = await Promise.race([
          chrome.tabs.sendMessage(tab.id, { type: 'GET_CACHED_CONTENT' }),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Cache retry timeout')), 5000))
        ]) as { success: boolean; data?: ExtractResult; fromCache?: boolean } | undefined;

        if (retryResponse?.success && retryResponse?.data) {
          console.log('[墨问] Got content after waiting, word count:', retryResponse.data.wordCount);
          setExtractResult(retryResponse.data);
          setPreviewState('P2_PreviewReady');
          return;
        }
      }

      // No cache available, do full extraction (fallback)
      console.log('[墨问] No cache available, doing full extraction');
      const response = await Promise.race([
        chrome.tabs.sendMessage(tab.id, { type: 'START_EXTRACTION' }),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('请求超时')), 15000))
      ]);

      if (response?.success) {
        setExtractResult(response.data);
        setPreviewState('P2_PreviewReady');
      } else {
        throw new Error(response?.error || '提取失败');
      }
    } catch (error) {
      console.error('[墨问] Failed to extract content:', error);

      // Provide more specific error messages
      let errorMessage = '提取失败，请重试';
      if (error instanceof Error) {
        if (error.message.includes('Receiving end does not exist')) {
          errorMessage = '页面脚本未加载,请刷新页面后重试';
        } else if (error.message.includes('Could not establish connection')) {
          errorMessage = '无法连接到页面,请刷新页面后重试';
        } else if (error.message.includes('Timeout') || error.message.includes('超时')) {
          errorMessage = '请求超时,请稍后重试';
        } else if (error.message.includes('刷新页面')) {
          errorMessage = error.message;
        }
      }

      setPreviewState('P5_Failed');
      setProgress({
        status: 'failed',
        error: errorMessage,
      });
    }
  };

  const handleCancelPreview = () => {
    // Clear legacy state if any
    chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
      if (tab?.id) TaskStore.clear(tab.id);
    });
    setPreviewState('P0_Idle');
    setExtractResult(null);
  };

  const handleSave = async () => {
    if (!extractResult) {
      console.error('[墨问 Popup] ❌ No extract result to save');
      setProgress({
        status: 'failed',
        error: '没有可保存的内容，请先获取预览',
      });
      setPreviewState('P5_Failed');
      return;
    }

    if (!settings.apiKey) {
      console.error('[墨问 Popup] ❌ No API key configured');
      setProgress({
        status: 'failed',
        error: 'API Key 未配置，请前往设置页面配置',
      });
      setPreviewState('P5_Failed');
      return;
    }

    console.log('[墨问 Popup] 💾 Starting save process...');

    // Stop auto-extraction to prevent state reset
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab?.id) {
        chrome.tabs.sendMessage(tab.id, { type: 'STOP_EXTRACTION' }).catch(() => { });
      }
    } catch (e) {
      // Ignore
    }

    console.log('[墨问 Popup] Save payload:', {
      title: extractResult.title,
      wordCount: extractResult.wordCount,
      images: extractResult.images.length,
      isPublic,
      includeImages,
      maxImages: settings.maxImages,
    });

    setPreviewState('P3_Saving');
    // 设置初始进度，包含图片数量以便进度条立即显示
    const imagesToProcess = includeImages ? Math.min(extractResult.images.length, settings.maxImages) : 0;
    const estimatedParts = Math.ceil(extractResult.wordCount / 19000) || 1;
    setProgress({
      status: 'creating',
      totalImages: imagesToProcess,
      uploadedImages: 0,
      totalParts: estimatedParts,
      currentPart: 0,
    });

    // Helper to proxy log
    const logProxy = async (msg: string) => {
      try {
        const [t] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (t?.id) chrome.tabs.sendMessage(t.id, { type: 'LOG_DEBUG', payload: msg }).catch(() => { });
      } catch {
        void 0;
      }
    };

    try {
      // 1. Connectivity Check
      await logProxy('Popup: Checking connectivity (PING)...');
      try {
        const pingRes = await chrome.runtime.sendMessage({ type: 'PING' });
        await logProxy(`Popup: PING success, status: ${pingRes?.status}`);
      } catch (pingErr) {
        await logProxy(`Popup: ❌ PING FAILED: ${pingErr}`);
        throw new Error(`无法连接后台服务 (${String(pingErr)})`);
      }

      // 2. Send save request
      console.log('[墨问 Popup] 📤 Sending SAVE_NOTE message to background...');
      const payloadStr = JSON.stringify({ extractResult, isPublic, includeImages, maxImages: settings.maxImages });
      const payloadSize = (payloadStr.length / 1024).toFixed(2);
      console.log(`[墨问 Popup] Payload size: ${payloadSize} KB`);

      // Proxy log to content script for user visibility preference
      try {
        const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (activeTab?.id) {
          chrome.tabs.sendMessage(activeTab.id, {
            type: 'LOG_DEBUG',
            payload: `Popup: Clicking Save. Payload size: ${payloadSize} KB. Sending to Background...`
          }).catch(() => { });
        }
      } catch (e) { console.error('Proxy log failed', e); }

      // Get tab ID before sending to ensure correct task binding
      const [saveTab] = await chrome.tabs.query({ active: true, currentWindow: true });
      const saveTabId = saveTab?.id;
      console.log('[墨问 Popup] 📤 Sending SAVE_NOTE with tabId:', saveTabId);

      const response = await Promise.race([
        chrome.runtime.sendMessage({
          type: 'SAVE_NOTE',
          payload: {
            extractResult,
            isPublic,
            includeImages,
            maxImages: settings.maxImages,
            createIndexNote: settings.createIndexNote,
            enableAutoTag,
            tabId: saveTabId, // Include tabId for proper task binding
          },
        }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('Background script timeout')), 5000)
        )
      ]);

      // Immediately log that we got a response
      await logProxy(`Popup: ✅ Got response from background: ${JSON.stringify(response)}`);
      console.log('[墨问 Popup] 📥 Received response from background:', response);

      // Check if background acknowledged the request
      if (!response?.success && !response?.acknowledged) {
        console.error('[墨问 Popup] ❌ Background did not acknowledge save request');
        setProgress({
          status: 'failed',
          error: '后台服务未响应，请重试或刷新扩展',
          errorCode: response?.errorCode,
        });
        setPreviewState('P5_Failed');
        return;
      }

      console.log('[墨问 Popup] ✅ Save request acknowledged, waiting for completion...');
      // If acknowledged, we'll wait for SAVE_NOTE_COMPLETE message
      // The completion will be handled by the message listener
    } catch (error) {
      console.error('[墨问 Popup] ❌ Save request failed:', error);

      // Proxy error to content script
      try {
        const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (activeTab?.id) {
          const errMsg = error instanceof Error ? error.message : String(error);
          chrome.tabs.sendMessage(activeTab.id, {
            type: 'LOG_DEBUG',
            payload: `Popup: ❌ Save failed: ${errMsg}`
          }).catch(() => { });
        }
      } catch (e) {
        void e;
      }

      let errorMessage = '保存失败，请重试';
      if (error instanceof Error) {
        if (error.message.includes('timeout')) {
          errorMessage = '后台服务响应超时，请检查扩展是否正常运行';
        } else if (error.message.includes('Could not establish connection')) {
          errorMessage = '无法连接到后台服务，请重新加载扩展';
        } else if (error.message.includes('Extension context invalidated')) {
          errorMessage = '扩展已失效，请刷新页面或重新加载扩展';
        } else {
          errorMessage = error.message;
        }
      }

      setProgress({
        status: 'failed',
        error: errorMessage,
      });
      setPreviewState('P5_Failed');
    }
  };

  const openOptions = (anchor?: string) => {
    // Note: Cannot directly navigate to anchor in Chrome extension,
    // but options page can read hash on load
    if (anchor) {
      console.log('Opening options with anchor:', anchor);
    }
    chrome.runtime.openOptionsPage();
  };

  const handleRetry = () => {
    // Clear failed state to start fresh
    chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
      if (tab?.id) TaskStore.clear(tab.id);
    });
    setPreviewState('P2_PreviewReady');
    setProgress({ status: 'idle' });
  };

  // Show cancel confirmation modal
  const handleCancelClick = () => {
    setShowCancelConfirm(true);
  };

  // User confirms cancel - actually stop the save
  const handleConfirmCancel = async () => {
    console.log('[墨问 Popup] ❌ User confirmed cancel');
    setShowCancelConfirm(false);
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab?.id) {
        await chrome.runtime.sendMessage({
          type: 'CANCEL_SAVE',
          payload: { tabId: tab.id }
        });
        // IMPORTANT: Clear persisted task state to prevent stale restoration on tab switch
        await TaskStore.clear(tab.id);
        console.log('[墨问 Popup] 🧹 Cleared TaskStore for tab:', tab.id);
      }
    } catch (err) {
      console.error('[墨问 Popup] Failed to send cancel message:', err);
    }
    setPreviewState('P5_Failed');
    setProgress({ status: 'cancelled' });
  };

  // User wants to continue saving
  const handleContinueSave = () => {
    setShowCancelConfirm(false);
  };

  // Reset to try again after cancel
  const handleRestartAfterCancel = () => {
    setPreviewState('P2_PreviewReady');
    setProgress({ status: 'idle' });
  };

  const handleRetryExtraction = () => {
    handleGetPreview();
  };

  // Card 1: Feature Overview (Always shown)
  const renderFeatureOverview = () => (
    <div className="card p-4 mb-3">
      <h3 className="text-sm font-semibold text-text-primary mb-3">你可以用它做什么</h3>
      <ul className="space-y-2.5">
        <li className="flex items-start gap-2.5">
          <div className="w-5 h-5 rounded-md bg-brand-soft flex items-center justify-center flex-shrink-0">
            <Scissors className="text-brand-primary" size={14} />
          </div>
          <span className="text-sm text-text-secondary">一键剪藏公众号/新闻/博客到墨问</span>
        </li>
        <li className="flex items-start gap-2.5">
          <div className="w-5 h-5 rounded-md bg-brand-soft flex items-center justify-center flex-shrink-0">
            <Image className="text-brand-primary" size={14} />
          </div>
          <span className="text-sm text-text-secondary">图片尽可能抓取上传,失败自动转链接</span>
        </li>
        <li className="flex items-start gap-2.5">
          <div className="w-5 h-5 rounded-md bg-brand-soft flex items-center justify-center flex-shrink-0">
            <FileText className="text-brand-primary" size={14} />
          </div>
          <span className="text-sm text-text-secondary">超过 19,000 字自动拆分为多篇</span>
        </li>
        <li className="flex items-start gap-2.5">
          <div className="w-5 h-5 rounded-md bg-brand-soft flex items-center justify-center flex-shrink-0">
            <Lock className="text-brand-primary" size={14} />
          </div>
          <span className="text-sm text-text-secondary">公开/私密可控,支持默认设置</span>
        </li>
      </ul>

      {/* AI 语音笔记入口 */}
      {isSidePanel && (
        <div className="mt-3 pt-3 border-t border-border-default">
          <button
            className="w-full flex items-center gap-3 p-3 rounded-lg bg-gradient-to-r from-brand-soft to-purple-50 hover:from-brand-soft/80 hover:to-purple-100 transition-all group"
            onClick={() => setShowVoiceNote(true)}
          >
            <div className="w-8 h-8 rounded-full bg-white flex items-center justify-center shadow-sm group-hover:shadow">
              <Mic className="text-brand-primary" size={16} />
            </div>
            <div className="text-left flex-1">
              <div className="text-sm font-medium text-text-primary">AI 语音笔记</div>
              <div className="text-xs text-text-secondary">说话即可记录，智能转写成文</div>
            </div>
            <span className="text-xs px-2 py-0.5 rounded-full bg-brand-primary/10 text-brand-primary">新</span>
          </button>
        </div>
      )}

      {currentDomain && (
        <div className="mt-3 pt-3 border-t border-border-default">
          <div className="flex items-center gap-2 text-xs">
            <Globe size={12} className="text-text-secondary" />
            <span className="text-text-secondary">当前页面:</span>
            <span className="pill pill-neutral px-2 py-0.5">{currentDomain}</span>
          </div>
          <div className="mt-1.5 text-xs">
            {isClippable ? (
              <span className="text-green-600">✓ 可剪藏</span>
            ) : (
              <span className="text-red-600">该页面不支持剪藏,请打开文章页</span>
            )}
          </div>
        </div>
      )}
    </div>
  );



  // Card 3: Quick Settings (Always shown)
  const renderQuickSettings = () => (
    <div className="card p-4 mb-3">
      <h3 className="text-sm font-semibold text-text-primary mb-3">快速设置</h3>
      <div className="space-y-3">
        {/* Include Images Toggle */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Image size={16} className="text-text-secondary" />
            <span className="text-sm text-text-primary">包含图片</span>
          </div>
          <button
            className={`switch ${includeImages ? 'switch-on' : 'switch-off'}`}
            onClick={() => setIncludeImages(!includeImages)}
          >
            <span className={`switch-thumb ${includeImages ? 'translate-x-5' : 'translate-x-1'}`} />
          </button>
        </div>
        <p className="text-xs text-text-secondary ml-6 -mt-2">开启后会尽量抓取并上传网页图片</p>

        {/* Auto Tag Toggle */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Tag size={16} className="text-text-secondary" />
            <span className="text-sm text-text-primary">添加标签</span>
          </div>
          <button
            className={`switch ${enableAutoTag ? 'switch-on' : 'switch-off'}`}
            onClick={() => {
              const newValue = !enableAutoTag;
              setEnableAutoTag(newValue);
              console.log('[墨问 Popup] Saving enableAutoTag:', newValue);
              // 通过 Background Script 保存，确保 Popup 关闭后设置仍能持久化
              chrome.runtime.sendMessage({
                type: 'SAVE_SETTING',
                payload: { enableAutoTag: newValue }
              }).then((response) => {
                if (!response?.success) {
                  console.error('[墨问 Popup] SAVE_SETTING failed:', response?.error);
                  // 恢复 UI 状态以反映保存失败
                  setEnableAutoTag(!newValue);
                }
              }).catch((err) => {
                console.error('[墨问 Popup] Failed to save enableAutoTag:', err);
                // 恢复 UI 状态以反映保存失败
                setEnableAutoTag(!newValue);
              });
            }}
          >
            <span className={`switch-thumb ${enableAutoTag ? 'translate-x-5' : 'translate-x-1'}`} />
          </button>
        </div>
        <p className="text-xs text-text-secondary ml-6 -mt-2">开启后自动为剪藏笔记添加「墨问剪藏」标签</p>

        {/* Public Toggle */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            {isPublic ? <Unlock size={16} className="text-text-secondary" /> : <Lock size={16} className="text-text-secondary" />}
            <span className="text-sm text-text-primary">发布公开笔记</span>
          </div>
          <button
            className={`switch ${isPublic ? 'switch-on' : 'switch-off'}`}
            onClick={() => setIsPublic(!isPublic)}
          >
            <span className={`switch-thumb ${isPublic ? 'translate-x-5' : 'translate-x-1'}`} />
          </button>
        </div>
        <p className="text-xs text-text-secondary ml-6 -mt-2">关闭则保存为私密</p>

        {/* Max Images Summary */}
        <div className="pt-2 border-t border-border-default">
          <div className="flex items-center justify-between">
            <span className="text-xs text-text-secondary">最大内嵌图片数: {settings.maxImages}</span>
            <button
              className="text-xs text-brand-primary hover:underline"
              onClick={() => openOptions()}            >
              修改
            </button>
          </div>
          <p className="text-xs text-text-secondary mt-1">超出数量的图片会转为可点击链接</p>
        </div>
      </div>
    </div>
  );

  // Card 4: Main Preview Card (Handles all main states: Config/Idle/Preview/Result)
  const renderPreviewCard = () => {
    const hasApiKey = !!settings.apiKey;
    const testSuccess = settings.lastTestStatus === 'success';

    // 1. No API Key
    if (!hasApiKey) {
      return (
        <div className="card p-5 mb-3 bg-brand-soft/30 border-brand-soft">
          <div className="text-center">
            <div className="w-12 h-12 bg-white rounded-full flex items-center justify-center mx-auto mb-3 shadow-sm border border-brand-soft">
              <Key className="text-brand-primary" size={24} />
            </div>
            <h4 className="text-sm font-semibold text-text-primary mb-1">未配置 API Key</h4>
            <p className="text-xs text-text-secondary mb-4 leading-relaxed">
              配置后即可保存到墨问<br />
              请先在<strong>墨问微信小程序</strong>生成 Key
            </p>
            <div className="flex flex-col gap-2">
              <button
                className="btn-primary w-full"
                onClick={() => openOptions()}
              >
                去设置
              </button>
              <button
                className="text-xs text-brand-primary hover:underline flex items-center justify-center gap-1.5 py-1"
                onClick={() => setShowTutorial(true)}
              >
                <BookOpen size={12} />
                查看获取教程
              </button>
            </div>
          </div>
        </div>
      );
    }

    // 2. Not Tested
    if (!testSuccess) {
      return (
        <div className="card p-5 mb-3 bg-yellow-50/50 border-yellow-100">
          <div className="text-center">
            <div className="w-12 h-12 bg-white rounded-full flex items-center justify-center mx-auto mb-3 shadow-sm border border-yellow-100">
              <AlertCircle className="text-yellow-600" size={24} />
            </div>
            <h4 className="text-sm font-semibold text-text-primary mb-1">API Key 未通过测试</h4>
            <p className="text-xs text-text-secondary mb-4">
              建议先进行连接测试，以确保 API 有效
            </p>
            <button className="btn-primary w-full mb-2" onClick={() => openOptions()}>
              测试连接
            </button>
          </div>
        </div>
      );
    }

    // P0 Idle (Ready to Clip)
    if (previewState === 'P0_Idle') {
      return (
        <div className="card p-4 mb-3">
          <h3 className="text-sm font-semibold text-text-primary mb-3">剪藏预览</h3>
          <div className="text-center py-6">
            <div className="w-12 h-12 bg-brand-soft rounded-full flex items-center justify-center mx-auto mb-3">
              <FileText className="text-brand-primary" size={24} />
            </div>
            {!isClippable ? (
              <>
                <p className="text-xs text-text-secondary mb-4">当前页面无法剪藏</p>
                <button className="btn-primary w-full mb-2" disabled>获取预览</button>
              </>
            ) : (
              <>
                <p className="text-xs text-text-secondary mb-4">点击下方按钮获取预览</p>
                <button
                  className="btn-primary w-full mb-2"
                  onClick={handleGetPreview}
                >
                  获取预览
                </button>
                {settings.lastTestNoteUrl && (
                  <button
                    className="text-xs text-brand-primary hover:underline flex items-center justify-center gap-1 w-full"
                    onClick={() => window.open(settings.lastTestNoteUrl!, '_blank')}
                  >
                    打开测试笔记 <ExternalLink size={12} />
                  </button>
                )}
              </>
            )}
          </div>
        </div>
      );
    }

    // P1 PreviewLoading
    if (previewState === 'P1_PreviewLoading') {
      return (
        <div className="card p-4 mb-3">
          <h3 className="text-sm font-semibold text-text-primary mb-3">剪藏预览</h3>
          <div className="text-center py-6">
            <RefreshCw className="animate-spin text-brand-primary mx-auto mb-3" size={32} />
            <p className="text-sm font-medium text-text-primary mb-2">正在提取正文…</p>
            <div className="text-xs text-text-secondary space-y-1">
              <p>1. 提取正文</p>
              <p>2. 解析图片</p>
              <p>3. 生成预览</p>
            </div>
            <button
              className="text-xs text-text-secondary hover:text-text-primary mt-4"
              onClick={handleCancelPreview}
            >
              取消
            </button>
          </div>
        </div>
      );
    }

    // P2 PreviewReady
    if (previewState === 'P2_PreviewReady' && extractResult) {
      const imagesToEmbed = Math.min(extractResult.images.length, settings.maxImages);
      const imagesToLink = Math.max(0, extractResult.images.length - settings.maxImages);

      return (
        <div className="card p-4 mb-3">
          <h3 className="text-sm font-semibold text-text-primary mb-3">剪藏预览</h3>
          <div>
            <h4 className="text-sm font-medium text-text-primary mb-2 line-clamp-2">
              {extractResult.title || '无标题'}
            </h4>
            <p className="text-xs text-text-secondary mb-3 truncate">来源: {currentUrl}</p>

            {/* Stats chips */}
            <div className="flex flex-wrap gap-2 mb-3">
              <span className="pill pill-neutral">字数: ≈ {extractResult.wordCount.toLocaleString()}</span>
              <span className="pill pill-neutral">图片: {extractResult.images.length}</span>
              {includeImages && (
                <>
                  <span className="pill pill-neutral">将内嵌: {imagesToEmbed}</span>
                  {imagesToLink > 0 && (
                    <span className="pill pill-neutral">将转链接: {imagesToLink}</span>
                  )}
                </>
              )}
            </div>

            {/* Action buttons */}
            <div className="flex gap-2">
              <button className="btn-primary flex-1" onClick={handleSave}>
                保存到墨问
              </button>
              <button className="btn-secondary" onClick={handleGetPreview}>
                <RefreshCw size={16} />
              </button>
            </div>
          </div>
        </div>
      );
    }

    // P3 Saving
    if (previewState === 'P3_Saving') {

      // Generate cancel confirmation description
      const getCancelDescription = () => {
        if (progress.totalImages && progress.totalImages > 0) {
          return `已上传 ${progress.uploadedImages || 0}/${progress.totalImages} 张图片，停止后本次内容不会写入墨问。`;
        }
        return '正在准备保存，停止后本次内容不会写入墨问。';
      };

      return (
        <div className="card p-4 mb-3 relative">
          {/* Header with X button */}
          <div className="flex justify-between items-center mb-3">
            <h3 className="text-sm font-semibold text-text-primary">剪藏预览</h3>
            <button
              className="w-7 h-7 flex items-center justify-center rounded-full text-gray-400 hover:text-brand-primary hover:bg-brand-soft transition-colors"
              onClick={handleCancelClick}
              title="停止保存"
            >
              <X size={16} />
            </button>
          </div>

          <div className="text-center py-4">
            <RefreshCw className="animate-spin text-brand-primary mx-auto mb-3" size={32} />
            <p className="text-sm font-medium text-text-primary mb-4">正在保存到墨问…</p>

            {/* Unified Progress Bar - Two Phases: Image Upload then Note Creation */}
            <div className="space-y-3 text-left px-2">
              {(() => {
                // Calculate unified progress: Image phase (0-50%) + Note phase (50-100%)
                const hasImages = progress.totalImages !== undefined && progress.totalImages > 0;
                const hasNotes = progress.totalParts !== undefined && progress.totalParts > 0;

                // Determine current phase and calculate overall progress
                let overallProgress = 0;
                let phaseLabel = '准备中...';
                let phaseDetail = '';

                if (hasImages) {
                  const imageProgress = (progress.uploadedImages || 0) / progress.totalImages!;
                  const imagesComplete = (progress.uploadedImages || 0) >= progress.totalImages!;

                  if (!imagesComplete) {
                    // Phase 1: Uploading images (0% - 50%)
                    overallProgress = (imageProgress * 50);
                    phaseLabel = '正在上传图片...';
                    phaseDetail = `${progress.uploadedImages || 0}/${progress.totalImages}`;
                  } else if (hasNotes) {
                    // Phase 2: Creating notes (50% - 100%)
                    const noteProgress = (progress.currentPart || 0) / progress.totalParts!;
                    overallProgress = 50 + (noteProgress * 50);
                    phaseLabel = '正在创建笔记...';
                    phaseDetail = `${progress.currentPart || 0}/${progress.totalParts}`;
                  } else {
                    // Images done, no notes yet
                    overallProgress = 50;
                    phaseLabel = '图片上传完成，准备创建笔记...';
                  }
                } else if (hasNotes) {
                  // No images, only notes (0% - 100%)
                  const noteProgress = (progress.currentPart || 0) / progress.totalParts!;
                  overallProgress = noteProgress * 100;
                  phaseLabel = '正在创建笔记...';
                  phaseDetail = `${progress.currentPart || 0}/${progress.totalParts}`;
                } else {
                  // No progress data yet
                  phaseLabel = '处理中...';
                }

                return (
                  <div>
                    <div className="flex justify-between items-center text-xs mb-1">
                      <span className="text-text-secondary">{phaseLabel}</span>
                      <div className="flex items-center gap-3">
                        {phaseDetail && <span className="text-text-secondary">{phaseDetail}</span>}
                        <button
                          className="text-brand-primary hover:underline px-2 py-1"
                          onClick={handleCancelClick}
                        >
                          取消
                        </button>
                      </div>
                    </div>
                    <div className="w-full h-2 bg-gray-200 rounded-full overflow-hidden">
                      <div
                        className="h-full bg-brand-primary rounded-full transition-all duration-300"
                        style={{ width: `${Math.min(overallProgress, 100)}%` }}
                      />
                    </div>
                    {/* Show phase indicator */}
                    {hasImages && hasNotes && (
                      <div className="flex justify-between text-xs text-text-secondary mt-1.5">
                        <span className={overallProgress < 50 ? 'text-brand-primary font-medium' : ''}>
                          ① 上传图片
                        </span>
                        <span className={overallProgress >= 50 ? 'text-brand-primary font-medium' : ''}>
                          ② 创建笔记
                        </span>
                      </div>
                    )}
                  </div>
                );
              })()}
            </div>
          </div>

          {/* Confirmation Modal */}
          {showCancelConfirm && (
            <div className="absolute inset-0 bg-white/95 rounded-xl flex flex-col items-center justify-center p-4 z-10">
              <AlertCircle className="text-brand-primary mb-3" size={32} />
              <h4 className="text-base font-semibold text-text-primary mb-2">停止保存？</h4>
              <p className="text-sm text-text-secondary text-center mb-4 px-2">
                {getCancelDescription()}
              </p>
              <div className="flex gap-3">
                <button
                  className="px-4 py-2 text-sm border border-gray-300 rounded-lg text-text-secondary hover:bg-gray-50"
                  onClick={handleConfirmCancel}
                >
                  停止
                </button>
                <button
                  className="px-4 py-2 text-sm bg-brand-primary text-white rounded-lg hover:opacity-90"
                  onClick={handleContinueSave}
                >
                  继续保存
                </button>
              </div>
            </div>
          )}
        </div>
      );
    }

    // P5 Failed / Cancelled
    if (previewState === 'P5_Failed') {
      // Check if this is a cancel state
      const isCancelled = progress.status === 'cancelled';

      if (isCancelled) {
        return (
          <div className="card p-4 mb-3">
            <h3 className="text-sm font-semibold text-text-primary mb-3">剪藏预览</h3>
            <div className="text-center py-4">
              <div className="w-12 h-12 bg-gray-100 rounded-full flex items-center justify-center mx-auto mb-3">
                <X className="text-gray-500" size={24} />
              </div>
              <p className="text-sm font-medium text-text-primary mb-1">已停止</p>
              <p className="text-xs text-text-secondary mb-4">本次内容未写入墨问。</p>
              <div className="flex gap-2 justify-center">
                <button
                  className="btn-primary text-sm"
                  onClick={handleRestartAfterCancel}
                >
                  重新开始
                </button>
              </div>
            </div>
          </div>
        );
      }

      // Regular P5_Failed (error state)
      const errorNeedsRefresh = progress.error?.includes('刷新页面');
      const isExtractionFailed = progress.error?.includes('提取失败') || progress.error?.includes('超时') || progress.error?.includes('未加载');

      return (
        <div className="card p-4 mb-3">
          <h3 className="text-sm font-semibold text-text-primary mb-3">剪藏预览</h3>
          <div className="text-center py-4">
            <div className="w-12 h-12 bg-red-100 rounded-full flex items-center justify-center mx-auto mb-3">
              <AlertCircle className="text-red-600" size={24} />
            </div>
            <p className="text-sm font-medium text-text-primary mb-1">
              {isExtractionFailed ? '预览失败' : '保存失败'}
            </p>
            <p className="text-xs text-text-secondary mb-4">{progress.error || '未知错误'}</p>

            <div className="flex flex-col gap-2">
              {errorNeedsRefresh && (
                <button
                  className="btn-primary w-full"
                  onClick={async () => {
                    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
                    if (tab?.id) {
                      await chrome.tabs.reload(tab.id);
                    }
                  }}
                >
                  刷新页面
                </button>
              )}

              <div className="flex gap-2">
                {isExtractionFailed ? (
                  <button className="btn-primary flex-1" onClick={handleRetryExtraction}>
                    重新获取预览
                  </button>
                ) : (
                  <>
                    <button className="btn-secondary flex-1" onClick={handleRetryExtraction}>
                      重新获取预览
                    </button>
                    <button className="btn-primary flex-1" onClick={handleRetry}>
                      重试保存
                    </button>
                  </>
                )}
              </div>
            </div>

            <div className="flex gap-4 justify-center mt-3">
              <button
                className="text-xs text-text-secondary hover:text-text-primary"
                onClick={() => openOptions()}
              >
                <SettingsIcon size={12} className="inline mr-1" />
                设置
              </button>
            </div>
          </div>
        </div>
      );
    }

    // P4 Success
    if (previewState === 'P4_Success') {
      const notes = progress.notes || [];
      const indexNote = notes.find(n => n.isIndex);
      const partNotes = notes.filter(n => !n.isIndex);

      return (
        <div className="card p-4 mb-3">
          <h3 className="text-sm font-semibold text-text-primary mb-3">剪藏预览</h3>
          <div className="text-center py-4">
            <div className="w-12 h-12 bg-green-100 rounded-full flex items-center justify-center mx-auto mb-3">
              <Check className="text-green-600" size={24} />
            </div>
            <p className="text-sm font-medium text-text-primary mb-3">保存成功!</p>

            {indexNote && (
              <a
                href={indexNote.noteUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="btn-primary w-full mb-2 inline-flex items-center justify-center gap-2"
              >
                打开合集笔记 <ExternalLink size={16} />
              </a>
            )}

            {partNotes.length > 0 && (
              <div className="space-y-2 mt-2">
                {partNotes.map((note, index) => (
                  <a
                    key={index}
                    href={note.noteUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center justify-between p-2.5 bg-gray-50 rounded-lg hover:bg-gray-100 transition-colors text-sm"
                  >
                    <span className="text-text-primary">第 {note.partIndex + 1} 篇</span>
                    <ExternalLink size={14} className="text-brand-primary" />
                  </a>
                ))}
              </div>
            )}
          </div>
        </div>
      );
    }

    return null;
  };

  // Remove the hard exit if no API key is configured
  // This allows showing the guide card within the normal layout

  // 如果正在显示语音笔记页面
  if (showVoiceNote) {
    return <VoiceNotePage onBack={() => setShowVoiceNote(false)} />;
  }

  return (
    <div className={isSidePanel ? 'sidepanel-container p-4' : 'popup-container p-4'}>
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-lg font-semibold text-text-primary">墨问笔记助手</h1>
        <div className="flex items-center gap-1">
          <button
            className="p-2 hover:bg-brand-soft rounded-lg transition-colors"
            onClick={() => openOptions()}
            title="设置"
          >
            <SettingsIcon size={18} className="text-text-secondary" />
          </button>
          {!isSidePanel && (
            <button
              className="p-2 hover:bg-brand-soft rounded-lg transition-colors"
              onClick={() => window.close()}
              title="关闭"
            >
              <X size={18} className="text-text-secondary" />
            </button>
          )}
        </div>
      </div>

      {/* Loading state */}
      {loading ? (
        <div className="card p-4 mb-3">
          <div className="flex items-center justify-center py-8">
            <RefreshCw className="animate-spin text-brand-primary" size={24} />
          </div>
        </div>
      ) : (
        <>
          {/* Card 1: Main Preview/Action Card */}
          {renderPreviewCard()}

          {/* Card 2: Quick Settings */}
          {renderQuickSettings()}

          {/* Card 3: Feature Overview */}
          {renderFeatureOverview()}

          {/* Tutorial Modal */}
          <TutorialModal
            isOpen={showTutorial}
            onClose={() => setShowTutorial(false)}
            onConfirm={() => {
              setShowTutorial(false);
              openOptions();
            }}
          />
        </>
      )}
    </div>
  );
};

export default Popup;

