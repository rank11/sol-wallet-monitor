# Solana 钱包余额监控系统

这是一个基于 TypeScript 和 @solana/web3.js 的实时监控脚本，用于监控 Solana 钱包地址的 SOL 余额变化。

## 功能特性

- ✅ 实时监控多个钱包地址的余额变化
- ✅ 自动识别转入/转出交易
- ✅ 显示变动金额和当前余额
- ✅ 使用 WebSocket 长连接，延迟低、效率高
- ✅ 完整的 TypeScript 类型安全

## 技术栈

- **Node.js** - JavaScript 运行时环境
- **TypeScript** - 提供类型安全的 JavaScript
- **@solana/web3.js** - Solana 官方 JavaScript SDK

## 安装步骤

### 1. 初始化项目

在项目根目录执行：

```bash
npm init -y
```

这会创建 `package.json` 文件（如果还没有的话）。

### 2. 安装依赖

安装项目所需的依赖包：

```bash
# 安装生产依赖（@solana/web3.js）
npm install @solana/web3.js

# 安装开发依赖（TypeScript 和 ts-node）
npm install --save-dev typescript ts-node @types/node
```

**说明：**
- `@solana/web3.js` - Solana Web3 SDK（类似 Java 的第三方库）
- `typescript` - TypeScript 编译器
- `ts-node` - 可以直接运行 TypeScript 文件，无需先编译（类似 Java 的 `java` 命令可以直接运行 `.java` 文件）
- `@types/node` - Node.js 的类型定义（提供类型提示）

### 3. 验证安装

检查 `package.json` 是否包含所有依赖：

```bash
cat package.json
```

应该看到 `dependencies` 和 `devDependencies` 部分都有相应的包。

## 运行脚本

### 方式一：使用 npm script（推荐）

```bash
npm start
```

或者：

```bash
npm run dev
```

### 方式二：直接使用 ts-node

```bash
npx ts-node src/monitor.ts
```

**说明：**
- `npx` 类似于 Java 的 `java -jar`，可以直接运行本地安装的包
- `ts-node` 会先编译 TypeScript 代码，然后执行（类似 Java 的即时编译）

## 配置钱包地址

编辑 `src/monitor.ts` 文件，修改 `WALLET_ADDRESSES` 数组：

```typescript
const WALLET_ADDRESSES: string[] = [
    'HhJpBhRRn4g56VsyLuT8DL5iXVhoChVNxuy36yZ7RfVH',  // 钱包1
    '你的钱包地址2',  // 钱包2
    '你的钱包地址3'   // 钱包3
];
```

## 输出示例

```
========================================
   Solana 钱包余额监控系统
========================================

[连接成功] Solana 节点版本: 1.18.0

[信息] 准备监控 1 个钱包地址

[初始化] 钱包 HhJpBhRRn4g56VsyLuT8DL5iXVhoChVNxuy36yZ7RfVH
  当前余额: 1234.567890123 SOL
  开始监控...

[信息] 钱包 HhJpBhRRn4g56VsyLuT8DL5iXVhoChVNxuy36yZ7RfVH 的订阅 ID: 12345

[信息] 所有监控任务已启动
[信息] 按 Ctrl+C 退出程序

[2024/01/15 14:30:25] 💰 转入
  钱包地址: HhJpBhRRn4g56VsyLuT8DL5iXVhoChVNxuy36yZ7RfVH
  变动金额: +10.500000000 SOL
  当前余额: 1245.067890123 SOL
  区块高度: 123456789
```

## 技术说明（Java 开发者参考）

### 异步编程

- **Promise** - 类似于 Java 的 `CompletableFuture<T>`
- **async/await** - 类似于 Java 的 `.get()` 或 `.join()`，用于等待异步操作完成
- **.then()/.catch()** - 类似于 Java 的 `.thenApply()` 和 `.exceptionally()`

### WebSocket vs 轮询

- **onAccountChange** - 使用 WebSocket 长连接，Solana 节点会主动推送更新
- **优势**：延迟低（毫秒级）、效率高（不占用带宽）、实时性强
- **对比**：如果使用轮询，需要每秒请求一次，延迟高且浪费资源

### 类型系统

- **TypeScript** - 提供编译时类型检查（类似 Java 的静态类型）
- **PublicKey** - 强类型包装类，确保地址格式正确
- **类型推断** - TypeScript 可以自动推断类型（类似 Java 的 `var`）

## 常见问题

### 1. 连接失败

如果看到 "连接失败" 错误，可能原因：
- 网络问题
- RPC 节点限制（公共节点有速率限制）
- 解决方案：使用付费 RPC 节点（如 QuickNode, Alchemy）

### 2. 监控不工作

- 检查钱包地址格式是否正确
- 确认钱包有余额（余额为 0 的钱包可能无法监控）
- 检查网络连接

### 3. 如何停止程序

按 `Ctrl+C` 退出程序。

## 项目结构

```
sol-whale-monitor/
├── src/
│   └── monitor.ts          # 主监控脚本
├── package.json            # 项目配置和依赖
├── tsconfig.json           # TypeScript 配置
└── README.md               # 本文件
```

## 下一步

- 添加数据库存储历史记录
- 添加 Webhook 通知
- 添加更多监控指标（如交易数量、Gas 费用等）
- 使用付费 RPC 节点提高稳定性

## 许可证

MIT

