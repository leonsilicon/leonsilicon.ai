import assert from "node:assert/strict";
import { test } from "node:test";
import { deploy } from "#deploy";

const plugins = [
  {
    name: "leon",
    mirror: "https://github.com/leonsiliconAI/hermes-plugin-leon",
    commit: "b".repeat(40),
  },
];

function hermes(answers: (Response | Error)[]) {
  const requests: { url: string; init?: RequestInit }[] = [];
  const fetch = async (url: string | URL | Request, init?: RequestInit) => {
    requests.push({
      url: typeof url === "string" ? url : url instanceof URL ? url.href : url.url,
      init,
    });
    const answer = answers.shift();
    if (!answer) throw new Error("no more answers");
    if (answer instanceof Error) throw answer;
    return answer;
  };
  return { fetch: fetch as typeof globalThis.fetch, requests };
}

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });

test("a deploy is posted with the token, then followed through a dashboard restart to its end", async () => {
  const { fetch, requests } = hermes([
    json({ id: "d1", status: "queued", log: [] }),
    json({ id: "d1", status: "installing", log: ["installing leon"] }),
    new Error("connection refused"),
    json({ id: "d1", status: "done", log: ["installing leon", "gateway restarted as 2"] }),
  ]);
  const lines: string[] = [];
  const record = await deploy({
    url: "https://hermes.example/",
    token: "t0k",
    plugins,
    source: "c".repeat(40),
    fetch,
    sleep: async () => {},
    log: (line) => lines.push(line),
  });
  assert.equal(record.status, "done");
  assert.equal(requests[0]!.url, "https://hermes.example/api/plugins/autodeploy/deploy");
  assert.equal(requests[0]!.init?.method, "POST");
  assert.deepEqual(JSON.parse(requests[0]!.init?.body as string).plugins, plugins);
  assert.equal(new Headers(requests[0]!.init?.headers).get("authorization"), "Bearer t0k");
  assert.equal(requests[1]!.url, "https://hermes.example/api/plugins/autodeploy/deploy?id=d1");
  // Each log line is printed once.
  assert.equal(lines.filter((line) => line === "installing leon").length, 1);
  assert.ok(lines.includes("gateway restarted as 2"));
});

test("a refused deploy throws with Hermes's answer", async () => {
  const { fetch } = hermes([json({ detail: { errors: ["leon isn't installed"] } }, 400)]);
  await assert.rejects(
    deploy({ url: "https://h", token: "t", plugins, source: "c", fetch, log: () => {} }),
    /refused the deploy \(400\).*isn't installed/,
  );
});

test("a failed step's output is printed, and a deploy that never ends times out", async () => {
  const lines: string[] = [];
  const failed = hermes([
    json({
      id: "d2",
      status: "failed",
      log: [],
      steps: [{ name: "leon", ok: false, error: "exited 1", output: "boom" }],
    }),
  ]);
  const record = await deploy({
    url: "https://h",
    token: "t",
    plugins,
    source: "c",
    fetch: failed.fetch,
    log: (l) => lines.push(l),
  });
  assert.equal(record.status, "failed");
  assert.ok(lines.some((line) => line.includes("leon failed: exited 1") && line.includes("boom")));

  let clock = 0;
  const stuck = hermes([
    json({ id: "d3", status: "restarting", log: [] }),
    json({ id: "d3", status: "restarting", log: [] }),
  ]);
  await assert.rejects(
    deploy({
      url: "https://h",
      token: "t",
      plugins,
      source: "c",
      fetch: stuck.fetch,
      log: () => {},
      sleep: async () => {
        clock += 30 * 60_000;
      },
      now: () => clock,
      timeout: 40 * 60_000,
    }),
    /still restarting after 40 minutes/,
  );
});
