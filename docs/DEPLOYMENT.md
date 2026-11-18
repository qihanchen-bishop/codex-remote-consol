# 自行部署

## 1. 中心工作台

按 README 安装依赖并创建自己的账号。没有预置密码，也不会从其他部署复制账号或机器。首次 `npm start` 选择本账号的 Codex 后台，默认仅监听 `127.0.0.1:8787`。

`.env.example` 可复制为 `.env`；只有中心进程读取自己的文件。常用配置：

| 配置 | 默认 | 含义 |
| --- | --- | --- |
| `WEB_HOST` | `127.0.0.1` | 监听地址；内网可显式改为 `0.0.0.0` |
| `WEB_PORT` | `8787` | HTTP 端口 |
| `WEB_STATE_DIR` | 项目 `.local` | 网站账号哈希、机器注册及上传图片 |
| `CODEX_TRANSPORT` | `auto` | `shared`、`stdio` 或按系统自动选择 |
| `CODEX_HOME` | Codex 默认资料目录 | 应与原客户端一致 |
| `CODEX_SOCKET` | 资料目录下的共享控制 socket | 自定义共享后台入口 |
| `CODEX_DEFAULT_CWD` | 项目目录 | 新会话的默认目录 |
| `CODEX_COMMAND_JSON` | 无 | 自定义 Codex 启动器参数数组 |
| `CODEX_PROXY_BIN` / `CODEX_BIN` | 无 | 包装器的 `run` 调用与 Codex 可执行路径 |
| `WEB_PUBLIC_ORIGIN` | 无 | 自己的精确 HTTPS 来源，不带路径或末尾斜杠 |
| `WEB_PUBLIC_PATH` | 空 | 可选挂载路径，如 `/codex` |
| `WEB_ALLOWED_HOSTS` | 空 | 额外允许的主机名，逗号分隔 |

启动器优先级：worker 的 `connector.json.codexCommand` → `CODEX_COMMAND_JSON` → `CODEX_PROXY_BIN` 搭配 `CODEX_BIN` → `CODEX_BIN` → 系统中的 Codex。参数没有 shell 展开。密码配置脚本也读取 `.env`，保证私有状态目录一致。

## 2. ngrok：建议先用于体验验证

按 [官方入门文档](https://ngrok.com/docs/getting-started/)安装并配置自己的 ngrok 账号。由 ngrok 分配或使用你自己的 endpoint，将它的 origin 写入 `WEB_PUBLIC_ORIGIN`，重启工作台后运行：

```bash
ngrok http 8787 --url=https://your-domain.ngrok-free.app --inspect=false
```

将示例域名替换为自己的，`WEB_PUBLIC_PATH` 留空。浏览器访问对应 HTTPS 地址，继续用自己创建的网站账号登录。自己的 ngrok 配置、认证信息和账号额度由你管理；仓库没有任何真实 ngrok 凭据或 endpoint。

`--inspect=false` 关闭本地 agent 的请求正文抓取。不要直接将 Codex app-server 暴露为公网服务。ngrok 终止外部 TLS，模型和网站流量的信任边界需要按自己的需求选择。ngrok 网站隧道与 Codex 模型出网代理是独立配置。

ngrok 提示页可能干扰普通文件下载。网站下载按钮会先用已登录请求获取 ZIP，再以浏览器 Blob 下载；首次访问仍按 ngrok 页面提示操作。

## 3. 同域名已有其他网站时

可选网关把根路径交给你自己的主网站，把 `/codex/` 交给工作台。它不包含任何特定业务网站：

```dotenv
WEB_PUBLIC_ORIGIN=https://your-domain.ngrok-free.app
WEB_PUBLIC_PATH=/codex
GATEWAY_PUBLIC_ORIGIN=https://your-domain.ngrok-free.app
GATEWAY_MAIN_URL=http://127.0.0.1:3000
GATEWAY_CODEX_URL=http://127.0.0.1:8787
GATEWAY_PORT=8790
```

```bash
npm start
# 另一个终端启动网关：
npm run gateway
# ngrok 改为连接网关：
ngrok http 8790 --url=https://your-domain.ngrok-free.app --inspect=false
```

工作台地址为 `https://your-domain.ngrok-free.app/codex/`。网关只接受回环 HTTP 上游，保留 WebSocket、流式 SSE 与 gzip；两个网站各自管理登录。独立部署不需要这一步。

## 4. 其他 HTTPS 入口

可以使用 Cloudflare Tunnel、Caddy/Nginx 或现有 VPN，设置相应 `WEB_PUBLIC_ORIGIN`。保留公网 Host 和原路径；上游转发至本机 HTTP 服务。`/api/events` 必须保留长连接和及时刷新，禁用代理缓冲。网站仅接受私网/回环来源，因此远程入口应由同机或私网代理转发。

公网模式由固定的 Host/origin 配置识别，直接内网 HTTP 访问仍保留自己的 Cookie 行为。不要用来自浏览器的 `X-Forwarded-*` 作为额外授权依据。

## 5. 后台常驻

`examples/systemd/codex-remote-console.service` 以 `~/codex-remote-console` 为示例目录；请按自己的安装位置和 Node 路径修改。也可用自己的进程管理器。

```bash
mkdir -p ~/.config/systemd/user
cp examples/systemd/codex-remote-console.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now codex-remote-console.service
```

这些命令由使用者主动执行；网站不会替使用者修改 SSH、防火墙或系统权限。worker 常驻见 CONNECTOR.md；它的 SSH 子进程退出后需要进程管理器重启。

## 6. 验收与数据备份

先做只读握手与历史发现，再在可丢弃会话中分别确认提交回执和模型回复，最后才交接重要会话。当前轮执行中、原客户端占用或有待审批时，先在原客户端由用户处理。

备份自己的 `.env` 和私有状态目录。上传图片位于中心 `.local/attachments` 或目标 worker 的 `.connector-state/attachments`，恢复图片需要保留对应文件。接入包包含私钥，备份也应限制访问。普通源码发布使用 `npm run release:source`，不会导出这些运行数据。
