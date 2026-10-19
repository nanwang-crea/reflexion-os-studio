/** Receipts contain hashes and status only, never mutation parameters or results. */
export const OPERATION_RECEIPTS_SCHEMA = `
CREATE TABLE IF NOT EXISTS operation_receipts (
  request_key TEXT PRIMARY KEY,
  fingerprint TEXT NOT NULL,
  snapshot_json TEXT NOT NULL
);
`

/** Invalidate only when a canonical mutation touches the checkpoint's prefix. */
export const CHECKPOINT_INVALIDATION_SCHEMA = [
  ...['INSERT', 'UPDATE', 'DELETE'].map((operation) => {
    const refs =
      operation === 'INSERT'
        ? ['NEW']
        : operation === 'DELETE'
          ? ['OLD']
          : ['OLD', 'NEW']
    const scopes = refs
      .map(
        (ref) =>
          `(${ref}.session_id = context_checkpoints.session_id AND (${ref}.created_at, ${ref}.rowid) <= (SELECT created_at, rowid FROM messages WHERE id = context_checkpoints.through_message_id))`,
      )
      .join(' OR ')
    return (
      `CREATE TRIGGER IF NOT EXISTS checkpoint_messages_${operation.toLowerCase()} BEFORE ${operation} ON messages BEGIN
      DELETE FROM context_checkpoints WHERE ${scopes}; END;`
        // NEW.rowid is undefined in BEFORE INSERT; insertion must be observed after allocation.
        .replace('BEFORE INSERT', 'AFTER INSERT')
    )
  }),
  ...['INSERT', 'UPDATE', 'DELETE'].map((operation) => {
    const refs =
      operation === 'INSERT'
        ? ['NEW']
        : operation === 'DELETE'
          ? ['OLD']
          : ['OLD', 'NEW']
    const scopes = refs
      .map(
        (
          ref,
        ) => `EXISTS (SELECT 1 FROM messages m JOIN messages watermark ON watermark.id = context_checkpoints.through_message_id
      WHERE m.id = ${ref}.message_id AND m.session_id = context_checkpoints.session_id AND (m.created_at, m.rowid) <= (watermark.created_at, watermark.rowid))`,
      )
      .join(' OR ')
    return `CREATE TRIGGER IF NOT EXISTS checkpoint_tools_${operation.toLowerCase()} BEFORE ${operation} ON tool_calls BEGIN
      DELETE FROM context_checkpoints WHERE ${scopes}; END;`
  }),
].join('\n')
