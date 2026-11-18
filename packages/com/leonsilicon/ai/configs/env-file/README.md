# @-/com.leonsilicon.ai.configs.env-file

Renders the env file a Mac mini service reads with `node --env-file`, from the items tagged with the app's name in the root [`.env.schema`](../../../../../../.env.schema). varlock resolves them, with secrets from Infisical, and only that tag is resolved.

```sh
vpx _env-file orca-bridge    # prints ~/.config/orca-bridge/env
```

The `--start` mode of `apps/orca-bridge/_deploy-orca-bridge.sh` and `apps/beeper-watch/_deploy-beeper-watch.sh` pipes this over SSH into place (mode 600), so the values never touch the local disk. It needs Infisical access: `INFISICAL_CLIENT_ID` and `INFISICAL_CLIENT_SECRET` in the root `.env`.

## API

- `formatEnvFile(values, header?)`: one `KEY='value'` line per defined value, with `header` as `#` comments. Values stay literal: single quotes, else backticks, else double quotes for a value without backslashes. It throws on multi-line values, values it can't quote, and invalid names, rather than write something Node would read back differently.

## Test

```sh
node --test packages/com/leonsilicon/ai/configs/env-file/__tests__/*.test.ts
```
