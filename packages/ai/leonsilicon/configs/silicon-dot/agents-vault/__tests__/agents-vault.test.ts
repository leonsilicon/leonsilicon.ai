import assert from "node:assert/strict";
import { test } from "node:test";
import { isSecret, matchItem, originAllowed, redact, selectField, type Item } from "#agents-vault";

const uoft: Item = {
  id: "uoftid",
  title: "University of Toronto (UofT)",
  category: "LOGIN",
  urls: [{ href: "https://utoronto.ca" }, { href: "https://duosecurity.com" }],
  fields: [
    { id: "username", type: "STRING", purpose: "USERNAME", label: "username", value: "utorid" },
    {
      id: "password",
      type: "CONCEALED",
      purpose: "PASSWORD",
      label: "password",
      value: "hunter2!",
    },
    {
      id: "notesPlain",
      type: "STRING",
      purpose: "NOTES",
      label: "notesPlain",
      value: "bypass codes",
    },
    { id: "TOTP_x", type: "OTP", label: "one-time password", value: "otpauth://…", totp: "123456" },
    { id: "abc", type: "STRING", label: "student number", value: "1010101010" },
  ],
};
const items: Item[] = [
  uoft,
  { id: "markusid", title: "MarkUs", category: "LOGIN" },
  { id: "tdid", title: "TD", category: "LOGIN" },
];

test("items match by ID, exact title, then a unique title fragment", () => {
  assert.equal(matchItem(items, "markusid").title, "MarkUs");
  assert.equal(matchItem(items, "td").title, "TD");
  assert.equal(matchItem(items, "UofT").id, "uoftid");
  assert.throws(() => matchItem(items, "u"), /matches 2 items/);
  assert.throws(() => matchItem(items, "gmail"), /No item matching/);
});

test("fields resolve by purpose, OTP type, or label, and notes are never selectable", () => {
  assert.equal(selectField(uoft, "username").value, "utorid");
  assert.equal(selectField(uoft, "Password").id, "password");
  assert.equal(selectField(uoft, "otp").totp, "123456");
  assert.equal(selectField(uoft, "student number").id, "abc");
  assert.throws(() => selectField(uoft, "notesPlain"), /no field/);
});

test("passwords, concealed fields and one-time codes count as secrets", () => {
  assert.ok(isSecret(selectField(uoft, "password")));
  assert.ok(isSecret(selectField(uoft, "otp")));
  assert.ok(!isSecret(selectField(uoft, "username")));
});

test("filling is limited to HTTPS pages on an item's saved hosts and their subdomains", () => {
  const saved = (uoft.urls ?? []).map((u) => u.href);
  assert.ok(originAllowed("https://idpz.utorauth.utoronto.ca/idp/profile/SAML2", saved));
  assert.ok(originAllowed("https://api-832cdf07.duosecurity.com/prompt/x", saved));
  assert.ok(originAllowed("https://utoronto.ca/", saved));
  assert.ok(!originAllowed("http://idpz.utorauth.utoronto.ca/", saved));
  assert.ok(!originAllowed("https://utoronto.ca.evil.example/", saved));
  assert.ok(!originAllowed("https://notutoronto.ca/", saved));
  assert.ok(!originAllowed("not a url", saved));
});

test("redaction covers raw and escaped forms of each secret", () => {
  const secret = `it's\\"x`;
  const printed = `fill('${secret.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}') ${JSON.stringify(secret)} ${secret}`;
  const out = redact(printed, [secret]);
  assert.ok(!out.includes("it's") && !out.includes("it\\'s"), out);
  assert.equal(redact("abc", ["abc"]), "abc", "secrets under four characters are left alone");
});
