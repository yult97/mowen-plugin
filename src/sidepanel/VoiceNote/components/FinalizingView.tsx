/**
 * 整理过渡组件
 * 录音结束后的整理动画
 */

import React from 'react';

export const FinalizingView: React.FC = () => {
    return (
        <div className="finalizing-view">
            <div className="finalizing-spinner" />
            <div className="finalizing-text">正在整理录音内容...</div>
            <div className="finalizing-subtext">请稍候，马上就好</div>
        </div>
    );
};
