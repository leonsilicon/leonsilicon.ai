import assert from "node:assert/strict";
import { existsSync, globSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { serveSite, sitePath, type Assets } from "#sites";

const root = fileURLToPath(new URL("../../../../../../", import.meta.url));

function fakeAssets(files: Record<string, string>): Assets & { seen: string[] } {
  const seen: string[] = [];
  return {
    seen,
    fetch: async (request) => {
      const { pathname } = new URL(request.url);
      seen.push(pathname);
      const body = files[pathname];
      return body === undefined
        ? new Response("not found", { status: 404 })
        : new Response(request.method === "HEAD" ? null : body, { status: 200 });
    },
  };
}

/** What a browser sends when it opens a page. */
const page = (url: string, method = "GET") =>
  new Request(url, { method, headers: { Accept: "text/html,*/*;q=0.8" } });

test("sitePath reverses the hostname into its www/ directory", () => {
  assert.equal(sitePath("orca.leonsilicon.ai"), "/ai/leonsilicon/orca/");
  assert.equal(sitePath("Slack-As-Leon.leonsilicon.ai:443"), "/ai/leonsilicon/slack-as-leon/");
  assert.equal(sitePath("leonsilicon.com."), "/com/leonsilicon/");
  for (const host of ["localhost", "", "a..b.com", "-x.leonsilicon.com", "a_b.leonsilicon.com"])
    assert.equal(sitePath(host), null, host);
});

test("a browser gets the host's page; API clients fall through", async () => {
  const assets = fakeAssets({
    "/ai/leonsilicon/orca/index.html": "orca page",
    "/assets/page-abc.css": "css",
  });
  const served = await serveSite(page("https://orca.leonsilicon.ai/"), assets);
  assert.equal(await served?.text(), "orca page");

  const css = await serveSite(
    new Request("https://orca.leonsilicon.ai/assets/page-abc.css"),
    assets,
  );
  assert.equal(await css?.text(), "css");

  const head = await serveSite(page("https://orca.leonsilicon.ai/", "HEAD"), assets);
  assert.equal(head?.status, 200);

  assets.seen.length = 0;
  for (const request of [
    // MCP: POST, and GET for the event stream.
    new Request("https://orca.leonsilicon.ai/", {
      method: "POST",
      headers: { Accept: "application/json, text/event-stream" },
      body: "{}",
    }),
    new Request("https://orca.leonsilicon.ai/", { headers: { Accept: "text/event-stream" } }),
    new Request("https://orca.leonsilicon.ai/healthz", {
      headers: { Accept: "application/json" },
    }),
    new Request("https://orca.leonsilicon.ai/mcp"),
  ])
    assert.equal(await serveSite(request, assets), null, `${request.method} ${request.url}`);
  assert.deepEqual(assets.seen, [], "API requests never touch the assets");
});

test("anything the build doesn't have falls through to the service", async () => {
  const assets = fakeAssets({ "/ai/leonsilicon/orca/index.html": "orca page" });
  assert.equal(await serveSite(page("https://orca.leonsilicon.ai/healthz"), assets), null);
  assert.equal(await serveSite(page("https://missing.leonsilicon.ai/"), assets), null);
  assert.equal(
    await serveSite(new Request("https://orca.leonsilicon.ai/assets/x.js"), assets),
    null,
  );
});

test("one host can't reach another host's pages", async () => {
  const assets = fakeAssets({ "/ai/leonsilicon/grok/index.html": "grok page" });
  for (const path of ["/ai/leonsilicon/grok/", "/../grok/", "/%2e%2e/grok/"])
    assert.equal(await serveSite(page(`https://orca.leonsilicon.ai${path}`), assets), null, path);
  assert.ok(
    assets.seen.every((p) => p.startsWith("/ai/leonsilicon/orca/")),
    assets.seen.join(),
  );
});

test("every Worker Custom Domain has a page in www/", () => {
  const configs = globSync("apps/*/wrangler.jsonc", { cwd: root });
  assert.ok(configs.length > 0);
  const hosts = configs.flatMap((config) =>
    [
      ...readFileSync(`${root}/${config}`, "utf8").matchAll(
        /"pattern":\s*"([^"]+)",\s*"custom_domain":\s*true/g,
      ),
    ].map((match) => match[1]!),
  );
  assert.ok(hosts.length > 0);
  for (const host of hosts) {
    const file = `www${sitePath(host)}index.html`;
    assert.ok(existsSync(`${root}/${file}`), `${host} has no ${file}`);
  }
});

test("sites are private entrypoints with no exports or package dependents", () => {
  const pages = globSync("www/**/index.html", { cwd: root, exclude: ["**/node_modules/**"] });
  assert.ok(pages.length > 0);
  const siteNames = new Set<string>();
  for (const page of pages) {
    const dir = dirname(page);
    const manifest = JSON.parse(readFileSync(`${root}${dir}/package.json`, "utf8")) as {
      name: string;
      private?: boolean;
      exports?: unknown;
    };
    assert.equal(manifest.name, `@-apps/${dir.slice("www/".length).replaceAll("/", ".")}`);
    assert.equal(manifest.private, true, dir);
    assert.deepEqual(manifest.exports, {}, dir);
    siteNames.add(manifest.name);
  }

  const manifests = globSync(
    ["package.json", "apps/*/package.json", "packages/**/package.json", "www/**/package.json"],
    { cwd: root, exclude: ["**/node_modules/**", "**/__tests__/**"] },
  );
  for (const path of manifests) {
    const manifest = JSON.parse(readFileSync(`${root}${path}`, "utf8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
    };
    for (const dependencies of [
      manifest.dependencies,
      manifest.devDependencies,
      manifest.optionalDependencies,
      manifest.peerDependencies,
    ]) {
      for (const name of Object.keys(dependencies ?? {})) {
        assert.ok(!siteNames.has(name), `${path} declares a dependency on site ${name}`);
      }
    }
  }
});
