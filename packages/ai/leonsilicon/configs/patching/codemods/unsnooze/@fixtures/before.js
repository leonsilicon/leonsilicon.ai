export const patterns = {
  busyPatterns: [
    /esc to interrupt/i,
    /\besc\b.*\binterrupt\b/i,
    /Retrying in\b/i,
    /\battempt\s+\d+\/\d+/i,
  ],
  overloadPatterns: [
    /API Error:?\s*\(?5\d\d/i,
    /overloaded_error/i,
    /API Error:?\s*\(?429/i,
    /temporarily limiting requests/i,
  ],
};
