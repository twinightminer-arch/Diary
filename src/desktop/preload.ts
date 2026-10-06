// SPDX-License-Identifier: AGPL-3.0-only
import { contextBridge, ipcRenderer } from 'electron';
import type { Request } from '../app/api.ts';
contextBridge.exposeInMainWorld('diary', { platform: 'windows', call: (request: Request) => ipcRenderer.invoke('diary:call', request) });
