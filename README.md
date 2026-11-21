# leonsilicon.ai

Leon's AI setup, in public: what runs on `leonsilicon.ai` and its subdomains, the Hermes plugins and agent tooling around it, organized as a [Flatcap](https://github.com/leonsilicon/flatcap) workspace with Vite+. Secrets and anything identifying (Slack IDs, tailnet hosts, usernames, private paths) live in Infisical, not here.

Each site's entrypoint is `www/<hostname, labels reversed>/index.html`: `cronometer.leonsilicon.ai` is [`www/ai/leonsilicon/cronometer/index.html`](www/ai/leonsilicon/cronometer/index.html).

## `*.leonsilicon.ai`

Services for Leon's agents (Hermes Cloud and others), each a Cloudflare Worker of its own. The MCP servers each check their own bearer token. Browsers get the page in `www/`.

| Site                                                         | What it is                                                                          | Runs on                                              |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------- | ---------------------------------------------------- |
| [`cronometer`](www/ai/leonsilicon/cronometer/index.html)     | [Cronometer](apps/cronometer/README.md)                                             | Its own Cloudflare Worker (Python), since 2026-11-21 |
| [`slack-puppet`](www/ai/leonsilicon/slack-puppet/index.html) | [Slack puppet: posts as Leon](apps/slack-as-leon/README.md)                         | Its own Cloudflare Worker                            |
| [`linear-slack`](www/ai/leonsilicon/linear-slack/index.html) | [Linear ⇄ Slack sync](apps/linear-slack-sync/README.md)                             | Its own Cloudflare Worker                            |
| [`autolinear`](www/ai/leonsilicon/autolinear/index.html)     | [autolinear: an issue and channel per Slack message](apps/autolinear/README.md)     | Its own Cloudflare Worker                            |
| [`dailylinear`](www/ai/leonsilicon/dailylinear/index.html)   | [dailylinear: the day's Linear project and its channel](apps/dailylinear/README.md) | Its own Cloudflare Worker, since 2026-11-21          |
| [`gmail-feed`](www/ai/leonsilicon/gmail-feed/index.html)     | [Gmail feed: every email into Slack](apps/gmail-feed/README.md)                     | Its own Cloudflare Worker                            |

Until 2026-11-21 an edge Worker, a tunnel and a gateway on Leon's Mac mini also served `orca`, `grok`, `beeper` and `watch` here, and `cronometer` ran there too. What they did now runs on Hermes Cloud (below) or as a Worker, so those four names and all three pieces were removed, and the mini serves nothing public. The git history has them.

## On Hermes Cloud

Services that run on Hermes Cloud's own machine, as local MCP servers with no public address.

| What                                                                    | State                                                                                                                              |
| ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| [Orca device](apps/orca-device/README.md)                               | Live since 2026-11-19: Hermes reaches the Macs' Orca directly. It replaced the Orca bridge                                         |
| [Beeper inbox](apps/beeper-inbox/README.md)                             | Live since 2026-11-19: Hermes reads and sends in Leon's Beeper chats over Matrix, no Beeper Desktop                                |
| [Grok relay](packages/com/leonsilicon/ai/services/grok-relay/README.md) | Live since 2026-11-21: Hermes messages Leon's Grok bots through the Beeper inbox. It replaced the mini's relay                     |
| [Beeper Watch](apps/beeper-watch/README.md)                             | Live since 2026-11-21: the #feed- channels and reply watches, read from the Beeper inbox's journal. It replaced the mini's service |

## Also here

| What                            | Where                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Hermes plugins                  | [Slack 👀 everywhere](packages/com/leonsilicon/hermes/plugins/slack-always-react/README.md) · [answers in the channel, not a thread](packages/com/leonsilicon/hermes/plugins/slack-flat-replies/README.md) · [an issue and channel per Slack message (autolinear)](packages/com/leonsilicon/hermes/plugins/autolinear/README.md) · [every Slack channel](packages/com/leonsilicon/hermes/plugins/slack-auto-join/README.md) · [follow-ups in its own threads](packages/com/leonsilicon/hermes/plugins/slack-own-thread-reply/README.md) · [slack-as-leon guard](packages/com/leonsilicon/hermes/plugins/slack-as-leon-guard/README.md) · [Beeper Watch notification guard](packages/com/leonsilicon/hermes/plugins/beeper-watch-notification-guard/README.md) · [Dropbox task memory](packages/com/leonsilicon/hermes/plugins/dropbox-task-memory/README.md) |
| Hermes's Beeper inbox           | [Direct Beeper Cloud conversations over Matrix (Pickle), no Beeper Desktop](apps/beeper-inbox/README.md) · [service](packages/com/leonsilicon/ai/services/beeper-inbox/README.md)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Silicon Dot's 1Password sign-in | [agents-vault command and skill](packages/com/leonsilicon/ai/configs/silicon-dot/agents-vault/README.md)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Unsnooze connection-loss fix    | [Codemod](packages/com/leonsilicon/ai/configs/patching/codemods/unsnooze/README.md) · [generator and apply commands](packages/com/leonsilicon/ai/configs/patching/generator/README.md) · [generated diffs](patches.gen/)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Todoist Automations             | [Linear → Todoist mirror and Todoist → Linear completion, published on every deploy](packages/com/leonsilicon/ai/configs/todoist-automations/README.md)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |

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
