const SIDE_PANEL_TABS_KEY = 'sidePanelOpenedTabs';

async function getSidePanelOpenedTabs(): Promise<Set<number>> {
  const result = await chrome.storage.session.get(SIDE_PANEL_TABS_KEY);
  const tabs = result[SIDE_PANEL_TABS_KEY] || [];
  return new Set<number>(tabs);
}

async function addSidePanelTab(tabId: number): Promise<void> {
  const tabs = await getSidePanelOpenedTabs();
  tabs.add(tabId);
  await chrome.storage.session.set({ [SIDE_PANEL_TABS_KEY]: Array.from(tabs) });
}

async function removeSidePanelTab(tabId: number): Promise<void> {
  const tabs = await getSidePanelOpenedTabs();
  tabs.delete(tabId);
  await chrome.storage.session.set({ [SIDE_PANEL_TABS_KEY]: Array.from(tabs) });
}

/**
 * 统一注册 Side Panel 相关事件。
 * 这部分只负责浏览器 UI 与 Tab 级启停，不介入保存流程状态机。
 */
export function registerSidePanelHandlers(deps: {
  formatErrorForLog: (error: unknown) => string;
}): void {
  const { formatErrorForLog } = deps;

  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false })
    .catch((error) => console.error(`[墨问 Background] Failed to set side panel behavior: ${formatErrorForLog(error)}`));

  chrome.sidePanel.setOptions({ enabled: false })
    .catch((error) => console.error(`[墨问 Background] Failed to set global side panel options: ${formatErrorForLog(error)}`));

  chrome.action.onClicked.addListener(async (tab) => {
    if (!tab.id) {
      return;
    }

    try {
      chrome.sidePanel.setOptions({
        tabId: tab.id,
        path: 'sidepanel.html',
        enabled: true,
      });

      await chrome.sidePanel.open({ tabId: tab.id });
      await addSidePanelTab(tab.id);

      console.log(`[墨问 Background] ✅ Side Panel opened for tab ${tab.id}`);
    } catch (error) {
      console.error(`[墨问 Background] Failed to open side panel: ${formatErrorForLog(error)}`);
    }
  });

  chrome.tabs.onActivated.addListener(async (activeInfo) => {
    const { tabId, windowId } = activeInfo;
    const openedTabs = await getSidePanelOpenedTabs();
    const shouldEnable = openedTabs.has(tabId);

    await chrome.sidePanel.setOptions({
      tabId,
      enabled: shouldEnable,
    });

    console.log(`[墨问 Background] 🔄 Tab ${tabId} activated, Side Panel enabled=${shouldEnable}`);

    if (shouldEnable) {
      chrome.runtime.sendMessage({
        type: 'TAB_ACTIVATED',
        payload: { tabId, windowId },
      }).catch(() => {
        // Side Panel 可能未打开或未监听，忽略错误
      });
    }
  });

  chrome.tabs.onRemoved.addListener((tabId) => {
    removeSidePanelTab(tabId).catch(() => { });
  });
}
