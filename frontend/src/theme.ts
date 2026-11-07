import { createTheme } from '@mantine/core'

/**
 * 比特100 设计系统（第十一轮重设计：现代极简风，对标 Uniswap）
 *
 * - 浅色为主：页面底 #F7F7F8，卡片纯白，大圆角（xl = 24px）+ 轻阴影
 * - 单一主强调色 brand（玫红 #FF007A）；涨跌色仅用于数据语义（见 App.css 的 --b100-up/--b100-down）
 * - 层级靠字号 / 字重 / 间距拉开，不靠边框堆叠；数字用等宽字体对齐
 * 纯 CSS 侧（App.css 等）通过 index.css 中的 --b100-* 变量引用同一套 token，两处数值须保持一致。
 */
export const theme = createTheme({
  colors: {
    // 主强调色：玫红（Uniswap 同系），6 号为标准填充色
    brand: [
      '#FFF0F7',
      '#FFE0EF',
      '#FFC2DE',
      '#FF94C6',
      '#FF5FA8',
      '#FF2E93',
      '#FF007A',
      '#E0006C',
      '#B8005A',
      '#8F0047',
    ],
    // 语义色：仅用于涨/买（up）与跌/卖（down）等数据语义，小面积使用
    up: [
      '#ECFDF3',
      '#D1FADF',
      '#A6F4C5',
      '#6CE9A6',
      '#32D583',
      '#12B76A',
      '#039855',
      '#027A48',
      '#05603A',
      '#054F31',
    ],
    down: [
      '#FEF3F2',
      '#FEE4E2',
      '#FECDCA',
      '#FDAAA5',
      '#F97066',
      '#F04438',
      '#D92D20',
      '#B42318',
      '#912018',
      '#7A271A',
    ],
  },
  primaryColor: 'brand',
  primaryShade: 6,
  fontFamily:
    'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", system-ui, sans-serif',
  fontFamilyMonospace:
    'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace',
  headings: {
    fontFamily:
      'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", system-ui, sans-serif',
    fontWeight: '600',
  },
  radius: {
    xs: '6px',
    sm: '10px',
    md: '12px',
    lg: '16px',
    xl: '24px',
  },
  defaultRadius: 'lg',
  shadows: {
    xs: '0 1px 2px rgba(16, 16, 20, 0.05)',
    sm: '0 2px 8px rgba(16, 16, 20, 0.05)',
    md: '0 8px 24px rgba(16, 16, 20, 0.08)',
    lg: '0 16px 40px rgba(16, 16, 20, 0.12)',
    xl: '0 24px 64px rgba(16, 16, 20, 0.16)',
  },
  components: {
    Button: {
      defaultProps: {
        size: 'md',
        radius: 'xl',
        fw: 600,
      },
    },
    Paper: {
      defaultProps: {
        radius: 'xl',
      },
    },
    Card: {
      defaultProps: {
        radius: 'xl',
      },
    },
    TextInput: {
      defaultProps: { radius: 'md' },
    },
    NumberInput: {
      defaultProps: { radius: 'md' },
    },
    Select: {
      defaultProps: { radius: 'md' },
    },
  },
})
