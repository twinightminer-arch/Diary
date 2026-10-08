// SPDX-License-Identifier: AGPL-3.0-only
import type { PortalViewName } from '../portal.ts';

export type TutorialModule = 'welcome' | 'workspace' | 'documents' | 'diary' | 'ai' | 'campus' | 'campus-competition' | 'personalize' | 'vpn' | 'pets';
export type TutorialStatus = 'not_started' | 'active' | 'dismissed' | 'completed';

export interface TutorialStep {
  id: string;
  module: TutorialModule;
  title: string;
  body: string;
  target?: string;
  view?: PortalViewName;
  warning?: string;
}

export interface TutorialProgress {
  version: number;
  status: TutorialStatus;
  currentStep: number;
  incrementalOnly?: boolean;
}

