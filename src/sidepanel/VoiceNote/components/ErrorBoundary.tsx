/**
 * 错误边界组件
 * 捕获子组件错误，显示友好的错误界面
 */

import { Component, ErrorInfo, ReactNode } from 'react';

interface ErrorBoundaryProps {
    children: ReactNode;
    /** 重试回调 */
    onRetry?: () => void;
}

interface ErrorBoundaryState {
    hasError: boolean;
    error: Error | null;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
    constructor(props: ErrorBoundaryProps) {
        super(props);
        this.state = { hasError: false, error: null };
    }

    static getDerivedStateFromError(error: Error): ErrorBoundaryState {
        return { hasError: true, error };
    }

    componentDidCatch(error: Error, errorInfo: ErrorInfo) {
        console.error('[VoiceNote Error]', error, errorInfo);
    }

    handleRetry = () => {
        this.setState({ hasError: false, error: null });
        this.props.onRetry?.();
    };

    render() {
        if (this.state.hasError) {
            return (
                <div className="error-boundary">
                    <div className="error-boundary-icon">⚠️</div>
                    <h3 className="error-boundary-title">出现了一些问题</h3>
                    <p className="error-boundary-message">
                        {this.state.error?.message || '语音笔记组件发生错误'}
                    </p>
                    <button
                        className="btn btn--primary"
                        onClick={this.handleRetry}
                    >
                        重试
                    </button>
                </div>
            );
        }

        return this.props.children;
    }
}
