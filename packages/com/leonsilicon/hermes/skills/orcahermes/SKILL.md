---
name: orcahermes
description: Explain, install, or diagnose OrcaHermes, the headless Orca server running on managed Hermes hosts. Use when a user names OrcaHermes or asks about its private pairing, service recovery, boot behavior, or server-side Codex.
---

# OrcaHermes

OrcaHermes keeps projects, terminals, and agents on the Hermes host. Orca's built-in supervisor restarts a failed runtime and can reconnect to its surviving terminal daemon. The Hermes s6 service tree starts the supervisor and replaces it if it dies. A gateway startup hook restores registration after a host restart. Tailscale supplies the private client route. [Service overview](https://orcahermes.leonsilicon.ai/)

## Choose the right target

- Identify the Hermes instance and Orca environment before running commands. When using a paired Orca client, explicitly select `--environment OrcaHermes` or the display name assigned to that host. Verify the project path and host before modifying a workspace.
- The separate `orca-device` bridge can target existing desktop Orca installations. Its reachability or tools alone do not establish that the hosted Orca runtime is healthy.
- The two public HTTPS sites explain the services. Client pairing uses the host's private Tailscale endpoint and Orca authentication. [Server reference](https://orcahermes.leonsilicon.ai/server.html)

## Onboard a new host

Use the published installer for a managed Hermes Linux host with writable persistent `/opt/data` and a writable s6 service tree. The installer pins and verifies upstream releases, keeps its own Orca profile, and provisions a dedicated userspace Tailscale daemon for the host. It checks for an existing deployment before taking ownership of paths. [Installation guide](https://orcahermes.leonsilicon.ai/setup.html)

The host owner sets a narrow tailnet policy and approves device sign-in. The paired client owner completes Orca pairing. Codex uses a separate sign-in on the host. Treat pairing offers and device codes as credentials and keep them within the intended private interaction.

## Diagnose an existing deployment

Start by testing the saved Orca pairing with a project-list request. On the managed host, inspect the service state with `/command/s6-svstat /run/hermes-service/orcahermes`. For a host created by the published installer, use the following command to check both services, the local Orca request, and the private route.

```sh
python3 /opt/data/orcahermes/orcahermes.py status
```

Captain Cloud was installed before this installer. It uses the same Orca s6 service name, a separate layout under `/opt/data/orcahermes`, and its existing Tailscale link. Its local Orca command is `/opt/data/orcahermes/bin/orca repo list --json`. Inspect the Orca logs under `/opt/data/orcahermes/logs` and check the live private endpoint independently when the runtime is up but clients cannot connect. [Platform reference](https://orcahermes.leonsilicon.ai/platform.html)

A scoped runtime or supervisor restart can preserve live terminals when the daemon survives. A full host restart ends those processes. Verify Codex continuity with a supported resume from its saved session. Coordinate any full host interruption with its owner and verify automatic startup and the saved pairing from another device afterward. [Supervisor reference](https://orcahermes-supervisor.leonsilicon.ai/)
