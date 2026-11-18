# @-/com.npmjs.yaml

Workspace wrapper for `yaml`, a YAML 1.2 parser and stringifier.

## Usage

```ts
import { parse } from "@-/com.npmjs.yaml";

parse("{event: Rogers unlimited BYOD deal, stop: 2026-12-01}");
// { event: "Rogers unlimited BYOD deal", stop: "2026-12-01" }
```

Its default schema is YAML 1.2 core, so a bare date like `2026-12-01` stays a string rather than becoming a `Date`.
