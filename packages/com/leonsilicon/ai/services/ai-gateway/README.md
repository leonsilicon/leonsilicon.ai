# @-/com.leonsilicon.ai.services.ai-gateway

The reverse proxy on the Mac mini behind `https://<name>.leonsilicon.ai`. The [ai-edge](../ai-edge/README.md) Worker delivers every request to it over Workers VPC and the Cloudflare Tunnel, and it forwards `/<name>` to that service's local MCP endpoint and `/<name>/healthz` to its health check. Deployment, the tunnel and the endpoint map are in [`apps/ai-gateway`](../../../../../../apps/ai-gateway/README.md).

## Behavior

- Only `/<name>`, `/<name>/` and `/<name>/healthz` are forwarded, plus the query string. Every other path, including a service's other paths (Beeper Desktop's REST API, OAuth discovery), gets 404.
- Bodies stream both ways without buffering, so SSE answers arrive event by event. Response headers are flushed as soon as the upstream sends them.
- Host is rewritten to the upstream's `127.0.0.1:<port>`, so each service's own DNS-rebinding check passes unchanged. `X-Forwarded-Host` (`<name>.leonsilicon.ai`), `X-Forwarded-Proto: https` and `X-Forwarded-For` (Cloudflare's `CF-Connecting-IP`) are added; hop-by-hop headers are dropped.
- It adds no authentication: every MCP endpoint checks its own bearer token. Logs name the route, status and duration, never the path, a header or a body.
- When the client disconnects first, the upstream request is cancelled. When the upstream is down, the answer is 502 `{"error":"upstream_unavailable","route":"<name>"}`.

## API

- `ROUTES`: the route table (`name`, `description`, `mcp`, optional `health`).
- `resolve(routes, url)`: the `Match` (`route`, `kind`, `target` URL) for a request URL, or `null`.
- `createGateway({ routes, publicSuffix, log? })`: a `node:http` server; `GET /healthz` answers for the gateway itself.

## Adding a service

Add a `Route` to `routes.ts` (loopback targets only; the tests check this) and the same name to the ai-edge service's `MINI_SERVICES` and Custom Domains, run `vpr -w test`, then redeploy with `apps/ai-gateway/_deploy-ai-gateway.sh --start` and `vpr -w deploy:ai-edge`.
