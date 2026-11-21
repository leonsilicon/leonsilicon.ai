# @-apps/ai-gateway

The agent services on the always-on Mac mini are public as `https://<name>.leonsilicon.ai` (since 2026-11-18; `<name>.ai.leonsilicon.com` from 2026-11-13; paths under `ai.leonsilicon.com` from 2026-11-12). Each service keeps its own bearer token. The routing code is the [ai-gateway service](../../packages/com/leonsilicon/ai/services/ai-gateway/README.md), and the public side is the [ai-edge Worker](../ai-edge/README.md).

```text
Hermes Cloud, … ──HTTPS──▶ <name>.leonsilicon.ai: Worker "ai-edge" (Cloudflare)
    ──Workers VPC service "ai-mini-gateway"──▶ Tunnel "ai-mini" ──▶ mini: cloudflared
    ──▶ ai-gateway 127.0.0.1:18800 ──▶ /<name> → the service's local MCP endpoint
```

The tunnel has no public hostname: the only way in is the Worker's VPC binding.

## Endpoints

As of 2026-11-21 the `orca`, `grok` and `watch` services are stopped (Hermes Cloud runs their replacements itself), so those three URLs answer 502. Their routes go when the gateway does. `beeper` still points at Beeper Desktop, which has been frozen since 2026-11-19, and `cronometer` still works.

| URL                                 | Service                                                                                                | Local target             | Token on the mini                                             |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------ | ------------------------ | ------------------------------------------------------------- |
| `https://orca.leonsilicon.ai`       | [Orca bridge](../orca-bridge/README.md): full Orca CLI incl. computer use, plus orca-mcp worker tools  | `127.0.0.1:18787/mcp`    | `ORCA_BRIDGE_TOKEN` (Infisical `/orca-bridge`)                |
| `https://grok.leonsilicon.ai`       | [Grok Bot relay](../../packages/com/leonsilicon/ai/configs/grok-relay-hermes/README.md) through Beeper | `127.0.0.1:18788/mcp`    | `token` in `~/.local/share/grok-relay-hermes/config.json`     |
| `https://beeper.leonsilicon.ai`     | Beeper Desktop's own MCP (no source of ours)                                                           | `127.0.0.1:23373/v0/mcp` | `token` in `~/.local/share/grok-relay-hermes/beeper-mcp.json` |
| `https://watch.leonsilicon.ai`      | [Beeper Watch](../beeper-watch/README.md)                                                              | `127.0.0.1:18789/mcp`    | `MCP_TOKEN` (Infisical `/beeper-watch`)                       |
| `https://cronometer.leonsilicon.ai` | [Cronometer](../../packages/com/leonsilicon/ai/configs/cronometer-mcp-http/README.txt)                 | `127.0.0.1:18791/mcp`    | `~/.config/cronometer-mcp-http/token`                         |

`/` and `/mcp` are each service's MCP endpoint, and `/healthz` its health check (all but `beeper`). Everything else is 404. A browser opening a service's URL gets its page from [`www/ai/leonsilicon/<name>/index.html`](../../www/com/leonsilicon/ai), served by the ai-edge Worker without reaching the mini. `muse.leonsilicon.ai` was retired on 2026-11-13: Hermes reaches Muse through Beeper now, and the Grok bots no longer use it. `https://slack-as-leon.leonsilicon.ai` is not on the mini: it is its own Worker ([slack-as-leon](../slack-as-leon/README.md)).

## Pieces

| Piece   | Where                                                                                                                                                                                                                      |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Edge    | Cloudflare Worker `ai-edge` with one Custom Domain per service ([`apps/ai-edge`](../ai-edge/README.md))                                                                                                                    |
| VPC     | Workers VPC service `ai-mini-gateway` (`01a1d6ff-59ac-77a0-9529-94bdf672bb81`): HTTP to `127.0.0.1:18800` through tunnel `ai-mini`                                                                                         |
| Gateway | Mini (as its usual user): LaunchAgent `com.leonsilicon.ai-gateway` (KeepAlive), app in `~/.local/share/ai-gateway/app`, logs in `~/.local/share/ai-gateway/logs/ai-gateway.log`                                            |
| Tunnel  | Mini: LaunchAgent `com.leonsilicon.cloudflared-ai` running Homebrew `cloudflared` with `~/.local/share/ai-gateway/cloudflared.yml` (from [`@assets/cloudflared.yml`](@assets/cloudflared.yml)); log `logs/cloudflared.log` |
| Secret  | Tunnel credentials `~/.cloudflared/8300e675-b32b-49ca-92cf-d00524c33d07.json` (mode 600), only on the mini                                                                                                                 |

## Deploy

```sh
apps/ai-gateway/_deploy-ai-gateway.sh          # copy the workspace to the mini and install
apps/ai-gateway/_deploy-ai-gateway.sh --start  # also write the tunnel config and restart both LaunchAgents
vpr -w deploy:ai-edge                          # the Worker and its Custom Domains
```

`DEPLOY_HOST` overrides the SSH host (default `mini`). Check with `curl -s https://orca.leonsilicon.ai/healthz` and `ssh mini 'tail ~/.local/share/ai-gateway/logs/*.log'`.

## Operating it

- **Add a service.** Add a `Route` to the gateway's `routes.ts`, add its name to `MINI_SERVICES` in the [ai-edge service](../../packages/com/leonsilicon/ai/services/ai-edge/README.md) and a Custom Domain to [`apps/ai-edge/wrangler.jsonc`](../ai-edge/wrangler.jsonc), run `vpr -w test`, then redeploy both. A test fails when the two lists differ.
- **Security.** Cloudflare terminates TLS, so it sees the bearer tokens and the traffic in clear. The Tailscale Funnel routes this replaced were end-to-end encrypted to the mini.
- **Turn one service off.** Remove its route and Custom Domain and redeploy, or stop the service itself.
- **Turn everything off.** `launchctl bootout gui/$(id -u)/com.leonsilicon.cloudflared-ai` on the mini. To remove it for good: `vpx wrangler delete --config apps/ai-edge/wrangler.jsonc`, `vpx wrangler vpc service delete 01a1d6ff-59ac-77a0-9529-94bdf672bb81`, and `cloudflared tunnel delete ai-mini` from the MacBook.
- **Updates.** `brew upgrade cloudflared` on the mini, then restart with `--start` (the config sets `no-autoupdate`).
- **Outages.** Every service here needs the mini logged in (LaunchAgents) and online; the Worker answers 502 `{"error":"mini_unreachable"}` when it isn't.
