# OutOfOffice

An explicitly disclosed meeting delegate that answers from approved facts. Core implementation of [the product design](design.md), developed in small, tested commits. The agent is named **OutOfOffice**.

This repository starts with a local laboratory demo. It does not currently join Google Meet. No external API calls or paid services are enabled by default.

Use Node.js 22.12+ (Node 24 LTS recommended) and pnpm 10.12.4. In Windows PowerShell, use `pnpm.cmd` if execution policy blocks `pnpm.ps1`.

```sh
pnpm install
pnpm typecheck
pnpm test
```

The initial workspace defines validated input contracts and private-by-default facts. Subsequent commits add the response policy, audio worker, persistence and local API. Run commands described here only as their implementation lands.
