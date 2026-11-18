# @-/com.leonsilicon.ai.services.ai-edge

The fetch handler behind `https://<name>.leonsilicon.ai`. It maps each subdomain to the Mac mini's [ai-gateway](../ai-gateway/README.md) path for that service and forwards the request through an upstream binding (Workers VPC in production). Deployment is in [`apps/ai-edge`](../../../../../../apps/ai-edge/README.md).

## Behavior

- `https://<name>.leonsilicon.ai/` and `/mcp` go to the gateway's `/<name>`, and `/healthz` to `/<name>/healthz`, with the query string. Any other path, and any host that isn't a known service name, gets 404.
- Method, headers (the bearer token included) and body pass through, and the response streams back as it arrives, so SSE answers and the gateway's keepalives work. `X-Forwarded-Host` and `X-Forwarded-Proto` are set.
- It adds no authentication: every service checks its own bearer token.
- When the upstream can't be reached, the answer is 502 `{"error":"mini_unreachable"}`.

## API

- `MINI_SERVICES`: the service names. A test checks they match the gateway's `ROUTES`.
- `gatewayPath(host, pathname, search?)`: the gateway path for a public request, or `null`.
- `createEdge(upstream)`: a `(Request) => Promise<Response>` that forwards to `GATEWAY_ORIGIN` (`http://127.0.0.1:18800`) through `upstream.fetch`.

## Test

```sh
node --test packages/com/leonsilicon/ai/services/ai-edge/__tests__/*.test.ts
```
