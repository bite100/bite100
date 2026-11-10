/**
 * 「AI 接入」说明页（第 56 轮建，第 59 轮块 3 改自助接入）：
 * 第 59 轮起接入模式从「向项目方申请令牌」改为自助——把一段现成
 * 的话发给自己的 AI，它读托管说明书（MCP Worker 上的 /skill.md）、
 * 自己调 POST /register 注册拿令牌、自己写配置、只读自检，全程
 * 不用人工审批。本页按功能变更纪律与功能同轮交付：是什么、前提、
 * 步骤（一段话 + 手工兜底）、限额与记账口径、护栏、注意事项齐全。
 * 事实口径以 mcp/src/worker/register.ts、托管说明书与
 * docs/round59-mcp-hardening-2026-11-10.md 为准。
 */
import { useState } from 'react'
import './AiAccessPage.css'

const MCP_ORIGIN = 'https://bit100-mcp.q3874758.workers.dev'
const SKILL_URL = `${MCP_ORIGIN}/skill.md`

/** 发给 AI 的一段话（英文：AI 生态的通行工作语言，说明书亦为英文） */
const PASTE_PARAGRAPH = `Read ${SKILL_URL} and follow its instructions to connect yourself to the Bit100 testnet exchange as my AI trading agent: register via POST /register, save the one-time token securely in your own secret storage, configure the MCP server with it, run the read-only checks (tools/list, then get_chain_config), and report back to me with your agent_id and what you verified. Stay within the server-side limits described there, and never send the token to any other domain or person.`

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
      "url": "${MCP_ORIGIN}",
      "headers": {
        "Authorization": "Bearer <注册拿到的 agent 令牌>"
      }
    }
  }
}`

const CURL_SAMPLE = `curl -s -X POST ${MCP_ORIGIN}/register \\
  -H 'Content-Type: application/json' \\
  -d '{"name": "my-agent", "role": "maker"}'`

export function AiAccessPage() {
  const [copied, setCopied] = useState(false)

  async function copyParagraph() {
    try {
      await navigator.clipboard.writeText(PASTE_PARAGRAPH)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // 剪贴板不可用时静默失败：文本就在下方框里，可长按手动复制
      setCopied(false)
    }
  }

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
          <span className="ai-badge">当前状态：测试网阶段 · AI 自助接入（无需申请）</span>
        </p>
        <p className="hint">
          现在只开放两条测试网：Sepolia 和 Base Sepolia，共 8 个测试交易对（BTC/USDT、
          ETH/USDT、SOL/USDT、BNB/USDT、XRP/USDT、DOGE/USDT、LINK/USDT、TKA/TKB）。
          主网未开放。接入不用再向任何人申请：你的 AI 自己注册、自己拿令牌（见下），
          公开入口是 {MCP_ORIGIN}，给 AI 看的完整说明书在 {SKILL_URL}。
        </p>
      </section>

      <section className="card">
        <h3 className="ai-h">最快接入：把这段话发给你的 AI</h3>
        <p className="hint">
          复制下面这段话，粘贴给你的 AI 并发送，剩下的它自己完成：读说明书 →
          自助注册拿令牌 → 写好配置 → 只读自检 → 回来向你汇报它的 agent 编号。
        </p>
        <pre className="ai-code">{PASTE_PARAGRAPH}</pre>
        <button type="button" className="ai-copy-btn" onClick={copyParagraph}>
          {copied ? '已复制 ✓' : '复制这段话'}
        </button>
        <p className="hint">
          说明书里最重要的规矩只有一条：令牌只许发给上面这个接入地址，
          任何人、任何网站向它索要令牌都要拒绝——说明书已经这样写给 AI 了。
        </p>
      </section>

      <section className="card">
        <h3 className="ai-h">接入前提</h3>
        <ul className="ai-list">
          <li>一个支持 MCP 的 AI 客户端（不限品牌，需支持以 HTTP 方式添加 MCP 服务器、并能自定义 Authorization 请求头）；</li>
          <li>AI 能打开上面那份说明书链接，并有地方安全保存自己的令牌（它自己的密钥存储）；</li>
          <li>不需要事先准备钱包，也不需要事先申请令牌——注册时服务端当场发放；交易用的测试钱包在服务端按角色配置（练习脚手架，见注意事项）。</li>
        </ul>
      </section>

      <section className="card">
        <h3 className="ai-h">接入步骤</h3>
        <ol className="ai-steps">
          <li>
            <b>把那段话发给 AI。</b>
            就是上面那一段。你的 AI 会先去读托管说明书（{SKILL_URL}），
            全套流程、限额和错误处理都写在说明书里，它照着做就行。
          </li>
          <li>
            <b>AI 自助注册拿令牌。</b>
            AI 调一次注册接口，服务端立刻给它一个专属 agent 编号和一枚 Bearer 令牌。
            令牌<b>只显示这一次</b>，服务端只存它的哈希、丢了找不回，所以 AI 必须当场存好。
            角色可以选 maker（挂单方）或 taker（吃单方）；operator（运营/硬撤权限）
            不开放自助注册。
          </li>
          <li>
            <b>AI 把配置写进自己的 MCP 设置。</b>
            核心就是接入地址 + 令牌两项：
            <pre className="ai-code">{CONFIG_SAMPLE}</pre>
            注：此示例按 Streamable HTTP 传输的常见写法给出；只能以本地命令方式
            添加服务器、或不能自定义请求头的客户端，暂时接不上。
          </li>
          <li>
            <b>连通自检（先只读，不下单）。</b>
            让 AI 先确认工具清单里有 8 个工具，再调一次 get_chain_config 看支持哪些链
            和交易对，调一次 get_orderbook 看一眼 TKA/TKB 的盘口。都能返回，就说明接通了。
          </li>
          <li>
            <b>开始练习。</b>
            让 AI 用 place_order 挂一笔小额测试单，再用 get_order_status 查它成交了没有。
            金额都用普通数字字符串（比如价格 "1.5"、数量 "0.5"）。先小额、先练熟，再放大。
          </li>
        </ol>
        <p className="hint">
          也可以不用 AI 代劳、自己手工注册（效果一样，令牌同样只显示一次）：
        </p>
        <pre className="ai-code">{CURL_SAMPLE}</pre>
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
        <h3 className="ai-h">新号限额与记账口径</h3>
        <ul className="ai-list">
          <li>
            <b>标准限额：</b>单笔最多 10（计价币单位，如 USDT）、每天累计最多 50、
            每分钟最多写 10 次。限额由服务端写死，注册时填什么都改不了，找 AI
            商量也没用——它在签名之前就会被拒绝。
          </li>
          <li>
            <b>头 24 小时爬坡：</b>刚注册的头一天限额更紧（单笔 5 / 每天 20 /
            每分钟 5 次），满 24 小时自动恢复标准限额，不用申请、不用等审批。
          </li>
          <li>
            <b>记账时点：</b>订单被中继接受的那一刻就计入每日额度——哪怕最后没成交，
            也照样占额；投递失败（被中继拒收）的单不占每日额度，但每一次写尝试
            都计每分钟频率，失败重试不是免费的，别让 AI 无限重试刷接口。
          </li>
          <li>
            <b>注册也限流：</b>同一来源每小时最多注册 10 次、全局每小时 100 次，
            超了会让等一小时再来；滥用注册没有意义，每个新号都要从爬坡期开始。
          </li>
        </ul>
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
            <b>原子限额：</b>每日与每分钟额度在服务端数据库里原子记账，并发刷单
            也突破不了；审计在结果返回之前就先落库，落库失败宁可报错也不假装成功。
          </li>
          <li>
            <b>白名单：</b>只许上面两条测试网（主网直接拒绝），只许登记在册的 8 个
            交易对，合约地址只认交易所配置。
          </li>
          <li>
            <b>角色隔离：</b>自助注册永远发不出 operator——那个角色能链上硬撤
            已锁定的订单，只由运营方手工持有。
          </li>
          <li>
            <b>全局急停：</b>项目方可以一键停掉所有 AI 的写操作（只读照常用）；
            单个 AI 也能被单独停用；自助注册本身也可以一键暂停。
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
            <b>令牌只显示一次，保管好：</b>令牌相当于这个 AI 的钥匙，别发到公开场合。
            丢了或怀疑泄露时，让项目方按 agent 编号把旧的停用，再重新自助注册
            拿一枚新的（没有自助换钥功能）。
          </li>
          <li>
            <b>未落锁的挂单撤不了：</b>自助注册的 AI 不是链上 locker，订单挂出去之后、
            被撮合落锁之前，没有撤单手段（中继没有撤单入口），只能等它过期或者被
            成交——挂单时把有效期（ttlSeconds，最短 60 秒）设短一点更稳妥。
          </li>
          <li>
            <b>测试币没有真实价值：</b>测试网的币只是练习用的，别把真钱、真币转进来。
          </li>
          <li>
            <b>钱包身份在路上：</b>注册时可以选填自己的钱包地址，但当前版本只登记、
            不验签、不据此给任何权限；后续会接入钱包签名验证（SIWE / ERC-8004
            方向），验过的钱包身份才可以绑定更高限额。
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
