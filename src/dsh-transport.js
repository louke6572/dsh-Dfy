// Plugin-owned HTTP transport. Do not import DSH host packages here: their
// transitive core plugins can shadow the running host during plugin discovery.
import { randomUUID } from 'node:crypto';

// Preserve the bridge's existing bound domain methods; protocol adaptation lives
// in NodeApiClient.callUnary, not in version-specific host response schemas.
const DOMAINS = {
  sessions: ['session', 'list search create history models selectModel rename fork prompt attachment updateQueue cancel'],
  subagents: ['subagent', 'list history prompt interrupt'],
  host: ['host', 'describe pickDirectory listDirectory createDirectory openPath'],
  workspace: ['workspace', 'list create rename delete insertBefore insertSessionBefore archiveSession'],
  skills: ['skill', 'list'],
  goals: ['goal', 'create edit pause resume complete clear'],
  settings: ['settings', 'describe openDocument update replace mutate'],
  credentials: ['credentials', 'describe set unset'],
  llm: ['llm', 'providers models discoverModels'],
};

export class DshTransport {
  constructor(timeoutMs = 30_000) {
    this.timeoutMs = timeoutMs;
    this.envelopeListeners = new Set();
    this.envelopeBatch = [];
    this.flushScheduled = false;
    for (const [name, [endpoint, methods]] of Object.entries(DOMAINS)) {
      this[name] = Object.fromEntries(methods.split(' ').map(method => [method,
        (payload, signal) => this.callUnary(`${endpoint}.${method}`, payload, signal,
          name === 'host' && method === 'pickDirectory' ? 'caller-signal-only' : 'default')
      ]));
    }
  }

  mintRpcId() { return randomUUID(); }

  subscribeEnvelopes(listener) {
    this.envelopeListeners.add(listener);
    return () => this.envelopeListeners.delete(listener);
  }

  onEnvelope(message) {
    if (!this.envelopeListeners.size) return;
    this.envelopeBatch.push(message);
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    queueMicrotask(() => {
      this.flushScheduled = false;
      const batch = this.envelopeBatch;
      this.envelopeBatch = [];
      for (const listener of this.envelopeListeners) {
        try { listener(batch); }
        catch (error) { console.error('[dsh-client] envelope listener threw:', error); }
      }
    });
  }

  async postJson(path, body, signal, timeoutPolicy = 'default') {
    const requestSignal = timeoutPolicy === 'default'
      ? signal === undefined ? AbortSignal.timeout(this.timeoutMs)
        : AbortSignal.any([AbortSignal.timeout(this.timeoutMs), signal])
      : signal;
    requestSignal?.throwIfAborted();
    const response = await this.doFetch(new URL(path, this.resolveBase()), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      ...(requestSignal === undefined ? {} : { signal: requestSignal }),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`transport failure for ${path}: HTTP ${response.status}`);
    }
    return response;
  }
}
