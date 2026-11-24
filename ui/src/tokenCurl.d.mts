export interface TokenCurlConfig {
  url: string;
  method: string;
  headers: string;
  body: string;
  contentType: 'json' | 'form';
  auth: 'none' | 'bearer' | 'basic';
  basic: string;
}

export function parseTokenCurl(command: string): TokenCurlConfig & { droppedBearer: boolean };
export function tokenCurl(config: TokenCurlConfig): string;
