# 接入另一台电脑

接入包由你自己的中心工作台生成，每台电脑包含独立的 `connector.json`。公开 GitHub 源码不包含该配置；不要把运行时接入包作为公开发布附件。

要求：Node.js 22+、已登录的 Codex、OpenSSH 客户端。请在平时运行 Codex 的系统账号下解压，并核对该进程与原客户端使用相同的 `CODEX_HOME`。

Windows 在 [Node.js 官网](https://nodejs.org/en/download)安装 LTS，重新打开 PowerShell，在解压目录运行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\start-windows.ps1
```

该执行策略只作用于这次进程。Linux 在解压目录运行：

```bash
bash ./start-linux.sh
```

第一次启动安装本地 npm 依赖，不安装或升级 Codex。按提示输入平时使用的 SSH 目标，例如 `operator@server.example.com` 或 SSH 主机别名。SSH 自行提示密码和主机指纹确认，程序不保存密码或自动接受未知主机。

可在私有配置中添加：

| 字段 | 用途 |
| --- | --- |
| `sshTarget` | SSH 目标或主机别名，便于无人值守启动 |
| `sshPort` | 非默认 SSH 端口，数值 |
| `cwd` | 新会话默认工作目录 |
| `codexCommand` | 自定义启动器参数数组，如 `["/path/to/launcher","run","/path/to/codex"]` |
| `transport` | 设为 `stdio` 可显式选择独立进程；默认 Linux 优先使用已有共享 socket |

不要将密码写进上述字段。跳板机等连接选项可放在自己的 SSH 配置中，再使用主机别名。可通过进程环境 `CODEX_COMMAND_JSON`，或 `CODEX_PROXY_BIN` 搭配 `CODEX_BIN` 配置自定义启动器；仓库没有硬编码的用户路径。

连接分三层验收：

1. 本地 `initialize` 和 `thread/list` 成功：协议连接可用，未恢复会话。
2. SSH 隧道建立后，网页选择这台电脑并刷新，能读取项目和历史：网站接入可用。
3. 另建可丢弃会话，分别确认提交回执与真实回复，再验证同一 thread ID 的续聊：执行链路可用。

worker 只监听目标电脑 `127.0.0.1` 的临时端口，SSH 把它映射到中心服务器的专用回环端口。无需公开目标电脑端口。`connector.json` 含独立接入密钥，应保存在自己的私有目录，不分享、不提交 Git；Linux 建议目录700、文件600。

Linux 优先连接已有共享 daemon，worker 退出不结束独立 daemon。Windows 当前使用独立 stdio app-server，关闭接入进程可能结束它管理的网页任务。旧客户端仍在执行或持有会话时，网页不强制抢占。待审批请求可能仍需在原客户端处理。

保持接入窗口运行；隧道退出后脚本会退出，不会自行循环重连。可由自己的 systemd 用户服务或 Windows 任务计划程序负责重启。自动重启不会自动发送消息或恢复旧任务。图片保存在目标电脑 `.connector-state/attachments` 下，恢复历史图片时需保留该目录。
