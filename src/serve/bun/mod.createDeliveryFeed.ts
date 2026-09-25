export type DeliveryEvent = {
  event?: string; decision?: string; timestamp: number; kind: string; direction: string; state: string; route: string;
  from: string; to: string; target: string; text: string; oracle: string; source: string; error?: string; lastLine?: string;
};

/** Delivery history, not observed tool-hook/status projection. */
export function createDeliveryFeed() {
  const events: DeliveryEvent[] = [];
  const truncate = (value: string, max: number) => Buffer.byteLength(value) <= max ? value : [...value].slice(0, max - 1).join('') + '…';
  return {
    append(event: DeliveryEvent) {
      events.push({ ...event, text: truncate(event.text, 2000), from: truncate(event.from, 2000), to: truncate(event.to, 2000), ...(event.error === undefined ? {} : { error: truncate(event.error, 1000) }), ...(event.lastLine === undefined ? {} : { lastLine: truncate(event.lastLine, 2000) }) });
      if (events.length > 200) events.splice(0, events.length - 200);
    },
    snapshot(limit?: number) {
      const selected = (limit === undefined || limit < 0 || limit >= events.length ? events : events.slice(events.length - limit)).map(event => ({ ...event }));
      return { events: selected, total: selected.length, active_oracles: [...new Set(selected.map(event => event.oracle))] };
    },
  };
}
