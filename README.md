# sillytavern-opencode-header

让 SillyTavern 可以发送 OpenCode Go 需要的 Header。

为 SillyTavern 的 **Custom (OpenAI-compatible) Chat Completion** 请求注入 `x-opencode-session` 头,解决 OpenCode Go(`https://opencode.ai/zen/go/v1`)从 2026-09-06 起强制要求该头导致的报错:

> Request is missing x-opencode-session and cannot be routed efficiently.

## 功能

- **注入 `x-opencode-session`**:三种会话 ID 模式(见下),每个请求自动合并进 `custom_include_headers`,由 ST 服务器端转发到上游。
- **User-Agent 伪装**:可选,把 `user-agent` 伪装成 opencode 客户端(两种预设或自定义)。
- **设置面板**:实时展示当前对话的 Session ID 与 User-Agent,提供「查询当前聊天 Session ID」按钮手动查询/生成。

## 会话 ID 三种模式

| 模式 | 行为 | 适用 |
|---|---|---|
| 每聊天固定(默认) | 每个聊天生成一次 `ses_` 格式 ID,存该聊天 metadata,该聊天内所有请求复用 | 缓存亲和最佳,推荐 |
| 全局随机 | 一个全局随机 ID,可用「随机换新」按钮重置 | 想手动重置上游会话关联 |
| 手动填写 | 使用你填的固定值(如 `ses_...`) | 指定固定会话 |

## 原理

- OpenCode Go 要求每个请求携带 `x-opencode-session`,值需**每个会话稳定**、**不同会话不同**。它在服务端用于路由优化和 prompt 缓存亲和。
- 本扩展复刻 OpenCode 客户端的 ID 生成方式:`ses_` + 时间戳/计数器 + 62 进制随机。
- 实现:监听 `CHAT_COMPLETION_SETTINGS_READY` 事件(每次请求发出前触发),把 header 合并进 `generate_data.custom_include_headers`(YAML),ST 服务器端 `mergeObjectWithYaml` 解析后附加到上游请求。

## 安装

1. 把整个 `sillytavern-opencode-header/` 文件夹复制到 SillyTavern 的扩展目录:
   - 单用户: `<SillyTavern>/data/default-user/extensions/sillytavern-opencode-header/`
   - 多用户: `<SillyTavern>/data/<用户名>/extensions/sillytavern-opencode-header/`
   - 或通过 Extensions → **Install Extension** 粘贴仓库 URL 直接导入。
2. 启动/刷新 SillyTavern,在 **Extensions** 面板确认已出现并启用该扩展。
3. 确保 Chat Completion 源选择 **Custom (OpenAI-compatible)**,API 地址填 `https://opencode.ai/zen/go/v1`,填入你的 OpenCode Go API Key,模型填 `deepseek-v4-flash` 等 Go 模型 ID。
4. 在扩展设置面板里选择会话 ID 模式、是否伪装 UA。

## 验证

- 浏览器控制台应输出 `[OpenCodeGoHeader] loaded.`。
- 发送一条消息应不再出现 `x-opencode-session` 缺失报错。
- 设置面板会显示当前对话的 Session ID 与 User-Agent。

## 说明 / 限制

- 仅在 Chat Completion 源为 `custom` 时生效(OpenCode Go 走的就是这个源)。
- 若你在 Custom Headers 里手写了 `x-opencode-session`,本扩展会**覆盖**为会话 ID。
- 每聊天模式下,Session ID 存在聊天的 metadata 里,跟随聊天存档持久化;删除聊天即随之删除。
- OpenCode Go 是为编码 agent 设计的订阅服务,SillyTavern 角色扮演流量属于非预期用途,存在被限流的风险——本扩展只解决协议层面问题,不改变服务条款。

## 文件

- `manifest.json` — 扩展清单
- `index.js` — 扩展逻辑(会话 ID + UA 伪装)
- `style.css` — 设置面板样式