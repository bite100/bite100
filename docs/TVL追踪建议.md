# TVL 追踪建议

> 主网上线后用于监控 Vault/AMMPool 总锁仓与协议曝光  
> 关联：[公开数据展示实现指南](./公开数据展示实现指南.md)、[主网上线与优化总览](./主网上线与优化总览.md)

---

## 一、推荐方式

### 1.1 DefiLlama API（首选）

- **最准确、多链、免费**：https://defillama.com/docs/api  
- 上线后：向 [DefiLlama-Adapters](https://github.com/DefiLlama/DefiLlama-Adapters) 提交你的协议 adapter，他们会加入 TVL 追踪。

**示例（查询协议 TVL）**：

```python
import requests

def get_protocol_tvl(protocol_slug: str = "your-protocol-slug"):
    url = f"https://api.llama.fi/protocol/{protocol_slug}"
    resp = requests.get(url).json()
    return resp.get("tvl", 0), resp.get("chainTvls", {})

tvl, chain_tvls = get_protocol_tvl("p2p-exchange")
print("TVL:", tvl, "Chain breakdown:", chain_tvls)
```

- 需在 DefiLlama-Adapters 中实现你的协议逻辑：汇总 Vault 总存款 + AMMPool 流动性（各链）。

### 1.2 Dune Analytics

- 创建 Dashboard，用 SQL 查询 Vault、Settlement、AMMPool 合约的余额与事件。
- 适合自定义图表、多链对比、与手续费/交易量结合。

### 1.3 自建脚本 + InfluxDB/Grafana

- 脚本定时（如每小时）查询链上：
  - Vault：总存款（各代币）
  - AMMPool：reserve0 + reserve1（或 getReserves），按价格换算成 USD
- 写入 InfluxDB，Grafana 做曲线图。
- 示例见 `scripts/tvl_example.py`（仅查询逻辑，不依赖 InfluxDB）。

---

## 二、自建脚本示例（Vault + AMM 流动性）

见仓库内 `scripts/tvl_example.py`：用 web3 读合约余额，输出当前「TVL」数值，便于接入 cron + 数据库或告警。

---

## 三、上线 Checklist 相关

- [ ] 确定主网 Vault、AMMPool、Settlement 地址  
- [ ] 选一种方式：DefiLlama 提交 / Dune Dashboard / 自建  
- [ ] 在 README 或官网展示 TVL（若使用 DefiLlama，可嵌 iframe 或 API 结果）

---

*本文档以当时修改为准。*
