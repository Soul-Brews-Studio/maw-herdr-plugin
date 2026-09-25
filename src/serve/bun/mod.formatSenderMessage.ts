/**
 * The `[node:oracle] ` tag legacy `POST /api/send` put in front of every normal
 * delivery (maw-rs 76f1308 sender_identity.rs format_local_hey_message).
 *
 * `rawFrom` is the X-Maw-From header in WIRE order, `oracle:node`; it is shown
 * in human order, `node:oracle`, so a local and a federated delivery from the
 * same sender carry the same tag (maw-rs #795). A header that is not
 * `oracle:node` falls back to this server's own identity, exactly as legacy
 * did. The header is display attribution under operator auth, not a verified
 * identity.
 *
 * Text starting with `/` is passed through untouched so slash commands still
 * run. This applies to the joined message, so an attachment-first message
 * whose first attachment is an absolute path is also untagged: that is the
 * legacy rule, kept for parity.
 */
export function formatSenderMessage(text: string, rawFrom: string, localIdentity: string): string {
  if (text.startsWith('/')) return text;
  const colon = rawFrom.indexOf(':');
  const oracle = colon >= 0 ? rawFrom.slice(0, colon) : '', node = colon >= 0 ? rawFrom.slice(colon + 1) : '';
  return `[${oracle && node ? `${node}:${oracle}` : localIdentity}] ${text}`;
}
