export type Platform = 'mac' | 'win' | 'linux';

export interface DesktopBridge {
  platform: Platform;
  openSnapshot: (options?: { compareOnly?: boolean }) => Promise<{ id: string; name: string; text: string; skipped?: string[] } | null>;
  listSnapshots: () => Promise<unknown>;
  selectSnapshot: (id: string) => Promise<unknown>;
  removeSnapshot: (id?: string) => Promise<unknown>;
  saveSnapshotCustomFields: (input: Record<string, unknown>) => Promise<unknown>;
  lastSnapshot: () => Promise<{ id: string; name: string; text: string } | null>;
  runRequest: (run: Record<string, unknown>) => Promise<unknown>;
  listEnvironments: () => Promise<unknown>;
  saveEnvironment: (input: Record<string, unknown>) => Promise<unknown>;
  deleteEnvironment: (id: string) => Promise<unknown>;
  listVariables: () => Promise<unknown>;
  saveVariable: (input: Record<string, unknown>) => Promise<unknown>;
  deleteVariable: (id: string) => Promise<unknown>;
  getPreferences: () => Promise<unknown>;
  savePreferences: (preferences: Record<string, unknown>) => Promise<unknown>;
  getLibrary: () => Promise<unknown>;
  saveLibrary: (library: unknown) => Promise<unknown>;
  exportCollection: (input: Record<string, unknown>) => Promise<unknown>;
  importCollection: () => Promise<unknown>;
  exportCatalog: (input: Record<string, unknown>) => Promise<unknown>;
  listCustomRequests: () => Promise<unknown>;
  saveCustomRequest: (input: Record<string, unknown>) => Promise<unknown>;
  deleteCustomRequest: (id: string) => Promise<unknown>;
  listTokenTypes: () => Promise<unknown>;
  saveTokenType: (input: Record<string, unknown>) => Promise<unknown>;
  fetchToken: (input: Record<string, unknown>) => Promise<unknown>;
  getScanRules: () => Promise<unknown>;
  saveScanRules: (input: Record<string, unknown>) => Promise<unknown>;
  pickFolder: () => Promise<{ ok: boolean; path?: string; cancelled?: boolean }>;
  findLocalProjects: (input: Record<string, unknown>) => Promise<unknown>;
  findGitHubProjects: (input: Record<string, unknown>) => Promise<unknown>;
  scanGitHub: (input: Record<string, unknown>) => Promise<unknown>;
  askAgents: (input: Record<string, unknown>) => Promise<unknown>;
  fillFromDescription: (input: Record<string, unknown>) => Promise<unknown>;
  confirmationRequired: (input: Record<string, unknown>) => Promise<{ required: boolean }>;
  saveConfirmations: (input: Record<string, unknown>) => Promise<unknown>;
  listConfirmations: () => Promise<unknown>;
  getDocs: () => Promise<unknown>;
  saveDocSettings: (input: Record<string, unknown>) => Promise<unknown>;
  setDocKey: (input: Record<string, unknown>) => Promise<unknown>;
  modelStatus: () => Promise<unknown>;
  listModels: () => Promise<unknown>;
  listKeptClones: () => Promise<unknown>;
  deleteKeptClone: (input: Record<string, unknown>) => Promise<unknown>;
  getDocJob: () => Promise<unknown>;
  stopDocJob: () => Promise<unknown>;
  generateDocs: (input: Record<string, unknown>) => Promise<unknown>;
  onSettingsOpen: (callback: () => void) => () => void;
  onFindOpen: (callback: () => void) => () => void;
  onFindResult: (callback: (result: unknown) => void) => () => void;
  onCloseRequest: (callback: () => void) => () => void;
  closeWindow: () => Promise<void>;
  setWindowAppearance: (mode: 'system' | 'light' | 'dark') => Promise<unknown>;
  setTextScale: (scale: number) => Promise<unknown>;
  findInPage: (input: Record<string, unknown>) => Promise<void>;
  stopFind: () => Promise<void>;
}

declare global {
  interface Window {
    desktop: DesktopBridge;
  }
}

export function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export function arrayOf<T>(value: unknown): T[] {
  return Array.isArray(value) ? value as T[] : [];
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Something went wrong. Please try again.';
}
