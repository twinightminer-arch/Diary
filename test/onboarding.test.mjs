import { test } from 'node:test';
import assert from 'node:assert/strict';

function storage() {
  const data = new Map();
  return { getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value), removeItem: key => data.delete(key) };
}

async function engineFor(user = 'user') {
  const { TutorialEngine } = await import('../src/app/onboarding/engine.ts');
  const engine = new TutorialEngine(); engine.setUser(user); return engine;
}

test('first use is one continuous full tutorial and does not start a second round', async () => {
  globalThis.localStorage = storage();
  const engine = await engineFor('new');
  assert.equal(engine.state.status, 'not_started');
  engine.start();
  const modules = [];
  while (engine.state.status === 'active') { modules.push(engine.step.module); engine.next(); }
  assert.equal(engine.state.status, 'completed');
  assert.ok(modules.indexOf('vpn') > modules.indexOf('personalize'));
  assert.ok(modules.indexOf('pets') > modules.indexOf('vpn'));
  const restored = await engineFor('new');
  assert.equal(restored.state.status, 'completed');
  assert.equal(restored.state.version, 5);
});

test('a v0.1.4-complete user sees only VPN then pets once', async () => {
  globalThis.localStorage = storage();
  localStorage.setItem('diary.onboarding.v2.upgraded', JSON.stringify({ version: 2, status: 'completed', currentStep: 25 }));
  const engine = await engineFor('upgraded');
  assert.equal(engine.state.status, 'active'); assert.equal(engine.step.module, 'vpn');
  const seen = [];
  while (engine.state.status === 'active') { seen.push(engine.step.module); engine.next(); }
  assert.ok(seen.every(module => ['vpn', 'pets', 'campus-competition', 'personalize'].includes(module)));
  assert.ok(seen.includes('vpn')); assert.ok(seen.includes('pets'));
  const restored = await engineFor('upgraded');
  assert.equal(restored.state.status, 'completed');
});

test('v0.1.5 and v0.1.6 users see only the new campus competition module once', async () => {
  for (const status of ['completed', 'dismissed']) {
    for (const version of [3,4]) {
      globalThis.localStorage = storage();
      localStorage.setItem(`diary.onboarding.v${version}.${status}-${version}`, JSON.stringify({ version, status, currentStep: 30 }));
      const engine = await engineFor(`${status}-${version}`);
      assert.equal(engine.state.status, 'active');
      assert.equal(engine.step.module, 'campus-competition');
      engine.next(); assert.equal(engine.step.id, 'complete'); engine.next(); assert.equal(engine.state.status, 'completed');
    }
  }
});

test('unfinished progress is migrated and restored at a reasonable operation', async () => {
  globalThis.localStorage = storage();
  localStorage.setItem('diary.onboarding.v3.partial', JSON.stringify({ version: 3, status: 'active', currentStep: 26 }));
  let engine = await engineFor('partial');
  assert.equal(engine.step.id, 'vpn-open');
  engine.next();
  engine = await engineFor('partial');
  assert.equal(engine.step.id, 'vpn-add');
});

test('module/all skipping persists and manual replay starts the complete tutorial', async () => {
  globalThis.localStorage = storage();
  const engine = await engineFor('skip'); engine.start();
  const firstModule = engine.step.module; engine.skipModule();
  assert.notEqual(engine.step.module, firstModule);
  engine.skipAll(); assert.equal(engine.state.status, 'dismissed');
  const restored = await engineFor('skip'); assert.equal(restored.state.status, 'dismissed');
  restored.restart(); assert.equal(restored.state.status, 'active'); assert.equal(restored.step.id, 'welcome');
});

test('VPN, pet and campus competition tutorial steps target current controls', async () => {
  const { tutorialSteps } = await import('../src/app/onboarding/content.zh-CN.ts');
  const vpn = tutorialSteps.filter(step => step.module === 'vpn');
  const pets = tutorialSteps.filter(step => step.module === 'pets');
  assert.deepEqual(vpn.map(step => step.id), ['vpn-entry', 'vpn-find', 'vpn-open', 'vpn-add', 'vpn-batch']);
  assert.deepEqual(pets.map(step => step.id), ['pet-entry', 'pet-preview', 'pet-select', 'pet-import', 'petdex']);
  assert.deepEqual(vpn.map(step => step.target), ['#vpnButton', '.vpn-toolbar', '#vpnList', '.vpn-add', '.vpn-import-actions']);
  assert.deepEqual(pets.map(step => step.target), ['#petButton', '#petList', '#petToggle', '.pet-import', '.petdex-footer']);
  assert.equal(tutorialSteps.find(step=>step.module==='campus-competition')?.target,'#campusCompetitionOpen');
  assert.ok(tutorialSteps.every(step => !/0\.1\.[0-6]/.test(`${step.title} ${step.body}`)));
});
