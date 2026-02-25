/**
 * Snackbar 组件
 * 底部轻量提示，不遮挡操作区域，2.5s 自动消失
 */

import React, { useEffect, useState } from 'react';

interface SnackbarProps {
    /** 消息内容 */
    message: string;
    /** 是否显示 */
    visible: boolean;
    /** 关闭回调 */
    onClose: () => void;
    /** 自动消失时间（毫秒），默认 2500 */
    duration?: number;
    /** 类型：info/error */
    type?: 'info' | 'error';
}

export const Snackbar: React.FC<SnackbarProps> = ({
    message,
    visible,
    onClose,
    duration = 2500,
    type = 'info',
}) => {
    const [isExiting, setIsExiting] = useState(false);

    useEffect(() => {
        if (!visible) {
            setIsExiting(false);
            return;
        }

        // 自动消失定时器
        const timer = setTimeout(() => {
            setIsExiting(true);
            // 等待退出动画完成后调用 onClose
            setTimeout(onClose, 250);
        }, duration);

        return () => clearTimeout(timer);
    }, [visible, duration, onClose]);

    // 手动关闭
    const handleClose = () => {
        setIsExiting(true);
        setTimeout(onClose, 250);
    };

    if (!visible) return null;

    return (
        <div
            className={`snackbar snackbar--${type} ${isExiting ? 'snackbar--exiting' : ''}`}
            role="alert"
            aria-live="polite"
        >
            <span className="snackbar-message">{message}</span>
            <button
                className="snackbar-close"
                onClick={handleClose}
                aria-label="关闭提示"
            >
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                    <path
                        d="M10.5 3.5L3.5 10.5M3.5 3.5L10.5 10.5"
                        stroke="currentColor"
                        strokeWidth="1.5"
                        strokeLinecap="round"
                    />
                </svg>
            </button>
        </div>
    );
};
