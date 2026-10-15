import { randomUUID } from 'node:crypto';

// P1 only. No refresh, disk persistence, environment lookup, or shared browser session.
// A production implementation must encrypt recoverable session material separately
// from the connection store and serialize refresh per credential reference.
export class MemorySessionStore {
  #sessions = new Map();
  async put(session) {
    const reference = randomUUID();
    this.#sessions.set(reference, structuredClone(session));
    return reference;
  }
  async get(reference) {
    const session = this.#sessions.get(reference);
    return session ? structuredClone(session) : null;
  }
  async delete(reference) { this.#sessions.delete(reference); }
}

export class MemoryConnectionStore {
  #connections = new Map();
  #digests = new Map();
  async create(connection) {
    if (this.#connections.has(connection.id) || this.#digests.has(connection.tokenDigest)) {
      throw new Error('duplicate_connection');
    }
    this.#connections.set(connection.id, structuredClone(connection));
    this.#digests.set(connection.tokenDigest, connection.id);
  }
  async get(id) {
    const value = this.#connections.get(id);
    return value ? structuredClone(value) : null;
  }
  async getByDigest(digest) {
    return this.get(this.#digests.get(digest));
  }
  async delete(id) {
    const previous = this.#connections.get(id);
    if (previous) this.#digests.delete(previous.tokenDigest);
    this.#connections.delete(id);
  }
  // Compare-and-swap is also required of a durable implementation.
  async replace(id, expectedEpoch, next) {
    const previous = this.#connections.get(id);
    if (!previous || previous.epoch !== expectedEpoch) return false;
    this.#digests.delete(previous.tokenDigest);
    this.#connections.set(id, structuredClone(next));
    this.#digests.set(next.tokenDigest, id);
    return true;
  }
}

export class MemoryAssistantStore {
  #assistants = new Map();
  async getOrCreate(userId, organizationId) {
    const key = `${userId}:${organizationId}`;
    if (!this.#assistants.has(key)) this.#assistants.set(key, randomUUID());
    return this.#assistants.get(key);
  }
}
