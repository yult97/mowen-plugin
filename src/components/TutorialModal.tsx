import React from 'react';
import { BookOpen, X, Info } from 'lucide-react';

interface TutorialModalProps {
    isOpen: boolean;
    onClose: () => void;
    onConfirm: () => void;
}

const TutorialModal: React.FC<TutorialModalProps> = ({ isOpen, onClose, onConfirm }) => {
    if (!isOpen) return null;

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40 backdrop-blur-sm">
            <div className="bg-white rounded-card shadow-xl max-w-lg w-full max-h-[90vh] overflow-hidden flex flex-col">
                {/* Header */}
                <div className="p-4 border-b border-border-default flex items-center justify-between">
                    <div className="flex items-center gap-2 text-brand-primary">
                        <BookOpen size={20} />
                        <h3 className="text-lg font-semibold">获取 API Key 教程</h3>
                    </div>
                    <button
                        onClick={onClose}
                        className="p-1.5 hover:bg-gray-100 rounded-full text-text-secondary"
                    >
                        <X size={20} />
                    </button>
                </div>

                {/* Content */}
                <div className="p-6 overflow-y-auto space-y-5">
                    <div className="bg-[#F7D9D9] border border-[#E9B5B5] rounded-2xl p-5 text-left">
                        <div className="flex items-start gap-3">
                            <div className="mt-0.5 text-[#C84848] opacity-80 shrink-0">
                                <Info size={16} />
                            </div>
                            <div className="space-y-1.5 min-w-0">
                                <p className="text-[#1F2329] font-medium text-sm leading-relaxed">
                                    API Key 仅支持在「墨问」微信小程序获取
                                </p>
                                <p className="text-[#C84848] font-medium text-sm leading-relaxed">
                                    我的 → 开发者 → 我的 API Key
                                </p>
                                <p className="text-[#32363D] font-medium text-sm leading-relaxed">
                                    需开通 <a
                                        href="https://note.mowen.cn/vip?inviteCode=V-T5J3NHDO0L"
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        className="text-[#C84848] hover:underline inline-flex items-center gap-0.5"
                                    >
                                        Pro 会员
                                        <span className="opacity-60 text-xs ml-0.5">↗</span>
                                    </a> 后可生成 API Key
                                </p>
                            </div>
                        </div>
                    </div>

                    <div className="space-y-3">
                        <div className="flex items-center gap-3">
                            <div className="w-6 h-6 rounded-full bg-brand-soft text-brand-primary flex items-center justify-center text-xs font-bold shrink-0">1</div>
                            <p className="text-sm text-text-primary">打开微信 → 进入墨问小程序</p>
                        </div>
                        <img
                            src="/tutorial-step1.png"
                            alt="在微信内搜索墨问，找到墨问小程序，进入"
                            className="rounded-lg border border-gray-200 w-full"
                        />
                        <div className="flex items-center gap-3">
                            <div className="w-6 h-6 rounded-full bg-brand-soft text-brand-primary flex items-center justify-center text-xs font-bold shrink-0">2</div>
                            <p className="text-sm text-text-primary">我的 → 开发者 → 我的 API Key → 复制（必要时重置）</p>
                        </div>
                        <img
                            src="/tutorial-step2.png"
                            alt="进入开发者后，在我的 API Key 处复制"
                            className="rounded-lg border border-gray-200 w-full"
                        />
                        <div className="flex items-center gap-3">
                            <div className="w-6 h-6 rounded-full bg-brand-soft text-brand-primary flex items-center justify-center text-xs font-bold shrink-0">3</div>
                            <p className="text-sm text-text-primary">回到插件粘贴 → 点击「测试连接」</p>
                        </div>
                    </div>
                </div>

                {/* Footer */}
                <div className="p-4 bg-gray-50 border-t border-border-default">
                    <button
                        className="btn-primary w-full"
                        onClick={onConfirm}
                    >
                        我已复制 API Key
                    </button>
                </div>
            </div>
        </div>
    );
};

export default TutorialModal;
