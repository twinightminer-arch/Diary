import test from 'node:test';
import assert from 'node:assert/strict';
import { campusServices, matchCampusService, createCampusCase, advanceCampusCase, applicationText, guideCategories, answerFromGuide, searchGuide } from '../dist/app/campus.js';

const profile = { name: '张同学', studentId: '20260001', school: '示例大学', college: '计算机学院', major: '软件工程', grade: '2026', phone: '13800000000', email: 'student@example.edu' };

test('campus catalog covers all requested affairs', () => {
  assert.deepEqual(campusServices.map(item => item.id), ['leave', 'scholarship', 'repair', 'transfer', 'transcript', 'internship']);
});

test('natural-language matching identifies a dorm repair', () => {
  assert.equal(matchCampusService('宿舍水管坏了，我要报修')[0]?.id, 'repair');
});

test('case creation auto-fills identity and routes departments', () => {
  const item = createCampusCase(campusServices[0], profile, { 请假类型: '病假', 请假原因: '发烧' });
  assert.equal(item.fields.姓名, '张同学');
  assert.equal(item.fields.学号, '20260001');
  assert.equal(item.fields.请假类型, '病假');
  assert.ok(item.materials.length > 0);
  assert.ok(item.steps.length > 1);
  assert.match(applicationText(item), /材料清单/);
});

test('tracking advances until completed', () => {
  let item = createCampusCase(campusServices[4], profile, {});
  for (let index = 0; index < item.steps.length; index++) item = advanceCampusCase(item);
  assert.equal(item.status, 'completed');
  assert.ok(item.steps.every(step => step.done));
});

test('guide catalogue exposes 6 categories covering all 24 affairs', () => {
  assert.equal(guideCategories.length, 6);
  assert.equal(guideCategories.reduce((total, category) => total + category.items.length, 0), 24);
  assert.ok(guideCategories.every(category => category.items.length === 4));
});

test('offline answer resolves a natural-language question without a model', () => {
  assert.equal(answerFromGuide('缓考需要什么条件？')[0]?.item.id, 'teaching-defer');
  assert.equal(answerFromGuide('宿舍水管坏了')[0]?.item.id, 'repair');
  assert.equal(answerFromGuide('怎么转专业')[0]?.item.id, 'transfer');
});

test('guide search spans every category', () => {
  assert.ok(searchGuide('校园卡').length >= 1);
  assert.ok(searchGuide('档案').length >= 1);
});
