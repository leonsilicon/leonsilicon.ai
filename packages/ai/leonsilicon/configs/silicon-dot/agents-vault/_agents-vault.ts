#!/usr/bin/env node
import { parseArgs } from "node:util";
import { fill, getItem, isSecret, listItems, matchItem, op, VAULT } from "#agents-vault";
import { uoftLogin } from "#uoft-login";

const usage = `agents-vault: read-only access to Leon's 1Password "${VAULT}" vault (service account "Silicon Dot").

  agents-vault check
      Confirm the service account works and show which vaults it can see.
  agents-vault items
      List items and their saved websites. No secrets.
  agents-vault fields <item>
      List an item's fields by label. No values.
  agents-vault fill <session> <target> <item> <field> [--submit | --click <target>]
      Type a field into a camoufox-browser element without printing it. <field> is
      username, password, otp, or a field label. Secrets need --submit or --click.
  agents-vault uoft-login [--url <url>] [--session uoft] [--no-persist]
      Sign in to UofT (UTORid weblogin + Duo passcode) in a camoufox-browser session.
  agents-vault op <op arguments>
      Run the 1Password CLI as the service account. Its output can contain secrets.
`;

function fail(message: string): never {
  console.error(`agents-vault: ${message}`);
  process.exit(1);
}

const [command, ...rest] = process.argv.slice(2);

try {
  switch (command) {
    case "check": {
      const whoami = op(["whoami", "--format", "json"]);
      const user = JSON.parse(whoami) as { user_type?: string };
      const vaults = (
        JSON.parse(op(["vault", "list", "--format", "json"])) as { name: string }[]
      ).map((v) => v.name);
      console.log(
        `Signed in as a ${user.user_type ?? "unknown"} account. Vaults visible: ${vaults.join(", ")}.`,
      );
      if (user.user_type !== "SERVICE_ACCOUNT" || vaults.join() !== VAULT) {
        fail(`expected a service account that sees only ${VAULT}`);
      }
      break;
    }
    case "items": {
      for (const item of listItems()) {
        const hosts = (item.urls ?? []).map((u) => {
          try {
            return new URL(u.href).host;
          } catch {
            return u.href;
          }
        });
        console.log(`${item.title}  [${item.id}]  ${hosts.join(", ")}`);
      }
      break;
    }
    case "fields": {
      if (rest.length !== 1) fail(`usage: agents-vault fields <item>`);
      const item = getItem(matchItem(listItems(), rest[0]!).id);
      console.log(item.title);
      for (const field of item.fields ?? []) {
        if (field.purpose === "NOTES") continue;
        const name =
          field.purpose === "USERNAME" || field.purpose === "PASSWORD"
            ? field.purpose.toLowerCase()
            : field.type === "OTP"
              ? "otp"
              : (field.label ?? field.id);
        console.log(
          `  ${name}${isSecret(field) ? "  (secret: fill with --submit or --click)" : ""}`,
        );
      }
      break;
    }
    case "fill": {
      const { values, positionals } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: { submit: { type: "boolean" }, click: { type: "string" } },
      });
      if (positionals.length !== 4)
        fail(
          `usage: agents-vault fill <session> <target> <item> <field> [--submit | --click <target>]`,
        );
      const [session, target, item, field] = positionals as [string, string, string, string];
      const result = await fill(session, target, item, field, {
        submit: values.submit,
        click: values.click,
      });
      console.log(`Filled ${result.item} "${result.field}" on ${result.host}.`);
      if (result.cleared) {
        console.log(
          `The page didn't move on after submitting, so the value was cleared from it. Snapshot to see what the site said.`,
        );
      }
      break;
    }
    case "uoft-login": {
      const { values } = parseArgs({
        args: rest,
        options: {
          url: { type: "string" },
          session: { type: "string" },
          "no-persist": { type: "boolean" },
        },
      });
      const result = await uoftLogin({
        url: values.url,
        session: values.session,
        persistent: !values["no-persist"],
        log: (line) => console.error(line),
      });
      console.log(`Signed in. Now on "${result.title}" at ${result.href}`);
      console.log(`Continue with: camoufox-browser -s=${values.session ?? "uoft"} snapshot`);
      break;
    }
    case "op": {
      op(rest, { inherit: true });
      break;
    }
    case undefined:
    case "help":
    case "--help":
    case "-h":
      console.log(usage);
      break;
    default:
      fail(`unknown command "${command}"\n\n${usage}`);
  }
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
