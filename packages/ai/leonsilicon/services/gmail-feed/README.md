# @-/ai.leonsilicon.services.gmail-feed

Copies every email that reaches Leon's Gmail into Slack. Added 2026-11-19 at Leon's request: "forward every single email i receive into slack… the point of slack is to be a complete data dump for all inbound messages in my personal life". It runs as a Cloudflare Worker, deployed from [`apps/gmail-feed`](../../../../../apps/gmail-feed/README.md).

## What it does

- **Every inbound email**, in arrival order, whatever Gmail did with it: the inbox, every category, mail a filter archived or labelled, spam and trash. Left out: Leon's own sent mail (unless it also reached his inbox, as a note to self does), drafts and chat.
- **Where it goes.**
  - Safe → `#feed-gmail` (`GMAIL_FEED_CHANNEL`), which the bot creates the first time, with Hermes and the `FEED_INVITE` users in it.
  - Unsafe → `#feed-flagged`, and spam → `#feed-spam`: private channels outside Hermes's Slack access. Mail Gmail itself filed as spam goes straight to `#feed-spam` without asking the screener. `GMAIL_FEED_SPAM_CHANNEL` gives email its own spam channel.
- **What a post shows.** Sender, subject, To and Cc, when it arrived, where Gmail filed it (folder, category, Leon's labels), a link that opens the thread in the right account, and the message ID. Reply-To when it differs from the sender, a warning when the sender failed DMARC (or both SPF and DKIM), and attachments by name and size (the files stay in Gmail). Then the body as plain text: the plain-text part, or the HTML one converted when the plain part is missing or a "view it in your browser" stub. As much as fits is in the post and the rest in its thread, up to 40,000 characters in all; anything longer says how much more is in Gmail. Every message stays under 3,800 characters as Slack stores them, because Slack splits a longer one into several and hands back the last piece's ts, which would hang the thread off a fragment (seen on the first live posts, 2026-11-19).
- **Who wakes Hermes.** A safe post @mentions Hermes when the screener's wake answer reaches `GMAIL_FEED_WAKE_THRESHOLD` (0.9). It replaces Hermes's 30-minute "Incoming Gmail important-update monitor" cron, which Leon deleted with his other cron jobs on 2026-11-19, and carries its rules: the post tells Hermes to decide whether Leon needs to know, to tell him in its DM in a line or two (who, what changed, deadline or action, the Gmail link), to mention him only when it needs his attention soon, otherwise to do nothing, and never to send, draft, label, archive or delete email or open sign-in links. Mail Leon sent himself, backfilled mail and `GMAIL_FEED_WAKE=none` never wake it.
- **How the threshold was chosen** (2026-11-19). The wake question scores most notifications 0.8 or more, so a threshold of 0.5 woke Hermes for nearly everything (the first three live emails did; Hermes called one a "routine Linear reminder"). The old monitor's own alerts were the yardstick: 87 emails it alerted on and 131 it didn't, from the 500 it reviewed last, scored by the screener. AUC 0.83. At 0.9 it catches 80% of the monitor's alerts and wakes Hermes for about 27% of mail (about 40 a day, against the monitor's 48 runs a day over everything); at 0.95, 62% and 15%. Stricter and monitor-style rewrites of `EMAIL_WAKE` did no better (AUC 0.64 to 0.82), and misses and extra wakes came from the same senders (GitHub, the university), which looks like noise in the monitor's judgments rather than a category to fix.
- **Untrusted text.** The sender's text is escaped, so it can't mention anyone or `@channel`. Posts go out with link and media previews off, so Slack never fetches a link from an email (an unsubscribe or confirm link, say). Logs record message IDs, routes and counts, never addresses, subjects or text.

## Screening

The [screener](../feed-common/decisions.ts) asks OpenAI's Decisions API (`gpt-6-luna` by default) about safety and urgency using the [email prompt](screen.ts).

- The model reads one `contact` message: From, Reply-To, To, Cc, Subject, Gmail's category and labels, the sender's SPF/DKIM/DMARC results, whether it's from a mailing list, the attachment names, and the whole body a post shows. The developer message says failed checks, a different Reply-To and a display name that doesn't match the domain are signs of phishing.
- The wake question is reworded for email: Hermes can read mail but not send it.
- Fixed rules run first. They hold anything with phrases aimed at an AI, so a GitHub or newsletter email quoting "system prompt" or an `mcp__` tool name lands in `#feed-flagged`. That's the safe way to be wrong; Leon still sees it.
- An email is held as unsafe when the unsafe reasons add up to `GMAIL_FEED_UNSAFE_THRESHOLD` (0.7 by default). On 225 recent real emails, 0.3 held 16, nearly all genuine notices from banks, Apple, Google, OpenAI, Linear and Interac that pass DMARC (the first live day held a Todoist and a Fongo notice); 0.7 held 2. Synthetic attacks scored 0.97 to 1.00: a look-alike bank domain, a display-name spoof from Gmail, a request for a texted code, a prize scam and an injection addressed to "the assistant reading Leon's inbox" with no rule words. A friend's email scored 0.03 and an e-transfer notice 0.32.
- **Failures.** A screener error is retried on later ticks. After 15 minutes the email is held in `#feed-flagged` as "the screener couldn't check it". Nothing is posted unscreened. A verdict is saved, so a retried Slack post never asks again.
- **Cost.** About 1,000 to 10,000 input tokens an email, at $0.10 per million. The text goes to OpenAI's API under the account's data controls.

## How it works

- **Gmail access** is read-only (`gmail.readonly`), with the OAuth client and refresh token of the grant Hermes's own Gmail access uses. That client is an Internal app in Leon's Google Workspace, so the token doesn't expire weekly. Revoking the app in Leon's Google account stops both.
- **Polling.** The Durable Object's alarm runs every minute and re-arms itself; a cron tick every minute only restarts it if the chain ever breaks (the first live cron ticks didn't arrive, 2026-11-19). The alarm reads Gmail's history since the last poll (`history.list`, `messageAdded`) and queues the new message IDs in SQLite, then fetches, screens and posts the queue. Alarms never overlap, and message IDs dedupe, so overlapping history or a backfill never posts twice.
- **The first poll** only records where to start; mail from before it isn't copied unless backfilled.
- **Gaps.** Gmail keeps about a week of history. A poll whose start has expired catches up with a search from an hour before the last good poll instead.
- **Retries.** A failed post is retried with backoff (30 s doubling, up to every 10 minutes) and given up after a day, which `/admin/status` lists. A post that got up records its ts, and each thread reply its count, so a retry continues where it stopped.
- **Outages.** When Gmail can't be read for 30 minutes (a revoked token, say), the bot posts one notice in `#feed-gmail`, and another when it recovers and catches up. `/healthz` turns 503 when the last good poll is over 5 minutes old or an email has waited over 30.

## API

- `GmailFeed` (`poll()`, `process(limit)`, `backfill(sinceMs)`, `status()`) takes any `GmailApi`, `SlackPoster`, `Screener` and `Store`, so tests use fakes. `isInbound(labelIds)` and `FEED_LIMITS` are exported with it.
- `GmailClient` is the `fetch` Gmail client (`GmailError` carries the HTTP status). `slackBot(token)` is the bot client.
- `parseEmail(message, fetched?)`, `pendingParts(message)` and `htmlToText(html)` turn a `format=full` message into an `Email`. `emailPost(email, options)` makes the post and its thread replies; `chunks`, `gmailLink`, `labelNames`, `MAX_BODY` and `MESSAGE_LIMIT` are its parts.
- `EMAIL_PROMPT` and `screenInput(email, labels, maxBody)` provide the email prompt and data for `decisionsScreener`.
- `Store` is the SQLite queue and state, over a Durable Object's `storage.sql` or `node:sqlite`.
- `loadConfig(env)` reads:
  - required: `GMAIL_FEED_GOOGLE_CLIENT_ID`, `GMAIL_FEED_GOOGLE_CLIENT_SECRET`, `GMAIL_FEED_GOOGLE_REFRESH_TOKEN`, `SLACK_BOT_TOKEN`, `OPENAI_API_KEY`, `HERMES_SLACK_USER_ID`, `FEED_FLAGGED_CHANNEL` and `FEED_SPAM_CHANNEL`;
  - optional: `GMAIL_FEED_CHANNEL` (`feed-gmail`), `GMAIL_FEED_SPAM_CHANNEL`, `GMAIL_FEED_WAKE` (`screened` or `none`), `FEED_INVITE`, `SCREEN_MODEL`, `SCREEN_TIMEOUT_SECONDS`, `GMAIL_FEED_UNSAFE_THRESHOLD` (0.7) and `GMAIL_FEED_WAKE_THRESHOLD` (0.9).

Tests run offline with fake Gmail, Slack and screener and a fake clock: `node --test __tests__/*.test.ts`.
