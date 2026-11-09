/**
 * 「AI 接入」说明页（第 56 轮）：把第 49 轮 MCP 接入讲成人话——
 * 是什么、当前状态（测试网申请制）、接入前提、四步接入、工具对照、
 * 安全护栏、注意事项。纯静态说明页，不接任何实时数据。
 * 事实口径以 mcp/README.md 与 docs/round49-mcp-agent-access-2026-11-09.md 为准：
 * MCP 服务没有公开自助注册入口，令牌由项目方发放，页面不写不存在的地址。
 */
import './AiAccessPage.css'

const READ_TOOLS: { name: string; desc: string }[] = [
  { name: 'get_chain_config', desc: '查某条链的合约地址与支持的交易对' },
  { name: 'get_orderbook', desc: '查某个交易对现在的买盘和卖盘' },
  { name: 'list_orders', desc: '查订单簿上还没过期的在挂订单' },
  { name: 'get_balances', desc: '查某个地址的钱包余额、金库余额和可用余额（直接读链）' },
  { name: 'get_order_status', desc: '查一笔订单成交了多少、锁没锁、撤没撤' },
]

const WRITE_TOOLS: { name: string; desc: string }[] = [
  { name: 'place_order', desc: '把一笔限价单挂到订单簿上' },
  { name: 'match_order', desc: '发一单并立刻撮合，能成交的当场结算上链' },
  { name: 'hard_cancel_order', desc: '把一笔已经落锁的订单在链上永久作废（限制见下方注意事项）' },
]

const CONFIG_SAMPLE = `{
  "mcpServers": {
    "bit100": {
      "url": "<项目方提供的接入地址>",
      "headers": {
        "Authorization": "Bearer <你的 agent 令牌>"
      }
    }
  }
}`

export function AiAccessPage() {
  return (
    <div className="ai-access">
      <section className="card">
        <h3 className="ai-h">这是什么</h3>
        <p className="hint">
          比特100 支持通过 MCP 协议，把你自己的 AI 接到交易所。接上之后，你的 AI
          能像真人交易员一样看订单簿、挂单、吃单成交、查订单状态——先在测试网上练，
          用的全是没有真实价值的测试币。任何支持 MCP 的 AI 客户端都能接，不限定某个品牌。
        </p>
        <p className="hint">
          <span className="ai-badge">当前状态：测试网阶段 · 申请制</span>
        </p>
        <p className="hint">
          现在只开放两条测试网：Sepolia 和 Base Sepolia，共 8 个测试交易对（BTC/USDT、
          ETH/USDT、SOL/USDT、BNB/USDT、XRP/USDT、DOGE/USDT、LINK/USDT、TKA/TKB）。
          主网未开放。MCP 服务目前没有公开的自助注册入口，接入令牌由项目方逐个发放。
        </p>
      </section>

      <section className="card">
        <h3 className="ai-h">接入前提</h3>
        <ul className="ai-list">
          <li>一个支持 MCP 的 AI 客户端（不限品牌，需支持以 HTTP 方式添加 MCP 服务器、并能自定义 Authorization 请求头）；</li>
          <li>一个测试钱包（练习专用，发放令牌时由项目方一并登记）；</li>
          <li>一个 agent 令牌（向项目方申请，见下面步骤 1）。</li>
        </ul>
      </section>

      <section className="card">
        <h3 className="ai-h">接入步骤</h3>
        <ol className="ai-steps">
          <li>
            <b>申请令牌。</b>
            向项目方申请测试接入，获取你的专属 agent 令牌与接入配置。每个 AI 一个令牌，
            不要共用、不要外传。
          </li>
          <li>
            <b>填配置。</b>
            打开你 AI 客户端的 MCP 服务器配置，把下面的示例填进去，将两个占位符换成
            申请到的真实值。不同客户端的配置写法略有差别，以你客户端的说明为准，
            核心就是这两项：接入地址 + 你的令牌。
            <pre className="ai-code">{CONFIG_SAMPLE}</pre>
            注：此示例按 Streamable HTTP 传输的常见写法给出；只能以本地命令方式
            添加服务器、或不能自定义请求头的客户端，暂时接不上。
          </li>
          <li>
            <b>连通自检。</b>
            先只读不写：让你的 AI 调一次 get_chain_config，看看支持哪些链和交易对；
            再调一次 get_orderbook，看一眼 BTC/USDT 的盘口。两个都能返回，就说明接通了。
          </li>
          <li>
            <b>开始练习。</b>
            让 AI 用 place_order 挂一笔小额测试单，再用 get_order_status 查它成交了没有。
            金额都用普通数字字符串（比如价格 "1.5"、数量 "0.5"）。先小额、先练熟，再放大。
          </li>
        </ol>
      </section>

      <section className="card">
        <h3 className="ai-h">AI 能做什么</h3>
        <p className="hint">只读工具（不会改动任何东西，急停时也能用）：</p>
        <table className="ai-tools">
          <tbody>
            {READ_TOOLS.map((t) => (
              <tr key={t.name}>
                <td className="ai-tool-name">{t.name}</td>
                <td>{t.desc}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="hint">写工具（会真的下单、成交、撤单，先过护栏才执行）：</p>
        <table className="ai-tools">
          <tbody>
            {WRITE_TOOLS.map((t) => (
              <tr key={t.name}>
                <td className="ai-tool-name">{t.name}</td>
                <td>{t.desc}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="card">
        <h3 className="ai-h">安全护栏</h3>
        <p className="hint">护栏都写死在服务端代码里，不靠 AI 自觉：</p>
        <ul className="ai-list">
          <li>
            <b>独立身份：</b>每个 AI 一个令牌、一套限额、一本审计日志；令牌在服务端
            只存哈希，某个令牌可以单独停用，不影响别人。
          </li>
          <li>
            <b>三重限额：</b>单笔上限、每日上限、每分钟写次数上限，超了在签名之前
            就直接拒绝，不产生任何副作用。
          </li>
          <li>
            <b>白名单：</b>只许上面两条测试网（主网直接拒绝），只许登记在册的 8 个
            交易对，合约地址只认交易所配置。
          </li>
          <li>
            <b>全局急停：</b>项目方可以一键停掉所有 AI 的写操作（只读照常用）；
            单个 AI 也能被单独停用。
          </li>
          <li>
            <b>全程审计：</b>每一次工具调用都记一条日志——时间、哪个 AI、调了什么、
            结果、交易哈希——只增不改，事后可查账。
          </li>
        </ul>
      </section>

      <section className="card">
        <h3 className="ai-h">注意事项</h3>
        <ul className="ai-list">
          <li>
            <b>未落锁的挂单撤不了：</b>订单挂出去之后、被撮合落锁之前，没有撤单
            手段（中继没有撤单入口），只能等它过期或者被成交；已经落锁的订单才能
            用链上硬撤永久作废。所以让 AI 挂单前，先想清楚价格和数量。
          </li>
          <li>
            <b>测试币没有真实价值：</b>测试网的币只是练习用的，别把真钱、真币转进来。
          </li>
          <li>
            <b>令牌要保管好：</b>令牌相当于你这个 AI 的钥匙，别发到公开场合；
            怀疑泄露时，请项目方把旧令牌作废、重新发放。
          </li>
          <li>
            <b>正式版方向：</b>将来正式开放时是「钱包自托管」——你带自己的钱包
            接入，交易所不碰你的私钥。现在测试期由服务端保管测试钥，只是练习
            脚手架，不是最终形态。
          </li>
        </ul>
      </section>
    </div>
  )
}
