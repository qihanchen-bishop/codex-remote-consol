# Codex Remote Console

[中文](README.md) · [Deployment](docs/DEPLOYMENT.md) · [Connector guide](CONNECTOR.md)

A self-hosted browser console for local and remote Codex conversations. Browse computer → project → thread, read history, continue the original thread, answer questions, choose models, and attach images.

This independent community project is not affiliated with OpenAI. The source contains no preconfigured accounts, real conversations, registered computers, connector keys, or personal public endpoints.

## Quick start

Prerequisites: Node.js 22+, npm, Git, and a locally installed and signed-in Codex CLI. Linux shared-daemon mode is the primary tested host configuration.

```bash
git clone https://github.com/qihanchen-bishop/codex-remote-consol.git codex-remote-console
cd codex-remote-console
npm ci
cp .env.example .env
npm run setup -- --username your-account
npm start
```

Set your own password at the hidden terminal prompt, then visit `http://127.0.0.1:8787`. There is no default account. The website login is separate from the existing Codex login.

`npm start` loads `.env`. `CODEX_TRANSPORT=auto` uses the shared daemon on Linux/macOS and stdio on Windows. A missing shared daemon is started without resuming conversations. For a custom launcher set `CODEX_COMMAND_JSON` to an array such as `["/path/to/launcher","run","/path/to/codex"]`.

## Public access

ngrok is an optional starting point. Configure your own ngrok account and endpoint, set `WEB_PUBLIC_ORIGIN=https://your-domain.ngrok-free.app` in `.env`, restart the console, and run:

```bash
ngrok http 8787 --url=https://your-domain.ngrok-free.app --inspect=false
```

Use your exact endpoint origin. Public cookies are Secure and HttpOnly. Request-body inspection is disabled in this example. Other HTTPS reverse proxies and private VPNs are supported; see [deployment](docs/DEPLOYMENT.md). The tunnel provider terminates TLS and is part of your trust boundary.

## Remote computers

Register a Windows or Linux computer using the sidebar, download its private connector package, and run it as the same OS user and `CODEX_HOME` used by the original Codex client. Node.js 22+, Codex, and OpenSSH are required on the target computer.

Windows:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\start-windows.ps1
```

Linux:

```bash
bash ./start-linux.sh
```

Enter your usual SSH destination. The worker initiates an SSH reverse tunnel to a dedicated loopback port on the hub. Browser cookies stay on the hub; each worker uses a separate key. Images are stored on the target computer. **Connector packages include private keys and must never be published as source releases.**

## Boundaries

- Reading history does not resume a task. The attach button and sending a message do.
- History visibility does not prove that a live desktop session can be handed off. Verify the same thread ID, wait for the original turn to finish, and respect client locks and approvals.
- Windows uses a separate stdio app-server; desktop shared-backend integration is not implemented. Stdio-owned tasks depend on that process remaining alive.
- This is a single-user console for trusted devices, not a multi-tenant service.
- An offline worker does not fall back to local execution. Failed requests are not automatically resent.
- Codex 0.169.x is the main protocol baseline. The 0.166.0 stdio handshake/history path was checked; actual Windows handoff remains a target-machine validation step.

## Development and source releases

```bash
npm run check
npm test
npm run privacy:check
```

Tests use synthetic fixtures and mock backends. Runtime state, `.env`, credentials, connector keys, images, and logs are ignored by Git. Review the staged diff before publishing. After committing, `npm run release:source` audits and exports only the committed Git tree to `dist/`.

See [SECURITY.md](SECURITY.md) for data and trust boundaries. MIT licensed; dependency licenses are listed in [THIRD_PARTY.md](THIRD_PARTY.md).
