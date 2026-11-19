# leonsilicon.ai

Leon's AI setup, in public: what runs on `leonsilicon.ai` and its subdomains, the Hermes plugins and agent tooling around it, organized as a [Flatcap](https://github.com/leonsilicon/flatcap) workspace with Vite+. Secrets and anything identifying (Slack IDs, tailnet hosts, usernames, private paths) live in Infisical, not here.

Each site's entrypoint is `www/<hostname, labels reversed>/index.html`: `orca.leonsilicon.ai` is [`www/ai/leonsilicon/orca/index.html`](www/ai/leonsilicon/orca/index.html).

## `*.leonsilicon.ai`

Services for Leon's agents (Hermes Cloud and others). The MCP servers each check their own bearer token. Browsers get the page in `www/`.

| Site                                                           | What it is                                                                        | Runs on                                             |
| -------------------------------------------------------------- | --------------------------------------------------------------------------------- | --------------------------------------------------- |
| [`orca`](www/ai/leonsilicon/orca/index.html)                   | [Orca bridge](apps/orca-bridge/README.md)                                         | Mac mini, through [ai-edge](apps/ai-edge/README.md) |
| [`grok`](www/ai/leonsilicon/grok/index.html)                   | [Grok Bot relay](packages/com/leonsilicon/ai/configs/grok-relay-hermes/README.md) | Mac mini, through ai-edge                           |
| [`beeper`](www/ai/leonsilicon/beeper/index.html)               | Beeper Desktop's own MCP (no source of ours)                                      | Mac mini, through ai-edge                           |
| [`watch`](www/ai/leonsilicon/watch/index.html)                 | [Beeper Watch](apps/beeper-watch/README.md)                                       | Mac mini, through ai-edge                           |
| [`cronometer`](www/ai/leonsilicon/cronometer/index.html)       | [Cronometer](packages/com/leonsilicon/ai/configs/cronometer-mcp-http/README.txt)  | Mac mini, through ai-edge                           |
| [`slack-as-leon`](www/ai/leonsilicon/slack-as-leon/index.html) | [Slack as Leon](apps/slack-as-leon/README.md)                                     | Its own Cloudflare Worker                           |
| [`linear-slack`](www/ai/leonsilicon/linear-slack/index.html)   | [Linear ⇄ Slack sync](apps/linear-slack-sync/README.md)                           | Its own Cloudflare Worker                           |

The [endpoint map](apps/ai-gateway/README.md) has the mini's local targets.

## Also here

| What                            | Where                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Hermes plugins                  | [Slack 👀 everywhere](packages/com/leonsilicon/hermes/plugins/slack-always-react/README.md) · [every Slack channel](packages/com/leonsilicon/hermes/plugins/slack-auto-join/README.md) · [follow-ups in its own threads](packages/com/leonsilicon/hermes/plugins/slack-own-thread-reply/README.md) · [slack-as-leon guard](packages/com/leonsilicon/hermes/plugins/slack-as-leon-guard/README.md) · [Beeper Watch notification guard](packages/com/leonsilicon/hermes/plugins/beeper-watch-notification-guard/README.md) · [Dropbox task memory](packages/com/leonsilicon/hermes/plugins/dropbox-task-memory/README.md) |
| Hermes's Beeper inbox           | [Direct Beeper Cloud conversations over Matrix (Pickle), no Beeper Desktop](apps/beeper-inbox/README.md) · [service](packages/com/leonsilicon/ai/services/beeper-inbox/README.md)                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Silicon Dot's 1Password sign-in | [agents-vault command and skill](packages/com/leonsilicon/ai/configs/silicon-dot/agents-vault/README.md)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Unsnooze connection-loss fix    | [Codemod](packages/com/leonsilicon/ai/configs/patching/codemods/unsnooze/README.md) · [generator and apply commands](packages/com/leonsilicon/ai/configs/patching/generator/README.md) · [generated diffs](patches.gen/)                                                                                                                                                                                                                                                                                                                                                                                                |

Personal prefs that aren't part of the setup (agent personas and memory, for example) stay in the private `leonsilicon/ai` workspace.

## Commands

Install with Node 24+, Bun 1.4.4 and Vite+ 1.5.0:

```sh
vp install
vpr -w test
vp check
vp dev        # pages at http://localhost:5173/ai/leonsilicon/<name>/
vp build      # dist/www
vpr -w patch:unsnooze   # reapply the Unsnooze fix after updating the global package
```

Put Infisical access in `.env` before deploying. Deploy commands are in each app's README. See [DEVELOPMENT.md](DEVELOPMENT.md) for the layout, conventions and secrets.
