# @-apps/ai-edge

The Cloudflare Worker that serves `https://<name>.leonsilicon.ai` for the services on the Mac mini (since 2026-11-13). It forwards each request over Workers VPC to the mini's [ai-gateway](../ai-gateway/README.md) through tunnel `ai-mini`. The code is the [ai-edge service](../../packages/com/leonsilicon/ai/services/ai-edge/README.md).

## Why a Worker

The Worker reaches the mini through a Workers VPC binding (in beta and free as of 2026-11), so the tunnel needs no public hostname of its own, and each service is a Custom Domain of this one Worker. The services moved from `<name>.ai.leonsilicon.com` to `<name>.leonsilicon.ai` on 2026-11-18. The old names are still Custom Domains here, as aliases, until every client has moved; a browser on one is redirected to the new name.

## Pieces

| Piece          | Where                                                                                                                           |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Worker         | `ai-edge`, config in [`wrangler.jsonc`](wrangler.jsonc); no workers.dev address                                                 |
| Custom Domains | `orca`, `grok`, `beeper`, `watch` and `cronometer` `.leonsilicon.ai`, plus the same names under `ai.leonsilicon.com` as aliases |
| Pages          | `www/ai/leonsilicon/<name>/index.html`, built into `dist/www` and uploaded as the Worker's assets (`ASSETS`)                    |
| VPC binding    | `MINI` → VPC service `ai-mini-gateway` (`01a1d6ff-59ac-77a0-9529-94bdf672bb81`): `127.0.0.1:18800` via `ai-mini`                |

## Deploy

```sh
vpr -w deploy:ai-edge
```

It typechecks and builds `www/` first. A browser opening `https://<name>.leonsilicon.ai/` gets that service's page (see [`@-/com.leonsilicon.www`](../../packages/com/leonsilicon/www/README.md)); MCP clients never ask for HTML, so they still reach the service. Check with `curl -s https://orca.leonsilicon.ai/healthz`; logs with `vpx wrangler tail --config apps/ai-edge/wrangler.jsonc`.

## Gotchas

- **New Custom Domain, empty DNS.** Don't query a new name before its Custom Domain exists. Cloudflare's own nameservers cached the "no such name" answer (zone SOA minimum: 1800 s) for names looked up seconds too early, so they stayed unresolvable for up to 30 minutes after their records existed. A name nobody had queried resolved within a minute.
- **Certificates.** Each Custom Domain's certificate takes about two minutes. `curl --resolve <name>.leonsilicon.ai:443:172.64.80.1 …` tests one before DNS answers.
