/**
 * Content Script Helper
 * 
 * Provides utilities for injecting and communicating with content scripts.
 * Extracted from Popup.tsx to avoid code duplication.
 */

import { TIMEOUT, popupLogger as logger } from './constants';

/**
 * Inject the content script into a tab.
 * @param tabId - The tab ID to inject into
 * @returns Promise<boolean> - true if injection succeeded
 */
export async function injectContentScript(tabId: number): Promise<boolean> {
    try {
        const manifest = chrome.runtime.getManifest();
        const contentScriptFile = manifest.content_scripts?.[0]?.js?.[0];

        if (!contentScriptFile) {
            logger.error('No content script file found in manifest');
            return false;
        }

        logger.log('Injecting content script:', contentScriptFile);
        await chrome.scripting.executeScript({
            target: { tabId },
            files: [contentScriptFile],
        });

        // Wait for script to initialize
        await new Promise(resolve => setTimeout(resolve, TIMEOUT.CONTENT_SCRIPT_INIT));
        return true;
    } catch (error) {
        const errMsg = error instanceof Error ? error.message : 'Unknown error';
        logger.warn('Content script injection failed:', errMsg);
        return false;
    }
}

/**
 * Ping the content script to check if it's ready.
 * @param tabId - The tab ID to ping
 * @param timeout - Timeout in milliseconds (default: TIMEOUT.PING)
 * @returns Promise<boolean> - true if content script responded
 */
export async function pingContentScript(tabId: number, timeout: number = TIMEOUT.PING): Promise<boolean> {
    try {
        const response = await Promise.race([
            chrome.tabs.sendMessage(tabId, { type: 'PING' }),
            new Promise<never>((_, reject) =>
                setTimeout(() => reject(new Error('Timeout')), timeout)
            )
        ]) as { success: boolean } | undefined;

        return response?.success === true;
    } catch (error) {
        // Clear lastError to prevent warnings
        if (chrome.runtime.lastError) {
            void chrome.runtime.lastError;
        }
        return false;
    }
}

/**
 * Ensure content script is ready, injecting if necessary.
 * @param tabId - The tab ID to ensure content script is ready
 * @returns Promise<boolean> - true if content script is ready
 */
export async function ensureContentScriptReady(tabId: number): Promise<boolean> {
    // First, try to ping existing content script
    let isReady = await pingContentScript(tabId, TIMEOUT.PING_INITIAL);

    if (isReady) {
        logger.debug('Content script already ready');
        return true;
    }

    // Not ready, try to inject
    logger.log('Content script not ready, attempting injection...');
    const injected = await injectContentScript(tabId);

    if (!injected) {
        logger.warn('Content script injection failed');
        return false;
    }

    // Retry ping after injection
    isReady = await pingContentScript(tabId, TIMEOUT.PING_RETRY);

    if (isReady) {
        logger.log('Content script injected and ready');
        return true;
    }

    logger.warn('Content script still not responding after injection');
    return false;
}

/**
 * Send a message to the content script with timeout.
 * @param tabId - The tab ID to send message to
 * @param message - The message object to send
 * @param timeout - Timeout in milliseconds
 * @returns Promise<T | null> - Response or null on failure
 */
export async function sendMessageToContentScript<T>(
    tabId: number,
    message: { type: string;[key: string]: unknown },
    timeout: number
): Promise<T | null> {
    try {
        const response = await Promise.race([
            chrome.tabs.sendMessage(tabId, message),
            new Promise<never>((_, reject) =>
                setTimeout(() => reject(new Error('Timeout')), timeout)
            )
        ]) as T;

        return response;
    } catch (error) {
        // Clear lastError to prevent warnings
        if (chrome.runtime.lastError) {
            void chrome.runtime.lastError;
        }
        const errMsg = error instanceof Error ? error.message : 'Unknown error';
        logger.warn(`Message to content script failed: ${errMsg}`);
        return null;
    }
}
