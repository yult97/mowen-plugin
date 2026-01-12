/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./popup.html",
    "./options.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        // 背景
        'bg-default': '#FBF5EF',
        // 卡片
        'surface-card': '#FFFFFF',
        // 描边
        'border-default': '#E8E0DA',
        // 主色（红色体系）
        'brand-primary': '#BF4045',
        'brand-hover': '#A8383D',
        'brand-active': '#8F2F33',
        'brand-soft': 'rgba(191, 64, 69, 0.08)',
        'brand-focus': 'rgba(191, 64, 69, 0.25)',
        // 文本
        'text-primary': '#1F2937',
        'text-secondary': '#6B7280',
        'text-disabled': '#9CA3AF',
        'text-on-brand': '#FFFFFF',
      },
      boxShadow: {
        'card': '0 6px 20px rgba(17, 24, 39, 0.08)',
      },
      borderRadius: {
        'card': '16px',
        'button': '12px',
      },
    },
  },
  plugins: [],
};
