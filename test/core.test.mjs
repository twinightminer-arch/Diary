import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LocaleManager, dictionaries, resolveLocale } from '../src/i18n/index.ts';
import { SkillEngine } from '../src/plugins/skill-engine.ts';

test('all locales preserve keys and placeholders', () => {
  const reference = dictionaries['en-US'];
  for (const dictionary of Object.values(dictionaries)) {
    assert.deepEqual(Object.keys(dictionary).sort(), Object.keys(reference).sort());
    for (const key of Object.keys(reference)) {
      assert.deepEqual(dictionary[key].match(/\{\w+\}/g), reference[key].match(/\{\w+\}/g));
    }
  }
});
test('locale normalization, interpolation and unsubscribe', () => {
  assert.equal(resolveLocale('zh_Hant_HK'), 'zh-TW');
  assert.equal(resolveLocale('fr-FR'), 'en-US');
  const manager = new LocaleManager('zh-CN');
  const changes = [];
  const unsubscribe = manager.subscribe(locale => changes.push(locale));
  manager.setLocale('ja');
  assert.equal(manager.t('entrySaved', { title: '$&' }), '$& を保存しました');
  unsubscribe();
  manager.setLocale('ko');
  assert.deepEqual(changes, ['ja-JP']);
});
const definition = { id: 'diary.test', description: 'Test', instructions: 'Test', capabilities: ['entries:create'] };
test('undeclared and ungranted capabilities cannot reach the host', async () => {
  let calls = 0;
  const engine = new SkillEngine({ 'entries:create': async () => ++calls });
  engine.load({ definition, run: (_, ctx) => ctx.call('entries:create', {}) }, []);
  await assert.rejects(engine.execute(definition.id, {}), /Permission denied/);
  assert.equal(calls, 0);
  const other = new SkillEngine({ 'entries:delete': async () => ++calls });
  other.load({ definition, run: (_, ctx) => ctx.call('entries:delete', {}) }, ['entries:delete']);
  await assert.rejects(other.execute(definition.id, {}), /Permission denied/);
  assert.equal(calls, 0);
});
test('hooks, expired contexts, duplicate IDs and unload', async () => {
  const engine = new SkillEngine({ 'entries:create': async value => value });
  const events = [];
  engine.onAgent(event => { events.push(event.phase); });
  engine.onAgent(() => { throw new Error('Observer failure'); });
  let context;
  const module = { definition, run: async (input, ctx) => { context = ctx; return ctx.call('entries:create', input); } };
  const unload = engine.load(module, ['entries:create']);
  assert.throws(() => engine.load(module, []), /Duplicate/);
  assert.equal(await engine.execute(definition.id, 'markdown'), 'markdown');
  assert.deepEqual(events, ['before', 'after']);
  await assert.rejects(context.call('entries:create', {}), /inactive/);
  unload();
  await assert.rejects(engine.execute(definition.id, {}), /Unknown skill/);
});
test('abort prevents invocation; mutation cannot increase grants', async () => {
  const engine = new SkillEngine({});
  const mutable = { ...definition, capabilities: [] };
  engine.load({ definition: mutable, run: (_, ctx) => ctx.call('entries:delete', {}) }, ['entries:delete']);
  mutable.capabilities.push('entries:delete');
  await assert.rejects(engine.execute(definition.id, {}), /Permission denied/);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(engine.execute(definition.id, {}, controller.signal), { name: 'AbortError' });
});
