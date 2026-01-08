Markdown

# 🐳 Solana Smart Money Monitor 
# Solana 聪明钱链上监控

[![TypeScript](https://img.shields.io/badge/Language-TypeScript-blue.svg)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Runtime-Node.js-green.svg)](https://nodejs.org/)
[![License](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

[English](#english) | [中文说明](#chinese)

---

<a name="english"></a>
## 🇬🇧 English Documentation

### 📖 Introduction
A professional-grade, real-time Solana blockchain monitor designed to track "Smart Money" and "Whales".
Unlike simple transaction listeners, this system features a **Dual-Core Data Engine** (Jupiter + DexScreener) for accurate pricing, an **Anti-Spam Filter** to ignore fake airdrops, and a **Smart Concurrency Queue** to bypass RPC rate limits (429 errors).

### ✨ Key Features (V28)
1.  **🚀 Dual-Core Data Engine**:
    * **Jupiter API (Primary)**: Provides ultra-fast price updates and correct token symbols.
    * **DexScreener (Secondary)**: Fetches Market Cap (FDV) and Liquidity data.
    * *Result:* No more "UNKNOWN" tokens or incorrect prices.
2.  **🛡️ Smart Anti-Spam & AirDrop Filter**:
    * Automatically distinguishes between real **SWAPS** (Buy/Sell) and **TRANSFERS** (Dev Airdrops/Distributions).
    * Filters out spam tokens that simulate activity without real SOL spending.
3.  **🚦 Traffic Control & Rate Limiting**:
    * Implements a concurrency queue (`MAX_CONCURRENT_TASKS = 5`).
    * Prevents `429 Too Many Requests` errors from free-tier RPCs (e.g., Helius) during high-traffic moments.
4.  **Tb Human-Readable Prices**:
    * Auto-formats meme coin prices (e.g., converts `5.38e-7` to `$0.00000053`).
5.  **🔄 Hot Reload**:
    * Update `wallets.json` on the fly without restarting the script.

### 🛠️ Installation

1.  **Clone the repo**
    ```bash
    git clone [https://github.com/your-username/sol-whale-monitor.git](https://github.com/your-username/sol-whale-monitor.git)
    cd sol-whale-monitor
    ```

2.  **Install Dependencies**
    ```bash
    npm install
    ```

3.  **Configuration**
    * Open `src/monitor.ts` to configure your **RPC URL**, **Telegram Bot Token**, and **Proxy Port** (default: 7890).
    * Create `wallets.json` in the root directory:
        ```json
        [
          { "address": "Wallet_Address_Here", "name": "Smart Money 1", "emoji": "👻" },
          { "address": "Wallet_Address_Here", "name": "Whale 2", "emoji": "🐋" }
        ]
        ```

4.  **Run**
    ```bash
    npm start
    ```

---

<a name="chinese"></a>
## 🇨🇳 中文说明

### 📖 项目简介
这是一个生产级的 Solana 链上监控系统，专为捕捉“聪明钱”和“巨鲸”动向而设计。
与普通的监控脚本不同，本项目集成了 **双核数据引擎**（Jupiter + DexScreener）以确保数据准确性，拥有 **防空投误报系统** 过滤垃圾信息，并内置了 **智能并发流控**，即使使用免费的 RPC 节点也能稳定运行不报错。

### ✨ 核心功能 (V28)
1.  **🚀 双核数据引擎**:
    * **Jupiter API (主)**: 毫秒级获取最准确的代币价格和 Symbol，解决代理屏蔽导致的名字解析失败问题。
    * **DexScreener (副)**: 补充市值 (FDV) 和流动性池数据。
    * *效果:* 彻底告别 "UNKNOWN" 代币名和错误的土狗币价格。
2.  **🛡️ 智能防空投/误报过滤**:
    * 通过分析交易类型和 SOL 变动，自动区分 **真实买卖 (Swap)** 和 **项目方空投/分发 (Transfer)**。
    * 只有真实花钱买入的交易才会被推送，拒绝垃圾信息轰炸。
3.  **🚦 智能并发流控**:
    * 内置任务队列，严格控制并发数 (`MAX_CONCURRENT_TASKS = 5`)。
    * 有效防止在行情剧烈波动时，Helius 等 RPC 节点返回 `429 Too Many Requests` 封禁 IP。
4.  **Tb 价格显示优化**:
    * 针对 Meme 币极小的价格进行美化（例如将 `5.38e-7` 自动格式化为 `$0.00000053`），拒绝科学计数法。
5.  **🔄 热更新配置**:
    * 运行中修改 `wallets.json` 名单，脚本会自动重载，无需重启进程。

### 🛠️ 安装与使用

1.  **下载项目**
    ```bash
    git clone [https://github.com/your-username/sol-whale-monitor.git](https://github.com/your-username/sol-whale-monitor.git)
    cd sol-whale-monitor
    ```

2.  **安装依赖包**
    ```bash
    npm install
    ```

3.  **配置文件**
    * 打开 `src/monitor.ts` 修改顶部的配置项：
        * `CUSTOM_RPC_URL`: 你的 Solana RPC 节点链接。
        * `TG_BOT_TOKEN`: Telegram 机器人的 Token。
        * `PROXY_URL`: 本地 VPN 代理地址 (默认 127.0.0.1:7890)。
    * 在根目录创建 `wallets.json` 文件：
        ```json
        [
          { "address": "钱包地址粘贴在这里", "name": "聪明钱01", "emoji": "👻" },
          { "address": "钱包地址粘贴在这里", "name": "大户02", "emoji": "🐋" }
        ]
        ```

4.  **启动监控**
    ```bash
    npm start
    ```
    *建议使用 PM2 后台运行:*
    ```bash
    pm2 start src/monitor.ts --interpreter ./node_modules/.bin/ts-node --name "sol-monitor"
    ```

### ⚙️ 参数详解 (src/monitor.ts)

| 变量名 | 默认值 | 说明 |
| :--- | :--- | :--- |
| `MAX_CONCURRENT_TASKS` | `5` | **并发阈值**。同时处理的钱包数量，设太高会导致 429 报错。 |
| `MIN_SOL_THRESHOLD` | `0` | **推送门槛**。交易涉及的 SOL 小于此值将不推送 (0 代表推送所有)。 |
| `PROXY_URL` | `127.0.0.1:7890` | **代理地址**。国内环境必须配置，否则无法连接 TG 和 API。 |
| `CACHE_TTL` | `60000` | **缓存时间**。代币信息缓存毫秒数，节省 API 调用次数。 |

---

## ⚠️ Disclaimer / 免责声明

This software is for educational and research purposes only. Cryptocurrency trading involves high risk. The developers are not responsible for any financial losses.

本软件仅供学习和研究使用。加密货币投资风险极高，开发者不对任何资金损失负责。请妥善保管您的私钥和 API Key。

---