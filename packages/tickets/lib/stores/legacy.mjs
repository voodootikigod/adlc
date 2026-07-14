import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { LEGACY_FILE } from '../constants.mjs';
import { invalid, operational } from '../errors.mjs';
import { prettyCanonicalJson } from '../canonical.mjs';
import { validateTickets } from '../schema.mjs';
import { TicketSnapshot } from '../snapshot.mjs';
import { durableMkdir, durableRename, durableWrite } from '../durability.mjs';

export class LegacyTicketStore {
  constructor(path = LEGACY_FILE) {
    this.path = path;
  }

  exists() {
    return existsSync(this.path);
  }

  load() {
    if (!this.exists()) throw operational('STORE_NOT_FOUND', `tickets file not found: ${this.path}`);
    const stat = lstatSync(this.path);
    if (stat.isSymbolicLink() || !stat.isFile()) throw invalid('UNSAFE_STORE_PATH', `${this.path} must be a regular file`);
    const parentStat = lstatSync(dirname(this.path));
    if (parentStat.isSymbolicLink() || !parentStat.isDirectory()) throw invalid('UNSAFE_STORE_PATH', `${dirname(this.path)} must be a real directory`);
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(this.path, 'utf8'));
    } catch (error) {
      throw invalid('INVALID_JSON', `invalid JSON in ${this.path}: ${error.message}`);
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !Array.isArray(parsed.tickets)) {
      throw invalid('INVALID_ENVELOPE', `${this.path} must contain { "tickets": [...] }`);
    }
    validateTickets(parsed.tickets);
    return new TicketSnapshot({ backend: 'legacy', formatVersion: 0, tickets: parsed.tickets });
  }

  write(tickets) {
    validateTickets(tickets);
    durableMkdir(dirname(this.path));
    const temporary = `${this.path}.tmp.${process.pid}`;
    durableWrite(temporary, prettyCanonicalJson({ tickets }));
    durableRename(temporary, this.path);
    return this.load();
  }
}
