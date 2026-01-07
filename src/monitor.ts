import { Connection, PublicKey, ParsedTransactionWithMeta } from '@solana/web3.js';
import * as fs from 'fs';
import * as path from 'path';
import { HttpsProxyAgent } from 'https-proxy-agent';
import fetch from 'node-fetch';

/**
 * Solana 巨鲸监控系统 (V13 Helius 1秒极速版)
 * * 配置说明：
 * 1. 已开启 1秒 极速轮询。
 * 2. 内置死磕重试机制，防止因轮询太快导致交易详情还没索引到的问题。
 */

// ==================== 1. 基础配置 (请修改这里) ====================

// 👇👇👇 在这里填入您的 Helius 免费 Key 👇👇👇
const CUSTOM_RPC_URL = 'https://mainnet.helius-rpc.com/?api-key=497e9af6-ea13-4430-877e-3c71cd2ebd94'; 

// 代理配置 (Clash: 7890)
const PROXY_URL = 'http://127.0.0.1:7890'; 
const proxyAgent = new HttpsProxyAgent(PROXY_URL);

const customFetch = (url: string, options: any = {}) => {
    return fetch(url, { ...options, agent: proxyAgent });
};

// ==================== 2. 代币名称解析 ====================
const tokenMetadataCache = new Map<string, string>();
const WSOL_MINT = 'So11111111111111111111111111111111111111112';
tokenMetadataCache.set(WSOL_MINT, 'SOL');
tokenMetadataCache.set('EPjFWdd5VenBxibDrxxPoNr6mVteov4ZHq9s6upZeY81', 'USDC');
tokenMetadataCache.set('Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', 'USDT');

const METADATA_PROGRAM_ID = new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s');

function isStandardTicker(str: string): boolean {
    return /^[A-Za-z0-9$ ]+$/.test(str);
}

async function fetchFromDexScreener(mint: string): Promise<string | null> {
    try {
        const url = `https://api.dexscreener.com/latest/dex/tokens/${mint}`;
        const res = await customFetch(url);
        if (!res.ok) return null;
        const data = await res.json();
        if (data.pairs && data.pairs.length > 0) return data.pairs[0].baseToken.symbol;
        return null;
    } catch (e) { return null; }
}

async function getSymbolFromMint(connection: Connection, mintAddress: string): Promise<string> {
    if (tokenMetadataCache.has(mintAddress)) return tokenMetadataCache.get(mintAddress)!;
    const shortName = `${mintAddress.slice(0, 4)}..${mintAddress.slice(-4)}`;
    
    try {
        const apiSymbol = await fetchFromDexScreener(mintAddress);
        if (apiSymbol) {
            tokenMetadataCache.set(mintAddress, apiSymbol);
            return apiSymbol;
        }
    } catch (e) {}

    try {
        const mintKey = new PublicKey(mintAddress);
        const [pda] = PublicKey.findProgramAddressSync(
            [Buffer.from('metadata'), METADATA_PROGRAM_ID.toBuffer(), mintKey.toBuffer()],
            METADATA_PROGRAM_ID
        );
        const accountInfo = await connection.getAccountInfo(pda);
        if (accountInfo && accountInfo.data[0] === 4) {
            let offset = 65;
            const nameLen = accountInfo.data.readUInt32LE(offset);
            offset += 4 + nameLen; 
            const symbolLen = accountInfo.data.readUInt32LE(offset);
            offset += 4;
            let symbol = accountInfo.data.toString('utf8', offset, offset + symbolLen).replace(/\u0000/g, '').trim();
            if (symbol && isStandardTicker(symbol)) {
                tokenMetadataCache.set(mintAddress, symbol);
                return symbol;
            }
        }
    } catch (e) {}

    tokenMetadataCache.set(mintAddress, shortName);
    return shortName;
}

// ==================== 3. RPC 连接 ====================
async function chooseRpcEndpoint(): Promise<string> {
    if (CUSTOM_RPC_URL && CUSTOM_RPC_URL.length > 20) {
        return CUSTOM_RPC_URL;
    }
    // 没填 Key 时的保底逻辑
    console.warn("⚠️ 未检测到 Helius Key，正在使用公共节点 (可能会被封)...");
    return 'https://api.mainnet-beta.solana.com';
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

// ==================== 5. 交易解析逻辑 (V13) ====================

interface TradeDetails {
    signature: string;
    tokenMint: string;
    tokenName: string;
    tokenChange: number;
    solChange: number; 
    isBuy: boolean;
    type: 'SWAP' | 'TRANSFER' | 'WRAP';
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function fetchLastTransactionDetails(
    connection: Connection, 
    pubKey: PublicKey
): Promise<TradeDetails | null> {
    let signatures: any[] = [];
    let attempts = 0;
    const maxRetries = 5;

    // 阶段1: 死磕获取签名 (因为1秒轮询太快，交易可能还没落地)
    while (attempts < maxRetries) {
        try {
            signatures = await connection.getSignaturesForAddress(pubKey, { limit: 3 });
            if (signatures.length > 0 && !signatures[0].err) break;
        } catch (e) {}
        attempts++;
        if (attempts < maxRetries) await sleep(1000 + (attempts * 500)); // 渐进式等待
    }

    if (signatures.length === 0) return null;
    const sig = signatures[0].signature;

    // 阶段2: 获取详情
    try {
        const tx = await connection.getParsedTransaction(sig, {
            maxSupportedTransactionVersion: 0,
            commitment: 'confirmed'
        });

        if (!tx || !tx.meta) return null;

        const logMessages = tx.meta.logMessages || [];
        const isSwapProgram = logMessages.some(log => 
            log.includes('Program JUP') || 
            log.includes('Program 675kPX9M') || 
            log.includes('Program 6EF8rrect') || 
            log.includes('Instruction: Swap')
        );

        const accountIndex = tx.transaction.message.accountKeys.findIndex(
            k => k.pubkey.toBase58() === pubKey.toBase58()
        );
        if (accountIndex === -1) return null;
        const preNative = tx.meta.preBalances[accountIndex];
        const postNative = tx.meta.postBalances[accountIndex];
        const nativeDiff = (postNative - preNative) / 1e9;

        let targetMint = '';
        let targetChange = 0;
        let wSolDiff = 0;

        const preTokenBals = tx.meta.preTokenBalances || [];
        const postTokenBals = tx.meta.postTokenBalances || [];
        const allMints = new Set<string>();
        preTokenBals.forEach(b => allMints.add(b.mint));
        postTokenBals.forEach(b => allMints.add(b.mint));

        for (const mint of allMints) {
            const preBalObj = preTokenBals.find(b => b.mint === mint && b.owner === pubKey.toBase58());
            const postBalObj = postTokenBals.find(b => b.mint === mint && b.owner === pubKey.toBase58());
            const amountPre = preBalObj?.uiTokenAmount.uiAmount || 0;
            const amountPost = postBalObj?.uiTokenAmount.uiAmount || 0;
            const diff = amountPost - amountPre;

            if (Math.abs(diff) > 0) {
                if (mint === WSOL_MINT) {
                    wSolDiff += diff;
                } else {
                    if (Math.abs(diff) > Math.abs(targetChange)) {
                        targetMint = mint;
                        targetChange = diff;
                    }
                }
            }
        }

        const totalSolFlow = nativeDiff + wSolDiff;

        if (targetMint) {
            const symbol = await getSymbolFromMint(connection, targetMint);
            return {
                signature: sig,
                tokenMint: targetMint,
                tokenName: symbol,
                tokenChange: targetChange,
                solChange: totalSolFlow,
                isBuy: targetChange > 0,
                type: 'SWAP'
            };
        }

        if (isSwapProgram) {
             return {
                signature: sig,
                tokenMint: 'UNKNOWN',
                tokenName: '未知代币',
                tokenChange: 0,
                solChange: totalSolFlow,
                isBuy: totalSolFlow < 0,
                type: 'SWAP'
            };
        }

        if (Math.abs(nativeDiff) > 0.001 && Math.abs(wSolDiff) > 0.001 && Math.abs(totalSolFlow) < 0.01) {
            return {
                signature: sig,
                tokenMint: 'WSOL',
                tokenName: 'wSOL',
                tokenChange: wSolDiff,
                solChange: nativeDiff,
                isBuy: wSolDiff > 0,
                type: 'WRAP'
            };
        }

        return {
            signature: sig,
            tokenMint: 'SOL',
            tokenName: 'SOL',
            tokenChange: totalSolFlow,
            solChange: totalSolFlow,
            isBuy: totalSolFlow > 0,
            type: 'TRANSFER'
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
    
    // 👇👇👇 这里的 1000 就是 1秒 轮询 👇👇👇
    const INTERVAL = 1000; 

    const chunks = chunkArray(wallets, CHUNK_SIZE);
    console.log(`[系统] 监控 ${wallets.length} 个钱包，分 ${chunks.length} 组轮询...`);
    console.log(`[极速模式] 轮询间隔: ${INTERVAL}ms (注意流量消耗)`);

    console.log('[初始化] 建立余额基准...');
    for (const chunk of chunks) {
        try {
            const infos = await connection.getMultipleAccountsInfo(chunk.map(w => w.publicKey));
            infos.forEach((info, i) => {
                balanceCache.set(chunk[i].address, info ? info.lamports : 0);
            });
            await sleep(100);
        } catch (e) {}
    }
    console.log('[初始化] 完成，开始极速监控...\n');

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
                        // 1秒轮询时，微小变动可能是 Gas 费或 wSOL，必须查
                        if (Math.abs(diffSol) > 0.000001) { 
                            balanceCache.set(wallet.address, cur); 
                            updates.push({ wallet, cur, diffSol });
                        } else {
                            balanceCache.set(wallet.address, cur);
                        }
                    }
                }

                if (updates.length > 0) {
                    // 并行查详情 (因为是 Helius，可以稍微奔放一点，不用像公共节点那样死排队)
                    // 但为了保险，还是保留 await Promise.all
                    const tasks = updates.map(async (update) => {
                        const { wallet, cur, diffSol } = update;
                        const details = await fetchLastTransactionDetails(connection, wallet.publicKey);
                        const nameDisplay = `${wallet.emoji} ${wallet.name}`;
                        const time = formatTime();
                        
                        if (details) {
                            if (details.type === 'TRANSFER') {
                                if (Math.abs(details.solChange) > 0.001) {
                                    const action = details.solChange > 0 ? "💰 纯SOL转入" : "💸 纯SOL转出";
                                    console.log('----------------------------------------');
                                    console.log(`[${time}] ${action} | ${nameDisplay}`);
                                    console.log(`   金额: ${details.solChange > 0 ? '+' : ''}${details.solChange.toFixed(4)} SOL`);
                                    console.log(`   TX: https://solscan.io/tx/${details.signature}`);
                                }
                            } else if (details.type !== 'WRAP') {
                                // SWAP
                                const action = details.isBuy ? "🟢 买入" : "🔴 卖出";
                                const tokenInfo = `${details.tokenName} (${details.tokenChange > 0 ? '+' : ''}${details.tokenChange.toFixed(2)})`;
                                const solInfo = `${Math.abs(details.solChange).toFixed(4)} SOL`;
                                
                                console.log('----------------------------------------');
                                console.log(`[${time}] ${action} | ${nameDisplay}`);
                                console.log(`   代币: ${tokenInfo}`);
                                console.log(`   CA: ${details.tokenMint}`);
                                console.log(`   金额: ${solInfo}`);
                                console.log(`   TX: https://solscan.io/tx/${details.signature}`);
                            }
                        } else {
                            // 兜底
                            if (Math.abs(diffSol) > 0.01) {
                                const action = diffSol > 0 ? "💰 余额增加" : "💸 余额减少";
                                console.log('----------------------------------------');
                                console.log(`[${time}] ${action} | ${nameDisplay}`);
                                console.log(`   金额: ${diffSol > 0 ? '+' : ''}${diffSol.toFixed(4)} SOL (延迟太高,未索引到交易)`);
                            }
                        }
                    });
                    await Promise.all(tasks);
                }
            } catch (e) {
                // Helius 很少报 429，除非欠费
                console.warn('[RPC警告]', e);
            }
            // 极速模式下，组间间隔可以很短
            await sleep(50); 
        }
        await sleep(INTERVAL);
    }
}

async function main() {
    try {
        const wallets = loadWalletConfigs();
        if (wallets.length === 0) return console.error('无钱包配置');
        
        // 验证 RPC
        const endpoint = await chooseRpcEndpoint();
        const connection = new Connection(endpoint, { commitment: 'confirmed', fetch: customFetch as any });
        
        console.log('========================================');
        console.log('   Solana 巨鲸监控系统 (V13 极速版)');
        console.log('========================================');
        
        startPolling(connection, wallets).catch(console.error);
    } catch (e) {
        console.error('启动失败:', e);
    }
}

main();