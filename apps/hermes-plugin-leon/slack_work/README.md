# slack-work

Shows Slack’s native working indicator while Hermes or an Orca job is processing a thread. The gateway uses its existing Slack bot token with `chat:write`. Hermes’s processing hooks track a message from admission through reply delivery, failure, or cancellation. The Orca relay supplies its queued and running jobs directly from SQLite. Slack’s visual indicator is refreshed during long runs.

The gateway uses `AUTOLINEAR_TOKEN` to report active issue channels to Autolinear’s `/work` endpoint. Set `AUTOLINEAR_WORK_URL` to use a different endpoint. The reports also reconcile gateway restarts. Autolinear moves Executing to Awaiting Leon once it observes the last run end, and honors an issue status already chosen by Hermes or Leon. A failed report is retried, and a quiet channel by itself has no effect.

Grok, Muse, and Silicon Dot handoffs currently report unknown activity because their integrations lack a reliable run-level completion signal. Autolinear holds those issues until an explicit status change. The logger uses the `slack-work` prefix for delivery failures.
