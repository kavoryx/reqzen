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
export interface SearchOptions {
  enforceIntent?: boolean;
  strictEntity?: boolean;
  distinguishGetAll?: boolean;
  entityGroups?: string[];
}
export const DEFAULT_SEARCH_OPTIONS: Required<SearchOptions>;
export function matchesApiSearchIntent(query: string, operation: SearchCandidate, options?: SearchOptions): boolean;
export function scoreApiSearch(query: string, operation: SearchCandidate, options?: SearchOptions): number;
export function rankApiSearch<T extends SearchCandidate>(query: string, candidates: T[], options?: SearchOptions): Array<{ candidate: T; index: number; score: number }>;
export function combinedSearchScore(localScore: number, aiRank: number | undefined): number;
export function requestValuesFromDocument(document: string, parameterNames: string[]): Record<string, string>;
export function updateRequestValuesFromDocument(
  current: Record<string, string>,
  previousDocument: string,
  nextDocument: string,
  parameterNames: string[],
): Record<string, string>;
