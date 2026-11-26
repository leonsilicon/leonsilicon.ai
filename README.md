# leonsilicon.ai

Leon's AI setup, in public: what runs on `leonsilicon.ai` and its subdomains, the Hermes plugins and agent tooling around it, organized as a [Flatcap](https://github.com/leonsilicon/flatcap) workspace with Vite+. Secrets and anything identifying (Slack IDs, tailnet hosts, usernames, private paths) live in Infisical, not here.

Each site's entrypoint is `www/<hostname, labels reversed>/index.html`: `cronometer.leonsilicon.ai` is [`www/ai/leonsilicon/cronometer/index.html`](www/ai/leonsilicon/cronometer/index.html).

[leonsilicon.ai](https://leonsilicon.ai/) is the public directory for the services and the Hermes Cloud tools.

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
| [Gmail2Slack](https://gmail2slack.leonsilicon.ai/)      | Mirrors incoming email into Slack                                   |

[Autotrigger](packages/ai/leonsilicon/services/autotrigger/README.md) routes relevant Slack feed messages to Awaiting Trigger issue channels, and opens an issue for each new case in Leon's [Watcher projects](packages/ai/leonsilicon/services/slack22linear/README.md#routine-and-watcher-projects). Routine projects follow his routines in Muse.

[Slack Puppet migration](https://slack-as-leon.leonsilicon.ai/) covers the temporary `slack-as-leon` hostname. Each live service page links its source and deployment runbook.

Until 2026-11-21 an edge Worker, a tunnel and a gateway on Leon's Mac mini also served `orca`, `grok`, `beeper` and `watch` here, and `cronometer` ran there too. What they did now runs on Hermes Cloud (below) or as a Worker, so those four names and all three pieces were removed, and the mini serves nothing public. The git history has them.

## On Hermes Cloud

Services that run on Hermes Cloud's own machine without a public address.

| What                                                           | State                                                                                                                                   |
| -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| [OrcaHermes Device](https://orcahermes-device.leonsilicon.ai/) | Live since 2026-11-19: Hermes reaches the Macs' Orca directly. It replaced the Orca bridge. [Runbook](apps/orcahermes-device/README.md) |
| [beeperd](apps/beeperd/README.md)                              | Live since 2026-11-26: Hermes's Beeper inbox as one 20 MB Go daemon. It replaced the Pickle daemon of 2026-11-19                        |
| [slack22grokbot](apps/beeperd/internal/grokrelay/README.md)    | Hermes delegates to Grok bots through the Beeper inbox and follows up in Slack task threads                                             |
| [slack22muse](apps/hermes-plugin-leon/hermes22muse/README.md)  | Muse side chats and editable Hermes progress in the Slack issue channel                                                                 |
| [slack22chatgpt](apps/beeperd/internal/handoff/README.md)      | ChatGPT Dots handoffs and Codex collaboration through Slack Puppet                                                                      |
| [Slack feeds](apps/beeperd/internal/feeds/README.md)           | Copies Discord, Instagram, LinkedIn, Reddit, WeChat, WhatsApp and X conversations into Slack as they arrive                             |

## Also here

| What                            | Where                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Hermes plugins                  | [leon](apps/hermes-plugin-leon/README.md), one plugin for all of these: [Slack 👀 everywhere](apps/hermes-plugin-leon/slack_always_react/README.md) · [answers in the channel, not a thread](apps/hermes-plugin-leon/slack_flat_replies/README.md) · [an issue and channel per Slack message (autolinear)](apps/hermes-plugin-leon/autolinear/README.md) · [every Slack channel](apps/hermes-plugin-leon/slack_auto_join/README.md) · [follow-ups in its own threads](apps/hermes-plugin-leon/slack_own_thread_reply/README.md) · [slack-as-leon guard](apps/hermes-plugin-leon/slack_as_leon_guard/README.md) · [Dropbox task memory](apps/hermes-plugin-leon/dropbox_task_memory/README.md) · [Slack-to-Orca delegation](apps/hermes-plugin-leon/slack22orca/README.md) · [Muse side chats (hermes22muse)](apps/hermes-plugin-leon/hermes22muse/README.md) · [Grok box browser](apps/hermes-plugin-leon/grok_box_browser/README.md); and [autodeploy](apps/hermes-plugin-autodeploy/README.md), which installs each push |
| Hermes's Beeper inbox           | [Direct Beeper Cloud conversations over Matrix (beeperd, on mautrix-go), no Beeper Desktop](apps/beeperd/README.md)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Silicon Dot's 1Password sign-in | [agents-vault command and skill](packages/ai/leonsilicon/configs/silicon-dot/agents-vault/README.md)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Unsnooze connection-loss fix    | [Codemod](packages/ai/leonsilicon/configs/patching/codemods/unsnooze/README.md) · [generator and apply commands](packages/ai/leonsilicon/configs/patching/generator/README.md) · [generated diffs](patches.gen/)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Todoist Automations             | [Linear → Todoist mirror and Todoist → Linear completion, published on every deploy](packages/ai/leonsilicon/configs/todoist-automations/README.md)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |

[Shared Slack task threads](apps/hermes-plugin-leon/hermes22muse/README.md#shared-task-thread-and-progress) connect Hermes, Grok Bot, Muse, and Codex under Hermes's first answer in each new issue channel.

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
