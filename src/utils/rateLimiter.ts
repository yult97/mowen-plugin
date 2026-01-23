import { sleep } from './helpers';

/**
 * 全局速率限制器
 * 采用"预占位"模式，确保所有经过调度器的请求严格遵守最小间隔
 */
export const GlobalRateLimiter = {
    // 下一次允许调用的时间戳
    _nextAvailableTime: 0,

    // 最小间隔 (ms)，默认 1.1秒
    MIN_INTERVAL: 1100,

    /**
     * 调度一个任务，确保在允许的时间执行
     * @param fn 要执行的异步函数
     */
    async schedule<T>(fn: () => Promise<T>): Promise<T> {
        const now = Date.now();
        // 计算原本应该允许执行的时间：取 当前时间 和 上次预定时间+间隔 的最大值
        // 也就是说，如果积压了任务，nextAvailableTime 会排到很后面，当前任务必须等到那时候
        // 如果闲置了很久，nextAvailableTime 是旧的，那么取 now 即可（立即执行）
        // 修正逻辑：
        // Case 1: 闲置状态。_next = 之前的时间。now > _next。StartAt = now。NewNext = now + 1100。
        // Case 2: 拥堵状态。_next = 未来的时间。now < _next。StartAt = _next。NewNext = _next + 1100。

        const startTime = Math.max(now, this._nextAvailableTime);

        // 更新全局游标，为下一个任务占位
        this._nextAvailableTime = startTime + this.MIN_INTERVAL;

        const waitTime = startTime - now;

        if (waitTime > 0) {
            // console.log(`[RateLimit] Queueing task... wait ${waitTime}ms`);
            await sleep(waitTime);
        }

        // console.log(`[RateLimit] Executing task at ${Date.now()}`);
        return await fn();
    }
};
