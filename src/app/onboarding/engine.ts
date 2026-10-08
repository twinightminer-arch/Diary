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
  /** Resume automatic onboarding without discarding saved progress. */
  start(): void { this.progress = { ...this.progress, status: 'active', currentStep: this.progress.status === 'active' ? this.progress.currentStep : 0 }; this.commit(); }
  /** A deliberate sidebar launch always replays the complete current tutorial. */
  restart(): void { this.progress = { version: TUTORIAL_VERSION, status: 'active', currentStep: 0 }; this.commit(); }
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
  private migrate(old: TutorialProgress, oldVersion: 2 | 3 | 4): TutorialProgress {
    const terminal = old.status === 'completed' || old.status === 'dismissed';
    if ((oldVersion === 3 || oldVersion === 4) && terminal) {
      const firstNew = tutorialSteps.findIndex(step => step.module === 'campus-competition');
      return { version: TUTORIAL_VERSION, status: 'active', currentStep: Math.max(0, firstNew) };
    }
    if (oldVersion === 2 && terminal) {
      const firstNew = tutorialSteps.findIndex(step => step.module === 'vpn');
      return { version: TUTORIAL_VERSION, status: 'active', currentStep: Math.max(0, firstNew) };
    }
    if (old.status === 'not_started') return { version: TUTORIAL_VERSION, status: 'not_started', currentStep: 0 };
    // v2 and v3 both stored a numeric index. Their common steps occupy the
    // same prefix; v3's added steps are mapped by stable IDs after expansion.
    const v3Ids = [
      'welcome','privacy-first','accounts','navigation','home','tutorial-entry','new-diary','save-preview','diary-catalog','diary-menu','diary-import','diary-security','diary-tools','batch','ai-model','ai-chat','ai-search','competition','guide','guide-local','wallpaper','music-media','profile','plugins','theme-lock','vpn-find','vpn-open-import','pet-select','pet-import','petdex','complete',
    ];
    const v4Ids = ['welcome','privacy-first','accounts','navigation','home','tutorial-entry','new-diary','save-preview','diary-catalog','diary-menu','diary-import','diary-security','diary-tools','batch','ai-model','ai-chat','ai-search','competition','guide','guide-local','wallpaper','music-media','profile','plugins','theme-lock','vpn-entry','vpn-find','vpn-open','vpn-add','vpn-batch','pet-entry','pet-preview','pet-select','pet-import','petdex','complete'];
    const v2Ids = ['welcome','privacy-first','accounts','navigation','home','tutorial-entry','new-diary','save-preview','diary-catalog','diary-menu','diary-import','diary-security','diary-tools','batch','ai-model','ai-chat','ai-search','competition','guide','guide-local','wallpaper','music-media','profile','plugins','theme-lock','complete'];
    const oldId = oldVersion === 4 ? v4Ids[old.currentStep] : oldVersion === 3 ? v3Ids[old.currentStep] : v2Ids[old.currentStep];
    const mapped = oldId ? tutorialSteps.findIndex(step => step.id === oldId) : -1;
    // The former combined VPN import step now begins at the first still unseen
    // VPN operation, so interrupted users do not lose tutorial coverage.
    const currentStep = oldId === 'vpn-open-import'
      ? tutorialSteps.findIndex(step => step.id === 'vpn-open')
      : mapped;
    return { version: TUTORIAL_VERSION, status: 'active', currentStep: Math.max(0, currentStep) };
  }
  private load(): TutorialProgress {
    try {
      const value = JSON.parse(localStorage.getItem(this.key()) ?? 'null') as TutorialProgress | null;
      if (value?.version === TUTORIAL_VERSION && Number.isInteger(value.currentStep)) return value;
      const v4 = JSON.parse(localStorage.getItem(`diary.onboarding.v4.${this.userId}`) ?? 'null') as TutorialProgress | null;
      if (v4?.version === 4 && Number.isInteger(v4.currentStep)) return this.migrate(v4, 4);
      const v3 = JSON.parse(localStorage.getItem(`diary.onboarding.v3.${this.userId}`) ?? 'null') as TutorialProgress | null;
      if (v3?.version === 3 && Number.isInteger(v3.currentStep)) return this.migrate(v3, 3);
      const v2 = JSON.parse(localStorage.getItem(`diary.onboarding.v2.${this.userId}`) ?? 'null') as TutorialProgress | null;
      if (v2?.version === 2 && Number.isInteger(v2.currentStep)) return this.migrate(v2, 2);
    } catch { /* use a fresh tutorial */ }
    return { version: TUTORIAL_VERSION, status: 'not_started', currentStep: 0 };
  }
  private commit(): void { localStorage.setItem(this.key(), JSON.stringify(this.progress)); this.changed(); }
  private changed(): void { this.dispatchEvent(new Event('change')); }
}

