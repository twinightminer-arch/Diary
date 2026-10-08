import { test } from 'node:test';
import assert from 'node:assert/strict';

function storage() {
  const data = new Map();
  return { getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value), removeItem: key => data.delete(key) };
}

test('tutorial remembers first-run state per user and skips a whole module', async () => {
  globalThis.localStorage = storage();
  const { TutorialEngine } = await import('../src/app/onboarding/engine.ts');
  const first = new TutorialEngine(); first.setUser('u-1');
  assert.equal(first.state.status, 'not_started');
  first.start(); assert.equal(first.state.status, 'active');
  const module = first.step.module; first.skipModule();
  assert.notEqual(first.step.module, module);
  const restored = new TutorialEngine(); restored.setUser('u-1');
  assert.equal(restored.state.currentStep, first.state.currentStep);
  restored.skipAll(); assert.equal(restored.state.status, 'dismissed');
  const other = new TutorialEngine(); other.setUser('u-2');
  assert.equal(other.state.status, 'not_started');
});
