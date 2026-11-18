"""Keep Hermes from answering the Slack messages it posted as Leon.

Hermes posts as Leon through the ``slack-as-leon`` MCP server (a Cloudflare Worker), which uses Leon's own
Slack web session so the Grok bots (and any other bot that answers only Leon) act on the message.
Those posts are indistinguishable from Leon's: same user, no ``bot_id``/``app_id``. Hermes listens to
Leon everywhere (``require_mention: false``), so without this plugin it would wake on its own post
and answer it as if Leon had written it, possibly in a loop.

The server stamps every such post with a ``client_msg_id`` whose first group is ``MARKER``. Slack keeps
it and delivers it in the message event (Leon's Slack clients use random UUIDs). This plugin wraps
the live adapter's ``_prefilter_inbound``, which every inbound ``message`` / ``app_mention`` event
passes through, and drops events that carry the marker, edits included. Nothing else changes: the
messages stay in Slack, and thread context still shows them.

It fails closed: if the adapter internals it relies on disappear, it logs a warning, so check the
gateway log after a Hermes update.
"""

from __future__ import annotations

import functools
import logging

logger = logging.getLogger(__name__)

#: First group of the client_msg_id on posts made through slack-as-leon (its ``CLIENT_MSG_ID_PREFIX``).
MARKER = "de1e6a7e"
_PATCHED_ATTR = "_slack_as_leon_guard_patched"


def _client_msg_id(event) -> str:
    if not isinstance(event, dict):
        return ""
    value = event.get("client_msg_id")
    if not value and isinstance(event.get("message"), dict):  # message_changed envelope
        value = event["message"].get("client_msg_id")
    return value if isinstance(value, str) else ""


def is_marked(event) -> bool:
    """True for an event about a message Hermes posted as Leon."""
    return _client_msg_id(event).startswith(f"{MARKER}-")


def wire(native, adapter) -> None:
    """``register_platform_handler`` factory: patch this adapter instance once."""
    if getattr(adapter, _PATCHED_ATTR, False):
        return
    prefilter = getattr(adapter, "_prefilter_inbound", None)
    if not callable(prefilter):
        logger.warning(
            "slack-as-leon-guard: Slack adapter internals changed (no _prefilter_inbound); "
            "Hermes may answer its own messages posted as Leon")
        return

    @functools.wraps(prefilter)
    async def guarded(event, *args, **kwargs):
        accepted = await prefilter(event, *args, **kwargs)
        if accepted is None:
            return None
        normalized = accepted[0] if isinstance(accepted, tuple) and accepted else None
        if is_marked(event) or is_marked(normalized):
            source = normalized if isinstance(normalized, dict) else event
            logger.info(
                "slack-as-leon-guard: not answering %s:%s, Hermes posted it as Leon",
                source.get("channel", ""), source.get("ts", ""))
            return None
        return accepted

    adapter._prefilter_inbound = guarded
    setattr(adapter, _PATCHED_ATTR, True)
    logger.info("slack-as-leon-guard: Hermes ignores the Slack messages it posts as Leon")


def register(ctx) -> None:
    ctx.register_platform_handler("slack", wire)
