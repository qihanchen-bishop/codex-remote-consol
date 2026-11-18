# Third-party dependencies

The MIT license in this repository applies to this project's code. Runtime dependencies retain their own licenses; `npm ci` installs their license notices alongside the packages.

| Dependency | Purpose | Declared license |
| --- | --- | --- |
| [marked](https://github.com/markedjs/marked) | Markdown parsing | MIT |
| [DOMPurify](https://github.com/cure53/DOMPurify) | HTML sanitization | MPL-2.0 OR Apache-2.0 |
| [sharp](https://github.com/lovell/sharp) | Image decoding and normalization | Apache-2.0 |
| [ws](https://github.com/websockets/ws) | Local app-server WebSocket transport | MIT |

Sharp distributes or uses additional native dependencies, including libvips, with their own notices. No `node_modules` directory or prebuilt native dependency is bundled in the public source archive. Refer to the installed packages for complete transitive dependency notices.

OpenAI Codex, ngrok, SSH clients and operating-system services are separately installed tools. This repository does not distribute their binaries or credentials.
