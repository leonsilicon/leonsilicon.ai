/** Neutralizes Slack control sequences such as `<!channel>` or `<@U123>` in text written by contacts. */
export function escapeSlack(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const REASON_LABELS: Record<string, string> = {
  ok: "ok",
  prompt_injection: "tries to instruct an AI",
  credential_or_code_request: "asks for a password, code or access",
  phishing_or_malicious_link: "phishing or a suspicious link",
  scam_or_fraud: "scam or fraud",
  impersonation: "impersonation",
  threat_or_harassment: "threat or harassment",
  promotion: "promotion",
  bulk_or_automated: "bulk or automated",
  other: "other",
  screener_unavailable: "the screener couldn't check it, so it's held to be safe",
  screener_refused: "the screener refused to judge it",
};

export const reasonLabel = (reason: string): string => REASON_LABELS[reason] ?? reason;
