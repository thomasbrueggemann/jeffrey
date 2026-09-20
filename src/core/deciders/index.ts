import type { DeciderConfig, DeciderProvider } from '../../config.js';
import type { DecisionModel, DecisionModelInfo } from '../decision.js';
import { TypeSafeClient, listTypeSafeModels } from './typesafe.js';
import { LayaClient, listLayaModels } from './laya.js';
import { MockDecider, type MockScript } from './mock.js';

/**
 * The providers jeffrey can route with. A provider is a decision model — something that answers
 * typed questions and returns probabilities — and nothing above this file knows which one is in
 * use. Adding one means a client that implements `DecisionModel` plus an entry here.
 */
export interface ProviderInfo {
  /** One line for `--help` and the docs. */
  summary: string;
  /** Config values that make sense for this provider and no other. */
  defaults: Pick<DeciderConfig, 'url' | 'model'> & Partial<DeciderConfig>;
  /** Whether a run can start without an API key. */
  needsApiKey: boolean;
  create(config: DeciderConfig): DecisionModel;
  listModels(config: DeciderConfig): Promise<DecisionModelInfo[]>;
}

export const PROVIDERS: Record<DeciderProvider, ProviderInfo> = {
  typesafe: {
    summary: 'TypeSafe System One (Jev), hosted — the default',
    defaults: { url: 'https://api.typesafe.ai/v1/systemone', model: 'jev-latest' },
    needsApiKey: true,
    create: (config) => new TypeSafeClient(config),
    listModels: listTypeSafeModels,
  },
  laya: {
    summary: 'Laya, Apache-2.0, hosted by you through sidecar/laya-server.py',
    defaults: { url: 'http://127.0.0.1:8137/v1/systemone', model: 'router', timeoutMs: 120_000 },
    needsApiKey: false,
    create: (config) => new LayaClient(config),
    listModels: listLayaModels,
  },
  mock: {
    summary: 'Scripted stand-in for tests and offline runs, no server at all',
    defaults: { url: '', model: 'mock' },
    needsApiKey: false,
    create: () => new MockDecider(),
    listModels: async () => [{ name: 'mock', description: 'scripted answers', release_date: '' }],
  },
};

export const PROVIDER_NAMES = Object.keys(PROVIDERS) as DeciderProvider[];

export function isProvider(name: string): name is DeciderProvider {
  return (PROVIDER_NAMES as string[]).includes(name);
}

/** Build the configured decision model. The mock script, when there is one, comes from the CLI. */
export function createDecisionModel(config: DeciderConfig, mockScript?: MockScript): DecisionModel {
  if (config.mock || config.provider === 'mock') return new MockDecider(mockScript);
  return PROVIDERS[config.provider].create(config);
}

export function listDecisionModels(config: DeciderConfig): Promise<DecisionModelInfo[]> {
  return PROVIDERS[config.provider].listModels(config);
}

export { TypeSafeClient } from './typesafe.js';
export { LayaClient } from './laya.js';
export { MockDecider, type MockScript } from './mock.js';
