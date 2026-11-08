/**
 * 跨链默认桥 · 逐通道披露内容（第四十一轮，第一期）
 *
 * 对应设计 §2.3（承诺点全披露）与 §7.4（失败三段式文案）：用户把某通道选为默认的
 * 那一屏，必须包含费率结构、时效区间、安全模型、具体风险点、不可撤销、失败时资金
 * 去向六要素，缺一不可。每条通道的披露有独立版本号；改版 bump 版本后旧确认失效。
 *
 * 口径纪律（设计 §3）：主网与测试网时效分开写、禁止混写；费率只写结构与计费方式，
 * 具体数字一律在设置/发起时实时读取，禁止把费率写死进文案。事实与桥页现行披露
 * （第 19/20 轮）保持一致：LZ 1-of-1 DVN 白话、CCIP DON+RMN、Wormhole 13-of-19。
 */
import type { DefaultChannelId } from './types'

export interface FailureGuide {
  /** 1. 交付发起失败 → 钱在哪、能做什么 */
  initiationFailure: string
  /** 2. 在途超时 → 怎么查、上限多久、谁介入 */
  inTransitTimeout: string
  /** 3. 目标侧入账异常 → 最终落点与到账后操作 */
  destinationIssue: string
}

export interface ChannelDisclosure {
  channel: DefaultChannelId
  /** 披露版本号：文案任何实质改动必须 +1，旧确认随之失效（§2.3） */
  version: number
  name: string
  /** 费率结构（只写结构与承担方式；数字实时读取，禁止写死） */
  feeStructure: string
  etaMainnetText: string
  etaTestnetText: string
  securityModel: string
  riskPoints: string[]
  irreversibility: string
  failureDestination: string
  failureGuide: FailureGuide
  /** 在途超时判定上限（毫秒）：超过仍未到账 → 交付异常（超时），触发告警口径（§7.2） */
  timeoutMs: { mainnet: number; testnet: number }
}

export const TESTNET_CHAIN_IDS: ReadonlySet<number> = new Set([11155111, 84532])

export function isTestnetChain(chainId: number): boolean {
  return TESTNET_CHAIN_IDS.has(chainId)
}

export const CHANNEL_DISCLOSURES: Record<DefaultChannelId, ChannelDisclosure> = {
  layerzero: {
    channel: 'layerzero',
    version: 1,
    name: 'LayerZero',
    feeStructure:
      '两部分：跨链消息费在发送时以源链原生币（ETH）实时报价支付；另有 0.1 TKA 桥费从到账数量中扣除。具体金额以每次交付发起前的实时报价为准，报价会显示在桥页与交付记录中，本页不写死数字。桥费由收款方（就是你）从成交款里承担，与结算 gas 的双方对半分摊是两笔分开的账。',
    etaMainnetText: '主网通常 2–6 分钟到账。这个速度来自用区块确认数代替全终局确认（以太坊源链约 15 个区块确认），属于概率性确认，理论上有极小的短重组风险——快是有代价的，选它前请知悉。',
    etaTestnetText: '测试网实测约 8 分钟（458 秒，项目内实测）。测试网数字只代表测试环境，不代表主网。',
    securityModel:
      '你的跨链消息由 LayerZero 网络的 DVN（去中心化验证网络）验证后，Executor 才在目标链投递。目前这条路径的 DVN 配置是 1-of-1：只有 LayerZero Labs 一家验证方。',
    riskPoints: [
      '目前只有 LayerZero 官方一家在验证，等于信任这一家：当前验证方是 1-of-1 配置，跨链消息只由一个验证方签字确认，没有第二个独立验证方复核；这家若被攻破或作恶，假消息也可能被放行。',
      '业界先例：2026 年 4 月 KelpDAO 约 2.92 亿美元损失事件中，涉事跨链路径正是 1-of-1 DVN 配置。本站已定硬门禁：主网开放此桥之前，必须先升级为多验证方配置并读回核实；在那之前请勿用它走大额资金。',
      '速度来自概率性确认（区块确认数而非全终局），理论上存在极小的链重组回滚风险。',
    ],
    irreversibility: '交付一旦发起不可取消、必然走完：消息桥没有撤销概念，发起后无法改道、无法退款，只能等它投递完成。',
    failureDestination:
      '发起失败时钱一分未动，留在你成交链的 Vault 余额里；在途消息确认终局失败时，等额款项按预登记落点退回你成交链的 Vault 余额，不会凭空消失。',
    failureGuide: {
      initiationFailure:
        '交付发起失败：钱还在你成交链的 Vault 余额里，一分未动。你可以在订单历史的交付记录里点「重试交付」，或点「提取到钱包」自行处理。',
      inTransitTimeout:
        '在途超时：先凭交付记录里的追踪链接到 LayerZero Scan 查消息状态。多数情况只是投递延迟；超过时效上限仍未到账，交付记录会转为异常并提示，运营侧可经无许可的 lzReceive 补投递兜底。',
      destinationIssue:
        '目标侧入账异常：只有在通道侧确认这条消息终局失败后，等额款项才会记回你成交链的 Vault 余额（资产页可见，带来源标注），确认前不会双记账。记回后你可以重试交付或提取到钱包。',
    },
    timeoutMs: { mainnet: 15 * 60_000, testnet: 30 * 60_000 },
  },
  ccip: {
    channel: 'ccip',
    version: 1,
    name: 'Chainlink CCIP',
    feeStructure:
      '费用在发送前由 Chainlink 报价、发送时锁定（固定价，中途不补差价），以源链原生币（ETH）支付，不另收桥费。具体金额以每次交付发起前的实时报价为准。桥费由收款方（就是你）从成交款里承担，与结算 gas 分开记账。',
    etaMainnetText: '主网 15–20 分钟级到账：CCIP 等源链全终局后才投递，连 L2 源链也要等其 L1 终局标记，所以快不了——换来的是确定性。',
    etaTestnetText: '测试网实测约 20 分钟。测试网数字只代表测试环境，不代表主网。',
    securityModel:
      '你的跨链消息由 Chainlink 的去中心化预言机网络（DON）提交验证，另有独立的风险管理网络（RMN）监控，异常时可自动熔断——三条通道里验证层最厚。',
    riskPoints: [
      '费用发送时锁定，但报价有效期短；价格变化后需要重新报价再发，交付可能因此稍有延迟。',
      '本通道经 wTKA 转移：发起时自动把 TKA 按 1:1 包裹成 wTKA 再发送，目标链收到的是 wTKA，可随时 1:1 换回 TKA，无差价损耗。',
      '智能合约与预言机网络风险仍然存在；跨链转账不可撤销，第一次使用请先小额试走。',
    ],
    irreversibility: '交付一旦发起不可取消、必然走完：消息桥没有撤销概念，发起后无法改道、无法退款，只能等它投递完成。',
    failureDestination:
      '发起失败时钱一分未动，留在你成交链的 Vault 余额里；在途消息确认终局失败时，等额款项按预登记落点退回你成交链的 Vault 余额，不会凭空消失。',
    failureGuide: {
      initiationFailure:
        '交付发起失败：钱还在你成交链的 Vault 余额里，一分未动。你可以在订单历史的交付记录里点「重试交付」，或点「提取到钱包」自行处理。',
      inTransitTimeout:
        '在途超时：先凭交付记录里的消息 ID 到 Chainlink CCIP 页面查状态。多数情况是源链终局等待或投递排队；超过时效上限仍未到账，交付记录会转为异常并提示，后续按 Chainlink 官方人工执行口径处理。',
      destinationIssue:
        '目标侧入账异常：只有在通道侧确认这条消息终局失败后，等额款项才会记回你成交链的 Vault 余额（资产页可见，带来源标注），确认前不会双记账。记回后你可以重试交付或提取到钱包。',
    },
    timeoutMs: { mainnet: 40 * 60_000, testnet: 60 * 60_000 },
  },
  wormhole: {
    channel: 'wormhole',
    version: 1,
    name: 'Wormhole（NTT）',
    feeStructure:
      '只需付消息费与发送交易的 gas，以源链原生币（ETH）支付，不另收桥费；测试网消息费为 0。具体金额以每次交付发起前的实时读取为准。桥费由收款方（就是你）从成交款里承担，与结算 gas 分开记账。',
    etaMainnetText: '主网约 15 分钟级到账（以太坊锚定路线含 L1 终局等待；L2 源链约 5 分钟）。',
    etaTestnetText: '测试网实测约 59 分钟：测试网没有自动中继，靠人工凭消息证明（VAA）补投递，所以明显慢于主网口径。测试网数字只代表测试环境。',
    securityModel:
      '你的跨链消息由 Wormhole 的 19 个 Guardian 节点共同签名，至少 13 个签名（13-of-19）消息才被放行，单个节点作恶无法放行假消息。',
    riskPoints: [
      '历史上 2022 年 Wormhole 曾因 Solana 侧验签漏洞被盗约 12 万 ETH——那是 Solana 侧组件，与本站 EVM 侧 NTT 配置不是同一组件；但它说明跨链桥整体属于高风险类别，请先小额试走。',
      '若目标链长时间未自动到账，可能需要凭消息证明（VAA）在目标链手动完成投递；交付记录里有追踪链接与说明，钱不会因此丢失。',
      '本通道经 wTKA 转移：发起时自动把 TKA 按 1:1 包裹成 wTKA 再发送，目标链收到的是 wTKA，可随时 1:1 换回 TKA，无差价损耗。',
    ],
    irreversibility: '交付一旦发起不可取消、必然走完：消息桥没有撤销概念，发起后无法改道、无法退款，只能等它投递完成（或按说明手动完成投递）。',
    failureDestination:
      '发起失败时钱一分未动，留在你成交链的 Vault 余额里；在途消息确认终局失败时，等额款项按预登记落点退回你成交链的 Vault 余额，不会凭空消失。',
    failureGuide: {
      initiationFailure:
        '交付发起失败：钱还在你成交链的 Vault 余额里，一分未动。你可以在订单历史的交付记录里点「重试交付」，或点「提取到钱包」自行处理。',
      inTransitTimeout:
        '在途超时：先凭交付记录里的链接到 WormholeScan 查状态，并可在该页面取得消息证明（VAA）后按指引手动完成投递——这是本通道既有的兜底路径，测试网一直如此。',
      destinationIssue:
        '目标侧入账异常：只有在通道侧确认这条消息终局失败后，等额款项才会记回你成交链的 Vault 余额（资产页可见，带来源标注），确认前不会双记账。记回后你可以重试交付或提取到钱包。',
    },
    timeoutMs: { mainnet: 40 * 60_000, testnet: 120 * 60_000 },
  },
}

export function getDisclosure(channel: DefaultChannelId): ChannelDisclosure {
  return CHANNEL_DISCLOSURES[channel]
}

export function currentDisclosureVersion(channel: DefaultChannelId): number {
  return CHANNEL_DISCLOSURES[channel].version
}

/** 按环境取时效文案（§3：主网/测试网分开，禁止混写） */
export function etaTextFor(channel: DefaultChannelId, chainId: number): string {
  const d = CHANNEL_DISCLOSURES[channel]
  return isTestnetChain(chainId) ? d.etaTestnetText : d.etaMainnetText
}

/** 一行预计用的短时效（§4.1）：逐通道真实区间 */
export function etaShortTextFor(channel: DefaultChannelId, chainId: number): string {
  if (isTestnetChain(chainId)) {
    return channel === 'layerzero' ? '约 8 分钟' : channel === 'ccip' ? '约 20 分钟' : '约 59 分钟（测试网人工中继）'
  }
  return channel === 'layerzero' ? '约 2–6 分钟' : channel === 'ccip' ? '约 15–20 分钟' : '约 15 分钟'
}
