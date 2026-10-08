// SPDX-License-Identifier: AGPL-3.0-only
import { TUTORIAL_VERSION, tutorialSteps } from './content.zh-CN.ts';
import type { TutorialProgress } from './types.ts';

export class TutorialEngine extends EventTarget {
  private userId = 'guest';
  private progress: TutorialProgress = { version: TUTORIAL_VERSION, status: 'not_started', currentStep: 0 };
  get state(): Readonly<TutorialProgress> { return this.progress; }
  get steps() { return tutorialSteps; }
  get step() { return tutorialSteps[Math.min(this.progress.currentStep, tutorialSteps.length - 1)]!; }
  setUser(userId: string): void { this.userId = userId || 'guest'; this.progress = this.load(); this.changed(); }
  start(): void { this.progress = { ...this.progress, status: 'active', currentStep: this.progress.status === 'active' ? this.progress.currentStep : 0 }; this.commit(); }
  next(): void {
    if (this.progress.currentStep >= tutorialSteps.length - 1) this.progress = { ...this.progress, status: 'completed' };
    else this.progress = { ...this.progress, currentStep: this.progress.currentStep + 1 };
    this.commit();
  }
  back(): void { this.progress = { ...this.progress, currentStep: Math.max(0, this.progress.currentStep - 1) }; this.commit(); }
  skipModule(): void {
    const module = this.step.module;
    const next = tutorialSteps.findIndex((step, index) => index > this.progress.currentStep && step.module !== module);
    this.progress = next < 0 ? { ...this.progress, status: 'completed' } : { ...this.progress, currentStep: next };
    this.commit();
  }
  skipAll(): void { this.progress = { ...this.progress, status: 'dismissed' }; this.commit(); }
  private key(): string { return `diary.onboarding.v${TUTORIAL_VERSION}.${this.userId}`; }
  private load(): TutorialProgress {
    try {
      const value = JSON.parse(localStorage.getItem(this.key()) ?? 'null') as TutorialProgress | null;
      if (value?.version === TUTORIAL_VERSION && Number.isInteger(value.currentStep)) return value;
    } catch { /* use a fresh tutorial */ }
    return { version: TUTORIAL_VERSION, status: 'not_started', currentStep: 0 };
  }
  private commit(): void { localStorage.setItem(this.key(), JSON.stringify(this.progress)); this.changed(); }
  private changed(): void { this.dispatchEvent(new Event('change')); }
}

