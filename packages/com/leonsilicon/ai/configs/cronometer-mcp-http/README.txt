cronometer-mcp-http: Cronometer food diary MCP for Leon's agents, hosted on the Mac mini (set up 2026-11-06)

Upstream is rollecode/cronometer-mcp (MIT), which talks to mobile.cronometer.com, the API Cronometer's
Android app uses. It needs no Gold subscription. Its client began as a copy of rwestergren/cronometer-api-mcp,
which is the more popular repo but has fewer write tools (no weight logging, entry edits or target changes).
Both are unofficial: a Cronometer app update can break them until upstream catches up.

  MCP client (Grok Bot, Hermes Cloud, Claude Code ...; header Authorization: Bearer <token>)
    -> https://cronometer.leonsilicon.ai                         (ai-edge Worker -> ai-gateway on the mini)
    -> http://127.0.0.1:18791/mcp                                   (server.py, LaunchAgent com.leonsilicon.cronometer-mcp-http)
    -> cronometer_mcp (pinned checkout) -> mobile.cronometer.com

Files on the mini (in the home directory of the user the services run as):
  ~/.local/share/cronometer-mcp/           upstream checkout pinned at e123a47 (v1.11.1, reviewed 2026-11-06: its only
                                           network host is mobile.cronometer.com), venv in .venv (Homebrew python3.13 via uv;
                                           mcp 1.30.0, httpx 0.28.1, uvicorn 0.54.0). Installed non-editable, so a git
                                           checkout alone changes nothing: reinstall with `uv pip install --python .venv/bin/python .`
  ~/.local/share/cronometer-mcp-http/      this directory's server.py and __tests__, logs/ (401s and upstream login lines;
                                           no diary contents)
  ~/.config/cronometer-mcp-http/token      bearer token, mode 600
  ~/.config/cronometer-mcp/env             Cronometer login, mode 600: CRONOMETER_USERNAME, CRONOMETER_PASSWORD, and
                                           CRONOMETER_TOTP_SECRET only if the account has 2FA (needs `pyotp` in the venv)
  ~/.cache/cronometer-mcp/session.json     Cronometer session token cached by upstream, so restarts don't log in again
                                           (Cronometer rate-limits logins and can lock the account for a while)
  ~/Library/LaunchAgents/com.leonsilicon.cronometer-mcp-http.plist

Grok Bot (connected 2026-11-06, all bots; Grok has no per-bot connectors): the Authentication Bot (Main Bot) added
"cronometer". Grok can't write a saved secret into a remote connector's header, so unlike muse and kernel it runs as a
small local connector on the bots' shared computer that reads Grok secret CRONOMETER_MCP_TOKEN at start and sends it as
the bearer header. Since 2026-11-18 it connects to https://cronometer.leonsilicon.ai/mcp (Cronometer Bot switched it and
ran get_profile); before that it used the mini's Tailscale Funnel route /cronometer, removed the same day. Cronometer Bot (created by Leon 2026-11-06) and the Authentication Bot both saw 41 tools and ran
get_profile. Grok probes /.well-known/openid-configuration first; those 401s in the log are expected.

Behaviour: bearer token required on every request (401 otherwise); FastMCP's Host check allows CRONOMETER_HTTP_PUBLIC_HOST
and localhost (the gateway hands it the local address); all 41 upstream tools are exposed (reads, plus adding, editing and deleting diary entries, custom foods,
recipes, notes, biometrics, exercise, fasts and nutrient targets). Upstream's Node OAuth server and nginx are not used,
so Claude.ai's custom-connector OAuth flow isn't available; clients that send a bearer header work.

Set the login (from Leon's 1Password item "Cronometer", Personal vault, no 2FA; set and verified 2026-11-06), without printing it:
  op item get Cronometer --fields username,password --reveal --format json \
    | python3 -c 'import json,sys; f={x["id"]:x["value"] for x in json.load(sys.stdin)}; print(f"CRONOMETER_USERNAME={f[\"username\"]}\nCRONOMETER_PASSWORD={f[\"password\"]}")' \
    | ssh mini 'umask 077; cat > ~/.config/cronometer-mcp/env'
  ssh mini 'rm -f ~/.cache/cronometer-mcp/session.json; launchctl kickstart -k gui/$(id -u)/com.leonsilicon.cronometer-mcp-http'
Quote values containing spaces or # in the env file.

Tests:    __tests__/test_server.py (offline, no Cronometer login needed):
          ssh mini 'cd ~/.local/share/cronometer-mcp-http && ../cronometer-mcp/.venv/bin/python -m pytest __tests__ -q'
Deploy:   scp server.py mini:.local/share/cronometer-mcp-http/ && ssh mini 'launchctl kickstart -k gui/$(id -u)/com.leonsilicon.cronometer-mcp-http'
LaunchAgent: the plist here has __HOME__ placeholders. Install it with
          ssh mini 'sed "s|__HOME__|$HOME|g" > ~/Library/LaunchAgents/com.leonsilicon.cronometer-mcp-http.plist' < com.leonsilicon.cronometer-mcp-http.plist
          then bootstrap it (launchctl bootstrap gui/$(id -u) <plist>) if it isn't loaded yet.
Health:   ssh mini curl -s http://127.0.0.1:18791/healthz   (process only; a real check is any read tool, e.g. get_profile)
Update:   ssh mini 'cd ~/.local/share/cronometer-mcp && git fetch && git log --oneline HEAD..origin/main'; review the diff
          (grep for new hosts), check out the new commit, reinstall into .venv, rerun the tests, kickstart.
Rotate:   new `openssl rand -hex 32` in the token file, kickstart, then have a Grok bot ask for CRONOMETER_MCP_TOKEN again
          through its secure field (fill it with `orca computer set-value --value-stdin` from the mini) and restart the connector.
Stop public access to Cronometer only:
          remove the `cronometer` route and Custom Domain (see "Turn one service off" in apps/ai-gateway/README.md)
          and redeploy the gateway and the ai-edge Worker.
