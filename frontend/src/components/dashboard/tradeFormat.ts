/**
 * 交易台数字/时间格式化（第 28 轮：K 线与订单显示视觉重做）。
 *
 * 单位口径（重要）：节点 /api/trades、/api/orderbook、/api/orders 返回的
 * price 是 1e18 定点（与 EIP-712 订单规范中 price 的缩放一致），amount 是
 * 代币 wei（18 位）。界面展示一律先经 fromScaled 换算为人类单位——这是
 * 展示层换算，不改变任何数据口径；订单簿行的「人类单位」口径也是
 * marketOrder.ts 文件头注明的既有约定。
 *
 * 格式基准（2026-11-08 实测 Binance / Hyperliquid 交易页，见
 * docs/round28-chart-orderbook-ui-2026-11-08.md）：
 * - 价格：千分位分组；小数位随量级（≥100 → 2 位，≥1 → 4 位，<1 → 6 位修剪）
 * - 数量：千分位分组；小数最多 6 位、修剪尾零、至少 2 位
 * - 累计：≥10000 用 K/M/B 缩写（Binance Total 列口径，如 45.22K）
 * - 时间：一律 Asia/Tokyo（JST）显式换算，不依赖浏览器本地时区/语言环境
 */

export const FIXED_SCALE = 1e18

/** 节点定点/wei 字符串 → 人类单位数值；无法解析返回 NaN */
export function fromScaled(v: unknown): number {
  if (v == null) return NaN
  if (typeof v === 'string' && v.trim() === '') return NaN
  const n = typeof v === 'number' ? v : Number(String(v).trim())
  if (!Number.isFinite(n)) return NaN
  return n / FIXED_SCALE
}

/**
 * 任意小数位缩放 → 人类单位数值（第六十轮）：自助上架对的价格缩放为
 * 18+quote 位数−base 位数、数量缩放为 base 位数，展示层按交易对的实际
 * 小数位换算；decimals=18 时与 fromScaled 完全一致。浮点口径与 fromScaled 同。
 */
export function fromScaledDecimals(v: unknown, decimals: number): number {
  if (decimals === 18) return fromScaled(v)
  if (v == null) return NaN
  if (typeof v === 'string' && v.trim() === '') return NaN
  const n = typeof v === 'number' ? v : Number(String(v).trim())
  if (!Number.isFinite(n)) return NaN
  return n / 10 ** decimals
}

/** 数值 → 定点展示字符串（供订单簿行等既有「人类单位字符串」接口回填） */
export function toPlain(n: number): string {
  if (!Number.isFinite(n)) return '0'
  // 避免科学计数法，并修剪浮点尾巴（保留至多 10 位小数，足够覆盖测试网价格）
  const s = n.toFixed(10)
  return s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s
}

function group(v: number, minFrac: number, maxFrac: number): string {
  return v.toLocaleString('en-US', {
    minimumFractionDigits: minFrac,
    maximumFractionDigits: maxFrac,
  })
}

/** 价格小数位（随量级）：≥100 → 2；≥1 → 4；<1 → 6 */
export function priceDecimals(price: number): number {
  const a = Math.abs(price)
  if (a >= 100) return 2
  if (a >= 1) return 4
  return 6
}

/** 价格：千分位 + 量级小数位（75696.05 → "75,696.05"；1 → "1.0000"） */
export function fmtPrice(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return '—'
  const d = priceDecimals(v)
  if (Math.abs(v) < 1) {
    // <1 时 6 位修剪尾零，但至少保留 4 位（0.5 → "0.5000"，0.00007 → "0.00007"）
    const raw = v.toFixed(d)
    const trimmed = raw.replace(/0+$/, '')
    const frac = trimmed.split('.')[1] ?? ''
    return v.toLocaleString('en-US', {
      minimumFractionDigits: Math.max(4, frac.length),
      maximumFractionDigits: d,
    })
  }
  return group(v, d, d)
}

/** 数量：千分位；小数随量级（≥100 → 2，≥1 → 4，<1 → 6），修剪尾零、至少 2 位 */
export function fmtAmount(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return '—'
  if (v === 0) return '0'
  const a = Math.abs(v)
  const maxD = a >= 100 ? 2 : a >= 1 ? 4 : 6
  const raw = v.toFixed(maxD)
  const frac = (raw.split('.')[1] ?? '').replace(/0+$/, '')
  return group(v, Math.max(2, frac.length), maxD)
}

/** 累计/总量：≥10000 用 K/M/B 缩写（45,220 → "45.22K"），否则同数量格式 */
export function fmtTotal(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return '—'
  const a = Math.abs(v)
  if (a >= 10000) {
    const units: Array<[number, string]> = [
      [1e9, 'B'],
      [1e6, 'M'],
      [1e3, 'K'],
    ]
    for (const [base, suffix] of units) {
      if (a >= base) return `${(v / base).toFixed(2)}${suffix}`
    }
  }
  return fmtAmount(v)
}

const dtfTime = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Tokyo',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
})
const dtfDate = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Tokyo',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
})
const dtfMonthDay = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Tokyo',
  month: '2-digit',
  day: '2-digit',
})

/** unix 秒 → "HH:mm:ss"（JST） */
export function fmtTime(sec: number): string {
  if (!sec || !Number.isFinite(sec)) return '—'
  return dtfTime.format(new Date(sec * 1000))
}

/** unix 秒 → "YYYY-MM-DD HH:mm:ss"（JST） */
export function fmtDateTime(sec: number): string {
  if (!sec || !Number.isFinite(sec)) return '—'
  const d = new Date(sec * 1000)
  return `${dtfDate.format(d)} ${dtfTime.format(d)}`
}

/** unix 秒 → "MM-DD HH:mm"（JST，K 线图例/十字光标用） */
export function fmtChartTime(sec: number): string {
  if (!sec || !Number.isFinite(sec)) return ''
  const d = new Date(sec * 1000)
  const hm = dtfTime.format(d).slice(0, 5)
  return `${dtfMonthDay.format(d)} ${hm}`
}

/** 简单移动平均：不足周期长度的位置返回 null */
export function sma(values: number[], period: number): Array<number | null> {
  const out: Array<number | null> = new Array(values.length).fill(null)
  if (period <= 0) return out
  let sum = 0
  for (let i = 0; i < values.length; i++) {
    sum += values[i]
    if (i >= period) sum -= values[i - period]
    if (i >= period - 1) out[i] = sum / period
  }
  return out
}
