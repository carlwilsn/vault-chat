// Schedule-delivery gating — channel-agnostic. Decides WHETHER a scheduled run's
// reply should be delivered to the user (the Alerts feed / Web Push), and what
// text to deliver. This is independent of any transport; it used to live in the
// Telegram module but the logic is about silence-vs-alert, not about Telegram.

// A scheduled run emits exactly this as its whole reply when there's nothing
// worth interrupting the user for. Delivery is suppressed (see isSilentReply).
export const SILENT_REPLY_SENTINEL = "[[SILENT]]";

export function isSilentReply(text: string): boolean {
  return text.trim().toUpperCase() === SILENT_REPLY_SENTINEL;
}

// Default-silent marker for "quiet unless alert" schedules (a supervisor). The
// run is delivered ONLY when its reply explicitly contains `ALERT:` — the text
// after the marker is the message. No marker → nothing is sent. This makes
// silence the DEFAULT, so a chatty "nothing's running" reply can't spam the
// user — far more robust than relying on the model to emit an exact silent
// token (which it won't always do).
export const ALERT_PREFIX = "ALERT:";

export function extractAlert(text: string): string | null {
  const idx = text.toUpperCase().indexOf(ALERT_PREFIX);
  if (idx < 0) return null;
  const msg = text.slice(idx + ALERT_PREFIX.length).trim();
  return msg.length > 0 ? msg : null;
}

// The text to actually deliver for a scheduled reply, or null to stay silent.
// Quiet schedules deliver only an explicit ALERT:; normal ones deliver
// everything except the legacy [[SILENT]] sentinel.
export function scheduledDeliveryText(
  reply: string,
  quietUnlessAlert: boolean,
): string | null {
  if (quietUnlessAlert) return extractAlert(reply);
  return isSilentReply(reply) ? null : reply;
}
