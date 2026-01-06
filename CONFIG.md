# 钱包配置文件说明

## 配置文件位置

钱包配置文件位于项目根目录的 `wallets.json` 文件。

## 配置文件格式

```json
[
  {
    "address": "钱包地址",
    "name": "钱包名称",
    "emoji": "表情符号（可选）"
  }
]
```

## 如何创建配置文件

### 方法一：使用转换脚本（推荐）

如果你有原始格式的 JSON 数据（包含 `trackedWalletAddress` 字段），可以使用转换脚本：

```bash
# 将原始 JSON 数据保存到 input.json，然后运行：
python3 scripts/convert-wallets.py < input.json > wallets.json
```

### 方法二：手动创建

直接创建 `wallets.json` 文件，格式如下：

```json
[
  {
    "address": "GjXobpiEexQqqLkghB29AtcwyJRokbeGDSkz8Kn7GGr1",
    "name": "bull-kol",
    "emoji": "👻"
  },
  {
    "address": "DxM1hfY8FQ8dNGrucuJzhJcF8KRbjk8WBwrgKvQ9spPv",
    "name": "rc-kol",
    "emoji": "👻"
  }
]
```

### 方法三：兼容原始格式

代码也支持原始格式（包含 `trackedWalletAddress` 字段），会自动转换：

```json
[
  {
    "trackedWalletAddress": "GjXobpiEexQqqLkghB29AtcwyJRokbeGDSkz8Kn7GGr1",
    "name": "bull-kol",
    "emoji": "👻",
    "alertsOnToast": true,
    "alertsOnBubble": true,
    "alertsOnFeed": true,
    "groups": ["Main"],
    "sound": "default"
  }
]
```

## 字段说明

- `address` 或 `trackedWalletAddress`: 钱包地址（必填）
- `name`: 钱包名称（必填）
- `emoji`: 表情符号（可选，默认为 👻）

其他字段（如 `alertsOnToast`, `groups` 等）会被忽略，但不会影响程序运行。

## 注意事项

1. 配置文件必须是有效的 JSON 格式
2. 如果配置文件不存在，程序会使用默认配置（一个示例钱包）
3. 如果配置文件格式错误，程序会显示错误信息并使用默认配置

