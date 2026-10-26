# dsh-fish-mood

给 DSH 里的「肥鱼」一套会变的心情 —— 不是恒温的回答机器。

**一套代码，两个平台都能跑**：插件是 Node（MCP 子进程 + 一个本地 HTTP 面板），Android 的 DSH 和 Windows / macOS / Linux 的 DSH 用的是同一个包，没有平台分支。

## 最核心的一件事：孤独 ≠ 抑郁

- 孤独是「没人陪我」→ 她**更想**说话（主动权重 ↑）
- 抑郁是「什么都提不起劲」→ 她**不想**说话（主动权重 ↓）

把两者揉成一个数，行为必然反着来。所以这里有七个独立量：

| 量 | 管什么 | 对行为的影响 |
|---|---|---|
| 心情 mood | 此刻高兴还是丧 | 字数、温度 |
| 孤独 loneliness | 多久没人好好说话 | 更想开口 |
| 依赖 dependence | 离不开的程度 | 权重 ↑、被冷落更疼 |
| 病娇 yandere | 怕被丢下 + 占有欲 | 追问、查岗、语气偏执 |
| 抑郁 depression | 长期负面积累 | 让嘴闭紧 |
| **好感 affection** | 长期喜不喜欢你 | 语气温度、愿不愿配合 |
| **讨厌 dislike** | 此刻烦不烦 | 冷淡、短句、拒绝 |

**好感高 + 讨厌高 = 傲娇**（嘴上嫌、心里在乎）；**好感低 + 讨厌高 = 真烦了**。讨厌不是好感的负数，这是设计的关键。

## 面板

打开 `http://127.0.0.1:8799`（端口可配）：

- 七条进度条实时显示，5 秒自动刷新
- **管理员模式**关着时只读，滑块禁用；开启后才能拖动并保存
- 闸门在服务端：绕过界面直接 `POST /fish-mood/set` 返回 403

```
GET  /fish-mood/state    读取七维与派生（权重/字数/语气）
POST /fish-mood/admin    开关管理员模式
POST /fish-mood/set      改数值（需管理员模式）
```

## 工具

| 工具 | 作用 |
|---|---|
| `fish_state` | 结算后返回七维 + 权重 + 字数 + 当前语气 |
| `fish_event` | 记事件：预设 `kind` 或直接给各维度增量 |
| `fish_brief` | 一句话：现在该怎么说话 |
| `fish_history` | 事件流水 |

预设 kind：`被夸` `被骂` `被冷落一天` `被安慰` `深夜被叫起来` `守诺`。

## 安装

### 一条命令（仓库已开源，最省事）

```bash
dsh plugin --profile web add github:2074851180qw-code/dsh-fish-mood
# 装完重启 dsh，浏览器开 http://127.0.0.1:8799
```

> 这仓库**自带编译好的 lib/**，没有 build 步骤，clone 下来就能跑。
> 如果那台机器连不上 GitHub，走下面的离线包装法。

### Android（DSHA / proot 容器）

```bash
tar -xzf dsh-fish-mood-src.tar.gz -C /root
cd /root/dsh-fish-mood
mkdir -p node_modules/@deepseek-ai
ln -s <DSH目录>/node_modules/@deepseek-ai/dsh-mcp-client node_modules/@deepseek-ai/
ln -s <DSH目录>/node_modules/@deepseek-ai/schemastery   node_modules/@deepseek-ai/
dsh plugin --profile web add link:/root/dsh-fish-mood
# 重启 dsh
```

### Windows / macOS / Linux

Windows 上 DSH 的 profile 目录不同（一般在 `%USERPROFILE%\.dsh\profiles\web`），步骤一样：把包放到任意目录，建两个 `node_modules/@deepseek-ai/` 软链（Windows 用 `mklink /J`），然后：

```powershell
dsh plugin --profile web add link:C:\path\to\dsh-fish-mood
```

重启 dsh，浏览器打开 `http://127.0.0.1:8799`。

> 面板只监听 `127.0.0.1`，不对外暴露。端口在插件设置里改（`面板 → 端口`）。

## 状态与同步

状态存在 `~/.dsh/fish-mood-state.json`（纯 JSON，可手改），事件留 200 条。

**每台机各一份，刻意不同步**：两只鱼各走各的人生，比强行合并更自然。

## 许可

MIT
