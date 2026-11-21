# @-/ai.leonsilicon.configs.env-file

Renders an app's env file, one `KEY='value'` line per item, from the items tagged with the app's name in the root [`.env.schema`](../../../../../.env.schema). varlock resolves them, with secrets from Infisical, and only that tag is resolved.

```sh
vpx _env-file beeper-watch    # prints Beeper Watch's settings file
```

Beeper Watch on Hermes Cloud reads its settings from this output ([its README](../../../../../apps/beeper-watch/README.md) says where it goes). The Mac mini services, retired on 2026-11-21, read theirs with `node --env-file`: the `--start` mode of `apps/orca-bridge/_deploy-orca-bridge.sh` and `apps/beeper-watch/_deploy-beeper-watch.sh` piped it over SSH into place (mode 600), so the values never touched the local disk. It needs Infisical access: `INFISICAL_CLIENT_ID` and `INFISICAL_CLIENT_SECRET` in the root `.env`.

## API

- `formatEnvFile(values, header?)`: one `KEY='value'` line per defined value, with `header` as `#` comments. Values stay literal: single quotes, else backticks, else double quotes for a value without backslashes. It throws on multi-line values, values it can't quote, and invalid names, rather than write something Node would read back differently.

## Test

```sh
node --test packages/ai/leonsilicon/configs/env-file/__tests__/*.test.ts
```
