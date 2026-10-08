// SPDX-License-Identifier: AGPL-3.0-only
import type { PortalViewName } from '../portal.ts';
import { moduleNames } from './content.zh-CN.ts';
import { TutorialEngine } from './engine.ts';

export function createOnboarding(navigate: (view: PortalViewName) => void) {
  const engine = new TutorialEngine();
  const root = document.createElement('section'); root.className = 'tutorial-layer'; root.hidden = true;
  root.innerHTML = `<div class="tutorial-scrim"></div><div class="tutorial-top-actions"><button id="tutorialSkipModule">跳过本模块</button><button id="tutorialSkipAll">跳过全部</button></div><article class="tutorial-card" role="dialog" aria-modal="true" aria-labelledby="tutorialTitle"><div class="tutorial-meta"><b id="tutorialModule"></b><span id="tutorialProgress"></span></div><h2 id="tutorialTitle"></h2><p id="tutorialBody"></p><p id="tutorialWarning" class="tutorial-warning" hidden></p><div class="tutorial-actions"><button id="tutorialBack">上一步</button><button id="tutorialNext" class="primary">下一步</button></div></article>`;
  document.body.append(root);
  const find = <T extends HTMLElement>(id: string) => root.querySelector<T>(`#${id}`)!;
  const card = root.querySelector<HTMLElement>('.tutorial-card')!;
  let highlighted: HTMLElement | null = null;
  const clearTarget = () => { highlighted?.classList.remove('tutorial-target'); highlighted = null; };
  const place = (target: HTMLElement | null) => {
    if (target) { highlighted = target; target.classList.add('tutorial-target'); target.scrollIntoView({ block: 'center', inline: 'nearest' }); }
    requestAnimationFrame(() => {
      const width = Math.min(430, innerWidth - 24); const box = target?.getBoundingClientRect();
      const gap = 16, maxLeft = innerWidth - width - 12, maxTop = innerHeight - card.offsetHeight - 12;
      let left = Math.max(12, innerWidth - width - 22), top = Math.max(70, (innerHeight - card.offsetHeight) / 2);
      if (box) {
        if (innerWidth - box.right >= width + gap) left = box.right + gap;
        else if (box.left >= width + gap) left = box.left - width - gap;
        else left = Math.max(12, Math.min(maxLeft, (innerWidth - width) / 2));
        if (innerWidth - box.right < width + gap && box.left < width + gap) {
          top = box.bottom + gap + card.offsetHeight <= innerHeight ? box.bottom + gap : box.top - card.offsetHeight - gap;
        } else top = box.top;
        top = Math.max(70, Math.min(maxTop, top));
      }
      card.style.left = `${left}px`; card.style.top = `${top}px`;
    });
  };
  const render = () => {
    clearTarget();
    if (engine.state.status !== 'active') { root.hidden = true; return; }
    root.hidden = false; const step = engine.step;
    if (step.view) navigate(step.view);
    find('tutorialModule').textContent = moduleNames[step.module];
    find('tutorialProgress').textContent = `${engine.state.currentStep + 1} / ${engine.steps.length}`;
    find('tutorialTitle').textContent = step.title; find('tutorialBody').textContent = step.body;
    const target = step.target ? document.querySelector<HTMLElement>(step.target) : null;
    const unavailable = step.target && !target ? '当前目标控件暂不可用，你仍可点击“下一步”继续，或使用右上角按钮跳过。' : '';
    const warning = find('tutorialWarning'); warning.hidden = !(step.warning || unavailable); warning.textContent = [step.warning, unavailable].filter(Boolean).join(' ');
    find<HTMLButtonElement>('tutorialBack').disabled = engine.state.currentStep === 0;
    find('tutorialNext').textContent = engine.state.currentStep === engine.steps.length - 1 ? '完成教程' : '下一步';
    setTimeout(() => place(target), 0);
  };
  find('tutorialNext').onclick = () => engine.next(); find('tutorialBack').onclick = () => engine.back();
  find('tutorialSkipModule').onclick = () => engine.skipModule(); find('tutorialSkipAll').onclick = () => engine.skipAll();
  engine.addEventListener('change', render);
  window.addEventListener('resize', render);
  return {
    syncUser(userId: string, autoStart: boolean) { engine.setUser(userId); if (autoStart && engine.state.status === 'not_started') engine.start(); },
    open() { engine.restart(); },
    state: () => engine.state,
  };
}
