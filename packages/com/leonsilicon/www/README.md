# @-/com.leonsilicon.www

Serves the pages in [`www/`](../../../../www) from Cloudflare Workers. A hostname's pages live in `www/` under its labels reversed, the same way packages are named: `orca.leonsilicon.ai` is `www/ai/leonsilicon/orca/index.html`. Vite builds every `www/**/index.html` into `dist/www`, which each Worker uploads as its static assets.

## Behavior

- A browser asking for `https://<host>/<path>` (GET or HEAD with `Accept: text/html`) gets `dist/www/<reversed host>/<path>`, with `index.html` added to a path that ends in `/`. So `https://orca.leonsilicon.ai/` is that service's page.
- `/assets/*` (Vite's hashed scripts and styles, shared by every page) is served for any host.
- Anything else, and anything the build doesn't have, is left to the Worker's own handler. MCP clients ask for JSON or `text/event-stream`, never `text/html`, so the MCP endpoint at `/` keeps working, and so does `/healthz` in a browser.
- Paths resolve under the host's own directory, so one host can't serve another's pages.
- A browser on a hostname under a moved suffix (`MOVED`: `*.ai.leonsilicon.com` → `*.leonsilicon.ai` since 2026-11-18) is redirected (301) to the same name under the new suffix. API requests there still reach the Worker, so the old names can stay as Custom Domain aliases until every client has moved.

The Worker needs an assets binding with `run_worker_first`, so it decides before the asset server does, and `html_handling: "none"`, so asset paths are never redirected:

```jsonc
"assets": {
  "directory": "../../dist/www",
  "binding": "ASSETS",
  "run_worker_first": true,
  "html_handling": "none",
  "not_found_handling": "none",
},
```

## API

From `@-/com.leonsilicon.www` (Worker side):

- `MOVED` and `movedHost(host)`: moved hostname suffixes, and where a hostname under one lives now (or `null`).
- `sitePath(host)`: the `www/` directory for a hostname, such as `/ai/leonsilicon/orca/`, or `null` for anything that isn't a plain DNS name.
- `serveSite(request, assets)`: the page or shared asset for a request, or `null` when the Worker's own handler should answer.
- `Assets`: the assets binding's type. `SHARED_ASSETS` is `/assets/`.

From `@-/com.leonsilicon.www/client` (browser side, imported by the pages):

- `mountServicePage()`: loads the shared styles and fills the page's `[data-health]` element from the service's own `/healthz`. A page without that element shows no status.

## Test

```sh
node --test packages/com/leonsilicon/www/__tests__/*.test.ts
```

A test also checks that every Custom Domain in `apps/*/wrangler.jsonc` has its page in `www/` (for an alias, the page of the name it moved to).
