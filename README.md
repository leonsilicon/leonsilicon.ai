# leonsilicon.ai

Leon's AI setup, in public: what runs on `leonsilicon.ai` and its subdomains, the Hermes plugins and agent tooling around it, organized as a [Flatcap](https://github.com/leonsilicon/flatcap) workspace with Vite+. Secrets and anything identifying (Slack IDs, tailnet hosts, usernames, private paths) live in Infisical, not here.

Each site's entrypoint is `www/<hostname, labels reversed>/index.html`: `cronometer.leonsilicon.ai` is [`www/ai/leonsilicon/cronometer/index.html`](www/ai/leonsilicon/cronometer/index.html).

## `*.leonsilicon.ai`

Services for Leon's agents (Hermes Cloud and others), each a Cloudflare Worker of its own. The MCP servers each check their own bearer token. Browsers get the page in `www/`.

| Live service                                            | What it does                                                        |
| ------------------------------------------------------- | ------------------------------------------------------------------- |
| [Cronometer MCP](https://cronometer.leonsilicon.ai/)    | Gives authorized agents access to Leon's Cronometer food diary      |
| [Slack Puppet](https://slack-puppet.leonsilicon.ai/)    | Lets Hermes post as Leon and delegated agents reply in task threads |
| [slack22linear](https://linear-slack.leonsilicon.ai/)   | Syncs Slack issue channels and Linear comments                      |
| [AutoLinear](https://autolinear.leonsilicon.ai/)        | Makes a Linear issue and channel for eligible Slack messages        |
| [DailyLinear](https://dailylinear.leonsilicon.ai/)      | Creates the day's Linear project and Slack channel                  |
| [Grok Bot Admin](https://grokbot-admin.leonsilicon.ai/) | Lists and deletes bots through MCP                                  |
| [Gmail Feed](https://gmail-feed.leonsilicon.ai/)        | Mirrors incoming email into Slack                                   |

[Slack Puppet migration](https://slack-as-leon.leonsilicon.ai/) covers the temporary `slack-as-leon` hostname. Each live service page links its source and deployment runbook.

Until 2026-11-21 an edge Worker, a tunnel and a gateway on Leon's Mac mini also served `orca`, `grok`, `beeper` and `watch` here, and `cronometer` ran there too. What they did now runs on Hermes Cloud (below) or as a Worker, so those four names and all three pieces were removed, and the mini serves nothing public. The git history has them.

## On Hermes Cloud

Services that run on Hermes Cloud's own machine without a public address.

| What                                                                  | State                                                                                                          |
| --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| [Orca device](apps/orca-device/README.md)                             | Live since 2026-11-19: Hermes reaches the Macs' Orca directly. It replaced the Orca bridge                     |
| [Beeper inbox](apps/beeper-inbox/README.md)                           | Live since 2026-11-19: Hermes reads and sends in Leon's Beeper chats over Matrix, no Beeper Desktop            |
| [Grok relay](packages/ai/leonsilicon/services/grok-relay/README.md)   | Live since 2026-11-21: Hermes messages Leon's Grok bots through the Beeper inbox. It replaced the mini's relay |
| [Beeper Feed](packages/ai/leonsilicon/services/beeper-feed/README.md) | One-way mirror from Beeper to the per-platform Slack feeds.                                                    |

## Also here

| What                            | Where                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Hermes plugins                  | [Slack 👀 everywhere](packages/com/leonsilicon/hermes/plugins/slack-always-react/README.md) · [answers in the channel, not a thread](packages/com/leonsilicon/hermes/plugins/slack-flat-replies/README.md) · [an issue and channel per Slack message (autolinear)](packages/com/leonsilicon/hermes/plugins/autolinear/README.md) · [every Slack channel](packages/com/leonsilicon/hermes/plugins/slack-auto-join/README.md) · [follow-ups in its own threads](packages/com/leonsilicon/hermes/plugins/slack-own-thread-reply/README.md) · [slack-as-leon guard](packages/com/leonsilicon/hermes/plugins/slack-as-leon-guard/README.md) · [Dropbox task memory](packages/com/leonsilicon/hermes/plugins/dropbox-task-memory/README.md) |
| Hermes's Beeper inbox           | [Direct Beeper Cloud conversations over Matrix (Pickle), no Beeper Desktop](apps/beeper-inbox/README.md) · [service](packages/ai/leonsilicon/services/beeper-inbox/README.md)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Silicon Dot's 1Password sign-in | [agents-vault command and skill](packages/ai/leonsilicon/configs/silicon-dot/agents-vault/README.md)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Unsnooze connection-loss fix    | [Codemod](packages/ai/leonsilicon/configs/patching/codemods/unsnooze/README.md) · [generator and apply commands](packages/ai/leonsilicon/configs/patching/generator/README.md) · [generated diffs](patches.gen/)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Todoist Automations             | [Linear → Todoist mirror and Todoist → Linear completion, published on every deploy](packages/ai/leonsilicon/configs/todoist-automations/README.md)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |

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
