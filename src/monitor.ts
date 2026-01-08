import { Connection, PublicKey, ParsedTransactionWithMeta } from '@solana/web3.js';
import * as fs from 'fs';
import * as path from 'path';
import fetch from 'node-fetch'; 
import TelegramBot from 'node-telegram-bot-api';
import { HttpsProxyAgent } from 'https-proxy-agent';

/**
 * 🐳 Solana 聪明钱监控tg通知轻量脚本 
 * ------------------------------------------------
 * 这是一个集成了多数据源、智能流控和防误报机制的链上监控脚本。
 * * [核心能力]
 * 1. 双核数据引擎: 优先使用 Jupiter API (极速) + DexScreener (兜底) 获取代币信息。
 * 2. 智能流控: 使用 "红绿灯" 队列机制 (MAX_CONCURRENT_TASKS)，防止 Helius 429 限流。
 * 3. 交易提纯: 自动识别并过滤 "Dev空投/分发" 产生的假交易，只推送真实 Swap。
 * 4. 价格美化: 自动处理土狗币的极小价格 (如 0.0000001)，拒绝科学计数法。
 */

// ==================== 1. 全局配置区 ====================

// [RPC节点] 使用 Helius 高速节点 (直连 Solana 链上数据)
const CUSTOM_RPC_URL = 'https://mainnet.helius-rpc.com/?api-key=你自己的apikey';

// [Telegram] 机器人凭证与频道 ID
const TG_BOT_TOKEN = '自己的tgbot_token'; 
const TG_CHAT_ID = '自己的tgchat_id';  

// [网络代理] 本地开发必须走代理 (自己VPN的端口 clash多为7890)
const PROXY_URL = 'http://127.0.0.1:7890'; 
const proxyAgent = new HttpsProxyAgent(PROXY_URL);

// [过滤阈值] 仅推送变动大于此值的 SOL 转账 (设置为 0 用于测试，生产建议 0.1)
const MIN_SOL_THRESHOLD = 0; 

// [并发控制] 同时处理的任务数。5 是 Helius 免费版不报 429 的安全值。
const MAX_CONCURRENT_TASKS = 5;

// [推广链接] 用于生成带返佣的看线链接
const REF_CONFIG = {
    gmgn: 'rank1143',
    axiom: 'rank1143'
};

// [网络请求封装] 强制所有 fetch 请求走代理，并设置 5秒超时防止挂死
const customFetch = (url: string, options: any = {}) => {
    return fetch(url, { 
        ...options, 
        agent: proxyAgent,
        timeout: 5000 
    }); 
};

// ==================== 2. 机器人初始化 ====================

let bot: TelegramBot | null = null;
if (TG_BOT_TOKEN && TG_BOT_TOKEN.length > 10) {
    try {
        bot = new TelegramBot(TG_BOT_TOKEN, { 
            polling: false,
            request: { agent: proxyAgent } as any // 关键：TG 必须走代理
        });
        console.log('[系统] Telegram Bot 已初始化 (V28 归档版)');
    } catch (e: any) {
        console.error('[系统] Bot 初始化失败:', e.message);
    }
}

/**
 * 发送 TG 消息的通用函数
 * @param text HTML 格式的消息内容
 */
async function sendTgMessage(text: string) {
    if (!bot || !TG_CHAT_ID) return;
    try {
        await bot.sendMessage(TG_CHAT_ID, text, { 
            parse_mode: 'HTML', 
            disable_web_page_preview: true 
        });
        console.log('   [系统] TG 推送成功 ✅');
    } catch (e: any) {
        console.error(`   [TG发送失败] ${e.message}`);
    }
}

// ==================== 3. 钱包名单热更新模块 ====================

interface WalletConfig {
    address: string;
    name: string;
    emoji?: string;
    publicKey: PublicKey;
}

let GLOBAL_WALLETS: WalletConfig[] = [];
const WALLETS_FILE = path.join(__dirname, '..', 'wallets.json');

/**
 * 读取本地 wallets.json 文件
 * 包含去重缓存清理，确保读取到最新修改
 */
function loadWalletConfigs(): WalletConfig[] {
    try {
        if (!fs.existsSync(WALLETS_FILE)) return [];
        delete require.cache[require.resolve(WALLETS_FILE)]; // 清除 Node.js 的 require 缓存
        const rawContent = fs.readFileSync(WALLETS_FILE, 'utf-8');
        const raw = JSON.parse(rawContent);
        const valid: WalletConfig[] = [];
        for (const item of raw) {
            // 兼容 address 和 trackedWalletAddress 两种字段名
            const addr = item.address || item.trackedWalletAddress;
            if (addr) {
                try {
                    valid.push({
                        address: addr,
                        name: item.name || '未知',
                        emoji: item.emoji || '👻',
                        publicKey: new PublicKey(addr)
                    });
                } catch (e) {}
            }
        }
        return valid;
    } catch (e) {
        return GLOBAL_WALLETS; // 读取失败时返回旧数据，防止崩坏
    }
}

/**
 * 监听文件变化，实现热更新
 */
function startConfigWatcher() {
    fs.watchFile(WALLETS_FILE, { interval: 2000 }, (curr, prev) => {
        if (curr.mtime !== prev.mtime) {
            const newWallets = loadWalletConfigs();
            if (newWallets.length > 0) {
                GLOBAL_WALLETS = newWallets;
                console.log(`\n[热更新] 配置已更新！当前监控: ${GLOBAL_WALLETS.length} 个钱包`);
            }
        }
    });
}

// ==================== 4. 双核数据引擎 (Jupiter + DexScreener) ====================

interface TokenMarketData { symbol: string; name: string; priceUsd: string; fdv: number; liquidity: number; }
interface RugCheckData { score: number; riskLevel: string; isNew: boolean; }

// 内存缓存，防止短时间内重复查询同一个代币，节省 API 额度
const tokenCache = new Map<string, { data: TokenMarketData; timestamp: number }>();
const rugCache = new Map<string, { data: RugCheckData; timestamp: number }>();
const CACHE_TTL = 60 * 1000; // 缓存有效期 60秒

const WSOL_MINT = 'So11111111111111111111111111111111111111112';

/**
 * 格式化大数字 (如市值)
 * 1000000 -> $1.00M
 */
function formatNumber(num: number): string {
    if (!num) return '$0';
    if (num >= 1_000_000_000) return `$${(num / 1_000_000_000).toFixed(2)}B`;
    if (num >= 1_000_000) return `$${(num / 1_000_000).toFixed(2)}M`;
    if (num >= 1_000) return `$${(num / 1_000).toFixed(2)}K`;
    return `$${num.toFixed(2)}`;
}

/**
 * 格式化价格 (针对 Meme 币优化)
 * 0.000000123 -> $0.000000123 (保留精度)
 * 1.23 -> $1.23
 */
function formatPrice(priceStr: string): string {
    const price = parseFloat(priceStr);
    if (!price || isNaN(price)) return '$0';
    
    if (price < 0.00000001) return `$${price.toFixed(10)}`;
    if (price < 0.00001) return `$${price.toFixed(8)}`;
    if (price < 0.01) return `$${price.toFixed(6)}`;
    if (price < 1) return `$${price.toFixed(4)}`;
    return `$${price.toFixed(2)}`; 
}

/**
 * [核心逻辑] 获取代币市场数据
 * 策略：并行请求 Jupiter (快/准) 和 DexScreener (全)。
 * Jupiter 负责提供准确的价格和符号，DexScreener 负责提供市值和流动性。
 */
async function fetchTokenMarketData(mint: string): Promise<TokenMarketData | null> {
    // 1. 查缓存
    const cached = tokenCache.get(mint);
    if (cached && (Date.now() - cached.timestamp < CACHE_TTL)) return cached.data;

    // 2. 并行请求
    const [jupRes, dexRes] = await Promise.allSettled([
        customFetch(`https://api.jup.ag/price/v2?ids=${mint}&showExtraInfo=true`),
        customFetch(`https://api.dexscreener.com/latest/dex/tokens/${mint}`)
    ]);

    let symbol = 'UNKNOWN';
    let name = 'Unknown Token';
    let priceUsd = '0';
    let fdv = 0;
    let liquidity = 0;
    let found = false;

    // 3. 解析 Jupiter 数据 (首选)
    if (jupRes.status === 'fulfilled' && jupRes.value.ok) {
        try {
            const jupData = await jupRes.value.json();
            const info = jupData.data?.[mint];
            if (info) {
                priceUsd = info.price || '0';
                if (info.extraInfo) {
                    symbol = info.extraInfo.symbol || symbol;
                    name = symbol; 
                    found = true;
                }
            }
        } catch (e) {}
    }

    // 4. 解析 DexScreener 数据 (补充)
    if (dexRes.status === 'fulfilled' && dexRes.value.ok) {
        try {
            const dexData = await dexRes.value.json();
            if (dexData.pairs && dexData.pairs.length > 0) {
                const bestPair = dexData.pairs.sort((a: any, b: any) => b.liquidity.usd - a.liquidity.usd)[0]; // 取流动性最好的池子
                if (symbol === 'UNKNOWN') symbol = bestPair.baseToken.symbol;
                if (name === 'Unknown Token') name = bestPair.baseToken.name;
                // 如果 Jupiter 没返回价格，用 DexScreener 的
                if (priceUsd === '0') priceUsd = bestPair.priceUsd;
                fdv = bestPair.fdv || 0;
                liquidity = bestPair.liquidity?.usd || 0;
                found = true;
            }
        } catch (e) {}
    }

    if (!found) return null;

    const result = { symbol, name, priceUsd, fdv, liquidity };
    tokenCache.set(mint, { data: result, timestamp: Date.now() });
    return result;
}

/**
 * 获取代币安全评分 (RugCheck)
 */
async function fetchRugCheckData(mint: string): Promise<RugCheckData> {
    const cached = rugCache.get(mint);
    if (cached && (Date.now() - cached.timestamp < CACHE_TTL)) return cached.data;

    try {
        const url = `https://api.rugcheck.xyz/v1/tokens/${mint}/report/summary`;
        const res = await customFetch(url);
        if (res.status === 404) return { score: 0, riskLevel: 'unknown', isNew: true };
        if (!res.ok) return { score: 0, riskLevel: 'error', isNew: false };
        const data = await res.json();
        const score = data.score || 0;
        let level = 'good';
        if (score > 2000) level = 'danger';
        else if (score > 500) level = 'warn';
        const result = { score, riskLevel: level, isNew: false };
        rugCache.set(mint, { data: result, timestamp: Date.now() });
        return result;
    } catch (e) { return { score: 0, riskLevel: 'error', isNew: false }; }
}

// ==================== 5. 交易深度解析引擎 ====================

interface TradeDetails {
    signature: string;
    tokenMint: string;
    tokenData: TokenMarketData | null;
    rugData: RugCheckData | null;
    tokenChange: number;
    solChange: number; 
    isBuy: boolean;
    type: 'SWAP' | 'TRANSFER' | 'WRAP';
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * [核心逻辑] 根据钱包地址，获取并解析最新的一笔交易
 */
async function fetchLastTransactionDetails(connection: Connection, pubKey: PublicKey): Promise<TradeDetails | null> {
    let signatures: any[] = [];
    let attempts = 0;
    const MAX_ATTEMPTS = 15; 

    // 1. 死磕机制：如果查不到签名，重试 15 次 (应对 RPC 索引延迟)
    while (attempts < MAX_ATTEMPTS) {
        try {
            signatures = await connection.getSignaturesForAddress(pubKey, { limit: 1 }); 
            if (signatures.length > 0 && !signatures[0].err) break;
        } catch (e: any) {
            if (e.message?.includes('429')) await sleep(1000); // 遇到限流多睡一会
        }
        attempts++;
        await sleep(200); 
    }

    if (signatures.length === 0) return null;
    const sig = signatures[0].signature;

    try {
        // 2. 获取交易详情 (Parsed 格式)
        const tx = await connection.getParsedTransaction(sig, {
            maxSupportedTransactionVersion: 0,
            commitment: 'confirmed'
        });

        if (!tx || !tx.meta) return null;

        // 3. 判断是否包含 Swap 相关的程序指令
        const logMessages = tx.meta.logMessages || [];
        const isSwapProgram = logMessages.some(log => 
            log.includes('Program JUP') || 
            log.includes('Program 675kPX9M') || 
            log.includes('Instruction: Swap')
        );

        // 4. 计算 SOL 的变化量
        const accountIndex = tx.transaction.message.accountKeys.findIndex(
            k => k.pubkey.toBase58() === pubKey.toBase58()
        );
        if (accountIndex === -1) return null;
        
        const preNative = tx.meta.preBalances[accountIndex];
        const postNative = tx.meta.postBalances[accountIndex];
        const nativeDiff = (postNative - preNative) / 1e9;
        
        // 5. 计算代币的变化量
        let targetMint = '';
        let targetChange = 0;
        let wSolDiff = 0;

        const preTokenBals = tx.meta.preTokenBalances || [];
        const postTokenBals = tx.meta.postTokenBalances || [];
        const allMints = new Set<string>();
        preTokenBals.forEach(b => allMints.add(b.mint));
        postTokenBals.forEach(b => allMints.add(b.mint));

        for (const mint of allMints) {
            // 找到属于当前监控钱包的代币变动
            const preBalObj = preTokenBals.find(b => b.mint === mint && b.owner === pubKey.toBase58());
            const postBalObj = postTokenBals.find(b => b.mint === mint && b.owner === pubKey.toBase58());
            const amountPre = preBalObj?.uiTokenAmount.uiAmount || 0;
            const amountPost = postBalObj?.uiTokenAmount.uiAmount || 0;
            const diff = amountPost - amountPre;

            if (Math.abs(diff) > 0) {
                if (mint === WSOL_MINT) {
                    wSolDiff += diff; // 记录 WSOL 变动
                } else {
                    // 假设变动最大的代币是目标代币 (过滤掉中间路由代币)
                    if (Math.abs(diff) > Math.abs(targetChange)) {
                        targetMint = mint;
                        targetChange = diff;
                    }
                }
            }
        }

        const totalSolFlow = nativeDiff + wSolDiff;

        // 6. 判定交易类型
        if (targetMint) {
            // 启发式判断：如果不是明确的 Swap 程序，且 SOL 变动极小，可能是 Dev 空投/分发
            let isRealSwap = isSwapProgram;
            if (!isRealSwap && Math.abs(nativeDiff) > 0.05) {
                isRealSwap = true; // 如果 SOL 变动大，也强制认为是 Swap
            }

            if (isRealSwap) {
                // 真正的买卖
                const [tokenData, rugData] = await Promise.all([
                    fetchTokenMarketData(targetMint),
                    fetchRugCheckData(targetMint)
                ]);
                return {
                    signature: sig,
                    tokenMint: targetMint,
                    tokenData: tokenData,
                    rugData: rugData,
                    tokenChange: targetChange,
                    solChange: totalSolFlow,
                    isBuy: targetChange > 0,
                    type: 'SWAP'
                };
            } else {
                // Dev 分发 / 空投 / 纯转账
                return {
                    signature: sig,
                    tokenMint: targetMint, 
                    tokenData: null,
                    rugData: null,
                    tokenChange: targetChange,
                    solChange: nativeDiff,
                    isBuy: false,
                    type: 'TRANSFER' // 标记为 Transfer，后续会被过滤
                };
            }
        }

        // 判断是否是 Wrap/Unwrap SOL
        if (Math.abs(nativeDiff) > 0.001 && Math.abs(wSolDiff) > 0.001 && Math.abs(totalSolFlow) < 0.01) {
            return {
                signature: sig,
                tokenMint: 'WSOL',
                tokenData: null,
                rugData: null,
                tokenChange: wSolDiff,
                solChange: nativeDiff,
                isBuy: wSolDiff > 0,
                type: 'WRAP'
            };
        }

        // 纯 SOL 转账
        return {
            signature: sig,
            tokenMint: 'SOL',
            tokenData: null,
            rugData: null,
            tokenChange: totalSolFlow,
            solChange: totalSolFlow,
            isBuy: totalSolFlow > 0,
            type: 'TRANSFER'
        };

    } catch (e: any) {
        return null;
    }
}

// ==================== 6. 主循环与调度系统 ====================

const balanceCache = new Map<string, number>();

// 数组分块函数
function chunkArray<T>(array: T[], size: number): T[][] {
    const res: T[][] = [];
    for (let i = 0; i < array.length; i += size) res.push(array.slice(i, i + size));
    return res;
}
function lamportsToSol(l: number) { return l / 1e9; }
function formatTime() { return new Date().toLocaleTimeString('zh-CN', { hour12: false }); }

async function startPolling(connection: Connection) {
    let dynamicInterval = 1000; 
    const CHUNK_SIZE = 50; // 每次请求 50 个账户的余额 (RPC 限制)
    
    console.log('[初始化] 建立余额基准...');
    let currentWallets = GLOBAL_WALLETS;
    const chunks = chunkArray(currentWallets, CHUNK_SIZE);
    
    // 初始化缓存
    for (const chunk of chunks) {
        try {
            const infos = await connection.getMultipleAccountsInfo(chunk.map(w => w.publicKey));
            infos.forEach((info, i) => {
                balanceCache.set(chunk[i].address, info ? info.lamports : 0);
            });
            await sleep(200);
        } catch (e) {}
    }

    console.log(`[初始化] 完成，开始智能监控 (并发: ${MAX_CONCURRENT_TASKS})...\n`);

    while (true) {
        currentWallets = GLOBAL_WALLETS;
        const dynamicChunks = chunkArray(currentWallets, CHUNK_SIZE);

        for (const chunk of dynamicChunks) {
            try {
                // 1. 批量查询余额
                const infos = await connection.getMultipleAccountsInfo(chunk.map(w => w.publicKey));
                
                // 动态调整间隔：如果网络顺畅，慢慢减少等待时间，加快速度
                if (dynamicInterval > 1000) dynamicInterval -= 100;

                const updates = [];
                for (let i = 0; i < infos.length; i++) {
                    const info = infos[i];
                    const wallet = chunk[i];
                    const cur = info ? info.lamports : 0;
                    const old = balanceCache.get(wallet.address) ?? 0;

                    // 2. 检测余额变动
                    if (cur !== old) {
                        const diffSol = lamportsToSol(cur - old);
                        // 过滤掉极微小的租金变动
                        if (Math.abs(diffSol) > 0.000000001) { 
                            balanceCache.set(wallet.address, cur); 
                            updates.push({ wallet, cur, diffSol });
                        } else {
                            balanceCache.set(wallet.address, cur);
                        }
                    }
                }

                // 3. 处理变动 (流控队列)
                if (updates.length > 0) {
                    console.log(`[系统] 检测到 ${updates.length} 个变动，处理中...`);
                    
                    // 将任务切分为小批次，防止瞬间请求过多导致 429
                    const updateBatches = chunkArray(updates, MAX_CONCURRENT_TASKS);

                    for (const batch of updateBatches) {
                        // 并发处理这一批
                        await Promise.all(batch.map(async (update) => {
                            const { wallet, diffSol } = update;
                            // 解析交易
                            const details = await fetchLastTransactionDetails(connection, wallet.publicKey);
                            const time = formatTime();
                            const nameDisplay = `${wallet.emoji} ${wallet.name}`;
                            
                            if (details) {
                                // === 逻辑分支 A: 转账 / 空投 / 分发 ===
                                if (details.type === 'TRANSFER') {
                                    // 过滤掉代币空投 (tokenMint 不是 SOL)
                                    if (details.tokenMint !== 'SOL') return;
                                    // 过滤掉小额噪音
                                    if (Math.abs(details.solChange) < MIN_SOL_THRESHOLD) return;
                                    
                                    // 推送大额 SOL 转账
                                    if (Math.abs(details.solChange) > 0.001) {
                                        const action = details.solChange > 0 ? "💰 纯SOL转入" : "💸 纯SOL转出";
                                        console.log(`[${time}] ${action} | ${nameDisplay} | ${details.solChange.toFixed(4)} SOL`);
                                        const tgMsg = `<b>${action}</b> | ${nameDisplay}\n<code>${wallet.address}</code>\n💎 ${details.solChange.toFixed(2)} SOL\n🔗 <a href="https://solscan.io/tx/${details.signature}">Solscan</a>`;
                                        await sendTgMessage(tgMsg);
                                    }

                                } else if (details.type !== 'WRAP') {
                                    // === 逻辑分支 B: 真实的 SWAP 交易 ===
                                    const action = details.isBuy ? "🟢 买入" : "🔴 卖出";
                                    const symbol = details.tokenData?.symbol || details.tokenMint.slice(0,4);
                                    const tokenChange = `${details.tokenChange > 0 ? '+' : ''}${details.tokenChange.toFixed(2)}`;
                                    const solInfo = `${Math.abs(details.solChange).toFixed(4)} SOL`;
                                    // 价格已修复
                                    const priceStr = details.tokenData ? formatPrice(details.tokenData.priceUsd) : 'N/A';
                                    const mc = details.tokenData ? formatNumber(details.tokenData.fdv) : 'N/A';
                                    
                                    let rugEmoji = '⏳';
                                    let rugText = '检测中';
                                    if (details.rugData) {
                                        if (details.rugData.isNew) { rugEmoji = '🆕'; rugText = '新盘'; }
                                        else {
                                            const s = details.rugData.score;
                                            if (s < 500) { rugEmoji = '✅'; rugText = `安全(${s})`; }
                                            else if (s < 1500) { rugEmoji = '⚠️'; rugText = `警告(${s})`; }
                                            else { rugEmoji = '☠️'; rugText = `危险(${s})`; }
                                        }
                                    }

                                    console.log(`[${time}] ${action} | ${nameDisplay} | ${symbol}`);

                                    // 生成链接
                                    const gmgnLink = `https://gmgn.ai/sol/token/${details.tokenMint}?ref=${REF_CONFIG.gmgn}`;
                                    const axiomLink = `https://axiom.trade/trade/${details.tokenMint}?invite=${REF_CONFIG.axiom}`;
                                    const rugLink = `https://rugcheck.xyz/tokens/${details.tokenMint}`;

                                    const tgMsg = `
${action === "🟢 买入" ? "🟢 <b>Smart Money Buy!</b>" : "🔴 <b>Smart Money Sell!</b>"}
👻 <b>Wallet:</b> ${nameDisplay}
<code>${wallet.address}</code>

💊 <b>Token:</b> ${symbol}
📊 <b>Amt:</b> ${tokenChange}
💰 <b>Cost:</b> ${solInfo}
💲 <b>Price:</b> ${priceStr} | <b>MC:</b> ${mc}
🛡️ <b>Risk:</b> ${rugEmoji} ${rugText}

🎯 <b>CA:</b> <code>${details.tokenMint}</code>

🛠️ <b>Quick Links:</b>
<a href="${gmgnLink}">GMGN</a> | <a href="${axiomLink}">Axiom</a> | <a href="${rugLink}">RugCheck</a>
`;
                                    await sendTgMessage(tgMsg);
                                }
                            }
                        }));
                        // 批次间隔，给 RPC 喘息时间
                        await sleep(200); 
                    }
                }
            } catch (e: any) {
                // 如果遇到 429，立即大幅降速
                if (e.message?.includes('429')) {
                    dynamicInterval += 1000; 
                    if (dynamicInterval > 10000) dynamicInterval = 10000;
                    process.stdout.write(`(429触发, 降速) `);
                }
            }
            await sleep(100); 
        }
        process.stdout.write('.'); 
        await sleep(dynamicInterval);
    }
}

async function main() {
    try {
        GLOBAL_WALLETS = loadWalletConfigs();
        startConfigWatcher();
        const connection = new Connection(CUSTOM_RPC_URL, { 
            commitment: 'confirmed', 
            fetch: customFetch as any // 全局使用代理 Fetch
        });
        
        console.log('========================================');
        console.log('   Solana 巨鲸监控 (V28 Final Archived)');
        console.log('========================================');
        
        startPolling(connection).catch(console.error);
    } catch (e) {
        console.error('启动失败:', e);
    }
}

main();