# 贡献指南

使用 Node.js 22+。拉取代码后执行 `npm ci`、`npm run check`、`npm test`、`npm run privacy:check`。自动测试使用本地模拟后台，不需要 Codex 登录、SSH 凭据或真实模型调用。

请使用虚构目录、保留示例域名和合成 thread ID。不要提交自己的 `.env`、会话、用户名、IP、截图、接入包或密钥。新增故障复现时，先将数据改为最小虚构样例。

开发手动联调时使用可丢弃的新会话；读取历史不恢复任务。不要替用户批准权限或扩大沙箱权限。修改原生协议行为时，说明支持的 Codex 版本及测试边界。

PR 请说明具体问题、最终行为及验证方法。面向使用者的配置或行为变化应同步更新 README、`.env.example` 和接入指南。

可用 `git config core.hooksPath .githooks` 启用提交前的基础数据检查。公开源码压缩包只从已提交且经过检查的 HEAD 生成：`npm run release:source`。
