#!/usr/bin/env python3
"""
将原始钱包配置 JSON 转换为简化格式
使用方法: python3 scripts/convert-wallets.py < input.json > wallets.json
"""

import json
import sys

def convert_wallets(input_data):
    """将原始格式转换为简化格式"""
    wallets = json.loads(input_data)
    simplified = []
    
    for wallet in wallets:
        simplified.append({
            "address": wallet.get("trackedWalletAddress", wallet.get("address", "")),
            "name": wallet.get("name", "未知钱包"),
            "emoji": wallet.get("emoji", "👻")
        })
    
    return simplified

if __name__ == "__main__":
    try:
        input_data = sys.stdin.read()
        result = convert_wallets(input_data)
        print(json.dumps(result, indent=2, ensure_ascii=False))
    except Exception as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)

