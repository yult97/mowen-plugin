// Timeout constants (in milliseconds)
export const TIMEOUT = {
    PING: 1500,
    PING_INITIAL: 1000,
    PING_RETRY: 1500,
    CACHE_CHECK: 1000,
    CACHE_RETRY: 2000,
    CACHE_FULL: 5000,
    EXTRACT_CONTENT: 15000,
    BACKGROUND_RESPONSE: 5000,
    CONTENT_SCRIPT_INIT: 500,
    AUTO_FETCH_DELAY: 500,
} as const;

// Content extraction limits
export const LIMITS = {
    SAFE_CONTENT_LENGTH: 19000,
    MAX_RETRY_ROUNDS: 3,
    IMAGE_UPLOAD_TIMEOUT: 30000,
    MAX_IMAGES_DEFAULT: 50,
} as const;

// Log prefixes for consistent logging
export const LOG_PREFIX = {
    POPUP: '[墨问 Popup]',
    BACKGROUND: '[墨问 Background]',
    CONTENT: '[墨问 Content]',
    API: '[墨问 API]',
} as const;

// Helper function to create a logger with a prefix
export function createLogger(prefix: string) {
    return {
        log: (...args: unknown[]) => console.log(`${prefix}`, ...args),
        warn: (...args: unknown[]) => console.warn(`${prefix}`, ...args),
        error: (...args: unknown[]) => console.error(`${prefix}`, ...args),
        debug: (...args: unknown[]) => console.log(`${prefix} 🔍`, ...args),
    };
}

// Popup logger
export const popupLogger = createLogger(LOG_PREFIX.POPUP);

// Background logger
export const backgroundLogger = createLogger(LOG_PREFIX.BACKGROUND);

// Content script logger
export const contentLogger = createLogger(LOG_PREFIX.CONTENT);
