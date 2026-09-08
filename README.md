# sillytavern-opencode-header

## 免责声明

> **本项目仅用于学习和软件原理研究。**
>
> 本项目通过阅读和分析 opencode 开源客户端源码，理解它在向外部 AI 服务发起请求时如何构造请求头（Header），并在本项目中以相同格式复现，作为协议层的学习参考。
>
> 本项目：
> - 不包含任何破解、绕过付费、规避认证、绕过限制或去除限制的实现；
> - 不鼓励、不参与任何滥用、刷量、冒充身份或违反服务条款的行为；
> - 不保证所接入服务的可用性，使用者应遵守所接入服务提供方的使用条款。
>
> 请合理、合法地使用本项目的学习成果。因使用本项目产生的一切后果，由使用者自行承担。

---

让 SillyTavern 发送的请求携带与 opencode 客户端相同格式的请求头，以便对接 OpenCode Go（`https://opencode.ai/zen/go/v1`）的 OpenAI 兼容接口。

为 SillyTavern 的 **Custom (OpenAI-compatible) Chat Completion** 请求注入与 opencode 客户端格式一致的请求头：

> Request is missing x-opencode-session and cannot be routed efficiently.

## 功能

- **注入 `x-opencode-session`**：三种会话 ID 模式（见下），每个请求自动合并进 `custom_include_headers`，由 ST 服务器端转发到上游。
- **注入 `x-opencode-request`**：每次请求新生成一个 `msg_` 格式 ID，与 opencode 客户端逐请求一致。
- **注入 `x-opencode-client: tui`**：固定常量，标识客户端类型。
- **User-Agent 配置**：可选，把 `user-agent` 配置为与 opencode 客户端一致的取值（两种预设或自定义）。
- **回复消息上显示 request id**：每次生成完成后，把本次请求使用的 `x-opencode-request` 显示在回复消息的时间旁边（重新生成会自动更新）。
- **设置面板**：实时展示当前对话的 Session ID 与 User-Agent，提供「查询当前聊天 Session ID」按钮手动查询/生成。

## 注入的请求头

| 头 | 值 | 来源 |
|---|---|---|
| `x-opencode-session` | `ses_...` | 按会话模式生成，整个会话稳定复用 |
| `x-opencode-request` | `msg_...` | 每次请求新生成（正序时间戳/计数器 + 62 进制随机） |
| `x-opencode-client` | `tui` | 固定常量 |
| `user-agent` | opencode 预设或自定义 | 可选 |

`x-opencode-project` 与 `x-parent-session-id` 刻意不加：前者绑定账号真实项目记录，后者仅子会话需要，服务端都不依赖。

## 会话 ID 三种模式

| 模式 | 行为 | 适用 |
|---|---|---|
| 每聊天固定（默认） | 每个聊天生成一次 `ses_` 格式 ID，存该聊天 metadata，该聊天内所有请求复用 | 缓存亲和最佳，推荐 |
| 全局随机 | 一个全局随机 ID，可用「随机换新」按钮重置 | 想手动重置上游会话关联 |
| 手动填写 | 使用你填的固定值（如 `ses_...`） | 指定固定会话 |

## 原理

- OpenCode Go 要求每个请求携带 `x-opencode-session`，值需**每个会话稳定**、**不同会话不同**。它在服务端用于路由优化和 prompt 缓存亲和。
- 本扩展复刻 opencode 客户端的 ID 生成方式：`前缀` + 时间戳/计数器（48 位，session 取反、message 正序） + 62 进制随机，与官方逐字节一致。
- 实现：监听 `CHAT_COMPLETION_SETTINGS_READY` 事件（每次请求发出前触发），把 header 合并进 `generate_data.custom_include_headers`（YAML），ST 服务器端 `mergeObjectWithYaml` 解析后附加到上游请求。

## 安装

1. 把整个 `sillytavern-opencode-header/` 文件夹复制到 SillyTavern 的扩展目录：
   - 单用户：`<SillyTavern>/data/default-user/extensions/sillytavern-opencode-header/`
   - 多用户：`<SillyTavern>/data/<用户名>/extensions/sillytavern-opencode-header/`
   - 或通过 Extensions → **Install Extension** 粘贴仓库 URL 直接导入。
2. 启动/刷新 SillyTavern，在 **Extensions** 面板确认已出现并启用该扩展。
3. 确保 Chat Completion 源选择 **Custom (OpenAI-compatible)**，API 地址填 `https://opencode.ai/zen/go/v1`，填入你的 OpenCode Go API Key，模型填 `deepseek-v4-flash` 等 Go 模型 ID。
4. 在扩展设置面板里选择会话 ID 模式、是否配置 UA。

## 验证

- 浏览器控制台应输出 `[OpenCodeGoHeader] loaded.`。
- 发送一条消息应不再出现 `x-opencode-session` 缺失报错。
- 设置面板会显示当前对话的 Session ID 与 User-Agent。

## 说明 / 限制

- 仅在 Chat Completion 源为 `custom` 时生效（OpenCode Go 走的就是这个源）。
- 若你在 Custom Headers 里手写了 `x-opencode-session`，本扩展会**覆盖**为会话 ID。
- 每聊天模式下，Session ID 存在聊天的 metadata 里，跟随聊天存档持久化；删除聊天即随之删除。
- 本扩展仅处理协议层请求头格式，不改变任何服务的条款或限制；请遵守所接入服务提供方的使用条款。

## 文件

- `manifest.json` — 扩展清单
- `index.js` — 扩展逻辑（会话 ID + UA 配置）
- `style.css` — 设置面板样式