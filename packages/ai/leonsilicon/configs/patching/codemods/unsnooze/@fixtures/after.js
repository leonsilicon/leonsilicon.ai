export const patterns = {
  busyPatterns: [
    /esc to interrupt/i,
    /\besc\b.*\binterrupt\b/i,
    /Retrying in\b/i,
    /Waiting for API response\b/i,
    /\battempt\s+\d+\/\d+/i,
  ],
  overloadPatterns: [
    /API Error:?\s*\(?5\d\d/i,
    /overloaded_error/i,
    /API Error:?\s*\(?429/i,
    // A dropped stream has no HTTP status. Match Claude's error line, not
    // quoted examples; the rest of the message may wrap onto another row.
    /^\s*(?:[⏺●•]\s*)?API Error:?\s*Connection lost\b/i,
    /temporarily limiting requests/i,
  ],
};
