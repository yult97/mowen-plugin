/**
 * "已修订"提示标签
 * 显示后 3s 自动淡出
 */

import React, { useState, useEffect } from 'react';

interface RevisionTagProps {
    /** 淡出延迟（毫秒） */
    fadeOutDelay?: number;
}

export const RevisionTag: React.FC<RevisionTagProps> = ({
    fadeOutDelay = 2500,
}) => {
    const [isVisible, setIsVisible] = useState(true);
    const [isFading, setIsFading] = useState(false);

    useEffect(() => {
        // 开始淡出动画
        const fadeTimer = setTimeout(() => {
            setIsFading(true);
        }, fadeOutDelay);

        // 完全隐藏
        const hideTimer = setTimeout(() => {
            setIsVisible(false);
        }, fadeOutDelay + 500);

        return () => {
            clearTimeout(fadeTimer);
            clearTimeout(hideTimer);
        };
    }, [fadeOutDelay]);

    if (!isVisible) return null;

    return (
        <span className={`revision-tag ${isFading ? 'revision-tag--fading' : ''}`}>
            <span className="revision-tag-icon">✏️</span>
            已修订
        </span>
    );
};
