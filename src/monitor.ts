import { Connection, PublicKey } from '@solana/web3.js';

/**
 * Solana 钱包余额监控脚本
 * 
 * 功能：实时监控指定钱包地址的 SOL 余额变化
 * 技术栈：TypeScript + @solana/web3.js
 * 
 * 对于 Java 开发者：
 * - Connection 类似于 Java 的数据库连接或 HTTP 客户端连接对象
 * - PublicKey 类似于 Java 的 String，但专门用于 Solana 地址（有类型安全）
 * - onAccountChange 使用 WebSocket 长连接，类似于 Java 的 WebSocket 客户端
 */

// ==================== 配置区域 ====================

/**
 * Solana 主网 RPC 节点地址
 * 注意：这是公共节点，有速率限制。生产环境建议使用付费节点（如 QuickNode, Alchemy）
 */
const RPC_ENDPOINT = 'https://api.mainnet-beta.solana.com';

/**
 * 要监控的钱包地址列表
 * 你可以在这里添加任意多个钱包地址
 * 
 * 示例地址：HhJpBhRRn4g56VsyLuT8DL5iXVhoChVNxuy36yZ7RfVH (某知名巨鲸)
 */
const WALLET_ADDRESSES: string[] = [
    'HhJpBhRRn4g56VsyLuT8DL5iXVhoChVNxuy36yZ7RfVH'
];

// ==================== 工具函数 ====================

/**
 * 将 lamports 转换为 SOL
 * 
 * 说明：Solana 的最小单位是 lamports（类似 Java 的 BigDecimal，但这里用整数表示）
 * 1 SOL = 1,000,000,000 lamports（10^9）
 * 
 * @param lamports - lamports 数量（类似 Java 的 long 类型）
 * @returns SOL 数量（类似 Java 的 double）
 */
function lamportsToSol(lamports: number): number {
    return lamports / 1_000_000_000;
}

/**
 * 格式化时间戳为可读字符串
 * 
 * @param timestamp - Unix 时间戳（毫秒）
 * @returns 格式化的时间字符串
 */
function formatTimestamp(timestamp: number): string {
    return new Date(timestamp).toLocaleString('zh-CN', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false
    });
}

// ==================== 监控逻辑 ====================

/**
 * 监控单个钱包地址的余额变化
 * 
 * 技术说明：
 * - onAccountChange 使用 WebSocket 长连接（类似 Java 的 WebSocket 客户端）
 * - 当账户数据发生变化时，Solana 节点会主动推送更新（类似观察者模式）
 * - 这比轮询（polling）更高效，延迟更低
 * 
 * @param connection - Solana 连接对象（类似 Java 的数据库连接）
 * @param walletAddress - 钱包地址（PublicKey 类型，类似 Java 的强类型 String）
 * @returns 订阅 ID（用于后续取消订阅，类似 Java 的 Subscription 对象）
 */
async function monitorWallet(
    connection: Connection,
    walletAddress: PublicKey
): Promise<number> {
    // 获取初始余额（类似 Java 的 CompletableFuture.get()）
    // await 关键字类似于 Java 的 .get() 或 .join()，会阻塞等待异步操作完成
    let previousBalance: number | null = null;
    
    try {
        const accountInfo = await connection.getAccountInfo(walletAddress);
        if (accountInfo) {
            previousBalance = accountInfo.lamports;
            console.log(`\n[初始化] 钱包 ${walletAddress.toBase58()}`);
            console.log(`  当前余额: ${lamportsToSol(previousBalance).toFixed(9)} SOL`);
            console.log(`  开始监控...\n`);
        } else {
            console.log(`\n[警告] 钱包 ${walletAddress.toBase58()} 不存在或余额为 0\n`);
            previousBalance = 0;
        }
    } catch (error) {
        console.error(`[错误] 获取初始余额失败: ${error}`);
        return;
    }

    // 设置账户变化监听器
    // onAccountChange 返回一个订阅 ID（类似 Java 的 Subscription 对象）
    // 这个监听器会持续运行，直到程序退出或手动取消订阅
    const subscriptionId = connection.onAccountChange(
        walletAddress,
        (accountInfo, context) => {
            // 这个回调函数类似于 Java 的 Consumer<T> 或 EventListener
            // 当账户数据变化时，Solana 节点会主动调用这个回调
            
            const currentBalance = accountInfo.lamports;
            const timestamp = Date.now();

            // 计算余额变化
            if (previousBalance !== null) {
                const balanceChange = currentBalance - previousBalance;
                const balanceChangeSol = lamportsToSol(balanceChange);

                // 判断是转入还是转出
                if (balanceChange > 0) {
                    // 转入（类似 Java 的 if-else）
                    console.log(`\n[${formatTimestamp(timestamp)}] 💰 转入`);
                    console.log(`  钱包地址: ${walletAddress.toBase58()}`);
                    console.log(`  变动金额: +${balanceChangeSol.toFixed(9)} SOL`);
                    console.log(`  当前余额: ${lamportsToSol(currentBalance).toFixed(9)} SOL`);
                    console.log(`  区块高度: ${context.slot}`);
                } else if (balanceChange < 0) {
                    // 转出
                    console.log(`\n[${formatTimestamp(timestamp)}] 💸 转出`);
                    console.log(`  钱包地址: ${walletAddress.toBase58()}`);
                    console.log(`  变动金额: ${balanceChangeSol.toFixed(9)} SOL`);
                    console.log(`  当前余额: ${lamportsToSol(currentBalance).toFixed(9)} SOL`);
                    console.log(`  区块高度: ${context.slot}`);
                }
                // 如果 balanceChange === 0，说明余额没变（可能是其他账户数据变化了）
            }

            // 更新之前的余额（类似 Java 的变量赋值）
            previousBalance = currentBalance;
        },
        'confirmed' // 确认级别：'confirmed' 表示交易已确认（类似 Java 的枚举值）
    );

    console.log(`[信息] 钱包 ${walletAddress.toBase58()} 的订阅 ID: ${subscriptionId}`);
    
    // 返回订阅 ID，用于后续取消订阅
    // 注意：在 TypeScript/JavaScript 中，Promise<number> 表示异步函数返回数字
    // 类似于 Java 的 CompletableFuture<Integer>
    return subscriptionId;
}

// ==================== 主函数 ====================

/**
 * 程序入口点（类似 Java 的 main 方法）
 * 
 * async function 表示这是一个异步函数（类似 Java 的 CompletableFuture）
 * 在 TypeScript 中，async 函数总是返回 Promise
 */
async function main(): Promise<void> {
    console.log('========================================');
    console.log('   Solana 钱包余额监控系统');
    console.log('========================================\n');

    // 创建 Solana 连接对象
    // 类似于 Java 中创建数据库连接或 HTTP 客户端
    // Connection 内部会建立 WebSocket 连接用于实时监听
    const connection = new Connection(RPC_ENDPOINT, 'confirmed');

    // 验证连接（类似 Java 的连接测试）
    try {
        const version = await connection.getVersion();
        console.log(`[连接成功] Solana 节点版本: ${version['solana-core']}\n`);
    } catch (error) {
        console.error(`[连接失败] 无法连接到 Solana 节点: ${error}`);
        console.error('请检查网络连接或 RPC 节点地址');
        process.exit(1); // 退出程序（类似 Java 的 System.exit(1)）
    }

    // 验证钱包地址并转换为 PublicKey 对象
    // PublicKey 是强类型，类似于 Java 的包装类，提供类型安全
    const walletPublicKeys: PublicKey[] = [];
    
    for (const address of WALLET_ADDRESSES) {
        try {
            // PublicKey 构造函数会验证地址格式（类似 Java 的输入验证）
            const publicKey = new PublicKey(address);
            walletPublicKeys.push(publicKey);
        } catch (error) {
            console.error(`[错误] 无效的钱包地址: ${address}`);
            console.error(`  错误信息: ${error}`);
        }
    }

    if (walletPublicKeys.length === 0) {
        console.error('[错误] 没有有效的钱包地址可监控');
        process.exit(1);
    }

    console.log(`[信息] 准备监控 ${walletPublicKeys.length} 个钱包地址\n`);

    // 为每个钱包启动监控（类似 Java 的并行处理）
    // Promise.all 类似于 Java 的 CompletableFuture.allOf()
    // 等待所有监控任务启动并获取订阅 ID
    const subscriptionIds = await Promise.all(
        walletPublicKeys.map(wallet => monitorWallet(connection, wallet))
    );

    console.log('\n[信息] 所有监控任务已启动');
    console.log('[信息] 按 Ctrl+C 退出程序\n');

    // 处理程序退出信号（类似 Java 的 ShutdownHook）
    // 在程序退出时，取消所有订阅以释放资源
    process.on('SIGINT', () => {
        console.log('\n\n[信息] 正在关闭监控...');
        
        // 取消所有订阅（类似 Java 的关闭资源）
        subscriptionIds.forEach((subscriptionId, index) => {
            try {
                connection.removeAccountChangeListener(subscriptionId);
                console.log(`[信息] 已取消钱包 ${walletPublicKeys[index].toBase58()} 的订阅`);
            } catch (error) {
                console.error(`[警告] 取消订阅失败: ${error}`);
            }
        });
        
        console.log('[信息] 监控已关闭');
        process.exit(0);
    });
}

// ==================== 启动程序 ====================

// 执行主函数并处理错误
// .catch() 类似于 Java 的 try-catch，用于捕获 Promise 的异常
main().catch((error) => {
    console.error('[致命错误] 程序异常退出:', error);
    process.exit(1);
});

