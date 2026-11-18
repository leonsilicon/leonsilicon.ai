# @-/com.leonsilicon.hermes.plugins.beeper-watch-notification-guard

Beeper Watch notification guard: a profile-local Hermes plugin preventing independent Beeper Watch notifications from being mistaken for replies in one bot conversation loop.

## Root cause and behavior

Hermes keys bot-chain state by profile/platform/channel. After Hermes replies to one Watch notification, later distinct updates can be rejected as `reply_to_reply`; the shared chain hop cap is a second failure mode. This plugin partitions chain state by normalized full notification text, while retaining the original shared channel rate budget and core duplicate expiration. Identical redelivery remains a duplicate.

Scope is deliberately pinned to Leon’s default profile `/opt/data` and four Slack IDs read from Hermes's environment: the team (`BEEPER_WATCH_GUARD_TEAM_ID`), the intake channel (`BEEPER_WATCH_GUARD_CHANNEL_ID`), the Watch sender (`BEEPER_WATCH_GUARD_SENDER_ID`) and the Hermes receiver (`BEEPER_WATCH_GUARD_RECEIVER_ID`). Their values are the `#hermes` items of the root `.env.schema`, kept in Infisical, and set in `$HERMES_HOME/.env`. If any is unset the guard stays off. Valid notification structure and untrusted-quote warning are required. Sender identity, authorization, `is_bot`, text, quoted-content trust, direct-reply exclusions, and other bots’ guards are unchanged. This is a scoped trusted-sender policy, not independent authentication of quoted content.

The Slack platform factory eagerly installs runner-instance wrappers during connect/live reload, covering the first busy notification without cold priming. `pre_gateway_dispatch` is a fallback. Private methods `_admit_bot_chain`, `_note_bot_reply`, and the private runner weak reference are compatibility seams: review and rerun the installed-runtime suite after managed Hermes updates. Missing seams fail closed. No managed core files or global guard settings are edited.

## Deploy and rollback

Copy `plugin.yaml` and `__init__.py` to `$HERMES_HOME/plugins/beeper-watch-notification-guard/`. This version is scoped to the default home `/opt/data`; other homes intentionally do not activate it.

```sh
hermes plugins enable beeper-watch-notification-guard
```

Require a successful live reload and the log `beeper-watch-notification-guard: runner-local chain policy installed` before test traffic. If reload fails, report it rather than restarting the hosted gateway from a tool subprocess.

Rollback:

```sh
hermes plugins disable beeper-watch-notification-guard
```

Wrappers consult opt-in on every call and revert to core behavior when disabled. No restart is required. Do not edit enabled closures in place; deploy a reviewed revision through a clean lifecycle.

## Verification

```sh
HERMES_HOME=/opt/data HERMES_RUNTIME_ROOT=/opt/hermes python __tests__/test_watch_guard.py
```

Uses stdlib unittest and the actual installed Hermes guard, admission, platform rewire and busy-message paths. Requires a compatible installed Hermes runtime. The runtime root can be supplied with `HERMES_RUNTIME_ROOT`; the configured plugin scope remains `/opt/data`. Tests load this package’s implementation, not a separately deployed plugin.

22 tests cover distinct sequential notifications, first busy admission, shared budget/cooldown, duplicates, authorization denial, scope boundaries, other bots, committed admission, missing seams and rollback. Test-first regressions reproduced both the original reply suppression and initial busy-path gap before fixes. Live validation additionally replayed two historical results through the real Beeper Watch service and independently read back both origin-thread receipts after the first reply. Historical test replay must never repeat calls, food logging or other external work.

Public API: `pluginName`, `pluginDirectory`, and `pluginFiles` through `+.ts`.
