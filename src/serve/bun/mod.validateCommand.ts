export interface Command {
  type?: string; target?: string; targets?: string[]; scope?: string; text?: string;
  command?: string; content?: string;
  force?: boolean; inbox?: boolean; attachments?: string[];
}

export function validateCommand(value: unknown, socket = false): Command {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_json');
  const strings = socket ? ['type', 'target', 'scope', 'text'] : ['target', 'text'];
  const lists = socket ? ['targets', 'attachments'] : ['attachments'];
  for (const [key, item] of Object.entries(value)) {
    if (key === 'command' && socket && 'type' in value && value.type === 'wake') { if (typeof item !== 'string') throw new Error('invalid_json'); }
    else if (key === 'content' && socket && 'type' in value && value.type === 'send') { if (item !== null && typeof item !== 'string') throw new Error('invalid_json'); }
    else if (strings.includes(key)) { if (item !== null && typeof item !== 'string') throw new Error('invalid_json'); }
    else if (lists.includes(key)) { if (item !== null && (!Array.isArray(item) || item.some(v => typeof v !== 'string'))) throw new Error('invalid_json'); }
    else if (['force', 'inbox'].includes(key)) { if (item !== null && typeof item !== 'boolean') throw new Error('invalid_json'); }
    else throw new Error('invalid_json');
  }
  return value as Command;
}
