import React, { useState, useEffect } from 'react';
import { Settings, ExtractResult, SaveProgress, DEFAULT_SETTINGS } from '../types';
import { getSettings } from '../utils/storage';
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
} from 'lucide-react';

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
  const [progress, setProgress] = useState<SaveProgress>({ status: 'idle' });
  const [currentUrl, setCurrentUrl] = useState('');
  const [currentDomain, setCurrentDomain] = useState('');
  const [isClippable, setIsClippable] = useState(true);
  const [previewState, setPreviewState] = useState<PreviewState>('P0_Idle');
  const [loading, setLoading] = useState(true);

  // State to trigger auto-fetch preview
  const [autoFetchTrigger, setAutoFetchTrigger] = useState(0);

  useEffect(() => {
    initializePopup();

    // Listen for storage changes (e.g., settings updated in Options page)
    const handleStorageChange = async (changes: { [key: string]: chrome.storage.StorageChange }, areaName: string) => {
      if (areaName === 'sync' || areaName === 'local') {
        if (changes['mowen_settings']) {
          console.log('[墨问 Popup] Settings changed, reloading...');
          const newSettings = changes['mowen_settings'].newValue;
          if (newSettings) {
            setSettings({ ...DEFAULT_SETTINGS, ...newSettings });
            setIsPublic(newSettings.defaultPublic ?? DEFAULT_SETTINGS.defaultPublic);
            setIncludeImages(newSettings.defaultIncludeImages ?? DEFAULT_SETTINGS.defaultIncludeImages);
          }
        }
      }
    };

    // Listen for tab activation (switching tabs)
    const handleTabChange = async (_activeInfo: chrome.tabs.TabActiveInfo) => {
      console.log('[墨问 Popup] Tab switched, auto-fetching preview...');
      // Reset preview state and trigger auto-fetch
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
        // Small delay to ensure content script is ready
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
        setProgress(() => ({
          status: 'creating',
          ...message.progress,
        }));
      }
    };

    // Add listeners
    chrome.storage.onChanged.addListener(handleStorageChange);
    chrome.tabs.onActivated.addListener(handleTabChange);
    chrome.tabs.onUpdated.addListener(handleTabUpdate);
    chrome.runtime.onMessage.addListener(handleSaveComplete);
    chrome.runtime.onMessage.addListener(handleSaveProgress);

    // Cleanup listeners on unmount
    return () => {
      chrome.storage.onChanged.removeListener(handleStorageChange);
      chrome.tabs.onActivated.removeListener(handleTabChange);
      chrome.tabs.onUpdated.removeListener(handleTabUpdate);
      chrome.runtime.onMessage.removeListener(handleSaveComplete);
      chrome.runtime.onMessage.removeListener(handleSaveProgress);
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

        // Helper to inject content script
        const injectContentScript = async (tabId: number): Promise<boolean> => {
          try {
            const manifest = chrome.runtime.getManifest();
            const contentScriptFile = manifest.content_scripts?.[0]?.js?.[0];
            if (!contentScriptFile) {
              return false;
            }
            console.log('[墨问 Popup] Injecting content script for auto-fetch...');
            await chrome.scripting.executeScript({
              target: { tabId },
              files: [contentScriptFile],
            });
            await new Promise(resolve => setTimeout(resolve, 500));
            return true;
          } catch (err) {
            console.log('[墨问 Popup] Content script injection failed:', err);
            return false;
          }
        };

        // Check if content script is ready
        let isReady = false;
        try {
          const pingRes = await Promise.race([
            chrome.tabs.sendMessage(tab.id, { type: 'PING' }),
            new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Timeout')), 1500))
          ]) as { success: boolean };
          isReady = pingRes?.success === true;
        } catch {
          // Content script not ready, try to inject
          console.log('[墨问 Popup] Content script not ready, injecting...');
          const injected = await injectContentScript(tab.id);
          if (injected) {
            try {
              const retryPing = await Promise.race([
                chrome.tabs.sendMessage(tab.id, { type: 'PING' }),
                new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Timeout')), 1500))
              ]) as { success: boolean };
              isReady = retryPing?.success === true;
            } catch {
              isReady = false;
            }
          }
        }

        if (!isReady) {
          console.log('[墨问 Popup] Content script still not ready after injection');
          setPreviewState('P0_Idle');
          return;
        }

        // Try to get content from content script
        try {
          const response = await Promise.race([
            chrome.tabs.sendMessage(tab.id, { type: 'EXTRACT_CONTENT' }),
            new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Timeout')), 10000))
          ]) as { success: boolean; data?: any; error?: string };

          if (response?.success && response?.data) {
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

      // Get current tab info and determine clippability
      await updateCurrentTab();

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
          // Helper to inject content script
          const injectContentScript = async (tabId: number): Promise<boolean> => {
            try {
              const manifest = chrome.runtime.getManifest();
              const contentScriptFile = manifest.content_scripts?.[0]?.js?.[0];
              if (!contentScriptFile) {
                console.error('[墨问 Popup] ❌ No content script file found in manifest');
                return false;
              }
              console.log('[墨问 Popup] 🔧 Injecting content script:', contentScriptFile);
              await chrome.scripting.executeScript({
                target: { tabId },
                files: [contentScriptFile],
              });
              // Wait for script to initialize
              await new Promise(resolve => setTimeout(resolve, 500));
              return true;
            } catch (err) {
              console.error('[墨问 Popup] ❌ Failed to inject content script:', err);
              return false;
            }
          };

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
                  }
                } catch (err) {
                  console.log('[墨问 Popup] ⚠️ Could not get cached content after retry');
                }
              }, 2000);
            } else {
              console.log('[墨问 Popup] ℹ️ No cached content available yet');
            }
          }
        } catch (error) {
          console.log('[墨问 Popup] ⚠️ Could not load cached content:', error);
          // Not a critical error, user can still manually trigger extraction
        }
      } else {
        console.log('[墨问 Popup] ⚠️ Page not clippable or no tab ID, skipping auto-load');
      }
    } catch (error) {
      console.error('[墨问 Popup] ❌ Failed to initialize popup:', error);
      setLoading(false);
    }
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

      // Helper to inject content script
      const injectContentScript = async (tabId: number): Promise<boolean> => {
        try {
          const manifest = chrome.runtime.getManifest();
          const contentScriptFile = manifest.content_scripts?.[0]?.js?.[0];
          if (!contentScriptFile) {
            console.error('[墨问 Popup] ❌ No content script file found in manifest');
            return false;
          }
          console.log('[墨问 Popup] 🔧 Injecting content script:', contentScriptFile);
          await chrome.scripting.executeScript({
            target: { tabId },
            files: [contentScriptFile],
          });
          // Wait for script to initialize
          await new Promise(resolve => setTimeout(resolve, 500));
          return true;
        } catch (err) {
          console.error('[墨问 Popup] ❌ Failed to inject content script:', err);
          return false;
        }
      };

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
        chrome.tabs.sendMessage(tab.id, { type: 'EXTRACT_CONTENT' }),
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
    console.log('[墨问 Popup] Save payload:', {
      title: extractResult.title,
      wordCount: extractResult.wordCount,
      images: extractResult.images.length,
      isPublic,
      includeImages,
      maxImages: settings.maxImages,
    });

    setPreviewState('P3_Saving');
    setProgress({ status: 'creating' });

    // Helper to proxy log
    const logProxy = async (msg: string) => {
      try {
        const [t] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (t?.id) chrome.tabs.sendMessage(t.id, { type: 'LOG_DEBUG', payload: msg }).catch(() => { });
      } catch { }
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

      const response = await Promise.race([
        chrome.runtime.sendMessage({
          type: 'SAVE_NOTE',
          payload: {
            extractResult,
            isPublic,
            includeImages,
            maxImages: settings.maxImages,
            createIndexNote: settings.createIndexNote,
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
      } catch (e) { }

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
        <div className="card p-4 mb-3">
          <div className="text-center py-2">
            <div className="w-12 h-12 bg-brand-soft rounded-full flex items-center justify-center mx-auto mb-3">
              <SettingsIcon className="text-brand-primary" size={24} />
            </div>
            <h4 className="text-sm font-semibold text-text-primary mb-1">还没配置 API Key</h4>
            <p className="text-xs text-text-secondary mb-4">配置后才能创建笔记并上传图片</p>
            <button className="btn-primary w-full mb-2" onClick={() => openOptions()}>
              去配置 API Key
            </button>
            <button
              className="text-xs text-brand-primary hover:underline"
              onClick={() => window.open('https://mowen.cn/help/api', '_blank')}
            >
              查看教程
            </button>
          </div>
        </div>
      );
    }

    // 2. Not Tested
    if (!testSuccess) {
      return (
        <div className="card p-4 mb-3">
          <div className="text-center py-2">
            <div className="w-12 h-12 bg-yellow-100 rounded-full flex items-center justify-center mx-auto mb-3">
              <AlertCircle className="text-yellow-600" size={24} />
            </div>
            <h4 className="text-sm font-semibold text-text-primary mb-1">API Key 已填写</h4>
            <p className="text-xs text-text-secondary mb-4">建议先测试连接,避免保存时失败</p>
            <button className="btn-primary w-full mb-2" onClick={() => openOptions('test')}>
              去测试连接
            </button>
            <button
              className="text-xs text-text-secondary hover:text-text-primary"
              onClick={() => { /* In a real app, we might set a flag to ignore this warning */ }}
            >
              稍后再说
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
      return (
        <div className="card p-4 mb-3">
          <h3 className="text-sm font-semibold text-text-primary mb-3">剪藏预览</h3>
          <div className="text-center py-6">
            <RefreshCw className="animate-spin text-brand-primary mx-auto mb-3" size={32} />
            <p className="text-sm font-medium text-text-primary mb-2">正在保存到墨问…</p>
            <div className="text-xs text-text-secondary space-y-1">
              {progress.currentPart && progress.totalParts && (
                <p>创建笔记 ({progress.currentPart}/{progress.totalParts})</p>
              )}
              {progress.uploadedImages !== undefined && progress.totalImages !== undefined && (
                <p>上传图片 ({progress.uploadedImages}/{progress.totalImages})</p>
              )}
              <p>设置公开/私密</p>
            </div>
            <button
              className="text-xs text-text-secondary hover:text-text-primary mt-4"
              onClick={() => {/* Show details */ }}
            >
              查看详情
            </button>
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
                打开索引笔记 <ExternalLink size={16} />
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

    // P5 Failed
    if (previewState === 'P5_Failed') {
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

              <div className={errorNeedsRefresh ? "flex gap-2" : "flex gap-2"}>
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
                去设置
              </button>
              <button
                className="text-xs text-text-secondary hover:text-text-primary"
                onClick={() => {
                  console.log('[墨问] Error details:', progress);
                  alert(`错误信息: ${progress.error || '未知错误'}\n错误代码: ${progress.errorCode || 'N/A'}`);
                }}
              >
                查看详情
              </button>
            </div>
          </div>
        </div>
      );
    }

    return null;
  };

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
          {/* Card 1: Main Preview/Action Card (Contains Status logic used to be in ActionCard) */}
          {renderPreviewCard()}

          {/* Card 2: Quick Settings */}
          {renderQuickSettings()}

          {/* Card 3: Feature Overview (Moved to bottom) */}
          {renderFeatureOverview()}
        </>
      )}
    </div>
  );
};

export default Popup;
