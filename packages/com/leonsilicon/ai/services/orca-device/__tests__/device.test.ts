import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { startForwarder } from "#forward";
import { ensureLink, readLinkStatus, startLink } from "#link";
import { devicePaths, readDeviceConfig, readEnvValue } from "#paths";

// Stands in for `tailscale nc <host> <port>`: a plain TCP connection piped to stdin/stdout.
const DIAL = [
  process.execPath,
  "-e",
  "const s=require('net').connect(+process.argv[2],process.argv[1]);process.stdin.pipe(s);s.pipe(process.stdout);s.on('close',()=>process.exit(0));s.on('error',()=>process.exit(1))",
];

async function echoServer(): Promise<{ port: number; close(): void }> {
  const server = net.createServer((socket) => socket.pipe(socket));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { port: (server.address() as net.AddressInfo).port, close: () => server.close() };
}

async function freePort(): Promise<number> {
  const probe = net.createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address() as net.AddressInfo;
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

function roundTrip(port: number, text: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1", () => socket.write(text));
    socket.once("data", (chunk) => {
      resolve(chunk.toString("utf8"));
      socket.end();
    });
    socket.on("error", reject);
  });
}

test("forwarder carries a loopback connection to the peer through the dial command", async () => {
  const echo = await echoServer();
  const listenPort = await freePort();
  // The forwarder listens on loopback:<peer port> and dials <peer address> <peer port>. Here the
  // stand-in dial goes to the echo server on another port, as `tailscale nc` reaches the Mac.
  const seen: string[] = [];
  const recordingDial = [
    process.execPath,
    "-e",
    `require('fs').appendFileSync(${JSON.stringify(join(tmpdir(), `od-dial-${process.pid}.log`))}, process.argv.slice(1).join(' ')+'\\n');const s=require('net').connect(${echo.port},'127.0.0.1');process.stdin.pipe(s);s.pipe(process.stdout);s.on('close',()=>process.exit(0))`,
  ];
  const live = startForwarder(
    { name: "Mac", address: "100.64.0.1", port: listenPort, loopback: "127.0.0.1" },
    recordingDial,
    () => undefined,
  );
  await live.ready;
  assert.equal(await roundTrip(listenPort, "ping over the tailnet"), "ping over the tailnet");
  assert.equal(live.stats.connections, 1);
  seen.push(
    ...readFileSync(join(tmpdir(), `od-dial-${process.pid}.log`), "utf8")
      .trim()
      .split("\n"),
  );
  assert.deepEqual(seen, [`100.64.0.1 ${listenPort}`], "dials the peer's tailnet address and port");
  live.server.close();
  echo.close();
  assert.ok(DIAL.length === 3);
});

test("link daemon: one owner, status file, peers listening, clean stop", async () => {
  const home = mkdtempSync(join(tmpdir(), "od-"));
  const env = { HOME: home, HERMES_HOME: home, PATH: process.env.PATH } as NodeJS.ProcessEnv;
  const paths = devicePaths(env);
  mkdirSync(paths.home, { recursive: true });
  const echo = await echoServer();
  const port = await freePort();
  writeFileSync(
    paths.config,
    JSON.stringify({
      hostname: "hermes-test",
      defaultEnvironment: "Mac mini",
      peers: [{ name: "Mac mini", address: "127.0.0.1", port, loopback: "127.0.0.1" }],
    }),
  );
  writeFileSync(paths.hermesEnv, "ORCA_DEVICE_TS_AUTHKEY='tskey-test'\nOTHER=x\n");
  assert.equal(readEnvValue(paths.hermesEnv, "ORCA_DEVICE_TS_AUTHKEY"), "tskey-test");
  assert.equal(readDeviceConfig(paths.config).defaultEnvironment, "Mac mini");

  const dialToEcho = [
    process.execPath,
    "-e",
    `const s=require('net').connect(${echo.port},'127.0.0.1');process.stdin.pipe(s);s.pipe(process.stdout);s.on('close',()=>process.exit(0))`,
  ];
  const link = await startLink({
    env,
    embedded: true,
    noTailscale: true,
    dial: dialToEcho,
    pollMs: 50,
  });
  assert.ok(link);
  assert.equal(
    await startLink({ env, embedded: true, noTailscale: true, dial: dialToEcho }),
    null,
    "a second owner is refused",
  );
  assert.equal(await roundTrip(port, "hello mini"), "hello mini");
  const status = readLinkStatus(paths);
  assert.equal(status?.pid, process.pid);
  assert.equal(status?.peers[0]?.listening, true);
  await link.stop();
  assert.ok(JSON.parse(readFileSync(paths.status, "utf8")));
  const again = await startLink({ env, embedded: true, noTailscale: true, dial: dialToEcho });
  assert.ok(again, "the lock is free after a clean stop");
  await again.stop();
  echo.close();
});

test("ensureLink works on a fresh home (no state directory yet)", async () => {
  const home = mkdtempSync(join(tmpdir(), "od-"));
  const paths = devicePaths({ HOME: home, HERMES_HOME: home } as NodeJS.ProcessEnv);
  // A command that exits at once: ensureLink must get as far as spawning it, then report no link.
  assert.equal(await ensureLink(paths, [process.execPath, "-e", ""], { HOME: home }, 500), null);
});

test("device config refuses non-loopback listen addresses", () => {
  const home = mkdtempSync(join(tmpdir(), "od-"));
  const file = join(home, "device.json");
  writeFileSync(
    file,
    JSON.stringify({ peers: [{ name: "MacBook", address: "100.64.0.2", loopback: "0.0.0.0" }] }),
  );
  assert.throws(() => readDeviceConfig(file), /127\.x\.y\.z/);
});
