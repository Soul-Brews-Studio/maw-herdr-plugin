import { createHash } from 'node:crypto';

/** Process-local receipts; an in-flight duplicate is queued, not completed. */
export function createDeliveryDedup(now: () => number = Date.now) {
  type Record = { state: string; seen: number };
  const records = new Map<string, Record>();
  return {
    key(source: string, target: string, logical: string, payload: string): string | undefined {
      source = source.trim(); target = target.trim(); logical = logical.trim();
      if (!source || !target || !logical) return undefined;
      return createHash('sha256').update(JSON.stringify([source, target, logical, payload])).digest('hex');
    },
    claim(key: string) {
      const time = now();
      for (const [key, value] of records) if (value.state && time - value.seen > 86_400_000) records.delete(key);
      const previous = records.get(key);
      if (previous) return { duplicate: previous.state || 'queued' };
      if (records.size >= 2048) throw new Error('delivery deduplication capacity reached');
      const owner: Record = { state: '', seen: time }; records.set(key, owner);
      return {
        complete(state: string) { if (records.get(key) === owner) { owner.state = state; owner.seen = now(); } },
        cancel() { if (records.get(key) === owner && !owner.state) records.delete(key); },
      };
    },
  };
}
