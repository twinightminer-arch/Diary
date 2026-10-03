// SPDX-License-Identifier: AGPL-3.0-only
export const capabilities = [
  'entries:read', 'entries:create', 'entries:update', 'entries:delete',
  'agent:invoke', 'media:generate', 'web:search', 'layout:apply',
] as const;
export type Capability = typeof capabilities[number];
export interface SkillDefinition {
  readonly id: string;
  readonly description: string;
  readonly instructions: string;
  readonly capabilities: readonly Capability[];
}
export interface SkillContext {
  readonly signal: AbortSignal;
  call(capability: Capability, input: unknown): Promise<unknown>;
}
export interface SkillModule {
  readonly definition: SkillDefinition;
  run(input: unknown, context: SkillContext): Promise<unknown>;
}
export type AgentEvent = Readonly<{
  phase: 'before' | 'after' | 'error'; skillId: string; executionId: string;
}>;
export type AgentHook = (event: AgentEvent) => void | Promise<void>;
export type CapabilityHandler = (input: unknown, signal: AbortSignal) => Promise<unknown>;
type Registration = { module: SkillModule; grants: ReadonlySet<Capability> };

/** Trusted, pre-imported modules only. Capability checks are not a JS sandbox. */
export class SkillEngine {
  #skills = new Map<string, Registration>();
  #hooks = new Set<AgentHook>();
  #handlers: Readonly<Partial<Record<Capability, CapabilityHandler>>>;
  constructor(handlers: Partial<Record<Capability, CapabilityHandler>>) {
    this.#handlers = Object.freeze({ ...handlers });
  }
  load(module: SkillModule, grants: readonly Capability[]): () => void {
    const definition = module.definition;
    if (!definition || !/^[a-z][a-z0-9.-]{0,63}$/.test(definition.id) ||
        typeof definition.description !== 'string' || typeof definition.instructions !== 'string' ||
        !Array.isArray(definition.capabilities) || typeof module.run !== 'function' ||
        definition.capabilities.some(c => !capabilities.includes(c))) {
      throw new TypeError('Invalid skill module');
    }
    if (this.#skills.has(definition.id)) throw new Error(`Duplicate skill: ${definition.id}`);
    const allowed = new Set(definition.capabilities.filter(c => grants.includes(c)));
    const snapshot = Object.freeze({ ...definition, capabilities: Object.freeze([...definition.capabilities]) });
    const registration: Registration = {
      module: Object.freeze({ definition: snapshot, run: module.run.bind(module) }), grants: allowed,
    };
    this.#skills.set(snapshot.id, registration);
    return () => {
      if (this.#skills.get(snapshot.id) === registration) this.#skills.delete(snapshot.id);
    };
  }
  list(): readonly SkillDefinition[] {
    return Object.freeze([...this.#skills.values()].map(({ module }) => module.definition));
  }
  onAgent(hook: AgentHook): () => void {
    this.#hooks.add(hook);
    return () => { this.#hooks.delete(hook); };
  }
  async #emit(event: AgentEvent): Promise<void> {
    // Observers cannot veto executions or convert successful writes into failures.
    await Promise.allSettled([...this.#hooks].map(hook => Promise.resolve().then(() => hook(Object.freeze(event)))));
  }
  async execute(id: string, input: unknown, signal = new AbortController().signal): Promise<unknown> {
    const registration = this.#skills.get(id);
    if (!registration) throw new Error(`Unknown skill: ${id}`);
    signal.throwIfAborted();
    const event = { skillId: id, executionId: crypto.randomUUID() };
    let active = true;
    const context: SkillContext = Object.freeze({
      signal,
      call: async (capability: Capability, payload: unknown) => {
        signal.throwIfAborted();
        if (!active || this.#skills.get(id) !== registration) throw new Error('Skill execution is inactive');
        if (!registration.grants.has(capability)) throw new Error(`Permission denied: ${capability}`);
        const handler = this.#handlers[capability];
        if (!handler) throw new Error(`Unavailable capability: ${capability}`);
        return handler(payload, signal);
      },
    });
    try {
      await this.#emit({ ...event, phase: 'before' });
      signal.throwIfAborted();
      if (this.#skills.get(id) !== registration) throw new Error('Skill unloaded');
      const result = await registration.module.run(input, context);
      active = false;
      await this.#emit({ ...event, phase: 'after' });
      return result;
    } catch (error) {
      active = false;
      await this.#emit({ ...event, phase: 'error' });
      throw error;
    }
  }
}
