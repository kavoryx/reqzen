export interface SearchCandidate {
  id: string;
  method: string;
  path: string;
  summary?: string;
  description?: string;
  service?: string;
  version?: string;
  metadata?: string;
}
export function scoreApiSearch(query: string, operation: SearchCandidate): number;
export function rankApiSearch<T extends SearchCandidate>(query: string, candidates: T[]): Array<{ candidate: T; index: number; score: number }>;
export function combinedSearchScore(localScore: number, aiRank: number | undefined): number;
export function requestValuesFromDocument(document: string, parameterNames: string[]): Record<string, string>;
