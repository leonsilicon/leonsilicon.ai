import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  envNames,
  fillEnv,
  manifestName,
  pairByName,
  redact,
  sameManifest,
  slug,
  toEnvRefs,
  type Json,
} from "#todoist-automations";

const USER = "11111111-2222-4333-8444-555555555555";
const manifest: Json = {
  name: "Mirror",
  triggers: [{ inputSchema: { assigneeId: { const: USER } } }],
  steps: [{ code: "return { text: `${title}` };", prompt: "{{trigger.issue.title}}" }],
};
const withRefs: Json = {
  name: "Mirror",
  triggers: [{ inputSchema: { assigneeId: { const: { $env: "LINEAR_USER" } } } }],
  steps: [{ code: "return { text: `${title}` };", prompt: "{{trigger.issue.title}}" }],
};

test("private values become { $env } and come back", () => {
  assert.deepEqual(toEnvRefs(manifest, { LINEAR_USER: USER }), withRefs);
  assert.deepEqual(fillEnv(withRefs, { LINEAR_USER: USER }), manifest);
  assert.deepEqual(envNames(withRefs), ["LINEAR_USER"]);
  // Template syntax the manifests already use is left alone.
  assert.deepEqual(fillEnv(manifest, {}), manifest);
});

test("refuses to leave a private value in the manifest", () => {
  const embedded: Json = { prompt: `Only issues for ${USER}` };
  assert.throws(() => toEnvRefs(embedded, { LINEAR_USER: USER }), /LINEAR_USER's value/);
  assert.throws(() => toEnvRefs({ [USER]: 1 }, { LINEAR_USER: USER }), /LINEAR_USER's value/);
  assert.throws(() => fillEnv(withRefs, {}), /No value for \$env LINEAR_USER/);
  // An empty value matches nothing rather than everything.
  assert.deepEqual(toEnvRefs(manifest, { EMPTY: "" }), manifest);
});

test("redacts every value from printed text", () => {
  const values = { TOKEN: "abc123", LONGER: "abc123def", EMPTY: "" };
  assert.equal(redact("t=abc123 l=abc123def", values), "t=$TOKEN l=$LONGER");
  assert.equal(redact("nothing here", values), "nothing here");
});

test("compares manifests whatever their key order", () => {
  assert.ok(
    sameManifest({ a: 1, b: { c: [1, { d: 2, e: 3 }] } }, { b: { c: [1, { e: 3, d: 2 }] }, a: 1 }),
  );
  assert.ok(!sameManifest({ a: [1, 2] }, { a: [2, 1] }));
});

test("names files after the automation", () => {
  assert.equal(slug("Mirror Linear tasks to Todoist"), "mirror-linear-tasks-to-todoist");
  assert.equal(slug("  Linear → Todoist: done!  "), "linear-todoist-done");
  assert.throws(() => slug("→"), /Can't make a file name/);
  assert.equal(manifestName({ name: "A" }), "A");
  assert.throws(() => manifestName({ name: " " }), /no name/);
});

test("pairs manifests with automations by name", () => {
  const name = (item: { n: string }) => item.n;
  const pairing = pairByName([{ n: "a" }, { n: "b" }], [{ n: "b" }, { n: "c" }], {
    here: name,
    live: name,
  });
  assert.deepEqual(pairing, {
    both: [{ name: "b", here: { n: "b" }, live: { n: "b" } }],
    hereOnly: [{ name: "a", here: { n: "a" } }],
    liveOnly: [{ name: "c", live: { n: "c" } }],
  });
  assert.throws(
    () => pairByName([], [{ n: "a" }, { n: "a" }], { here: name, live: name }),
    /Two automations in Todoist are named "a"/,
  );
});

test("the manifests here are named after their automations and hold no private values", () => {
  const assets = fileURLToPath(new URL("../@assets/", import.meta.url));
  const schema = readFileSync(
    fileURLToPath(new URL("../../../../../../.env.schema", import.meta.url)),
    "utf8",
  );
  // The items .env.schema tags #todoist-automations: the only names a manifest may refer to.
  const tagged = new Set(
    [...schema.matchAll(/^#[^\n]*@tag\(([^)]*)\)[^\n]*\n([A-Z0-9_]+)=/gm)]
      .filter((match) => match[1]!.split(",").some((tag) => tag.trim() === "todoist-automations"))
      .map((match) => match[2]!),
  );
  const files = readdirSync(assets).filter((file) => file.endsWith(".json"));
  assert.ok(files.length > 0);
  for (const file of files) {
    const text = readFileSync(`${assets}${file}`, "utf8");
    const parsed = JSON.parse(text) as Json;
    assert.equal(file, `${slug(manifestName(parsed))}.json`);
    for (const name of envNames(parsed))
      assert.ok(tagged.has(name), `${file}: ${name} isn't tagged`);
    assert.doesNotMatch(
      text,
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
      file,
    );
  }
});
