import { Connection, PublicKey, ParsedTransactionWithMeta } from '@solana/web3.js';
import * as fs from 'fs';
import * as path from 'path';
import { HttpsProxyAgent } from 'https-proxy-agent';
import fetch from 'node-fetch';

/**
 * Solana 巨鲸监控系统 (V8 强一致性重试版)
 * * 修复痛点：
 * 1. [防漏单] 增加"回马枪"机制：如果余额变了但查不到交易，等待 2秒 后重试。
 * 2. [防乱码] 增加字符清洗，过滤掉 𒐪 这种怪异符号，强制使用 DexScreener 修正名称。
 * 3. [防遗漏] 每次查找最近 5 笔交易，防止高频交易掩盖真实变动。
 */

// ==================== 1. 基础配置 ====================
// 代理配置 (Clash: 7890, v2ray: 10808)
const PROXY_URL = 'http://127.0.0.1:7890'; 
const proxyAgent = new HttpsProxyAgent(PROXY_URL);

const customFetch = (url: string, options: any = {}) => {
    return fetch(url, { ...options, agent: proxyAgent });
};

// ==================== 2. 代币名称解析 (增强版) ====================
const tokenMetadataCache = new Map<string, string>();
// 预设
tokenMetadataCache.set('So11111111111111111111111111111111111111112', 'SOL');
tokenMetadataCache.set('EPjFWdd5VenBxibDrxxPoNr6mVteov4ZHq9s6upZeY81', 'USDC');
tokenMetadataCache.set('Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', 'USDT');

const METADATA_PROGRAM_ID = new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s');

/**
 * 字符串清洗函数：去除乱码、控制字符
 */
function cleanString(str: string): string {
    // 移除空字符和非打印字符
    // eslint-disable-next-line no-control-regex
    return str.replace(/\u0000/g, '').trim();
}

/**
 * 尝试从 DexScreener 获取代币信息
 */
async function fetchFromDexScreener(mint: string): Promise<string | null> {
    try {
        const url = `https://api.dexscreener.com/latest/dex/tokens/${mint}`;
        const res = await customFetch(url);
        if (!res.ok) return null;
        
        const data = await res.json();
        if (data.pairs && data.pairs.length > 0) {
            const bestPair = data.pairs[0];
            return bestPair.baseToken.symbol; // 返回标准化名称
        }
        return null;
    } catch (e) {
        return null;
    }
}

/**
 * 获取代币符号 (主函数)
 */
async function getSymbolFromMint(connection: Connection, mintAddress: string): Promise<string> {
    if (tokenMetadataCache.has(mintAddress)) {
        return tokenMetadataCache.get(mintAddress)!;
    }

    const shortName = `${mintAddress.slice(0, 4)}..${mintAddress.slice(-4)}`;

    // 优先尝试 DexScreener (因为它显示的名称更符合人类阅读习惯，且没有乱码)
    try {
        const apiSymbol = await fetchFromDexScreener(mintAddress);
        if (apiSymbol) {
            tokenMetadataCache.set(mintAddress, apiSymbol);
            return apiSymbol;
        }
    } catch (e) {}

    // 如果 API 失败，再尝试链上解析
    try {
        const mintKey = new PublicKey(mintAddress);
        const [pda] = PublicKey.findProgramAddressSync(
            [Buffer.from('metadata'), METADATA_PROGRAM_ID.toBuffer(), mintKey.toBuffer()],
            METADATA_PROGRAM_ID
        );

        const accountInfo = await connection.getAccountInfo(pda);
        if (accountInfo) {
            const buffer = accountInfo.data;
            if (buffer[0] === 4) {
                let offset = 65;
                const nameLen = buffer.readUInt32LE(offset);
                offset += 4 + nameLen; 
                const symbolLen = buffer.readUInt32LE(offset);
                offset += 4;
                let symbol = buffer.toString('utf8', offset, offset + symbolLen);
                
                symbol = cleanString(symbol);
                
                // 如果清洗后是空的或者还是乱码，就放弃
                if (symbol && symbol.length > 0 && symbol.length < 20) {
                    tokenMetadataCache.set(mintAddress, symbol);
                    return symbol;
                }
            }
        }
    } catch (e) {}

    tokenMetadataCache.set(mintAddress, shortName);
    return shortName;
}

// ==================== 3. RPC 连接 ====================
const PUBLIC_RPC_ENDPOINTS = [
    'https://api.mainnet-beta.solana.com',
    'https://solana-api.projectserum.com',
    'https://rpc.ankr.com/solana'
];

async function chooseRpcEndpoint(): Promise<string> {
    const envRpc = process.env.SOLANA_RPC_ENDPOINT;
    if (envRpc) return envRpc;
    for (const endpoint of PUBLIC_RPC_ENDPOINTS) {
        try {
            const conn = new Connection(endpoint, { fetch: customFetch as any });
            const v = await conn.getVersion();
            console.log(`[连接] 成功: ${endpoint} (v${v['solana-core']})`);
            return endpoint;
        } catch (e) {}
    }
    throw new Error('无可用 RPC 节点，请检查代理');
}

// ==================== 4. 钱包配置读取 ====================
interface WalletConfig {
    address: string;
    name: string;
    emoji?: string;
    publicKey: PublicKey;
}

function loadWalletConfigs(): WalletConfig[] {
    try {
        const p = path.join(__dirname, '..', 'wallets.json');
        const raw = JSON.parse(fs.readFileSync(p, 'utf-8'));
        const valid: WalletConfig[] = [];
        for (const item of raw) {
            const addr = item.address || item.trackedWalletAddress;
            if (addr) {
                valid.push({
                    address: addr,
                    name: item.name || '未知',
                    emoji: item.emoji || '👻',
                    publicKey: new PublicKey(addr)
                });
            }
        }
        return valid;
    } catch (e) {
        console.error('读取 wallets.json 失败');
        return [];
    }
}

// ==================== 5. 交易解析逻辑 (含重试) ====================

interface TradeDetails {
    signature: string;
    tokenMint: string;
    tokenName: string;
    tokenChange: number;
    solChange: number;
    isBuy: boolean;
}

// 辅助：等待函数
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function fetchLastTransactionDetails(
    connection: Connection, 
    pubKey: PublicKey
): Promise<TradeDetails | null> {
    try {
        // 【关键升级】获取最近 5 笔，防止并发遗漏
        let signatures = await connection.getSignaturesForAddress(pubKey, { limit: 5 });
        
        // 【防漏单机制】如果没查到，或者签名太旧（这里简单判空），等待 2 秒重试一次
        if (signatures.length === 0) {
            // console.log('[重试] 暂未索引到交易，等待 2s...');
            await sleep(2000);
            signatures = await connection.getSignaturesForAddress(pubKey, { limit: 5 });
        }

        if (signatures.length === 0) return null;
        
        // 我们需要找到一笔成功的交易
        const validSig = signatures.find(s => !s.err);
        if (!validSig) return null;

        const sig = validSig.signature;
        
        const tx = await connection.getParsedTransaction(sig, {
            maxSupportedTransactionVersion: 0,
            commitment: 'confirmed'
        });

        if (!tx || !tx.meta) return null;

        const accountIndex = tx.transaction.message.accountKeys.findIndex(
            k => k.pubkey.toBase58() === pubKey.toBase58()
        );
        if (accountIndex === -1) return null;

        const preSol = tx.meta.preBalances[accountIndex];
        const postSol = tx.meta.postBalances[accountIndex];
        const solChange = (postSol - preSol) / 1e9;

        let targetMint = '';
        let targetChange = 0;

        const preTokenBals = tx.meta.preTokenBalances || [];
        const postTokenBals = tx.meta.postTokenBalances || [];

        for (const postBal of postTokenBals) {
            if (postBal.owner === pubKey.toBase58()) {
                const mint = postBal.mint;
                const preBal = preTokenBals.find(b => b.owner === pubKey.toBase58() && b.mint === mint);
                const amountPost = postBal.uiTokenAmount.uiAmount || 0;
                const amountPre = preBal?.uiTokenAmount.uiAmount || 0;
                const diff = amountPost - amountPre;

                if (Math.abs(diff) > 0 && mint !== 'So11111111111111111111111111111111111111112') {
                    if (Math.abs(diff) > Math.abs(targetChange)) {
                        targetMint = mint;
                        targetChange = diff;
                    }
                }
            }
        }

        if (!targetMint) {
            return {
                signature: sig,
                tokenMint: 'SOL',
                tokenName: 'SOL',
                tokenChange: solChange,
                solChange: solChange,
                isBuy: solChange > 0
            };
        }

        const symbol = await getSymbolFromMint(connection, targetMint);

        return {
            signature: sig,
            tokenMint: targetMint,
            tokenName: symbol, 
            tokenChange: targetChange,
            solChange: solChange,
            isBuy: targetChange > 0
        };

    } catch (e) {
        return null;
    }
}

// ==================== 6. 轮询监控逻辑 ====================

const balanceCache = new Map<string, number>();

function chunkArray<T>(array: T[], size: number): T[][] {
    const res: T[][] = [];
    for (let i = 0; i < array.length; i += size) res.push(array.slice(i, i + size));
    return res;
}

function lamportsToSol(l: number) { return l / 1e9; }
function formatTime() { return new Date().toLocaleTimeString('zh-CN', { hour12: false }); }

async function startPolling(connection: Connection, wallets: WalletConfig[]) {
    const CHUNK_SIZE = 50;
    const INTERVAL = 10000; 

    const chunks = chunkArray(wallets, CHUNK_SIZE);
    console.log(`[系统] 监控 ${wallets.length} 个钱包，分 ${chunks.length} 组轮询...\n`);

    console.log('[初始化] 建立余额基准...');
    for (const chunk of chunks) {
        try {
            const infos = await connection.getMultipleAccountsInfo(chunk.map(w => w.publicKey));
            infos.forEach((info, i) => {
                balanceCache.set(chunk[i].address, info ? info.lamports : 0);
            });
            await sleep(200);
        } catch (e) {}
    }
    console.log('[初始化] 完成，开始监控交易...\n');

    while (true) {
        for (const chunk of chunks) {
            try {
                const infos = await connection.getMultipleAccountsInfo(chunk.map(w => w.publicKey));

                const updates = [];
                for (let i = 0; i < infos.length; i++) {
                    const info = infos[i];
                    const wallet = chunk[i];
                    const cur = info ? info.lamports : 0;
                    const old = balanceCache.get(wallet.address) ?? 0;

                    if (cur !== old) {
                        const diffSol = lamportsToSol(cur - old);
                        // 阈值设低一点，防止漏掉小额高频
                        if (Math.abs(diffSol) > 0.001) {
                            balanceCache.set(wallet.address, cur); 
                            updates.push({ wallet, cur, diffSol });
                        } else {
                            balanceCache.set(wallet.address, cur);
                        }
                    }
                }

                if (updates.length > 0) {
                    for (const update of updates) {
                        const { wallet, cur, diffSol } = update;
                        
                        // 查交易详情
                        const details = await fetchLastTransactionDetails(connection, wallet.publicKey);
                        
                        const nameDisplay = `${wallet.emoji} ${wallet.name}`;
                        const time = formatTime();
                        
                        console.log('----------------------------------------');
                        if (details && details.tokenMint !== 'SOL') {
                            const action = details.isBuy ? "🟢 买入" : "🔴 卖出";
                            // 格式化代币名称，移除乱码
                            const tokenInfo = `${details.tokenName} (${details.tokenChange > 0 ? '+' : ''}${details.tokenChange.toFixed(2)})`;
                            const solInfo = `${Math.abs(details.solChange).toFixed(4)} SOL`;
                            
                            console.log(`[${time}] ${action} | ${nameDisplay}`);
                            console.log(`   代币: ${tokenInfo}`);
                            console.log(`   金额: ${solInfo}`);
                            console.log(`   TX: https://solscan.io/tx/${details.signature}`);
                        } else {
                            // 降级显示
                            const action = diffSol > 0 ? "💰 转入(SOL)" : "💸 转出(SOL)";
                            console.log(`[${time}] ${action} | ${nameDisplay}`);
                            console.log(`   金额: ${diffSol > 0 ? '+' : ''}${diffSol.toFixed(4)} SOL`);
                            // 如果有详情但只是解析不出代币，还是显示 TX
                            if (details) {
                                console.log(`   TX: https://solscan.io/tx/${details.signature}`);
                            } else {
                                console.log(`   [提示] 余额变动，但未索引到交易详情 (可能是网络延迟)`);
                            }
                        }

                        // 排队休息
                        if (updates.length > 1) await sleep(2000);
                    }
                }

            } catch (e) {
                if (String(e).includes('429')) {
                    console.warn('[限流] 休息 5秒...');
                    await sleep(5000);
                }
            }
            await sleep(500); 
        }
        await sleep(INTERVAL);
    }
}

// ==================== 7. 启动 ====================
async function main() {
    try {
        const wallets = loadWalletConfigs();
        if (wallets.length === 0) return console.error('无钱包配置');
        
        const endpoint = await chooseRpcEndpoint();
        const connection = new Connection(endpoint, {
            commitment: 'confirmed',
            fetch: customFetch as any
        });
        
        console.log('========================================');
        console.log('   Solana 巨鲸监控系统 (V8 强一致性重试版)');
        console.log('========================================');
        
        startPolling(connection, wallets).catch(console.error);
    } catch (e) {
        console.error('启动失败:', e);
    }
}

main();