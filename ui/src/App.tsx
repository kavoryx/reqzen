import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import {
  arrayOf,
  errorMessage,
  record,
  type Platform,
} from './bridge';
import { parseTokenCurl, tokenCurl, type TokenCurlConfig } from './tokenCurl.mjs';
import { combinedSearchScore, rankApiSearch, scoreApiSearch } from './apiSearch.mjs';

type View = 'home' | 'catalog' | 'collections' | 'settings';
type SettingsSection = 'appearance' | 'environments' | 'variables' | 'tokens' | 'ai' | 'documentation' | 'scan-rules' | 'privacy';
type Severity = 'success' | 'error' | 'info';

interface ApiParameter {
  name: string;
  in: 'path' | 'query' | 'header';
  required?: boolean;
  description?: string;
  schema?: { type?: string; enum?: unknown[] };
}

interface Operation {
  operationId: string;
  revisionId?: string;
  serviceId?: string;
  serviceName: string;
  contractVersion?: string;
  httpMethod: string;
  pathTemplate: string;
  summary?: string;
  description?: string;
  schemaComplete?: boolean;
  definition?: Record<string, unknown>;
  parameters?: ApiParameter[];
  customFields?: Record<string, string>;
}

interface CustomFieldDefinition {
  key: string;
  label: string;
  visible: boolean;
}

interface Service {
  serviceId: string;
  name: string;
}

interface Environment {
  id?: string;
  environmentId?: string;
  name: string;
  baseUrl: string;
  production?: boolean;
  enabled?: boolean;
  yours?: boolean;
  overridden?: boolean;
}

interface Snapshot {
  format?: string;
  services: Service[];
  operations: Operation[];
  environments: Environment[];
  serviceOverrides?: Array<Record<string, unknown>>;
  customFieldDefinitions: CustomFieldDefinition[];
}

interface Variable {
  id: string;
  name: string;
  value: string;
  byEnvironment: Record<string, string>;
}

interface LibraryItem {
  operationId: string;
  serviceName: string;
  contractVersion: string;
  httpMethod: string;
  pathTemplate: string;
  summary: string;
  contextPath: string;
  defaultBody: string;
}

interface Library {
  favourites: LibraryItem[];
  collections: Array<{ id: string; name: string; items: LibraryItem[] }>;
}

interface Preferences {
  mode: 'system' | 'light' | 'dark';
  palette: 'blue' | 'teal' | 'violet' | 'amber' | 'graphite';
  wrapText: boolean;
  columnWidths: number[] | null;
  textScale: number;
}

interface WorkspaceSnapshot {
  id: string;
  name: string;
  createdAt?: string;
  operationCount: number;
  serviceCount: number;
}

interface TokenType {
  id: string;
  name: string;
  mode: 'request' | 'api';
  url?: string;
  method?: string;
  operation?: LibraryItem;
  tokenField?: string;
  auth?: 'none' | 'bearer' | 'basic';
  headers?: string;
  contentType?: 'json' | 'form';
  body?: string;
  basic?: string;
}

interface Project {
  name: string;
  path: string;
  absolute?: string;
  manifest?: string;
  languages?: string[];
  frameworks?: string[];
  operations?: number;
}

interface Notice {
  message: string;
  severity: Severity;
}

const defaultPreferences: Preferences = {
  mode: 'system',
  palette: 'blue',
  wrapText: false,
  columnWidths: null,
  textScale: 100,
};

const methods = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];
const shortcut = (platform: Platform, key: string) => `${platform === 'mac' ? '⌘' : 'Ctrl+'}${key}`;

function isOperation(value: unknown): value is Operation {
  const item = record(value);
  return typeof item.operationId === 'string'
    && typeof item.httpMethod === 'string'
    && typeof item.pathTemplate === 'string'
    && typeof item.serviceName === 'string';
}

function parseSnapshot(text: string): Snapshot {
  const parsed: unknown = JSON.parse(text);
  const data = record(parsed);
  if (data.format !== 'api-explorer-snapshot'
    || !Array.isArray(data.operations)
    || !Array.isArray(data.services)) {
    throw new Error('This file is not a supported Reqzen API snapshot.');
  }
  const operations = data.operations.filter(isOperation);
  const services = arrayOf<Record<string, unknown>>(data.services)
    .filter((service) => typeof service.name === 'string')
    .map((service) => ({
      serviceId: typeof service.serviceId === 'string' ? service.serviceId : String(service.name),
      name: String(service.name),
    }));
  return {
    format: 'api-explorer-snapshot',
    services,
    operations,
    environments: arrayOf<Environment>(data.environments),
    serviceOverrides: arrayOf<Record<string, unknown>>(data.serviceOverrides),
    customFieldDefinitions: arrayOf<CustomFieldDefinition>(data.customFieldDefinitions),
  };
}

function resultError(value: unknown): string | null {
  const result = record(value);
  const problems = arrayOf<unknown>(result.problems).filter((problem): problem is string => typeof problem === 'string');
  if (problems.length) return problems.join(' ');
  if (typeof result.problem === 'string' && result.problem) return result.problem;
  if (result.ok === false) return 'The action could not be completed.';
  return null;
}

function operationParameters(operation: Operation): ApiParameter[] {
  if (Array.isArray(operation.parameters)) return operation.parameters;
  const definition = record(operation.definition);
  const detail = record(definition.operation);
  const values = [
    ...arrayOf<ApiParameter>(definition.pathParameters),
    ...arrayOf<ApiParameter>(detail.parameters),
  ];
  return values.filter((parameter, index) => values.findIndex((other) =>
    other.name === parameter.name && other.in === parameter.in) === index);
}

function libraryItem(operation: Operation): LibraryItem {
  return {
    operationId: operation.operationId,
    serviceName: operation.serviceName,
    contractVersion: operation.contractVersion || '',
    httpMethod: operation.httpMethod,
    pathTemplate: operation.pathTemplate,
    summary: operation.summary || '',
    contextPath: '',
    defaultBody: '',
  };
}

function versionFor(operation: Operation): string {
  const explicit = operation.contractVersion?.trim();
  const fromPath = operation.pathTemplate.match(/\/v(\d+(?:\.\d+)*)/i);
  return explicit || (fromPath ? `v${fromPath[1]}` : '—');
}

function routeUrl(operation: Operation, environment: Environment | undefined, values: Record<string, string>): string {
  let path = operation.pathTemplate;
  for (const [name, value] of Object.entries(values)) {
    const formatted = value.startsWith('{') && value.endsWith('}') ? value : encodeURIComponent(value);
    path = path.replaceAll(`{${name}}`, formatted);
  }
  const base = (environment?.baseUrl || '').replace(/\/+$/, '');
  return `${base}${path.startsWith('/') ? path : `/${path}`}`;
}

function applyAccessToken(value: string, token: string): string {
  if (!token) return value;
  return value
    .replaceAll('{{accessToken}}', token)
    .replaceAll('{{access_token}}', token)
    .replaceAll('<TOKEN>', token);
}

function parseCurlCommand(command: string): { name: string; method: string; url: string; auth: 'none' | 'bearer'; headers: string; body: string } {
  const normalized = command
    .replace(/\\\r?\n/g, ' ')
    .replace(/^\s*curl(?:\.exe)?\s+/i, '')
    .trim();

  const urlMatch = normalized.match(/(?:https?:\/\/)[^\s'"<>]+|(?<!\S)'(https?:\/\/[^']+)'|(?<!\S)"(https?:\/\/[^"]+)"/i);
  let url = (urlMatch?.[1] || urlMatch?.[2] || urlMatch?.[0] || '').replace(/^['"]|['"]$/g, '');

  const methodMatch = normalized.match(/(?:-X|--request)\s+(["']?)(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\1/i);
  let method = methodMatch?.[2]?.toUpperCase() || '';
  const headers: string[] = [];
  const headerPattern = /(?:-H|--header)\s+(["'])(.*?)\1|(?:-H|--header)\s+([^\s]+)/gi;
  let headerMatch: RegExpExecArray | null;
  while ((headerMatch = headerPattern.exec(normalized)) !== null) {
    const header = headerMatch[2] || headerMatch[3];
    if (header) headers.push(header);
  }

  const dataMatch = normalized.match(/(?:-d|--data|--data-raw|--data-binary)\s+(["'])([\s\S]*?)\1/i);
  const body = dataMatch?.[2] || '';
  if (!method) method = body ? 'POST' : 'GET';

  let auth: 'none' | 'bearer' = 'none';
  const authorization = headers.find((header) => /^Authorization:/i.test(header));
  if (authorization?.match(/Bearer\s+(.+)/i)) auth = 'bearer';

  let name = 'Imported curl request';
  try {
    if (url) {
      const parsed = new URL(url);
      name = `${method} ${parsed.pathname || '/'}`;
    }
  } catch {
    name = `${method} request`;
  }
  return { name, method: methods.includes(method) ? method : 'GET', url, auth, headers: headers.join('\n'), body };
}

function Button({
  children,
  variant = 'secondary',
  className = '',
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' | 'quiet' | 'danger' }) {
  return <button className={`button button-${variant} ${className}`} {...props}>{children}</button>;
}

function MethodBadge({ method }: { method: string }) {
  return <span className={`method method-${method.toLowerCase()}`}>{method}</span>;
}

function Dialog({
  title,
  detail,
  children,
  onClose,
  className = '',
}: {
  title: string;
  detail?: string;
  children: ReactNode;
  onClose: () => void;
  className?: string;
}) {
  const dialogRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const first = dialogRef.current?.querySelector<HTMLElement>('input:not([disabled]), select:not([disabled]), textarea:not([disabled]), button:not([disabled])');
    first?.focus();
  }, []);
  return (
    <div className="dialog-scrim" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <section
        ref={dialogRef}
        className={`dialog ${className}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="dialog-title"
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.stopPropagation();
            onClose();
          } else if (event.key === 'Tab') {
            const items = dialogRef.current?.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])');
            if (!items?.length) return;
            const firstItem = items[0];
            const lastItem = items[items.length - 1];
            if (event.shiftKey && document.activeElement === firstItem) {
              event.preventDefault();
              lastItem.focus();
            } else if (!event.shiftKey && document.activeElement === lastItem) {
              event.preventDefault();
              firstItem.focus();
            }
          }
        }}
      >
        <header className="dialog-header">
          <div>
            <h2 id="dialog-title">{title}</h2>
            {detail && <p>{detail}</p>}
          </div>
          <button className="icon-button no-drag" type="button" onClick={onClose} aria-label="Close dialog">×</button>
        </header>
        {children}
      </section>
    </div>
  );
}

function TokenTypeDialog({
  initial, environments, defaultEnvironmentId, tokensByEnvironment, onSave, onClose,
}: {
  initial: TokenType;
  environments: Environment[];
  defaultEnvironmentId: string;
  tokensByEnvironment: Record<string, string>;
  onSave: (config: TokenCurlConfig & { name: string; tokenField: string }) => Promise<void>;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<TokenCurlConfig & { name: string; tokenField: string }>({
    name: initial.name,
    url: initial.url || '',
    method: initial.method || 'POST',
    headers: initial.headers || '',
    body: initial.body || '',
    contentType: initial.contentType || 'json',
    auth: initial.auth || 'none',
    basic: initial.basic || '',
    tokenField: initial.tokenField || 'access_token',
  });
  const [curl, setCurl] = useState('');
  const [copiedCurl, setCopiedCurl] = useState('');
  const [message, setMessage] = useState('');
  const [messageError, setMessageError] = useState(false);
  const [environmentId, setEnvironmentId] = useState(defaultEnvironmentId);
  const [confirmed, setConfirmed] = useState(false);
  const [convertLegacy, setConvertLegacy] = useState(false);
  const [busy, setBusy] = useState(false);
  const environment = environments.find((item) => (item.environmentId || item.id) === environmentId);
  const update = (patch: Partial<typeof draft>) => {
    setDraft((current) => ({ ...current, ...patch }));
    setConfirmed(false);
    setCopiedCurl('');
    setMessage('');
  };
  const importCurl = () => {
    try {
      const { droppedBearer, ...parsed } = parseTokenCurl(curl);
      update(parsed);
      setMessageError(false);
      setMessage(droppedBearer
        ? 'Imported. The Bearer value was not saved; the selected environment’s access token will be used.'
        : 'Imported. Review the request before saving or testing.');
    } catch (error) {
      setMessageError(true);
      setMessage(errorMessage(error));
    }
  };
  const copyCurl = async () => {
    const command = tokenCurl(draft);
    setCopiedCurl(command);
    try {
      await navigator.clipboard.writeText(command);
      setMessageError(false);
      setMessage('Curl copied. It may contain credentials or other sensitive values; keep it private.');
    } catch {
      setMessageError(true);
      setMessage('Could not copy automatically. Select and copy the command below.');
    }
  };
  const testRequest = async () => {
    if (!environment || !confirmed) return;
    setBusy(true);
    setMessage('');
    try {
      const result = record(await window.desktop.fetchToken({
        ...draft,
        environmentId: environment.environmentId || environment.id,
        bearer: tokensByEnvironment[environment.environmentId || environment.id || ''] || '',
        confirmWrite: confirmed,
        acceptIncomplete: false,
        validateConfig: true,
      }));
      const problem = resultError(result);
      if (problem) throw new Error(problem);
      if (result.ok !== true || typeof result.token !== 'string') throw new Error('The token response did not contain an access token.');
      setMessageError(false);
      setMessage(`Token found (${result.token.length} characters, HTTP ${String(result.status)}). The token was not shown or saved.`);
    } catch (error) {
      setMessageError(true);
      setMessage(`Test failed: ${errorMessage(error)}`);
    } finally {
      setBusy(false);
      setConfirmed(false);
    }
  };
  return (
    <Dialog title={initial.id ? 'Edit token type' : 'Add token type'} detail="Configure a token request manually or import a curl command." onClose={onClose} className="wide-dialog">
        <form className="dialog-form" onSubmit={(event) => { event.preventDefault(); if (initial.mode !== 'api' || convertLegacy) void onSave(draft); }}>
          <fieldset className="token-editor-fields" disabled={busy}>
            {initial.mode === 'api' && <label className="check-row"><input type="checkbox" checked={convertLegacy} onChange={(event) => setConvertLegacy(event.target.checked)} /><span><strong>Convert this catalog-based token type to a token endpoint</strong><small>Saving replaces its catalog API configuration with the request below.</small></span></label>}
            <Field label="Token type name"><input required value={draft.name} onChange={(event) => update({ name: event.target.value })} placeholder="Support token" /></Field>
            <div className="token-curl-panel">
              <Field label="Import from curl" hint="Paste a command to fill the request. It is parsed locally and never executed.">
                <textarea className="code-editor" rows={3} value={curl} onChange={(event) => setCurl(event.target.value)} placeholder="curl -X POST 'https://auth.example.com/token' -u 'client:secret' -d 'grant_type=client_credentials'" />
              </Field>
              <Button type="button" disabled={!curl.trim()} onClick={importCurl}>Fill from curl</Button>
            </div>
            <div className="form-grid">
              <Field label="Method"><select value={draft.method} onChange={(event) => update({ method: event.target.value })}>{methods.filter((method) => !['HEAD', 'OPTIONS'].includes(method)).map((method) => <option key={method}>{method}</option>)}</select></Field>
              <Field label="Token endpoint"><input required value={draft.url} onChange={(event) => update({ url: event.target.value })} placeholder="https://auth.example.com/oauth/token" /></Field>
            </div>
            <div className="form-grid">
              <Field label="Content type"><select value={draft.contentType} onChange={(event) => update({ contentType: event.target.value === 'form' ? 'form' : 'json' })}><option value="json">JSON</option><option value="form">Form</option></select></Field>
              <Field label="Access token field"><input value={draft.tokenField} onChange={(event) => update({ tokenField: event.target.value })} /></Field>
            </div>
            <Field label="Request headers"><textarea rows={3} value={draft.headers} onChange={(event) => update({ headers: event.target.value })} placeholder="Accept: application/json" /></Field>
            <Field label="Request body" hint="Headers, body and Basic credentials are stored locally with the token type."><textarea rows={5} value={draft.body} onChange={(event) => update({ body: event.target.value })} placeholder='{"client":"reqzen"}' /></Field>
            <Field label="Send access token with this token call"><select value={draft.auth} onChange={(event) => update({ auth: event.target.value === 'basic' ? 'basic' : event.target.value === 'bearer' ? 'bearer' : 'none' })}><option value="none">None</option><option value="bearer">Bearer token from selected environment</option><option value="basic">Basic authentication</option></select></Field>
            {draft.auth === 'basic' && <Field label="Basic credential" hint="Authorization value in the form Basic followed by the base64-encoded client ID and secret."><input type="password" autoComplete="off" value={draft.basic} onChange={(event) => update({ basic: event.target.value })} placeholder="Basic …" /></Field>}
            <div className="token-curl-panel">
              <strong>Test token request</strong>
              <p>Sends this unsaved request once. The result will not replace your access token.</p>
              <Field label="Test environment"><select value={environmentId} onChange={(event) => { setEnvironmentId(event.target.value); setConfirmed(false); setMessage(''); }}><option value="">Choose an environment</option>{environments.filter((item) => item.enabled !== false).map((item) => <option key={item.environmentId || item.id} value={item.environmentId || item.id}>{item.name}{item.production ? ' · Production' : ''}</option>)}</select></Field>
              <label className="check-row"><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} /><span><strong>I confirm sending this request{environment?.production ? ' to a production environment' : ''}.</strong></span></label>
              <div className="token-editor-actions"><Button type="button" disabled={!environmentId || !draft.url.trim() || !confirmed} onClick={() => { void testRequest(); }}>Test token request</Button><Button type="button" disabled={!draft.url.trim()} onClick={() => { void copyCurl(); }}>Copy curl</Button></div>
              {copiedCurl && <Field label="Curl command" hint="This command may contain secrets."><textarea className="code-editor" readOnly rows={4} value={copiedCurl} onFocus={(event) => event.currentTarget.select()} /></Field>}
            </div>
          </fieldset>
          {busy && <p role="status">Testing token request…</p>}
          {message && <p role="status" className={messageError ? 'field-error' : 'token-test-success'}>{message}</p>}
          <div className="dialog-actions"><Button type="button" onClick={onClose}>Cancel</Button><Button variant="primary" type="submit" disabled={busy || (initial.mode === 'api' && !convertLegacy)}>Save token type</Button></div>
        </form>
    </Dialog>
  );
}

function ShareSnapshotDialog({ services, environments, tokenTypes, variables, defaultEnvironmentId, onExport, onClose }: {
  services: Service[];
  environments: Environment[];
  tokenTypes: TokenType[];
  variables: Variable[];
  defaultEnvironmentId: string;
  onExport: (selection: Record<string, unknown>) => Promise<boolean>;
  onClose: () => void;
}) {
  const [serviceIds, setServiceIds] = useState(services.map((item) => item.serviceId));
  const [environmentIds, setEnvironmentIds] = useState<string[]>([]);
  const [typeIds, setTypeIds] = useState<string[]>([]);
  const [variableIds, setVariableIds] = useState<string[]>([]);
  const [includeVariableValues, setIncludeVariableValues] = useState(false);
  const [includeTokenSecrets, setIncludeTokenSecrets] = useState(false);
  const [busy, setBusy] = useState(false);
  const toggle = (id: string, values: string[], set: (ids: string[]) => void) =>
    set(values.includes(id) ? values.filter((value) => value !== id) : [...values, id]);
  const group = (title: string, items: Array<{ id: string; label: string }>, selected: string[], set: (ids: string[]) => void, disabled = false) => (
    <fieldset className="share-group" disabled={disabled}>
      <legend>{title}</legend>
      {items.length > 0 ? <>
        <div className="share-select-actions"><button type="button" className="text-button" onClick={() => set(items.map((item) => item.id))}>Select all</button><button type="button" className="text-button" onClick={() => set([])}>Clear</button></div>
        <div className="share-items">{items.map((item) => <label key={item.id}><input type="checkbox" checked={selected.includes(item.id)} onChange={() => toggle(item.id, selected, set)} /> {item.label}</label>)}</div>
      </> : <small>None available.</small>}
    </fieldset>
  );
  return (
    <Dialog title="Export snapshot" detail="Choose what to share. Nothing is sent to another service by Reqzen." onClose={onClose} className="wide-dialog">
      <form className="dialog-form" onSubmit={(event) => {
        event.preventDefault();
        setBusy(true);
        void onExport({ share: true, format: 'json', services: serviceIds, environments: environmentIds, tokenTypes: typeIds, variables: variableIds, defaultEnvironmentId, includeVariableValues, includeTokenSecrets })
          .then((ok) => { if (ok) onClose(); })
          .finally(() => setBusy(false));
      }}>
        {group('Services and APIs', services.map((item) => ({ id: item.serviceId, label: item.name })), serviceIds, setServiceIds)}
        {group('Environments', environments.map((item) => ({ id: item.environmentId || item.id || '', label: `${item.name}${item.production ? ' · Production' : ''}` })).filter((item) => item.id), environmentIds, setEnvironmentIds)}
        {group('Token types', tokenTypes.map((item) => ({ id: item.id, label: item.name })), typeIds, setTypeIds)}
        {tokenTypes.some((item) => typeIds.includes(item.id) && item.mode === 'api') && <p className="privacy-note">API-based token types can be shared, but must be reconfigured as token requests to generate tokens in this workspace.</p>}
        <label className="check-row"><input type="checkbox" checked={includeTokenSecrets} onChange={(event) => setIncludeTokenSecrets(event.target.checked)} /><span><strong>Include token request credentials and data</strong><small>Includes Basic credentials, URL credentials and query, headers and request bodies. Without this, those parts are removed and recipients may need to reconfigure the request.</small></span></label>
        <label className="check-row"><input type="checkbox" checked={includeVariableValues} onChange={(event) => { setIncludeVariableValues(event.target.checked); if (!event.target.checked) setVariableIds([]); }} /><span><strong>Include variable values</strong><small>Variable values may contain secrets. Environment-specific values are exported only for selected environments.</small></span></label>
        {group('Variables', variables.map((item) => ({ id: item.id, label: item.name })), variableIds, setVariableIds, !includeVariableValues)}
        <p className="privacy-note">Snapshots may contain sensitive API details and environment addresses. Review the file before sharing. Session access tokens are never included.</p>
        <div className="dialog-actions"><Button type="button" onClick={onClose} disabled={busy}>Cancel</Button><Button variant="primary" type="submit" disabled={busy || serviceIds.length === 0}>{busy ? 'Exporting…' : 'Export snapshot'}</Button></div>
      </form>
    </Dialog>
  );
}

function CustomFieldDialog({ initial, onSave, onClose }: {
  initial: CustomFieldDefinition[];
  onSave: (definitions: CustomFieldDefinition[]) => Promise<boolean>;
  onClose: () => void;
}) {
  const [fields, setFields] = useState(initial);
  const [key, setKey] = useState('');
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const add = () => {
    const name = key.trim();
    const title = label.trim();
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,39}$/.test(name) || Object.prototype.hasOwnProperty.call(Object.prototype, name) || !title || title.length > 60) {
      setError('Use a key starting with a letter (letters, digits, _ or -, up to 40 characters) and a label up to 60 characters.');
      return;
    }
    if (fields.some((field) => field.key.toLowerCase() === name.toLowerCase())) {
      setError('That field key already exists.');
      return;
    }
    setFields([...fields, { key: name, label: title, visible: true }]);
    setKey('');
    setLabel('');
    setError('');
  };
  return (
    <Dialog title="Configure API fields" detail="Add fields to the snapshot and choose which appear as catalog columns." onClose={onClose} className="wide-dialog">
      <div className="custom-fields-list">{fields.map((field, index) => (
        <div className="custom-field-row" key={field.key}>
          <div><label>Label <input aria-label={`Label for ${field.key}`} maxLength={60} value={field.label} onChange={(event) => setFields(fields.map((entry, i) => i === index ? { ...entry, label: event.target.value } : entry))} /></label><small>{field.key}</small></div>
          <label><input type="checkbox" checked={field.visible} onChange={(event) => setFields(fields.map((entry, i) => i === index ? { ...entry, visible: event.target.checked } : entry))} /> Show column</label>
          <Button type="button" onClick={() => setFields(fields.filter((entry) => entry.key !== field.key))}>Remove</Button>
        </div>
      ))}</div>
      <p className="privacy-note">Removing a field and saving also removes its values from every API. Custom fields are included in exported snapshots.</p>
      <div className="form-grid">
        <Field label="Field key"><input value={key} onChange={(event) => setKey(event.target.value)} placeholder="owner" /></Field>
        <Field label="Field label"><input value={label} onChange={(event) => setLabel(event.target.value)} placeholder="Team owner" /></Field>
      </div>
      {error && <p className="field-error" role="alert">{error}</p>}
      <Button type="button" disabled={fields.length >= 12} onClick={add}>Add field</Button>
      <div className="dialog-actions"><Button type="button" onClick={onClose} disabled={busy}>Cancel</Button><Button type="button" variant="primary" disabled={busy} onClick={() => {
        setBusy(true);
        void onSave(fields).then((ok) => { if (ok) onClose(); }).finally(() => setBusy(false));
      }}>Save fields</Button></div>
    </Dialog>
  );
}

function OperationCustomFields({ operation, definitions, onSave }: {
  operation: Operation;
  definitions: CustomFieldDefinition[];
  onSave: (values: Record<string, string>) => Promise<boolean>;
}) {
  const [values, setValues] = useState<Record<string, string>>(operation.customFields || {});
  const [busy, setBusy] = useState(false);
  if (!definitions.length) return null;
  return <div className="token-generator">
    <div className="token-generator-head"><strong>Custom API fields</strong><small>Saved with this snapshot and included when shared. Do not enter secrets.</small></div>
    {definitions.map((field) => <Field key={field.key} label={field.label}><input maxLength={1000} value={values[field.key] || ''} onChange={(event) => setValues({ ...values, [field.key]: event.target.value })} /></Field>)}
    <Button type="button" disabled={busy} onClick={() => { setBusy(true); void onSave(values).finally(() => setBusy(false)); }}>{busy ? 'Saving…' : 'Save API fields'}</Button>
  </div>;
}

function App() {
  const desktop = window.desktop;
  const platform: Platform = desktop.platform;
  const [view, setView] = useState<View>('home');
  const [settingsSection, setSettingsSection] = useState<SettingsSection>('appearance');
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [workspaceSnapshots, setWorkspaceSnapshots] = useState<WorkspaceSnapshot[]>([]);
  const [activeSnapshotId, setActiveSnapshotId] = useState('');
  const [snapshotName, setSnapshotName] = useState('');
  const [preferences, setPreferences] = useState<Preferences>(defaultPreferences);
  const [library, setLibrary] = useState<Library>({ favourites: [], collections: [] });
  const [variables, setVariables] = useState<Variable[]>([]);
  const [customRequests, setCustomRequests] = useState<Array<Record<string, unknown>>>([]);
  const [environments, setEnvironments] = useState<Environment[]>([]);
  const [confirmations, setConfirmations] = useState<Array<Record<string, unknown>>>([]);
  const [selectedOperation, setSelectedOperation] = useState<Operation | null>(null);
  const [activeEnvironmentId, setActiveEnvironmentId] = useState('');
  const [search, setSearch] = useState('');
  const [aiSearchIds, setAiSearchIds] = useState<string[]>([]);
  const [aiSearchBusy, setAiSearchBusy] = useState(false);
  const [aiSearchMessage, setAiSearchMessage] = useState('');
  const [aiAvailable, setAiAvailable] = useState(false);
  const [selectedService, setSelectedService] = useState('');
  const [notice, setNotice] = useState<Notice | null>(null);
  const [noticePaused, setNoticePaused] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [commandOpen, setCommandOpen] = useState(false);
  const [commandQuery, setCommandQuery] = useState('');
  const [activeCommand, setActiveCommand] = useState(0);
  const [overflowOpen, setOverflowOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [findOpen, setFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState('');
  const [localProjects, setLocalProjects] = useState<Project[] | null>(null);
  const [githubProjectState, setGithubProjectState] = useState<{
    repo: string;
    path: string;
    token: string;
    branch: string;
    mode: 'clone' | 'api';
    keepClone: boolean;
    generateDocs: boolean;
    projects: Project[];
  } | null>(null);
  const [environmentEditor, setEnvironmentEditor] = useState<Environment | null>(null);
  const [variableEditor, setVariableEditor] = useState<Variable | null>(null);
  const [confirmationPrompt, setConfirmationPrompt] = useState<{
    operation: Operation;
    url: string;
    headers: Record<string, string>;
    body: string | null;
    environmentName: string;
    token: string;
    acceptIncomplete: boolean;
    required: boolean;
  } | null>(null);
  const [confirmText, setConfirmText] = useState('');
  const [tokensByEnvironment, setTokensByEnvironment] = useState<Record<string, string>>({});
  const [globalTokenTypeId, setGlobalTokenTypeId] = useState('');
  const [globalTokenBusy, setGlobalTokenBusy] = useState(false);
  const [globalTokenStatus, setGlobalTokenStatus] = useState('');
  const [requestEnvironmentId, setRequestEnvironmentId] = useState('');
  const [requestToken, setRequestToken] = useState('');
  const [response, setResponse] = useState<Record<string, unknown> | null>(null);
  const [requestValues, setRequestValues] = useState<Record<string, string>>({});
  const [requestHeaders, setRequestHeaders] = useState('');
  const [requestBody, setRequestBody] = useState('');
  const [acceptIncomplete, setAcceptIncomplete] = useState(false);
  const [collectionEditor, setCollectionEditor] = useState<string | null>(null);
  const [customRequestEditor, setCustomRequestEditor] = useState(false);
  const [customRequestMode, setCustomRequestMode] = useState<'form' | 'curl'>('form');
  const [curlCommand, setCurlCommand] = useState('');
  const [customRequestDraft, setCustomRequestDraft] = useState({
    name: '',
    method: 'GET',
    url: '',
    auth: 'none',
    body: '',
  });
  const [customRequestHeaders, setCustomRequestHeaders] = useState<Array<{ key: string; value: string; enabled: boolean }>>([]);
  const [localProjectSelection, setLocalProjectSelection] = useState<string[]>([]);
  const [docsSettings, setDocsSettings] = useState<Record<string, unknown>>({});
  const [tokenTypes, setTokenTypes] = useState<TokenType[]>([]);
  const [tokenEditor, setTokenEditor] = useState<TokenType | null>(null);
  const [shareSnapshotOpen, setShareSnapshotOpen] = useState(false);
  const [customFieldEditorOpen, setCustomFieldEditorOpen] = useState(false);
  const [scanRulesText, setScanRulesText] = useState('');
  const [aiStatus, setAiStatus] = useState('');
  const [aiKey, setAiKey] = useState('');
  const [docJob, setDocJob] = useState<Record<string, unknown>>({ state: 'idle' });
  const [docProgressVisible, setDocProgressVisible] = useState(false);
  const [keptClones, setKeptClones] = useState<string[]>([]);
  const [scanRefresh, setScanRefresh] = useState(false);
  const [documentationMode, setDocumentationMode] = useState<'automatic' | 'manual'>('automatic');
  const [closeRequest, setCloseRequest] = useState(false);
  const [snapshotRemoveId, setSnapshotRemoveId] = useState<string | null>(null);
  const [accessTokenOpen, setAccessTokenOpen] = useState(true);
  const [workspaceCollapsed, setWorkspaceCollapsed] = useState(false);
  const [workspaceSide, setWorkspaceSide] = useState<'left' | 'right'>('left');
  const [workspaceWidth, setWorkspaceWidth] = useState(232);
  const searchRef = useRef<HTMLInputElement>(null);
  const findInputRef = useRef<HTMLInputElement>(null);
  const commandRef = useRef<HTMLInputElement>(null);
  const requestSendRef = useRef<(() => void) | null>(null);
  const overflowRef = useRef<HTMLDivElement>(null);
  const aiSearchSequence = useRef(0);
  const latestSearch = useRef(search);
  const latestSnapshot = useRef(snapshot);
  latestSearch.current = search;
  latestSnapshot.current = snapshot;

  const notify = useCallback((message: string, severity: Severity = 'info') => {
    setNoticePaused(false);
    setNotice({ message, severity });
  }, []);

  useEffect(() => {
    if (!notice || noticePaused) return;
    const duration = Math.max(notice.severity === 'error' ? 12000 : 6000, Math.min(30000, notice.message.length * 80));
    const timer = window.setTimeout(() => setNotice(null), duration);
    return () => window.clearTimeout(timer);
  }, [notice, noticePaused]);

  useEffect(() => {
    if (!docProgressVisible || docJob.state === 'running') return;
    const timer = window.setTimeout(() => setDocProgressVisible(false), docJob.state === 'failed' ? 12000 : 6000);
    return () => window.clearTimeout(timer);
  }, [docProgressVisible, docJob.state]);

  useEffect(() => {
    if (!globalTokenStatus || globalTokenBusy) return;
    const timer = window.setTimeout(() => setGlobalTokenStatus(''), 12000);
    return () => window.clearTimeout(timer);
  }, [globalTokenStatus, globalTokenBusy]);

  const applySnapshot = useCallback((text: string, name: string, id = '', navigate = true) => {
    const parsed = parseSnapshot(text);
    setSnapshot(parsed);
    setSnapshotName(name);
    setActiveSnapshotId(id);
    setSelectedService(parsed.services[0]?.serviceId || '');
    setSelectedOperation(null);
    setAiSearchIds([]);
    if (navigate) setView('catalog');
  }, []);

  const refreshWorkspaceSnapshots = useCallback(async () => {
    const data = record(await desktop.listSnapshots());
    setWorkspaceSnapshots(arrayOf<WorkspaceSnapshot>(data.snapshots));
    setActiveSnapshotId(String(data.activeId || ''));
  }, [desktop]);

  const refreshSettingsData = useCallback(async () => {
    const [envResult, variableResult, confirmationResult, libraryResult, requestResult, tokenResult, scanResult] = await Promise.all([
      desktop.listEnvironments(),
      desktop.listVariables(),
      desktop.listConfirmations(),
      desktop.getLibrary(),
      desktop.listCustomRequests(),
      desktop.listTokenTypes(),
      desktop.getScanRules(),
    ]);
    const envData = record(envResult);
    const yours = arrayOf<Environment>(envData.yours).map((environment) => ({ ...environment, yours: true }));
    const overrides = record(envData.overrides);
    const hidden = new Set(arrayOf<string>(envData.hidden));
    const builtIns = (snapshot?.environments || [])
      .filter((environment) => environment.environmentId && !hidden.has(environment.environmentId))
      .map((environment) => {
        const override = record(overrides[environment.environmentId || '']);
        return {
          ...environment,
          ...(typeof override.baseUrl === 'string' ? { baseUrl: override.baseUrl, overridden: true } : {}),
          yours: false,
        };
      });
    const nextEnvironments = [...builtIns, ...yours];
    setEnvironments(nextEnvironments);
    if (!activeEnvironmentId || !nextEnvironments.some((environment) =>
      (environment.id || environment.environmentId) === activeEnvironmentId)) {
      setActiveEnvironmentId(nextEnvironments.find((environment) => environment.enabled !== false)?.id
        || nextEnvironments.find((environment) => environment.enabled !== false)?.environmentId
        || '');
    }
    setVariables(arrayOf<Variable>(record(variableResult).variables));
    setConfirmations(arrayOf<Record<string, unknown>>(record(confirmationResult).environments));
    const libraryData = record(record(libraryResult).library);
    setLibrary({
      favourites: arrayOf<LibraryItem>(libraryData.favourites),
      collections: arrayOf<Library['collections'][number]>(libraryData.collections),
    });
    setCustomRequests(arrayOf<Record<string, unknown>>(record(requestResult).requests));
    setTokenTypes(arrayOf<TokenType>(record(tokenResult).types));
    const rules = record(record(scanResult).rules);
    setScanRulesText((current) => current || JSON.stringify(rules, null, 2));
  }, [activeEnvironmentId, desktop, snapshot]);

  useEffect(() => {
    document.documentElement.dataset.platform = platform;
    document.documentElement.dataset.palette = preferences.palette;
    document.documentElement.dataset.theme = preferences.mode;
  }, [platform, preferences]);

  useEffect(() => {
    let active = true;
    Promise.all([desktop.getPreferences(), desktop.lastSnapshot(), desktop.getDocs(), desktop.listSnapshots(), desktop.modelStatus()])
      .then(([preferenceResult, lastSnapshot, docsResult, workspaceResult, modelResult]) => {
        if (!active) return;
        const saved = record(record(preferenceResult).preferences);
        const mode = ['system', 'light', 'dark'].includes(String(saved.mode))
          ? saved.mode as Preferences['mode']
          : defaultPreferences.mode;
        const palette = ['blue', 'teal', 'violet', 'amber', 'graphite'].includes(String(saved.palette))
          ? saved.palette as Preferences['palette']
          : defaultPreferences.palette;
        const columnWidths = Array.isArray(saved.columnWidths)
          && saved.columnWidths.length === 5
          && saved.columnWidths.every((width) => typeof width === 'number' && Number.isInteger(width) && width >= 60 && width <= 1200)
          ? saved.columnWidths as number[]
          : null;
        const textScale = typeof saved.textScale === 'number' && Number.isInteger(saved.textScale) && saved.textScale >= 80 && saved.textScale <= 150 && saved.textScale % 10 === 0 ? saved.textScale : 100;
        setPreferences({ mode, palette, wrapText: saved.wrapText === true, columnWidths, textScale });
        void desktop.setTextScale(textScale).then((result) => {
          const problem = resultError(result);
          if (problem) throw new Error(problem);
        }).catch((error: unknown) => notify(`Could not apply text size: ${errorMessage(error)}`, 'error'));
        const workspace = record(workspaceResult);
        setWorkspaceSnapshots(arrayOf<WorkspaceSnapshot>(workspace.snapshots));
        setActiveSnapshotId(String(workspace.activeId || lastSnapshot?.id || ''));
        const model = record(modelResult);
        setAiAvailable(model.available === true);
        if (model.available === true) setAiStatus(`Connected · ${String(model.model || 'model ready')}`);
        void desktop.setWindowAppearance(mode).catch((error: unknown) =>
          notify(`Could not update the window appearance: ${errorMessage(error)}`, 'error'));
        setDocsSettings(record(docsResult));
        if (lastSnapshot) applySnapshot(lastSnapshot.text, lastSnapshot.name, lastSnapshot.id, false);
      })
      .catch((error: unknown) => notify(`Could not load saved app data: ${errorMessage(error)}`, 'error'))
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => { active = false; };
  }, [applySnapshot, desktop, notify]);

  useEffect(() => {
    refreshSettingsData().catch((error: unknown) => notify(`Could not load workspace settings: ${errorMessage(error)}`, 'error'));
  }, [refreshSettingsData, snapshot]);

  useEffect(() => {
    if (!overflowOpen) return;
    const dismiss = (event: MouseEvent) => {
      if (overflowRef.current && !overflowRef.current.contains(event.target as Node)) setOverflowOpen(false);
    };
    const onEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOverflowOpen(false);
    };
    document.addEventListener('mousedown', dismiss);
    document.addEventListener('keydown', onEscape);
    return () => {
      document.removeEventListener('mousedown', dismiss);
      document.removeEventListener('keydown', onEscape);
    };
  }, [overflowOpen]);

  useEffect(() => desktop.onFindResult(() => {
    if (findOpen) window.setTimeout(() => findInputRef.current?.focus(), 0);
  }), [desktop, findOpen]);

  useEffect(() => {
    let active = true;
    const refreshDocState = async () => {
      try {
        const [job, clones] = await Promise.all([desktop.getDocJob(), desktop.listKeptClones()]);
        if (!active) return;
        const nextJob = record(job);
        setDocJob(nextJob);
        if (nextJob.state === 'running' && docJob.state !== 'running') setDocProgressVisible(true);
        if (nextJob.state !== 'running') {
          const docs = record(await desktop.getDocs());
          if (active) setDocsSettings(docs);
        }
        setKeptClones(arrayOf<string>(record(clones).paths));
      } catch (error) {
        if (active) notify(`Could not refresh documentation status: ${errorMessage(error)}`, 'error');
      }
    };
    void refreshDocState();
    const timer = window.setInterval(() => {
      if (docJob.state === 'running') void refreshDocState();
    }, 2000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [desktop, docJob.state, notify]);

  useEffect(() => {
    const unsubscribeSettings = desktop.onSettingsOpen(() => {
      setView('settings');
      setSettingsSection('appearance');
    });
    const unsubscribeFind = desktop.onFindOpen(() => {
      setFindOpen(true);
      window.setTimeout(() => document.getElementById('find-input')?.focus(), 0);
    });
    const unsubscribeClose = desktop.onCloseRequest(() => {
      if (commandOpen) setCommandOpen(false);
      else if (confirmationPrompt) setConfirmationPrompt(null);
      else if (selectedOperation || environmentEditor || variableEditor || localProjects || githubProjectState) {
        setSelectedOperation(null);
        setEnvironmentEditor(null);
        setVariableEditor(null);
        setLocalProjects(null);
        setGithubProjectState(null);
      } else setCloseRequest(true);
    });
    return () => {
      unsubscribeSettings();
      unsubscribeFind();
      unsubscribeClose();
    };
  }, [commandOpen, confirmationPrompt, desktop, environmentEditor, githubProjectState, localProjects, selectedOperation, variableEditor]);

  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      const key = event.key.toLowerCase();
      const modifier = event.metaKey || event.ctrlKey;
      if (modifier && key === 'k') {
        event.preventDefault();
        setCommandOpen((open) => !open);
      } else if (modifier && key === ',') {
        event.preventDefault();
        setView('settings');
      } else if (modifier && key === 'f') {
        event.preventDefault();
        setFindOpen(true);
        window.setTimeout(() => document.getElementById('find-input')?.focus(), 0);
      } else if (modifier && key === 'n') {
        event.preventDefault();
        setCustomRequestEditor(true);
      } else if (modifier && key === 'o') {
        event.preventDefault();
        void desktop.openSnapshot().then((opened) => {
          if (opened) {
            applySnapshot(opened.text, opened.name, opened.id);
            const skipped = opened.skipped || [];
            notify(skipped.length ? `Opened ${opened.name}. Skipped imports: ${skipped.join(' ')}` : `Opened ${opened.name}.`, skipped.length ? 'info' : 'success');
            void refreshWorkspaceSnapshots();
          }
        }).catch((error: unknown) => notify(`The snapshot could not be opened: ${errorMessage(error)}`, 'error'));
      } else if (modifier && key === 'enter' && selectedOperation) {
        event.preventDefault();
        requestSendRef.current?.();
      } else if (event.key === 'Escape') {
        if (commandOpen) setCommandOpen(false);
        else if (findOpen) {
          setFindOpen(false);
          void desktop.stopFind();
        } else if (confirmationPrompt) setConfirmationPrompt(null);
        else if (selectedOperation) setSelectedOperation(null);
        else if (overflowOpen) setOverflowOpen(false);
        else if (shortcutsOpen) setShortcutsOpen(false);
      } else if (event.altKey && event.key === 'ArrowLeft') {
        event.preventDefault();
        setView('home');
      }
    };
    window.addEventListener('keydown', listener);
    return () => window.removeEventListener('keydown', listener);
  }, [applySnapshot, commandOpen, confirmationPrompt, desktop, findOpen, notify, overflowOpen, refreshWorkspaceSnapshots, selectedOperation, shortcutsOpen, snapshot]);

  useEffect(() => {
    if (commandOpen) {
      setCommandQuery('');
      setActiveCommand(0);
      window.setTimeout(() => commandRef.current?.focus(), 0);
    }
  }, [commandOpen]);

  useEffect(() => {
    if (customRequestEditor) {
      setCustomRequestMode('form');
      setCurlCommand('');
      setCustomRequestDraft({ name: '', method: 'GET', url: '', auth: 'none', body: '' });
      setCustomRequestHeaders([]);
    }
  }, [customRequestEditor]);

  useEffect(() => setActiveCommand(0), [commandQuery]);

  const activeEnvironment = environments.find((environment) =>
    (environment.id || environment.environmentId) === activeEnvironmentId);
  const tokenEnvironmentKey = activeEnvironment?.environmentId || activeEnvironment?.id || activeEnvironmentId || 'workspace';
  const token = tokensByEnvironment[tokenEnvironmentKey] || '';
  const setToken = useCallback((value: string) => {
    setTokensByEnvironment((current) => ({ ...current, [tokenEnvironmentKey]: value }));
  }, [tokenEnvironmentKey]);
  const documentedOperations = useMemo(() => {
    const generatedDocs = record(docsSettings.docs);
    return (snapshot?.operations || []).map((operation) => {
      const generated = record(operation.revisionId ? generatedDocs[operation.revisionId] : undefined);
      const description = typeof generated.description === 'string' ? generated.description : '';
      const summary = typeof generated.summary === 'string' ? generated.summary : '';
      return {
        ...operation,
        description: operation.description || description,
        summary: operation.summary || summary,
      };
    });
  }, [docsSettings.docs, snapshot]);
  const searchCandidates = useMemo(() => documentedOperations.map((operation) => ({
    id: operation.operationId,
    method: operation.httpMethod,
    path: operation.pathTemplate,
    summary: operation.summary || '',
    description: operation.description || '',
    service: operation.serviceName,
    version: operation.contractVersion || '',
    metadata: (snapshot?.customFieldDefinitions || []).map((field) => {
      const value = operation.customFields?.[field.key];
      return value ? `${field.label} ${value}` : '';
    }).join(' '),
  })), [documentedOperations, snapshot?.customFieldDefinitions]);

  const runAiSearch = useCallback(async (question = search) => {
    const normalized = question.trim();
    if (!normalized || !snapshot) return;
    const sequence = ++aiSearchSequence.current;
    setAiSearchBusy(true);
    setAiSearchMessage('');
    try {
      const ranked = rankApiSearch(normalized, searchCandidates).map((entry) => entry.candidate);
      const rankedIds = new Set(ranked.map((candidate) => candidate.id));
      const candidates = [...ranked, ...searchCandidates.filter((candidate) => !rankedIds.has(candidate.id))].slice(0, 40);
      const raw = record(await desktop.askAgents({ question: normalized, candidates }));
      if (sequence !== aiSearchSequence.current || normalized !== latestSearch.current.trim() || snapshot !== latestSnapshot.current) return;
      const problem = resultError(raw);
      if (problem) throw new Error(problem);
      setAiSearchIds(arrayOf<string>(raw.ids));
      if (typeof raw.message === 'string' && raw.message) setAiSearchMessage(raw.message);
      if (raw.action !== 'search') notify(String(raw.message || 'AI could not search this request.'), 'info');
    } catch (error) {
      if (sequence !== aiSearchSequence.current || normalized !== latestSearch.current.trim() || snapshot !== latestSnapshot.current) return;
      setAiSearchIds([]);
      notify(`AI search is unavailable; showing regular matches. ${errorMessage(error)}`, 'info');
    } finally {
      if (sequence === aiSearchSequence.current) setAiSearchBusy(false);
    }
  }, [desktop, notify, search, searchCandidates, snapshot]);

  useEffect(() => {
    aiSearchSequence.current++;
    setAiSearchIds([]);
    setAiSearchMessage('');
    setAiSearchBusy(false);
    if (!aiAvailable || search.trim().length < 3 || !snapshot) {
      return;
    }
    const timer = window.setTimeout(() => { void runAiSearch(search); }, 900);
    return () => window.clearTimeout(timer);
  }, [aiAvailable, runAiSearch, search, snapshot]);

  const filteredOperations = useMemo(() => {
    const normalized = search.trim();
    const aiRank = new Map(aiSearchIds.map((id, index) => [id, index]));
    return documentedOperations.map((operation, index) => ({
      operation,
      index,
      score: normalized ? scoreApiSearch(normalized, searchCandidates[index]) : 0,
    })).filter(({ operation, score }) => {
      const matchesService = !selectedService || operation.serviceId === selectedService
        || operation.serviceName === snapshot?.services.find((service) => service.serviceId === selectedService)?.name;
      return matchesService && (!normalized || score > 0 || aiRank.has(operation.operationId));
    }).sort((left, right) => {
      const leftRank = aiRank.get(left.operation.operationId);
      const rightRank = aiRank.get(right.operation.operationId);
      return combinedSearchScore(right.score, rightRank) - combinedSearchScore(left.score, leftRank) || left.index - right.index;
    }).map(({ operation }) => operation);
  }, [aiSearchIds, documentedOperations, searchCandidates, search, selectedService, snapshot]);

  useEffect(() => {
    if (!selectedOperation?.revisionId) return;
    const generated = record(record(docsSettings.docs)[selectedOperation.revisionId]);
    if (typeof generated.description !== 'string' || selectedOperation.description === generated.description) return;
    setSelectedOperation({ ...selectedOperation, description: generated.description });
  }, [docsSettings.docs, selectedOperation]);

  const runOperation = useCallback(async (
    operation: Operation,
    url: string,
    headers: Record<string, string>,
    body: string | null,
    environmentName: string,
    confirmedName = '',
    accept = false,
    requestToken = '',
  ) => {
    setBusy(true);
    setResponse(null);
    try {
      const result = record(await desktop.runRequest({
        method: operation.httpMethod,
        url,
        headers,
        body,
        environmentName,
        confirmEnvironment: confirmedName,
        confirmWrite: false,
        acceptIncomplete: accept,
        token: requestToken,
        operation,
      }));
      setResponse(result);
      const message = resultError(result);
      if (message) notify(message, 'error');
      else notify(`Request completed with HTTP ${String(result.status)}.`, 'success');
    } catch (error) {
      notify(`The request could not be sent: ${errorMessage(error)}`, 'error');
    } finally {
      setBusy(false);
    }
  }, [desktop, notify]);

  const sendSelectedRequest = useCallback(async () => {
    if (!selectedOperation) return;
    const requestEnvironment = environments.find((environment) =>
      (environment.id || environment.environmentId) === requestEnvironmentId);
    const environmentName = requestEnvironment?.name || '';
    const params = operationParameters(selectedOperation);
    const missing = params.find((parameter) => parameter.required && !requestValues[parameter.name]?.trim());
    if (missing) {
      notify(`Enter a value for the required ${missing.in} parameter “${missing.name}”.`, 'error');
      return;
    }
    const pathValues = Object.fromEntries(params.filter((parameter) => parameter.in === 'path')
      .map((parameter) => [parameter.name, requestValues[parameter.name] || '']));
    let url = applyAccessToken(routeUrl(selectedOperation, requestEnvironment, pathValues), requestToken);
    const query = new URLSearchParams();
    for (const parameter of params.filter((item) => item.in === 'query')) {
      const value = requestValues[parameter.name] || '';
      if (value) query.set(parameter.name, value);
    }
    const queryString = query.toString();
    if (queryString) url += `${url.includes('?') ? '&' : '?'}${queryString}`;
    const headers: Record<string, string> = {};
    for (const parameter of params.filter((item) => item.in === 'header')) {
      const value = requestValues[parameter.name] || '';
      if (value) headers[parameter.name] = applyAccessToken(value, requestToken);
    }
    for (const line of requestHeaders.split(/\r?\n/)) {
      const separator = line.indexOf(':');
      if (separator > 0) headers[line.slice(0, separator).trim()] = applyAccessToken(line.slice(separator + 1).trim(), requestToken);
    }
    const body = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(selectedOperation.httpMethod)
      ? applyAccessToken(requestBody, requestToken) || null
      : null;
    if (!requestEnvironment || !environmentName) {
      notify('Choose an enabled environment before sending a request.', 'error');
      return;
    }
    try {
      const confirmation = await desktop.confirmationRequired({ environmentName, method: selectedOperation.httpMethod });
      const contractNeedsConfirmation = selectedOperation.schemaComplete === false && !acceptIncomplete;
      if (confirmation.required || contractNeedsConfirmation) {
        setConfirmText('');
        setConfirmationPrompt({
          operation: selectedOperation,
          url,
          headers,
          body,
          environmentName,
          token: requestToken,
          acceptIncomplete: contractNeedsConfirmation || acceptIncomplete,
          required: confirmation.required,
        });
        return;
      }
    } catch (error) {
      notify(`Could not check the environment confirmation settings: ${errorMessage(error)}`, 'error');
      return;
    }
    await runOperation(selectedOperation, url, headers, body, environmentName, '', acceptIncomplete, requestToken);
  }, [acceptIncomplete, desktop, environments, notify, requestBody, requestEnvironmentId, requestHeaders, requestToken, requestValues, runOperation, selectedOperation]);

  useEffect(() => {
    requestSendRef.current = () => { void sendSelectedRequest(); };
  }, [sendSelectedRequest]);

  const openSnapshot = async () => {
    setBusy(true);
    try {
      const opened = await desktop.openSnapshot();
      if (opened) {
        applySnapshot(opened.text, opened.name, opened.id);
        await refreshWorkspaceSnapshots();
        const skipped = opened.skipped || [];
        notify(skipped.length ? `Opened ${opened.name}. Skipped imports: ${skipped.join(' ')}` : `Opened ${opened.name}.`, skipped.length ? 'info' : 'success');
      }
    } catch (error) {
      notify(`The snapshot could not be opened: ${errorMessage(error)}`, 'error');
    } finally {
      setBusy(false);
    }
  };

  const stopDocumentation = async () => {
    setDocJob((current) => ({ ...current, state: 'stopped', reason: 'Stopped by user.' }));
    setDocProgressVisible(true);
    try {
      const result = record(await desktop.stopDocJob());
      setDocJob(result);
      notify('Documentation generation stopped.', 'info');
    } catch (error) {
      notify(`Documentation could not be stopped: ${errorMessage(error)}`, 'error');
    }
  };

  const selectSnapshot = async (id: string) => {
    if (id === activeSnapshotId) return;
    setBusy(true);
    try {
      const raw = record(await desktop.selectSnapshot(id));
      const problem = resultError(raw);
      if (problem) throw new Error(problem);
      const selected = record(raw.snapshot);
      if (typeof selected.text !== 'string' || typeof selected.name !== 'string') throw new Error('The snapshot could not be opened.');
      applySnapshot(selected.text, selected.name, String(selected.id || id));
      await refreshWorkspaceSnapshots();
    } catch (error) {
      notify(`Could not switch snapshots: ${errorMessage(error)}`, 'error');
    } finally {
      setBusy(false);
    }
  };

  const removeSnapshot = async (id: string) => {
    setBusy(true);
    try {
      const result = record(await desktop.removeSnapshot(id));
      const problem = resultError(result);
      if (problem) throw new Error(problem);
      const nextId = String(result.activeId || '');
      await refreshWorkspaceSnapshots();
      if (id === activeSnapshotId) {
        if (nextId) {
          const selected = record(await desktop.selectSnapshot(nextId));
          const snapshotData = record(selected.snapshot);
          if (typeof snapshotData.text === 'string' && typeof snapshotData.name === 'string') {
            applySnapshot(snapshotData.text, snapshotData.name, nextId);
          }
        } else {
          setSnapshot(null);
          setSnapshotName('');
          setActiveSnapshotId('');
          setSelectedOperation(null);
          setView('home');
        }
      }
      await refreshSettingsData();
      setSnapshotRemoveId(null);
      notify('Only that workspace snapshot was removed. Your own environments were kept.', 'success');
    } catch (error) {
      notify(`Could not remove the snapshot: ${errorMessage(error)}`, 'error');
    } finally {
      setBusy(false);
    }
  };

  const beginLocalScan = async () => {
    try {
      const picked = await desktop.pickFolder();
      if (!picked.ok || !picked.path) return;
      setBusy(true);
      const result = record(await desktop.findLocalProjects({ folder: picked.path }));
      const problem = resultError(result);
      if (problem) {
        notify(problem, 'error');
        return;
      }
      const projects = arrayOf<Project>(record(result).projects);
      if (projects.length === 0) {
        notify('No supported API projects with endpoints were found in that folder.', 'info');
        return;
      }
      setLocalProjects(projects.map((project) => ({ ...project, absolute: project.absolute || picked.path })));
      setLocalProjectSelection(projects.map((project) => `${project.path}-${project.name}`));
    } catch (error) {
      notify(`Could not scan that folder: ${errorMessage(error)}`, 'error');
    } finally {
      setBusy(false);
    }
  };

  const scanLocalProjects = async (projects: Project[]) => {
    const sources = projects.map((project) => ({
      repo: project.absolute || project.path,
      service: project.name,
    }));
    setBusy(true);
    try {
      const result = record(await desktop.scanGitHub({ mode: 'folder', sources, splitProjects: false, generateDocs: docsSettings.generateAfterScan !== false, refresh: scanRefresh }));
      const message = resultError(result);
      if (message) {
        notify(message, 'error');
        return;
      }
      if (typeof result.text !== 'string') throw new Error('The scan did not return a catalogue.');
      applySnapshot(result.text, `Local scan: ${projects.map((project) => project.name).join(', ')}`);
      await refreshWorkspaceSnapshots();
      await showScanDocumentationStatus(result.documentation);
      setScanRefresh(false);
      setLocalProjects(null);
    } catch (error) {
      notify(`The local scan failed: ${errorMessage(error)}`, 'error');
    } finally {
      setBusy(false);
    }
  };

  const openGithubScan = () => {
    setGithubProjectState({ repo: '', path: '', token: '', branch: '', mode: 'clone', keepClone: false, generateDocs: docsSettings.generateAfterScan !== false, projects: [] });
  };

  const findGithubProjects = async (event: FormEvent) => {
    event.preventDefault();
    if (!githubProjectState) return;
    setBusy(true);
    try {
      const result = record(await desktop.findGitHubProjects({
        repo: githubProjectState.repo,
        path: githubProjectState.path,
        token: githubProjectState.token,
        branch: githubProjectState.branch,
        mode: githubProjectState.mode,
      }));
      const problem = resultError(result);
      if (problem) {
        notify(problem, 'error');
        return;
      }
      const projects = arrayOf<Project>(result.projects);
      setGithubProjectState({ ...githubProjectState, projects });
      if (!projects.length) notify('No supported API projects were found at that repository path.', 'info');
    } catch (error) {
      notify(`Could not inspect the GitHub repository: ${errorMessage(error)}`, 'error');
    } finally {
      setBusy(false);
    }
  };

  const scanGithubProjects = async (projects: Project[]) => {
    if (!githubProjectState) return;
    const sources = projects.map((project) => ({
      repo: `${githubProjectState.repo}${githubProjectState.branch ? `@${githubProjectState.branch}` : ''}`,
      path: project.path,
      service: project.name,
    }));
    setBusy(true);
    try {
      const result = record(await desktop.scanGitHub({
        mode: githubProjectState.mode,
        sources,
        token: githubProjectState.token,
        splitProjects: false,
        keepClone: githubProjectState.keepClone,
        generateDocs: githubProjectState.generateDocs,
        refresh: scanRefresh,
      }));
      const problem = resultError(result);
      if (problem) {
        notify(problem, 'error');
        return;
      }
      if (typeof result.text !== 'string') throw new Error('The scan did not return a catalogue.');
      applySnapshot(result.text, `GitHub scan: ${projects.map((project) => project.name).join(', ')}`);
      await refreshWorkspaceSnapshots();
      await showScanDocumentationStatus(result.documentation);
      setScanRefresh(false);
      setGithubProjectState(null);
    } catch (error) {
      notify(`The GitHub scan failed: ${errorMessage(error)}`, 'error');
    } finally {
      setBusy(false);
    }
  };

  const openSettings = (section: SettingsSection = 'appearance') => {
    setView('settings');
    setSettingsSection(section);
    setSelectedOperation(null);
  };

  const persistLibrary = async (next: Library) => {
    const result = await desktop.saveLibrary(next);
    const problem = resultError(result);
    if (problem) throw new Error(problem);
    const saved = record(record(result).library);
    setLibrary({
      favourites: arrayOf<LibraryItem>(saved.favourites),
      collections: arrayOf<Library['collections'][number]>(saved.collections),
    });
  };

  const removeFavouriteItem = async (item: LibraryItem) => {
    const next = {
      ...library,
      favourites: library.favourites.filter((favourite) => !(favourite.httpMethod === item.httpMethod
        && favourite.pathTemplate === item.pathTemplate
        && favourite.serviceName === item.serviceName
        && favourite.contractVersion === item.contractVersion)),
    };
    try {
      await persistLibrary(next);
      notify('Removed from favourites.', 'success');
    } catch (error) {
      notify(`Could not update favourites: ${errorMessage(error)}`, 'error');
    }
  };

  const removeCollectionItem = async (collectionId: string, item: LibraryItem) => {
    const next = {
      ...library,
      collections: library.collections.map((collection) => collection.id === collectionId
        ? { ...collection, items: collection.items.filter((existing) => !(existing.operationId === item.operationId
          || (existing.httpMethod === item.httpMethod
            && existing.pathTemplate === item.pathTemplate
            && existing.serviceName === item.serviceName
            && existing.contractVersion === item.contractVersion))) }
        : collection),
    };
    try {
      await persistLibrary(next);
      notify('Removed API from collection.', 'success');
    } catch (error) {
      notify(`Could not update the collection: ${errorMessage(error)}`, 'error');
    }
  };

  const toggleFavourite = async (operation: Operation) => {
    const item = libraryItem(operation);
    const exists = library.favourites.some((favourite) =>
      favourite.httpMethod === item.httpMethod
      && favourite.pathTemplate === item.pathTemplate
      && favourite.serviceName === item.serviceName
      && favourite.contractVersion === item.contractVersion);
    const next = {
      ...library,
      favourites: exists
        ? library.favourites.filter((favourite) => !(favourite.httpMethod === item.httpMethod
          && favourite.pathTemplate === item.pathTemplate && favourite.serviceName === item.serviceName
          && favourite.contractVersion === item.contractVersion))
        : [...library.favourites, item],
    };
    try {
      await persistLibrary(next);
      notify(exists ? 'Removed from favourites.' : 'Added to favourites.', 'success');
    } catch (error) {
      notify(`Could not update favourites: ${errorMessage(error)}`, 'error');
    }
  };

  const createCollection = async (event: FormEvent) => {
    event.preventDefault();
    const name = (collectionEditor || '').trim();
    if (!name) return;
    try {
      await persistLibrary({ ...library, collections: [...library.collections, { id: `col:${crypto.randomUUID()}`, name, items: [] }] });
      setCollectionEditor(null);
      notify('Collection created.', 'success');
    } catch (error) {
      notify(`Could not create collection: ${errorMessage(error)}`, 'error');
    }
  };

  const addToCollection = async (collectionId: string, operation: Operation) => {
    const item = libraryItem(operation);
    const next = {
      ...library,
      collections: library.collections.map((collection) => collection.id === collectionId
        ? { ...collection, items: collection.items.some((existing) => existing.operationId === item.operationId)
          ? collection.items
          : [...collection.items, item] }
        : collection),
    };
    try {
      await persistLibrary(next);
      notify('Added API to collection.', 'success');
    } catch (error) {
      notify(`Could not update the collection: ${errorMessage(error)}`, 'error');
    }
  };

  const openOperation = (operation: Operation) => {
    setSelectedOperation(operation);
    setRequestEnvironmentId(activeEnvironmentId);
    setRequestToken(token);
    setRequestValues({});
    setRequestHeaders('');
    setRequestBody('');
    setAcceptIncomplete(false);
    setResponse(null);
  };

  const saveEnvironment = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!environmentEditor) return;
    const form = new FormData(event.currentTarget);
    const input = {
      ...(environmentEditor.id ? { id: environmentEditor.id } : {}),
      name: String(form.get('name') || ''),
      baseUrl: String(form.get('baseUrl') || ''),
      production: form.get('production') === 'on',
      enabled: form.get('enabled') === 'on',
    };
    try {
      const result = await desktop.saveEnvironment(input);
      const problem = resultError(result);
      if (problem) throw new Error(problem);
      setEnvironmentEditor(null);
      await refreshSettingsData();
      notify('Environment saved.', 'success');
    } catch (error) {
      notify(`Could not save environment: ${errorMessage(error)}`, 'error');
    }
  };

  const saveVariable = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!variableEditor) return;
    const form = new FormData(event.currentTarget);
    const input = {
      ...(variableEditor.id ? { id: variableEditor.id } : {}),
      name: String(form.get('name') || ''),
      value: String(form.get('value') || ''),
    };
    try {
      const result = await desktop.saveVariable(input);
      const problem = resultError(result);
      if (problem) throw new Error(problem);
      setVariableEditor(null);
      await refreshSettingsData();
      notify('Variable saved.', 'success');
    } catch (error) {
      notify(`Could not save variable: ${errorMessage(error)}`, 'error');
    }
  };

  const savePreference = async (patch: Partial<Preferences>) => {
    const next = { ...preferences, ...patch };
    try {
      const result = await desktop.savePreferences(next);
      const problem = resultError(result);
      if (problem) throw new Error(problem);
      setPreferences(next);
      if (next.textScale !== preferences.textScale) {
        const scaleResult = await desktop.setTextScale(next.textScale);
        const scaleProblem = resultError(scaleResult);
        if (scaleProblem) throw new Error(scaleProblem);
      }
      const chromeResult = await desktop.setWindowAppearance(next.mode);
      const chromeProblem = resultError(chromeResult);
      if (chromeProblem) throw new Error(chromeProblem);
    } catch (error) {
      notify(`Could not save appearance settings: ${errorMessage(error)}`, 'error');
    }
  };

  const deleteEnvironment = async (environment: Environment) => {
    if (!environment.id) return;
    try {
      const result = await desktop.deleteEnvironment(environment.id);
      const problem = resultError(result);
      if (problem) throw new Error(problem);
      await refreshSettingsData();
      notify('Environment removed.', 'success');
    } catch (error) {
      notify(`Could not remove environment: ${errorMessage(error)}`, 'error');
    }
  };

  const deleteVariable = async (variable: Variable) => {
    try {
      const result = await desktop.deleteVariable(variable.id);
      const problem = resultError(result);
      if (problem) throw new Error(problem);
      await refreshSettingsData();
      notify('Variable removed.', 'success');
    } catch (error) {
      notify(`Could not remove variable: ${errorMessage(error)}`, 'error');
    }
  };

  const saveTokenType = async (config: TokenCurlConfig & { name: string; tokenField: string }) => {
    if (!tokenEditor) return;
    try {
      const result = record(await desktop.saveTokenType({ id: tokenEditor.id || undefined, config: { ...config, mode: 'request' } }));
      const problem = resultError(result);
      if (problem) throw new Error(problem);
      setTokenTypes(arrayOf<TokenType>(record(result).types));
      setTokenEditor(null);
      notify(tokenEditor.id ? 'Token type updated.' : 'Token type created.', 'success');
    } catch (error) {
      notify(`Could not save the token type: ${errorMessage(error)}`, 'error');
    }
  };

  const deleteTokenType = async (token: TokenType) => {
    try {
      const result = record(await desktop.saveTokenType({ id: token.id, config: null }));
      const problem = resultError(result);
      if (problem) throw new Error(problem);
      setTokenTypes(arrayOf<TokenType>(record(result).types));
      notify('Token type removed.', 'success');
    } catch (error) {
      notify(`Could not remove the token type: ${errorMessage(error)}`, 'error');
    }
  };

  const saveScanRules = async () => {
    try {
      const rules = JSON.parse(scanRulesText);
      const result = record(await desktop.saveScanRules({ rules }));
      const problem = resultError(result);
      if (problem) throw new Error(problem);
      const saved = record(record(result).rules);
      setScanRulesText(JSON.stringify(saved, null, 2));
      notify('Scan rules saved.', 'success');
    } catch (error) {
      notify(`Could not save scan rules: ${errorMessage(error)}`, 'error');
    }
  };

  const resetScanRules = async (presetId = 'spring') => {
    try {
      const result = record(await desktop.getScanRules());
      const presets = arrayOf<{ id: string; rules: Record<string, unknown> }>(record(result).presets);
      const preset = presets.find((item) => item.id === presetId) || presets.find((item) => item.id === 'spring');
      if (!preset) throw new Error('The selected scan preset is unavailable.');
      setScanRulesText(JSON.stringify(preset.rules, null, 2));
      notify(`${String(preset.rules.name || 'Preset')} loaded. Save to apply it.`, 'info');
    } catch (error) {
      notify(`Could not reset scan rules: ${errorMessage(error)}`, 'error');
    }
  };

  const changeConfirmation = async (environmentId: string, method: string, checked: boolean) => {
    const current = confirmations.find((row) => row.environmentId === environmentId);
    const currentMethods = record(current?.methods);
    const nextMethods = { ...currentMethods, [method]: checked };
    try {
      const result = await desktop.saveConfirmations({ environmentId, methods: nextMethods });
      const problem = resultError(result);
      if (problem) throw new Error(problem);
      setConfirmations(arrayOf<Record<string, unknown>>(record(result).environments));
      notify('Request confirmation settings updated.', 'success');
    } catch (error) {
      notify(`Could not update confirmation settings: ${errorMessage(error)}`, 'error');
    }
  };

  const saveAiSettings = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const generateAfterScan = event.currentTarget.querySelector<HTMLInputElement>('input[name="generateAfterScan"]');
    const input = {
      provider: String(form.get('provider') || 'local'),
      baseUrl: String(form.get('baseUrl') || ''),
      model: String(form.get('model') || ''),
      instructions: String(form.get('instructions') ?? docsSettings.instructions ?? ''),
      afterScanInstructions: String(form.get('afterScanInstructions') ?? docsSettings.afterScanInstructions ?? ''),
      generateAfterScan: generateAfterScan ? generateAfterScan.checked : docsSettings.generateAfterScan !== false,
    };
    setBusy(true);
    try {
      const result = record(await desktop.saveDocSettings(input));
      const problem = resultError(result);
      if (problem) throw new Error(problem);
      if (aiKey) {
        const keyResult = await desktop.setDocKey({ provider: input.provider, key: aiKey });
        const keyProblem = resultError(keyResult);
        if (keyProblem) throw new Error(keyProblem);
        setAiKey('');
      }
      setDocsSettings(record(await desktop.getDocs()));
      const status = record(await desktop.modelStatus());
      setAiAvailable(status.available === true);
      setAiStatus(status.available === true
        ? `Connected · ${String(status.model || 'model ready')}`
        : String(status.reason || 'Model is not available.'));
      notify('AI settings saved for this session.', 'success');
    } catch (error) {
      notify(`Could not save AI settings: ${errorMessage(error)}`, 'error');
    } finally {
      setBusy(false);
    }
  };

  const testAiConnection = async () => {
    setBusy(true);
    try {
      const status = record(await desktop.modelStatus());
      setAiAvailable(status.available === true);
      setAiStatus(status.available === true ? `Connected · ${String(status.model || 'model ready')}` : String(status.reason || 'Model is not available.'));
      notify(status.available === true ? 'AI provider is available.' : 'AI provider is not available.', status.available === true ? 'success' : 'info');
    } catch (error) {
      notify(`Could not check the AI provider: ${errorMessage(error)}`, 'error');
    } finally {
      setBusy(false);
    }
  };

  const generateDocumentation = async (operations: Operation[]) => {
    if (operations.length === 0) {
      notify('Load a catalog before generating documentation.', 'info');
      return;
    }
    try {
      const result = record(await desktop.generateDocs({ operations }));
      const problem = resultError(result);
      if (problem) throw new Error(problem);
      setDocJob({ state: 'running', total: operations.length, done: 0, reason: String(result.reason || '') });
      setDocProgressVisible(true);
      notify(String(result.factualFallback
        ? 'AI is unavailable, so documentation is being created from the API contract.'
        : 'Documentation generation started.'), result.factualFallback ? 'info' : 'success');
    } catch (error) {
      notify(`Documentation could not be started: ${errorMessage(error)}`, 'error');
    }
  };

  const copyExternalPrompt = async (kind: 'source' | 'enrich') => {
    const prompt = record(docsSettings.externalPrompts)[kind];
    if (typeof prompt !== 'string' || !prompt) {
      notify('The external documentation prompt is unavailable.', 'error');
      return;
    }
    try {
      const definitions = snapshot?.customFieldDefinitions || [];
      const requestedFields = definitions.length
        ? `\n\nRequested custom fields: ${JSON.stringify(definitions)}.`
        : '\n\nSpecify any desired custom field keys and labels when supplying the source or catalog.';
      await navigator.clipboard.writeText(`${prompt}${requestedFields}`);
      notify('Prompt copied. Review source or catalog data before sharing it with an external tool.', 'success');
    } catch (error) {
      notify(`Could not copy the prompt: ${errorMessage(error)}`, 'error');
    }
  };

  const exportSnapshot = async (selection: Record<string, unknown>): Promise<boolean> => {
    try {
      const result = record(await desktop.exportCatalog(selection));
      if (result.cancelled === true) return false;
      const problem = resultError(result);
      if (problem) throw new Error(problem);
      if (result.ok !== true) throw new Error('The catalog could not be exported.');
      notify('Snapshot exported. Review it before sharing.', 'success');
      return true;
    } catch (error) {
      notify(`Could not export the snapshot: ${errorMessage(error)}`, 'error');
      return false;
    }
  };

  const saveCustomFields = async (definitions: CustomFieldDefinition[], changed?: { id: string; values: Record<string, string> }): Promise<boolean> => {
    if (!snapshot) return false;
    const keys = new Set(definitions.map((field) => field.key));
    const values = Object.fromEntries(snapshot.operations.map((operation) => {
      const current = changed?.id === operation.operationId ? changed.values : operation.customFields || {};
      return [operation.operationId, Object.fromEntries(Object.entries(current).filter(([key]) => keys.has(key)))];
    }));
    try {
      const result = record(await desktop.saveSnapshotCustomFields({ definitions, values }));
      const problem = resultError(result);
      if (problem) throw new Error(problem);
      if (result.ok !== true || typeof result.text !== 'string') throw new Error('The snapshot could not be updated.');
      const updated = parseSnapshot(result.text);
      setSnapshot(updated);
      setSelectedOperation((current) => current ? updated.operations.find((operation) => operation.operationId === current.operationId) || current : null);
      notify('Custom API fields saved.', 'success');
      return true;
    } catch (error) {
      notify(`Could not save custom fields: ${errorMessage(error)}`, 'error');
      return false;
    }
  };

  const generateGlobalToken = async () => {
    const tokenType = tokenTypes.find((item) => item.id === globalTokenTypeId);
    if (!tokenType || !activeEnvironment) {
      setGlobalTokenStatus('Choose an environment and token type first.');
      return;
    }
    setGlobalTokenBusy(true);
    setGlobalTokenStatus('Generating token…');
    try {
      const result = record(await desktop.fetchToken({
        environmentId: activeEnvironment.environmentId || activeEnvironment.id,
        url: tokenType.url,
        method: tokenType.method || 'POST',
        headers: tokenType.headers,
        contentType: tokenType.contentType,
        body: tokenType.body,
        tokenField: tokenType.tokenField,
        auth: tokenType.auth,
        basic: tokenType.basic,
        bearer: token,
        confirmWrite: true,
        acceptIncomplete: false,
      }));
      const problem = resultError(result);
      if (problem) throw new Error(problem);
      if (typeof result.token !== 'string') throw new Error('The token response did not contain an access token.');
      setToken(result.token);
      setGlobalTokenStatus(`Token ready for ${activeEnvironment.name}. It will be reused for every API in this environment.`);
      notify(`Access token generated for ${activeEnvironment.name}.`, 'success');
    } catch (error) {
      setGlobalTokenStatus(errorMessage(error));
      notify(`The access token could not be generated: ${errorMessage(error)}`, 'error');
    } finally {
      setGlobalTokenBusy(false);
    }
  };

  const copyGlobalToken = async () => {
    if (!token) return;
    try {
      await navigator.clipboard.writeText(token);
      setGlobalTokenStatus(`Copied — the access token for ${activeEnvironment?.name || 'this environment'} is on your clipboard.`);
      notify('Access token copied.', 'success');
    } catch (error) {
      setGlobalTokenStatus(`Could not copy the token: ${errorMessage(error)}`);
      notify('The access token could not be copied.', 'error');
    }
  };

  const showScanDocumentationStatus = async (raw: unknown) => {
    const documentation = record(raw);
    const job = record(await desktop.getDocJob());
    setDocJob(job);
    setDocProgressVisible(documentation.status !== 'skipped' && Number(job.total || documentation.total || 0) > 0);
    if (documentation.status === 'started') {
      notify(documentation.factualFallback === true
        ? `Scan complete. Writing factual documentation for ${String(documentation.total)} APIs.`
        : `Scan complete. Writing documentation for ${String(documentation.total)} APIs.`, 'success');
    } else if (documentation.status === 'busy') {
      notify('Scan complete. Documentation is already running in the background.', 'info');
    } else if (documentation.status === 'done') {
      notify(String(documentation.reason || 'Scan complete. Documentation is up to date.'), 'success');
    } else if (documentation.status === 'skipped') {
      notify(`Scan complete. Documentation paused: ${String(documentation.reason || 'automatic generation is disabled.')}`, 'info');
    }
  };

  const saveCustomRequest = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const request = {
      name: String(form.get('name') || ''),
      method: String(form.get('method') || 'GET'),
      url: String(form.get('url') || ''),
      auth: String(form.get('auth') || 'none'),
      query: [],
      headers: customRequestHeaders,
      body: String(form.get('body') || ''),
    };
    try {
      const result = record(await desktop.saveCustomRequest({ request }));
      const problem = resultError(result);
      if (problem) throw new Error(problem);
      setCustomRequests(arrayOf<Record<string, unknown>>(result.requests));
      setCustomRequestEditor(false);
      notify('Custom request saved.', 'success');
    } catch (error) {
      notify(`Could not save custom request: ${errorMessage(error)}`, 'error');
    }
  };

  const commandResults = useMemo(() => {
    const query = commandQuery.trim().toLowerCase();
    const rows = [
      ...(['Home', 'Catalog', 'Collections', 'Settings'] as const).map((label) => ({ label, action: () => {
        setView(label === 'Home' ? 'home' : label === 'Catalog' ? 'catalog' : label === 'Collections' ? 'collections' : 'settings');
        setCommandOpen(false);
      } })),
      ...environments.map((environment) => ({ label: `Switch environment · ${environment.name}`, action: () => {
        setActiveEnvironmentId(environment.id || environment.environmentId || '');
        setCommandOpen(false);
      } })),
      ...(snapshot?.operations || []).slice(0, 100).map((operation) => ({
        label: `${operation.httpMethod} ${operation.pathTemplate} · ${operation.serviceName}`,
        action: () => {
          setView('catalog');
          openOperation(operation);
          setCommandOpen(false);
        },
      })),
    ];
    return query ? rows.filter((row) => row.label.toLowerCase().includes(query)).slice(0, 12) : rows.slice(0, 12);
  }, [commandQuery, environments, snapshot]);

  const currentServiceName = snapshot?.services.find((service) => service.serviceId === selectedService)?.name || 'All services';
  const isFavourite = selectedOperation && library.favourites.some((favourite) =>
    favourite.operationId === selectedOperation.operationId);
  const startWorkspaceResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = workspaceWidth;
    const direction = workspaceSide === 'left' ? 1 : -1;
    const move = (moveEvent: PointerEvent) => {
      setWorkspaceWidth(Math.max(180, Math.min(420, startWidth + (moveEvent.clientX - startX) * direction)));
    };
    const stop = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', stop);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', stop);
  };

  if (loading) {
    return <main className="loading-screen" aria-live="polite"><span className="brand-mark">R</span><p>Preparing your workspace…</p></main>;
  }

  return (
    <div className="app-frame">
      <header className="topbar">
        <button className="brand no-drag" type="button" onClick={() => setView('home')} aria-label="Reqzen home">
          <span className="brand-mark">R</span><span>Reqzen</span>
        </button>
        <div className="toolbar-search no-drag">
          <span aria-hidden="true">⌕</span>
          <input
            ref={searchRef}
            aria-label="Search APIs"
            placeholder="Search APIs, services…"
            value={search}
            onChange={(event) => { setSearch(event.target.value); setView('catalog'); }}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && aiAvailable) {
                event.preventDefault();
                void runAiSearch();
              }
            }}
          />
          {search.trim() && (
            <button
              className={`ai-search-chip ${aiSearchIds.length ? 'active' : ''}`}
              type="button"
              title={aiAvailable ? 'Search with the configured AI model' : 'Configure an AI model to use AI search'}
              disabled={!aiAvailable || aiSearchBusy}
              onClick={() => { void runAiSearch(); }}
            >
              {aiSearchBusy ? 'AI…' : 'AI'}
            </button>
          )}
          <button type="button" className="key-hint" onClick={() => setCommandOpen(true)} aria-label={`Open command palette (${shortcut(platform, 'K')})`}>
            {shortcut(platform, 'K')}
          </button>
        </div>
        <div className="topbar-actions no-drag">
          {environments.length > 0 && (
            <label className="environment-picker">
              <span className={`environment-dot ${activeEnvironment?.production ? 'production' : ''}`} aria-hidden="true" />
              <span className="sr-only">Active environment</span>
              <select value={activeEnvironmentId} onChange={(event) => setActiveEnvironmentId(event.target.value)}>
                {environments.map((environment) => (
                  <option key={environment.id || environment.environmentId} value={environment.id || environment.environmentId}>
                    {environment.name}{environment.production ? ' · Production' : ''}
                  </option>
                ))}
              </select>
              {activeEnvironment?.production && <span className="prod-badge">PROD</span>}
            </label>
          )}
          <button className="token-chip no-drag" type="button" aria-expanded={accessTokenOpen} aria-controls="global-access-token" onClick={() => setAccessTokenOpen((open) => !open)} title="Manage the access token shared by this workspace">
            <span aria-hidden="true">◈</span>
            <span>{token ? 'Access token ready' : 'Access token'}</span>
            <span aria-hidden="true">{accessTokenOpen ? '⌃' : '⌄'}</span>
          </button>
          <button className="icon-button" type="button" title={`Settings (${shortcut(platform, ',')})`} onClick={() => openSettings()}>
            <span aria-hidden="true">⚙</span><span className="sr-only">Settings</span>
          </button>
          <div className="overflow-anchor" ref={overflowRef}>
            <button className="avatar-button" type="button" title="More actions" aria-label="More actions" aria-expanded={overflowOpen} onClick={() => setOverflowOpen((open) => !open)}>•••</button>
            {overflowOpen && <div className="overflow-menu" role="menu">
              <button type="button" role="menuitem" onClick={() => { setOverflowOpen(false); setCommandOpen(true); }}>Command palette <kbd>{shortcut(platform, 'K')}</kbd></button>
              <button type="button" role="menuitem" onClick={() => { setOverflowOpen(false); void openSnapshot(); }}>Open snapshot…</button>
              {snapshot && <button type="button" role="menuitem" onClick={() => { setOverflowOpen(false); setSnapshotRemoveId(activeSnapshotId || null); }}>Remove active snapshot…</button>}
              <button type="button" role="menuitem" onClick={() => { setOverflowOpen(false); void beginLocalScan(); }}>Scan local project…</button>
              <button type="button" role="menuitem" onClick={() => { setOverflowOpen(false); setCustomRequestEditor(true); }}>New request</button>
              <div className="overflow-divider" />
              <button type="button" role="menuitem" onClick={() => { setOverflowOpen(false); openSettings(); }}>Settings</button>
            </div>}
          </div>
        </div>
      </header>
      {accessTokenOpen && (
        <section id="global-access-token" className="global-token-panel" aria-label="Global access token">
          <div className="global-token-heading"><span className="global-token-icon">◈</span><div><strong>Workspace environment & token</strong><small>Selections are reused by every API in this environment.</small></div></div>
          <label className="global-control-field">
            <span>Environment</span>
            <select value={activeEnvironmentId} onChange={(event) => {
              setActiveEnvironmentId(event.target.value);
              setGlobalTokenStatus('');
            }}>
              <option value="">Choose environment</option>
              {environments.filter((environment) => environment.enabled !== false).map((environment) => (
                <option key={environment.id || environment.environmentId} value={environment.id || environment.environmentId}>
                  {environment.name}{environment.production ? ' · Production' : ''}
                </option>
              ))}
            </select>
          </label>
          <label className="global-control-field">
            <span>Token type</span>
            <select value={globalTokenTypeId} onChange={(event) => setGlobalTokenTypeId(event.target.value)}>
              <option value="">Paste token manually</option>
              {tokenTypes.map((tokenType) => <option key={tokenType.id} value={tokenType.id}>{tokenType.name}</option>)}
            </select>
          </label>
          <label className="global-token-field">
            <span>Environment access token</span>
            <input type="password" autoComplete="off" value={token} onChange={(event) => setToken(event.target.value)} placeholder={activeEnvironment ? `Token for ${activeEnvironment.name}` : 'Choose an environment'} />
          </label>
          <Button variant="primary" onClick={() => { void generateGlobalToken(); }} disabled={globalTokenBusy || !activeEnvironment || !globalTokenTypeId}>{globalTokenBusy ? 'Generating…' : 'Generate token'}</Button>
          <Button onClick={() => { void copyGlobalToken(); }} disabled={!token}>{globalTokenStatus.startsWith('Copied') ? 'Copied' : 'Copy token'}</Button>
          <Button onClick={() => setToken('')} disabled={!token}>Clear</Button>
          <button className="icon-button" type="button" aria-label="Collapse global access token" onClick={() => setAccessTokenOpen(false)}>⌃</button>
          {globalTokenStatus && <div className={globalTokenStatus.toLowerCase().includes('ready for') || globalTokenStatus.startsWith('Copied') ? 'global-token-status success' : 'global-token-status'} role="status"><span>{globalTokenStatus}</span><button type="button" aria-label="Dismiss token status" onClick={() => setGlobalTokenStatus('')}>×</button></div>}
        </section>
      )}

      <div className={`workspace workspace-${workspaceSide} ${workspaceCollapsed ? 'workspace-collapsed' : ''}`} style={{ '--workspace-width': `${workspaceWidth}px` } as CSSProperties}>
        {view !== 'home' && (
          <aside className="sidebar" aria-label="Main navigation">
            <div className="sidebar-group">
              <p className="sidebar-label"><span>Workspace</span><span className="sidebar-controls"><button type="button" aria-label={`Move workspace to ${workspaceSide === 'left' ? 'right' : 'left'}`} onClick={() => setWorkspaceSide((side) => side === 'left' ? 'right' : 'left')}>⇄</button><button type="button" aria-label="Collapse workspace" onClick={() => setWorkspaceCollapsed(true)}>‹</button></span></p>
              <NavButton active={false} onClick={() => setView('home')} icon="⌂">Home</NavButton>
              <NavButton active={view === 'catalog'} onClick={() => setView('catalog')} icon="◫">Catalog</NavButton>
              <NavButton active={view === 'collections'} onClick={() => setView('collections')} icon="▤">Collections</NavButton>
            </div>
            <div className="sidebar-group snapshot-group">
              <p className="sidebar-label">Sources <span>{workspaceSnapshots.length}</span></p>
              {workspaceSnapshots.map((item) => (
                <div className={`snapshot-source ${item.id === activeSnapshotId ? 'active' : ''}`} key={item.id}>
                  <button type="button" className="snapshot-source-main" onClick={() => { void selectSnapshot(item.id); }} title={item.name}>
                    <span className="service-bullet">◫</span><span><strong>{item.name}</strong><small>{item.operationCount} APIs</small></span>
                  </button>
                  <button type="button" className="snapshot-source-remove" aria-label={`Remove ${item.name}`} onClick={() => setSnapshotRemoveId(item.id)}>×</button>
                </div>
              ))}
              <button type="button" className="sidebar-add-source" onClick={() => { void openSnapshot(); }}>＋ Add snapshot</button>
            </div>
            <div className="sidebar-group">
              <p className="sidebar-label">Pinned</p>
              {library.favourites.length ? library.favourites.slice(0, 6).map((item) => {
                const operation = snapshot?.operations.find((row) => row.operationId === item.operationId);
                return (
                  <div className="sidebar-favourite-row" key={`${item.serviceName}-${item.httpMethod}-${item.pathTemplate}`}>
                    <button className="sidebar-favourite" type="button" onClick={() => operation && openOperation(operation)}>
                      <MethodBadge method={item.httpMethod} /><span>{item.pathTemplate}</span>
                    </button>
                    <button className="sidebar-favourite-remove" type="button" aria-label={`Unpin ${item.pathTemplate}`} title="Remove from pinned" onClick={() => { void removeFavouriteItem(item); }}>×</button>
                  </div>
                );
              }) : <p className="sidebar-empty">Favourite APIs to pin them here.</p>}
            </div>
            <div className="sidebar-bottom">
              <NavButton active={view === 'settings'} onClick={() => openSettings()} icon="⚙">Settings</NavButton>
              <button className="sidebar-help" type="button" onClick={() => setShortcutsOpen(true)}>
                <span className="help-dot">?</span> Keyboard shortcuts
              </button>
            </div>
          </aside>
        )}
        {view !== 'home' && workspaceCollapsed && <button className="workspace-expand" type="button" aria-label="Expand workspace" onClick={() => setWorkspaceCollapsed(false)}>›</button>}
        {view !== 'home' && !workspaceCollapsed && <div className="panel-resizer workspace-resizer" role="separator" aria-label="Resize workspace" aria-orientation="vertical" onPointerDown={startWorkspaceResize} />}

        <main className={`main-content ${view === 'home' ? 'main-home' : ''}`}>
          {view === 'home' && (
            <Welcome
              busy={busy}
              onOpenSnapshot={() => { void openSnapshot(); }}
              onLocalScan={() => { void beginLocalScan(); }}
              onGithubScan={openGithubScan}
              onNewRequest={() => setCustomRequestEditor(true)}
              onSettings={() => openSettings()}
              onContinue={() => setView('catalog')}
              recentName={snapshotName}
              hasSnapshot={!!snapshot}
            />
          )}
          {view === 'catalog' && snapshot && (
            <Catalog
              operations={filteredOperations}
              services={snapshot.services}
              selectedService={selectedService}
              serviceName={currentServiceName}
              onSelectService={setSelectedService}
              onOpenOperation={openOperation}
              onNewRequest={() => setCustomRequestEditor(true)}
              customFields={snapshot.customFieldDefinitions}
              onConfigureFields={() => setCustomFieldEditorOpen(true)}
              onExportSnapshot={() => setShareSnapshotOpen(true)}
              snapshotName={snapshotName}
              aiIds={aiSearchIds}
              aiMessage={aiSearchMessage}
              aiSearching={aiSearchBusy}
              search={search}
              onSearch={setSearch}
              onAiSearch={() => { void runAiSearch(); }}
              aiAvailable={aiAvailable}
            />
          )}
          {view === 'catalog' && !snapshot && (
            <div className="empty-panel">
              <span className="empty-icon">⌕</span><h1>Your API catalog starts here</h1>
              <p>Scan a project or open a snapshot to explore and prepare API requests.</p>
              <div className="button-row"><Button variant="primary" onClick={() => { void beginLocalScan(); }}>Scan local project</Button><Button onClick={() => { void openSnapshot(); }}>Open snapshot</Button></div>
            </div>
          )}
          {view === 'collections' && (
            <Collections
              library={library}
              customRequests={customRequests}
              operations={snapshot?.operations || []}
              onCreate={() => setCollectionEditor('')}
              onNewRequest={() => setCustomRequestEditor(true)}
              onOpen={openOperation}
              onNotify={notify}
              onRemoveFavourite={(item) => { void removeFavouriteItem(item); }}
              onRemoveCollectionItem={(collectionId, item) => { void removeCollectionItem(collectionId, item); }}
            />
          )}
          {view === 'settings' && (
            <Settings
              section={settingsSection}
              onSection={setSettingsSection}
              preferences={preferences}
              onPreferences={savePreference}
              environments={environments}
              variables={variables}
              confirmations={confirmations}
              onAddEnvironment={() => setEnvironmentEditor({ name: '', baseUrl: '', enabled: true })}
              onEditEnvironment={setEnvironmentEditor}
              onDeleteEnvironment={(environment) => { void deleteEnvironment(environment); }}
              onAddVariable={() => setVariableEditor({ id: '', name: '', value: '', byEnvironment: {} })}
              onEditVariable={setVariableEditor}
              onDeleteVariable={(variable) => { void deleteVariable(variable); }}
              onConfirmation={(id, method, checked) => { void changeConfirmation(id, method, checked); }}
              docsSettings={docsSettings}
              aiKey={aiKey}
              onAiKey={setAiKey}
              aiStatus={aiStatus}
              onSaveAi={(event) => { void saveAiSettings(event); }}
              onTestAi={() => { void testAiConnection(); }}
              tokenTypes={tokenTypes}
              onAddToken={() => setTokenEditor({ id: '', name: '', mode: 'request', url: '', method: 'POST', auth: 'none', tokenField: 'access_token' })}
              onEditToken={setTokenEditor}
              onDeleteToken={(token) => { void deleteTokenType(token); }}
              scanRulesText={scanRulesText}
              onScanRulesText={setScanRulesText}
              onSaveScanRules={() => { void saveScanRules(); }}
              onResetScanRules={(presetId) => { void resetScanRules(presetId); }}
              docJob={docJob}
              documentationMode={documentationMode}
              onDocumentationMode={setDocumentationMode}
              keptClones={keptClones}
              onDeleteClone={async (clone) => {
                try {
                  const result = record(await desktop.deleteKeptClone({ path: clone }));
                  if (result.ok !== true) throw new Error(arrayOf<string>(result.problems).join(' ') || 'Could not delete the clone.');
                  setKeptClones((current) => current.filter((path) => path !== clone));
                  notify('Cloned project removed.', 'success');
                } catch (error) {
                  notify(errorMessage(error), 'error');
                }
              }}
              onScanClone={async (clone) => {
                setBusy(true);
                try {
                  const result = record(await desktop.scanGitHub({
                    mode: 'folder',
                    sources: [{ repo: clone, service: 'Kept clone' }],
                    splitProjects: true,
                    generateDocs: docsSettings.generateAfterScan !== false,
                    refresh: true,
                  }));
                  const problem = resultError(result);
                  if (problem) throw new Error(problem);
                  if (typeof result.text !== 'string') throw new Error('The scan did not return a catalogue.');
                  applySnapshot(result.text, `Kept clone scan: ${clone}`);
                  await refreshWorkspaceSnapshots();
                  await showScanDocumentationStatus(result.documentation);
                } catch (error) {
                  notify(errorMessage(error), 'error');
                } finally {
                  setBusy(false);
                }
              }}
              onStopDocs={() => { void stopDocumentation(); }}
              onGenerateDocs={() => {
                void generateDocumentation(snapshot?.operations || []);
              }}
              hasSnapshot={!!snapshot}
              onCopyExternalPrompt={(kind) => { void copyExternalPrompt(kind); }}
              onExportExternalCatalog={() => setShareSnapshotOpen(true)}
              onImportExternalSnapshot={() => { void openSnapshot(); }}
              busy={busy}
            />
          )}
        </main>
      </div>

      {docProgressVisible && docJob.state !== 'idle' && Number(docJob.total || 0) > 0 && (
        <aside className={`documentation-live-notice documentation-live-${String(docJob.state)}`} aria-live="polite">
          <span className="documentation-live-icon" aria-hidden="true">▤</span>
          <div className="documentation-live-copy">
            <div><strong>{docJob.state === 'running' ? 'Generating documentation' : docJob.state === 'done' ? 'Documentation complete' : docJob.state === 'failed' ? 'Documentation failed' : 'Documentation stopped'}</strong><span>{Number(docJob.done || 0)} / {Number(docJob.total || 0)}</span></div>
            <div className="documentation-live-track" role="progressbar" aria-label="Documentation generation progress" aria-valuemin={0} aria-valuemax={Number(docJob.total || 0)} aria-valuenow={Number(docJob.done || 0)}>
              <span style={{ width: `${Math.min(100, (Number(docJob.done || 0) / Number(docJob.total || 1)) * 100)}%` }} />
            </div>
            <small>{String(docJob.reason || (docJob.state === 'running' ? 'Descriptions are being generated in the background.' : 'Open documentation settings to review the result.'))}</small>
          </div>
          <button type="button" className="text-button" onClick={() => openSettings('documentation')}>View</button>
          {docJob.state === 'running' && <button type="button" className="text-button" onClick={() => { void stopDocumentation(); }}>Stop</button>}
          <button type="button" className="icon-button" aria-label="Dismiss documentation progress" onClick={() => setDocProgressVisible(false)}>×</button>
        </aside>
      )}

      <footer className="statusbar">
        <div><span className="status-dot" /> Local-first workspace</div>
        <div>{snapshot ? `${snapshot.operations.length} APIs · ${snapshot.services.length} services` : 'No catalog loaded'}</div>
        {docJob.state === 'running' && (
          <button className="statusbar-doc-progress" type="button" onClick={() => openSettings('documentation')}>
            <span className="status-dot running" />
            <span>Documentation {String(docJob.done || 0)} / {String(docJob.total || 0)}</span>
            <span className="doc-progress-track" role="progressbar" aria-label="Documentation progress" aria-valuemin={0} aria-valuemax={Number(docJob.total || 0)} aria-valuenow={Number(docJob.done || 0)}>
              <span style={{ width: `${Number(docJob.total || 0) > 0 ? (Number(docJob.done || 0) / Number(docJob.total || 0)) * 100 : 0}%` }} />
            </span>
          </button>
        )}
        <div className="status-shortcut">{shortcut(platform, 'K')} Command palette</div>
      </footer>

      {selectedOperation && (
        <RequestDialog
          operation={selectedOperation}
          tokenTypes={tokenTypes}
          environments={environments}
          activeEnvironmentId={requestEnvironmentId}
          onEnvironment={(id) => {
            setRequestEnvironmentId(id);
            const environment = environments.find((item) => (item.id || item.environmentId) === id);
            const key = environment?.environmentId || environment?.id || id;
            setRequestToken(tokensByEnvironment[key] || '');
          }}
          token={requestToken}
          onToken={setRequestToken}
          values={requestValues}
          onValues={setRequestValues}
          headers={requestHeaders}
          onHeaders={setRequestHeaders}
          body={requestBody}
          onBody={setRequestBody}
          response={response}
          acceptIncomplete={acceptIncomplete}
          onAcceptIncomplete={setAcceptIncomplete}
          busy={busy}
          platform={platform}
          isFavourite={!!isFavourite}
          collections={library.collections}
          onFavourite={() => { void toggleFavourite(selectedOperation); }}
          onAddToCollection={(id) => { void addToCollection(id, selectedOperation); }}
          onSend={() => { void sendSelectedRequest(); }}
          documentationBusy={docJob.state === 'running'}
          onDocument={() => { void generateDocumentation([selectedOperation]); }}
          customFields={snapshot?.customFieldDefinitions || []}
          onSaveCustomFields={(values) => saveCustomFields(snapshot?.customFieldDefinitions || [], { id: selectedOperation.operationId, values })}
          onClose={() => setSelectedOperation(null)}
        />
      )}

      {shareSnapshotOpen && snapshot && <ShareSnapshotDialog services={snapshot.services} environments={environments} tokenTypes={tokenTypes} variables={variables} defaultEnvironmentId={activeEnvironmentId} onExport={exportSnapshot} onClose={() => setShareSnapshotOpen(false)} />}
      {customFieldEditorOpen && snapshot && <CustomFieldDialog initial={snapshot.customFieldDefinitions} onSave={(definitions) => saveCustomFields(definitions)} onClose={() => setCustomFieldEditorOpen(false)} />}

      {environmentEditor && (
        <Dialog
          title={environmentEditor.id ? 'Edit environment' : 'Add environment'}
          detail="Requests are checked against enabled environments before they are sent."
          onClose={() => setEnvironmentEditor(null)}
        >
          <form className="dialog-form" onSubmit={(event) => { void saveEnvironment(event); }}>
            <Field label="Environment name"><input name="name" autoFocus defaultValue={environmentEditor.name} required maxLength={80} placeholder="Development" /></Field>
            <Field label="Base address"><input name="baseUrl" defaultValue={environmentEditor.baseUrl} required placeholder="https://api.example.com" /></Field>
            <label className="check-row"><input type="checkbox" name="production" defaultChecked={environmentEditor.production} /> <span><strong>Production environment</strong><small>Write requests will ask for an additional typed confirmation.</small></span></label>
            <label className="check-row"><input type="checkbox" name="enabled" defaultChecked={environmentEditor.enabled !== false} /> <span><strong>Enabled</strong><small>Only enabled HTTPS environment hosts are allowed for API requests.</small></span></label>
            <div className="dialog-actions"><Button type="button" onClick={() => setEnvironmentEditor(null)}>Cancel</Button><Button variant="primary" type="submit">Save environment</Button></div>
          </form>
        </Dialog>
      )}

      {variableEditor && (
        <Dialog title={variableEditor.id ? 'Edit variable' : 'Add variable'} detail="Values stay on this computer and can be used in request paths, headers, and bodies." onClose={() => setVariableEditor(null)}>
          <form className="dialog-form" onSubmit={(event) => { void saveVariable(event); }}>
            <Field label="Variable name"><input name="name" autoFocus defaultValue={variableEditor.name} required placeholder="orgId" /></Field>
            <Field label="Shared value"><input name="value" defaultValue={variableEditor.value} placeholder="Value used unless an environment value overrides it" /></Field>
            <div className="dialog-actions"><Button type="button" onClick={() => setVariableEditor(null)}>Cancel</Button><Button variant="primary" type="submit">Save variable</Button></div>
          </form>
        </Dialog>
      )}

      {localProjects && (
        <Dialog title="Choose projects to scan" detail="Choose one or more projects found below the parent folder. Only source files are read locally." onClose={() => setLocalProjects(null)} className="wide-dialog">
          <div className="project-selection-toolbar">
            <span>{localProjectSelection.length} of {localProjects.length} selected</span>
            <button type="button" className="text-button" onClick={() => setLocalProjectSelection(localProjects.map((project) => `${project.path}-${project.name}`))}>Select all</button>
            <button type="button" className="text-button" onClick={() => setLocalProjectSelection([])}>Clear</button>
          </div>
          <div className="project-list">
            {localProjects.map((project) => {
              const key = `${project.path}-${project.name}`;
              return (
                <label className="project-row project-select-row" key={key}>
                  <input type="checkbox" checked={localProjectSelection.includes(key)} onChange={(event) => setLocalProjectSelection((current) => event.target.checked ? [...current, key] : current.filter((id) => id !== key))} />
                  <span className="project-icon">▱</span>
                  <div><strong>{project.name}</strong><small>{project.manifest || project.frameworks?.join(' · ') || project.path}</small></div>
                  <span className="project-count">{project.languages?.join(', ') || ''}{project.operations ? ` · ${project.operations} APIs` : ''}</span>
                </label>
              );
            })}
          </div>
          <div className="dialog-actions"><Button onClick={() => setLocalProjects(null)}>Cancel</Button><Button variant="primary" disabled={busy || localProjectSelection.length === 0} onClick={() => { void scanLocalProjects(localProjects.filter((project) => localProjectSelection.includes(`${project.path}-${project.name}`))); }}>Scan {localProjectSelection.length} {localProjectSelection.length === 1 ? 'project' : 'projects'}</Button></div>
        </Dialog>
      )}

      {githubProjectState && (
        <Dialog title="Scan from GitHub" detail="Inspect the repository first, then choose which detected projects to scan." onClose={() => setGithubProjectState(null)} className="wide-dialog">
          <form className="dialog-form" onSubmit={(event) => { void findGithubProjects(event); }}>
            <Field label="Repository"><input autoFocus value={githubProjectState.repo} onChange={(event) => setGithubProjectState({ ...githubProjectState, repo: event.target.value })} placeholder="owner/repository" required /></Field>
            <Field label="Folder inside repository (optional)"><input value={githubProjectState.path} onChange={(event) => setGithubProjectState({ ...githubProjectState, path: event.target.value })} placeholder="services/catalog" /></Field>
            <div className="form-grid">
              <Field label="Branch or tag (optional)"><input value={githubProjectState.branch} onChange={(event) => setGithubProjectState({ ...githubProjectState, branch: event.target.value })} placeholder="main" /></Field>
              <Field label="Personal access token"><input type="password" autoComplete="off" value={githubProjectState.token} onChange={(event) => setGithubProjectState({ ...githubProjectState, token: event.target.value })} placeholder="Private repos and API access" /></Field>
            </div>
            <Field label="Scan method"><select value={githubProjectState.mode} onChange={(event) => setGithubProjectState({ ...githubProjectState, mode: event.target.value as 'clone' | 'api' })}><option value="clone">Clone branch locally, then scan</option><option value="api">Scan remotely with GitHub API</option></select></Field>
            {githubProjectState.mode === 'clone' && (
              <label className="check-row"><input type="checkbox" checked={githubProjectState.keepClone} onChange={(event) => setGithubProjectState({ ...githubProjectState, keepClone: event.target.checked })} /><span><strong>Keep the cloned project</strong><small>Keep a local copy after scanning. Copies can be removed later from Scan rules / Kept clones.</small></span></label>
            )}
            <label className="check-row"><input type="checkbox" checked={githubProjectState.generateDocs} onChange={(event) => setGithubProjectState({ ...githubProjectState, generateDocs: event.target.checked })} /><span><strong>Generate documentation after scan</strong><small>Writes descriptions automatically using the configured AI provider.</small></span></label>
            <label className="check-row"><input type="checkbox" checked={scanRefresh} onChange={(event) => setScanRefresh(event.target.checked)} /><span><strong>Refresh this scan</strong><small>Ignore the cached catalog and inspect the repository again.</small></span></label>
            <div className="dialog-actions"><Button type="button" onClick={() => setGithubProjectState(null)}>Cancel</Button><Button variant="primary" type="submit" disabled={busy}>{busy ? 'Inspecting…' : 'Find projects'}</Button></div>
          </form>
          {githubProjectState.projects.length > 0 && (
            <>
              <div className="project-list">
                {githubProjectState.projects.map((project) => <ProjectRow key={`${project.path}-${project.name}`} project={project} />)}
              </div>
              <div className="dialog-actions"><Button variant="primary" disabled={busy} onClick={() => { void scanGithubProjects(githubProjectState.projects); }}>Scan {githubProjectState.projects.length} {githubProjectState.projects.length === 1 ? 'project' : 'projects'}</Button></div>
            </>
          )}
        </Dialog>
      )}

      {tokenEditor && (
        <TokenTypeDialog
          initial={tokenEditor}
          environments={environments}
          defaultEnvironmentId={activeEnvironmentId}
          tokensByEnvironment={tokensByEnvironment}
          onSave={saveTokenType}
          onClose={() => setTokenEditor(null)}
        />
      )}

      {confirmationPrompt && (
        <Dialog
          title={confirmationPrompt.required ? 'Confirm this request' : 'Incomplete API contract'}
          detail={confirmationPrompt.required
            ? 'This environment or request method requires deliberate confirmation before it can be sent.'
            : 'Some contract details are missing. Review the request and confirm to continue.'}
          onClose={() => { setConfirmationPrompt(null); setConfirmText(''); }}
        >
          <div className="confirm-callout">
            <MethodBadge method={confirmationPrompt.operation.httpMethod} />
            <code>{confirmationPrompt.url}</code>
          </div>
          {confirmationPrompt.required && (
            <Field label={`Type “${confirmationPrompt.environmentName}” to confirm`}>
              <input autoFocus value={confirmText} onChange={(event) => setConfirmText(event.target.value)} />
            </Field>
          )}
          {!confirmationPrompt.required && <p className="body-copy">The request will not be sent unless you explicitly confirm below.</p>}
          <div className="dialog-actions">
            <Button onClick={() => setConfirmationPrompt(null)}>Cancel</Button>
            <Button
              variant="primary"
              disabled={confirmationPrompt.required && confirmText !== confirmationPrompt.environmentName}
              onClick={() => {
                const prompt = confirmationPrompt;
                setConfirmationPrompt(null);
                void runOperation(prompt.operation, prompt.url, prompt.headers, prompt.body, prompt.environmentName,
                  prompt.required ? confirmText : '', prompt.acceptIncomplete, prompt.token);
                setConfirmText('');
              }}
            >Review and send</Button>
          </div>
        </Dialog>
      )}

      {collectionEditor !== null && (
        <Dialog title="New collection" detail="Keep related APIs together for a repeatable workflow." onClose={() => setCollectionEditor('')}>
          <form className="dialog-form" onSubmit={(event) => { void createCollection(event); }}>
            <Field label="Collection name"><input autoFocus value={collectionEditor || ''} onChange={(event) => setCollectionEditor(event.target.value)} placeholder="Release checks" maxLength={80} /></Field>
            <div className="dialog-actions"><Button type="button" onClick={() => setCollectionEditor(null)}>Cancel</Button><Button variant="primary" type="submit">Create collection</Button></div>
          </form>
        </Dialog>
      )}

      {customRequestEditor && (
        <Dialog title="New request" detail="Prepare a one-off request, or save it for later. Nothing is sent until you choose Send." onClose={() => setCustomRequestEditor(false)} className="wide-dialog">
          <div className="segmented-control custom-request-mode" role="group" aria-label="Request creation mode">
            <button type="button" className={customRequestMode === 'form' ? 'selected' : ''} aria-pressed={customRequestMode === 'form'} onClick={() => setCustomRequestMode('form')}>Enter details</button>
            <button type="button" className={customRequestMode === 'curl' ? 'selected' : ''} aria-pressed={customRequestMode === 'curl'} onClick={() => setCustomRequestMode('curl')}>Paste curl</button>
          </div>
          {customRequestMode === 'curl' && (
            <div className="curl-import">
              <Field label="Curl command" hint="Paste a curl command to populate the method, address, headers, and request body.">
                <textarea rows={8} value={curlCommand} onChange={(event) => setCurlCommand(event.target.value)} placeholder={"curl -X POST 'https://api.example.com/v1/items' \\\n  -H 'Authorization: Bearer token' \\\n  -H 'Content-Type: application/json' \\\n  -d '{\"limit\":20}'"} />
              </Field>
              <div className="dialog-actions">
                <Button type="button" onClick={() => setCurlCommand('')}>Clear</Button>
                <Button variant="primary" type="button" disabled={!curlCommand.trim()} onClick={() => {
                  const parsed = parseCurlCommand(curlCommand);
                  if (!parsed.url) {
                    notify('Paste a curl command containing an HTTP or HTTPS address.', 'error');
                    return;
                  }
                  setCustomRequestMode('form');
                  setCurlCommand('');
                  setCustomRequestDraft({
                    name: parsed.name,
                    method: parsed.method,
                    url: parsed.url,
                    auth: parsed.auth,
                    body: parsed.body,
                  });
                  setCustomRequestHeaders(parsed.headers.split(/\r?\n/).map((line) => {
                    const separator = line.indexOf(':');
                    return separator > 0
                      ? { key: line.slice(0, separator).trim(), value: line.slice(separator + 1).trim(), enabled: true }
                      : null;
                  }).filter((header): header is { key: string; value: string; enabled: boolean } => header !== null));
                }}>Populate request</Button>
              </div>
            </div>
          )}
          {customRequestMode === 'form' && (
          <form className="dialog-form custom-request-form" onSubmit={(event) => { void saveCustomRequest(event); }}>
            <Field label="Request name"><input name="name" autoFocus required defaultValue={customRequestDraft.name} placeholder="List recent orders" /></Field>
            <div className="form-grid">
              <Field label="Method"><select name="method" defaultValue={customRequestDraft.method}>{methods.map((method) => <option key={method}>{method}</option>)}</select></Field>
              <Field label="Address"><input name="url" required defaultValue={customRequestDraft.url} placeholder="/v1/items or https://api.example.com/v1/items" /></Field>
            </div>
            <Field label="Authentication"><select name="auth" defaultValue={customRequestDraft.auth}><option value="none">None</option><option value="bearer">Bearer token</option></select></Field>
            {customRequestHeaders.length > 0 && <div className="privacy-note">Imported headers: {customRequestHeaders.map((header) => header.key).join(', ')}</div>}
            <Field label="Request body (JSON or text)"><textarea name="body" rows={4} defaultValue={customRequestDraft.body} placeholder='{"limit": 20}' /></Field>
            <div className="dialog-actions"><Button type="button" onClick={() => setCustomRequestEditor(false)}>Cancel</Button><Button variant="primary" type="submit">Save request</Button></div>
          </form>
          )}
        </Dialog>
      )}

      {commandOpen && (
        <div className="palette-scrim" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget) setCommandOpen(false);
        }}>
          <section className="command-palette" role="dialog" aria-modal="true" aria-label="Command palette">
            <div className="command-input">
              <span aria-hidden="true">⌕</span>
              <input
                ref={commandRef}
                value={commandQuery}
                onChange={(event) => setCommandQuery(event.target.value)}
                placeholder="Search APIs, pages, environments…"
                onKeyDown={(event) => {
                  if (event.key === 'ArrowDown') {
                    event.preventDefault();
                    setActiveCommand((index) => Math.min(index + 1, Math.max(commandResults.length - 1, 0)));
                  } else if (event.key === 'ArrowUp') {
                    event.preventDefault();
                    setActiveCommand((index) => Math.max(index - 1, 0));
                  } else if (event.key === 'Enter') {
                    event.preventDefault();
                    commandResults[activeCommand]?.action();
                  }
                }}
              />
              <kbd>ESC</kbd>
            </div>
            <div className="command-results">
              {commandResults.map((item, index) => <button key={item.label} type="button" aria-selected={index === activeCommand} onMouseEnter={() => setActiveCommand(index)} onClick={item.action}>{item.label}<span>↵</span></button>)}
              {commandResults.length === 0 && <p>No matching commands</p>}
            </div>
            <footer><span>Navigate with ↑ ↓</span><span>Open with ↵</span></footer>
          </section>
        </div>
      )}

      {findOpen && (
        <div className="find-bar">
          <label htmlFor="find-input">Find in page</label>
          <input ref={findInputRef} id="find-input" autoFocus value={findQuery} onChange={(event) => {
            setFindQuery(event.target.value);
            const input = event.currentTarget;
            void desktop.findInPage({ text: event.target.value }).finally(() => {
              window.setTimeout(() => {
                if (document.contains(input)) input.focus();
              }, 0);
            });
          }} onKeyDown={(event) => {
            if (event.key === 'Enter') void desktop.findInPage({ text: findQuery, findNext: true });
            if (event.key === 'Escape') {
              setFindOpen(false);
              void desktop.stopFind();
            }
          }} />
          <Button onClick={() => { setFindOpen(false); void desktop.stopFind(); }}>Done</Button>
        </div>
      )}

      {closeRequest && (
        <Dialog title="Close Reqzen?" detail="Your workspace settings are saved. Access tokens stay in memory only for this app session." onClose={() => setCloseRequest(false)}>
          <div className="dialog-actions"><Button onClick={() => setCloseRequest(false)}>Keep open</Button><Button variant="primary" onClick={() => { void desktop.closeWindow(); }}>Close app</Button></div>
        </Dialog>
      )}

      {snapshotRemoveId && (
        <Dialog title="Remove this snapshot?" detail={`Only “${workspaceSnapshots.find((item) => item.id === snapshotRemoveId)?.name || 'this snapshot'}” and its APIs will be removed from the workspace. Other snapshots and your own environments will be kept.`} onClose={() => setSnapshotRemoveId(null)}>
          <div className="dialog-actions"><Button onClick={() => setSnapshotRemoveId(null)}>Cancel</Button><Button variant="danger" disabled={busy} onClick={() => { void removeSnapshot(snapshotRemoveId); }}>Remove snapshot</Button></div>
        </Dialog>
      )}
      {shortcutsOpen && (
        <Dialog title="Keyboard shortcuts" detail="Use these shortcuts to navigate without leaving the keyboard." onClose={() => setShortcutsOpen(false)}>
          <div className="shortcut-list">
            <ShortcutRow label="Open command palette" keys={`${shortcut(platform, 'K')}`} />
            <ShortcutRow label="Open settings" keys={`${shortcut(platform, ',')}`} />
            <ShortcutRow label="Find in page" keys={`${shortcut(platform, 'F')}`} />
            <ShortcutRow label="Open snapshot" keys={`${shortcut(platform, 'O')}`} />
            <ShortcutRow label="New request" keys={`${shortcut(platform, 'N')}`} />
            <ShortcutRow label="Send current request" keys={`${shortcut(platform, 'Enter')}`} />
            <ShortcutRow label="Close the current panel" keys="Esc" />
            <ShortcutRow label="Go back" keys={platform === 'mac' ? '⌥ ←' : 'Alt + ←'} />
          </div>
          <div className="dialog-actions"><Button variant="primary" onClick={() => setShortcutsOpen(false)}>Done</Button></div>
        </Dialog>
      )}

      {notice && (
        <div className={`toast toast-${notice.severity}`} role={notice.severity === 'error' ? 'alert' : 'status'} onMouseEnter={() => setNoticePaused(true)} onMouseLeave={() => setNoticePaused(false)} onFocus={() => setNoticePaused(true)} onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setNoticePaused(false); }}>
          <span className="toast-icon" aria-hidden="true">{notice.severity === 'success' ? '✓' : notice.severity === 'error' ? '!' : 'i'}</span>
          <span className="toast-message">{notice.message}</span>
          <button type="button" onClick={() => setNotice(null)} aria-label="Dismiss notification">×</button>
        </div>
      )}
    </div>
  );
}

function NavButton({ active, icon, children, onClick }: { active: boolean; icon: string; children: ReactNode; onClick: () => void }) {
  return <button type="button" className={`nav-button ${active ? 'active' : ''}`} aria-current={active ? 'page' : undefined} onClick={onClick}><span aria-hidden="true">{icon}</span>{children}</button>;
}

function ShortcutRow({ label, keys }: { label: string; keys: string }) {
  return <div className="shortcut-row"><span>{label}</span><kbd>{keys}</kbd></div>;
}

function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return <label className="field"><span>{label}</span>{children}{hint && <small>{hint}</small>}</label>;
}

function Welcome({
  busy,
  onOpenSnapshot,
  onLocalScan,
  onGithubScan,
  onNewRequest,
  onSettings,
  onContinue,
  recentName,
  hasSnapshot,
}: {
  busy: boolean;
  onOpenSnapshot: () => void;
  onLocalScan: () => void;
  onGithubScan: () => void;
  onNewRequest: () => void;
  onSettings: () => void;
  onContinue: () => void;
  recentName: string;
  hasSnapshot: boolean;
}) {
  return (
    <div className="welcome-page">
      <div className="welcome-glow" aria-hidden="true" />
      <div className="welcome-inner">
        <div className="eyebrow"><span className="eyebrow-line" /> API DISCOVERY, WITHOUT THE SETUP</div>
        <h1>Point at code.<br /><span>Get a working API client.</span></h1>
        <p className="welcome-subtitle">Scan your project, explore its endpoints, and prepare requests in one calm, local-first workspace.</p>
        <div className="trust-row">
          <span><b>✓</b> Local-first</span><span><b>✓</b> No account</span><span><b>✓</b> Review before send</span>
        </div>
        {hasSnapshot && recentName && (
          <button className="recent-card" type="button" onClick={onContinue}>
            <span className="recent-icon">◫</span><span><strong>Continue where you left off</strong><small>{recentName}</small></span><b aria-hidden="true">→</b>
          </button>
        )}
        <div className="start-grid" aria-label="Choose a starting point">
          <button className="start-card start-primary" type="button" disabled={busy} onClick={onLocalScan}>
            <span className="start-icon">⌘</span><span className="start-label">01 · RECOMMENDED</span><strong>Scan a local project</strong><small>Find APIs from source code on this computer.</small><span className="card-arrow">→</span>
          </button>
          <button className="start-card" type="button" disabled={busy} onClick={onGithubScan}>
            <span className="start-icon start-icon-blue">↗</span><span className="start-label">02 · REPOSITORY</span><strong>Scan from GitHub</strong><small>Inspect a public or private repository.</small><span className="card-arrow">→</span>
          </button>
          <button className="start-card" type="button" disabled={busy} onClick={onOpenSnapshot}>
            <span className="start-icon start-icon-purple">▤</span><span className="start-label">03 · CATALOG</span><strong>Open a snapshot</strong><small>Continue with a saved Reqzen catalog.</small><span className="card-arrow">→</span>
          </button>
          <button className="start-card" type="button" disabled={busy} onClick={onNewRequest}>
            <span className="start-icon start-icon-green">＋</span><span className="start-label">04 · QUICK START</span><strong>New request</strong><small>Build a request without a catalog.</small><span className="card-arrow">→</span>
          </button>
        </div>
        <div className="welcome-bottom"><span>Need an environment or AI model?</span><button type="button" onClick={onSettings}>Set up workspace <span aria-hidden="true">→</span></button></div>
      </div>
    </div>
  );
}

function ProjectRow({ project }: { project: Project }) {
  return (
    <div className="project-row">
      <span className="project-icon">▱</span>
      <div><strong>{project.name}</strong><small>{project.manifest || project.frameworks?.join(' · ') || project.path}</small></div>
      <span className="project-count">{project.operations || 0} APIs</span>
    </div>
  );
}

function Catalog({
  operations,
  services,
  customFields,
  onConfigureFields,
  onExportSnapshot,
  selectedService,
  serviceName,
  onSelectService,
  onOpenOperation,
  onNewRequest,
  snapshotName,
  aiIds,
  aiMessage,
  aiSearching,
  search,
  onSearch,
  onAiSearch,
  aiAvailable,
}: {
  operations: Operation[];
  services: Service[];
  customFields: CustomFieldDefinition[];
  onConfigureFields: () => void;
  onExportSnapshot: () => void;
  selectedService: string;
  serviceName: string;
  onSelectService: (serviceId: string) => void;
  onOpenOperation: (operation: Operation) => void;
  onNewRequest: () => void;
  snapshotName: string;
  aiIds: string[];
  aiMessage: string;
  aiSearching: boolean;
  search: string;
  onSearch: (value: string) => void;
  onAiSearch: () => void;
  aiAvailable: boolean;
}) {
  const [servicesCollapsed, setServicesCollapsed] = useState(false);
  const [servicesSide, setServicesSide] = useState<'left' | 'right'>('left');
  const [serviceWidth, setServiceWidth] = useState(220);
  const catalogActionsRef = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const dismiss = (event: MouseEvent) => {
      if (catalogActionsRef.current && !catalogActionsRef.current.contains(event.target as Node)) catalogActionsRef.current.open = false;
    };
    document.addEventListener('mousedown', dismiss);
    return () => document.removeEventListener('mousedown', dismiss);
  }, []);
  const aiSet = useMemo(() => new Set(aiIds), [aiIds]);
  const visibleFields = customFields.filter((field) => field.visible);
  const columnsStyle: CSSProperties | undefined = visibleFields.length
    ? { gridTemplateColumns: `62px minmax(160px, 1.2fr) minmax(100px, .8fr) minmax(150px, 1fr) 64px repeat(${visibleFields.length}, minmax(130px, 1fr))`, minWidth: `${700 + visibleFields.length * 140}px` }
    : undefined;
  const startServiceResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = serviceWidth;
    const direction = servicesSide === 'left' ? 1 : -1;
    const move = (moveEvent: PointerEvent) => {
      setServiceWidth(Math.max(180, Math.min(420, startWidth + (moveEvent.clientX - startX) * direction)));
    };
    const stop = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', stop);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', stop);
  };
  return (
    <div className="catalog-page">
      <div className="page-heading">
        <div><p className="breadcrumb">WORKSPACE <span>/</span> CATALOG</p><h1>API catalog</h1><p className="page-description">Browse and prepare requests across your services.</p></div>
        <div className="page-actions">
          <span className="snapshot-chip" title={snapshotName || 'Loaded catalog'}>◫ {snapshotName || 'Loaded catalog'}</span>
          <details ref={catalogActionsRef} className="catalog-actions" onKeyDown={(event) => { if (event.key === 'Escape') { event.currentTarget.open = false; event.currentTarget.querySelector('summary')?.focus(); } }}>
            <summary>Catalog actions <span aria-hidden="true">⌄</span></summary>
            <div className="catalog-actions-menu">
              <button type="button" onClick={(event) => { event.currentTarget.closest('details')?.removeAttribute('open'); onConfigureFields(); }}>Configure fields</button>
              <button type="button" onClick={(event) => { event.currentTarget.closest('details')?.removeAttribute('open'); onExportSnapshot(); }}>Export snapshot</button>
            </div>
          </details>
          <Button variant="primary" onClick={onNewRequest}>＋ New request</Button>
        </div>
      </div>
      {aiMessage && <div className="ai-search-message" role="status">{aiMessage}</div>}
      <div className={`catalog-layout services-${servicesSide} ${servicesCollapsed ? 'services-collapsed' : ''}`} style={{ '--service-width': `${serviceWidth}px` } as CSSProperties}>
        <aside className="service-list" aria-label="Services">
          <p className="section-overline"><span>SERVICES · {services.length}</span><span className="service-controls"><button type="button" aria-label={`Move services to ${servicesSide === 'left' ? 'right' : 'left'}`} onClick={() => setServicesSide((side) => side === 'left' ? 'right' : 'left')}>⇄</button><button type="button" aria-label="Collapse services" onClick={() => setServicesCollapsed(true)}>‹</button></span></p>
          <button className={`service-row ${selectedService === '' ? 'selected' : ''}`} onClick={() => onSelectService('')} type="button"><span className="service-bullet">◈</span>All services <span className="service-count">{operations.length}</span></button>
          {services.map((service) => (
            <button key={service.serviceId} className={`service-row ${selectedService === service.serviceId ? 'selected' : ''}`} onClick={() => onSelectService(service.serviceId)} type="button">
              <span className="service-bullet">◈</span><span className="service-name">{service.name}</span>
            </button>
          ))}
          <div className="service-list-bottom"><span className="status-dot" />Snapshot ready</div>
        </aside>
        {!servicesCollapsed && <div className="panel-resizer services-resizer" role="separator" aria-label="Resize services" aria-orientation="vertical" onPointerDown={startServiceResize} />}
        {servicesCollapsed && <button className="services-expand" type="button" aria-label="Expand services" onClick={() => setServicesCollapsed(false)}>›</button>}
        <section className="operation-list" aria-label="API operations">
          <div className="operation-list-head">
            <div><h2>{serviceName}</h2><p>{operations.length} operations</p></div>
            <div className="catalog-search" role="search">
              <span aria-hidden="true">⌕</span>
              <input aria-label="Find the best matching API" value={search} onChange={(event) => onSearch(event.target.value)} placeholder="Describe the API you need…" onKeyDown={(event) => {
                if (event.key === 'Enter' && aiAvailable) onAiSearch();
              }} />
              <button type="button" className="catalog-ai-button" onClick={onAiSearch} disabled={!aiAvailable || aiSearching || !search.trim()}>{aiSearching ? 'Finding…' : 'Find with AI'}</button>
            </div>
          </div>
          {operations.length ? (
            <div className={`operation-table ${visibleFields.length ? 'custom-columns' : ''}`}>
              <div className="operation-table-head" aria-hidden="true" style={columnsStyle}>
                <span>Method</span><span>Path</span><span>Service</span><span>Summary</span><span>Version</span>
                {visibleFields.map((field) => <span key={field.key}>{field.label}</span>)}
              </div>
              <div className="operation-rows">
              {operations.map((operation) => (
                <button className={`operation-row ${aiSet.has(operation.operationId) ? 'ai-suggested' : ''}`} key={operation.operationId} type="button" style={columnsStyle} onClick={() => onOpenOperation(operation)}>
                  <MethodBadge method={operation.httpMethod} />
                  <span className="operation-path"><code>{operation.pathTemplate}</code>{aiSet.has(operation.operationId) && <span className="ai-badge">AI suggested</span>}</span>
                  <span className="operation-service">{operation.serviceName}</span>
                  <span className="operation-summary">{operation.summary || '—'}</span>
                  <span className="operation-version">{versionFor(operation)}</span>
                  {visibleFields.map((field) => <span className="operation-custom-field" key={field.key} title={`${field.label}: ${operation.customFields?.[field.key] || 'Not set'}`}>{operation.customFields?.[field.key] || '—'}</span>)}
                </button>
              ))}
              </div>
            </div>
          ) : (
            <div className="empty-list"><span className="empty-icon">⌕</span><h3>No matching APIs</h3><p>Try a different search or select another service.</p></div>
          )}
        </section>
      </div>
    </div>
  );
}

function RequestDialog({
  operation,
  tokenTypes,
  environments,
  activeEnvironmentId,
  onEnvironment,
  token,
  onToken,
  values,
  onValues,
  headers,
  onHeaders,
  body,
  onBody,
  response,
  acceptIncomplete,
  onAcceptIncomplete,
  busy,
  isFavourite,
  collections,
  onFavourite,
  onAddToCollection,
  onSend,
  documentationBusy,
  onDocument,
  customFields,
  onSaveCustomFields,
  onClose,
  platform,
}: {
  operation: Operation;
  tokenTypes: TokenType[];
  environments: Environment[];
  activeEnvironmentId: string;
  onEnvironment: (id: string) => void;
  token: string;
  onToken: (token: string) => void;
  values: Record<string, string>;
  onValues: (values: Record<string, string>) => void;
  headers: string;
  onHeaders: (headers: string) => void;
  body: string;
  onBody: (body: string) => void;
  response: Record<string, unknown> | null;
  acceptIncomplete: boolean;
  onAcceptIncomplete: (accept: boolean) => void;
  busy: boolean;
  isFavourite: boolean;
  collections: Library['collections'];
  onFavourite: () => void;
  onAddToCollection: (collectionId: string) => void;
  onSend: () => void;
  documentationBusy: boolean;
  onDocument: () => void;
  customFields: CustomFieldDefinition[];
  onSaveCustomFields: (values: Record<string, string>) => Promise<boolean>;
  onClose: () => void;
  platform: Platform;
}) {
  const environment = environments.find((item) => (item.id || item.environmentId) === activeEnvironmentId);
  const [selectedTokenTypeId, setSelectedTokenTypeId] = useState('');
  const [generatingToken, setGeneratingToken] = useState(false);
  const [tokenStatus, setTokenStatus] = useState('');
  const parameters = operationParameters(operation);
  const bodyMethod = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(operation.httpMethod);
  const requestUrl = routeUrl(operation, environment, Object.fromEntries(parameters.filter((parameter) =>
    parameter.in === 'path').map((parameter) => [parameter.name, values[parameter.name] || `{${parameter.name}}`])));
  const resultProblems = arrayOf<string>(response?.problems);
  const generateToken = async () => {
    const tokenType = tokenTypes.find((item) => item.id === selectedTokenTypeId);
    if (!tokenType) return;
    if (!environment) {
      setTokenStatus('Choose an environment before generating a token.');
      return;
    }
    setGeneratingToken(true);
    setTokenStatus('');
    try {
      const result = record(await window.desktop.fetchToken({
        environmentId: environment.environmentId || environment.id,
        url: tokenType.url,
        method: tokenType.method || 'POST',
        headers: tokenType.headers,
        contentType: tokenType.contentType,
        body: tokenType.body,
        tokenField: tokenType.tokenField,
        auth: tokenType.auth,
        basic: tokenType.basic,
        bearer: token,
        confirmWrite: true,
        acceptIncomplete: false,
      }));
      const problems = arrayOf<string>(result.problems);
      if (result.ok !== true) {
        setTokenStatus(problems[0] || 'The token could not be generated.');
      } else if (typeof result.token === 'string') {
        onToken(result.token);
        setTokenStatus(`Token generated successfully · ${String(result.tokenLength || result.token.length)} characters`);
      }
    } catch (error) {
      setTokenStatus(errorMessage(error));
    } finally {
      setGeneratingToken(false);
    }
  };
  const copyToken = async () => {
    if (!token) return;
    try {
      await navigator.clipboard.writeText(token);
      setTokenStatus('Access token copied.');
    } catch {
      setTokenStatus('The access token could not be copied.');
    }
  };

  return (
    <div className="request-scrim" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <section className="request-panel" role="dialog" aria-modal="true" aria-labelledby="request-title">
        <header className="request-header">
          <div><p className="breadcrumb">CATALOG <span>/</span> {operation.serviceName.toUpperCase()}</p><h2 id="request-title">Request builder</h2></div>
          <button className="request-close-button" type="button" aria-label="Close request" onClick={onClose}>
            <span>Close</span><span aria-hidden="true">×</span>
          </button>
        </header>
        <div className="request-url-row">
          <MethodBadge method={operation.httpMethod} />
          <code>{requestUrl}</code>
          <Button variant="primary" disabled={busy || !environment} onClick={onSend}>{busy ? 'Sending…' : 'Send'}           <span className="send-shortcut">{shortcut(platform, 'Enter')}</span></Button>
        </div>
        <div className="request-context"><strong>{operation.summary || operation.pathTemplate}</strong><span>{operation.description || 'Review the inputs below before sending.'}</span></div>
        <div className="request-content">
          <section className="request-section">
            <div className="request-section-head"><div><h3>Request settings</h3><p>Values are used for this request only.</p></div><div className="request-quick-actions"><button type="button" className="quiet-action" onClick={onFavourite}>{isFavourite ? '★ Saved' : '☆ Favourite'}</button><button type="button" className="quiet-action" onClick={onDocument} disabled={documentationBusy}>{documentationBusy ? 'Documenting…' : 'Document'}</button></div></div>
            <OperationCustomFields key={operation.operationId} operation={operation} definitions={customFields} onSave={onSaveCustomFields} />
            <Field label="Environment">
              <select value={activeEnvironmentId} onChange={(event) => onEnvironment(event.target.value)}>
                <option value="">Choose an environment</option>
                {environments.filter((item) => item.enabled !== false).map((item) => <option value={item.id || item.environmentId} key={item.id || item.environmentId}>{item.name}{item.production ? ' · Production' : ''}</option>)}
              </select>
            </Field>
            {parameters.map((parameter) => (
              <Field key={`${parameter.in}-${parameter.name}`} label={`${parameter.name}${parameter.required ? ' · required' : ''}`} hint={`${parameter.in} parameter${parameter.description ? ` · ${parameter.description}` : ''}`}>
                <input value={values[parameter.name] || ''} onChange={(event) => onValues({ ...values, [parameter.name]: event.target.value })} placeholder={parameter.schema?.type || 'Enter a value'} />
              </Field>
            ))}
            <div className="token-generator">
              <div className="token-generator-head">
                <div><strong>Access token</strong><small>Started from the workspace token. Changes and generated tokens stay in this request only.</small></div>
              </div>
              <div className="token-generator-controls">
                <select aria-label="Token type" value={selectedTokenTypeId} onChange={(event) => setSelectedTokenTypeId(event.target.value)} disabled={tokenTypes.length === 0}>
                  <option value="">Choose token type</option>
                  {tokenTypes.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
                </select>
                <Button type="button" onClick={() => { void generateToken(); }} disabled={!selectedTokenTypeId || !environment || generatingToken}>{generatingToken ? 'Generating…' : 'Generate token'}</Button>
              </div>
              <div className="token-input-row">
                <input type="password" value={token} onChange={(event) => onToken(event.target.value)} autoComplete="off" placeholder="Generated or pasted access token" />
                <Button type="button" onClick={() => { void copyToken(); }} disabled={!token}>Copy</Button>
              </div>
              {tokenStatus && <small className={tokenStatus.toLowerCase().includes('successfully') || tokenStatus.toLowerCase().includes('copied') ? 'token-status success' : 'token-status'}>{tokenStatus}</small>}
            </div>
            <Field label="Additional headers" hint="One header per line, in Name: value format.">
              <textarea rows={3} value={headers} onChange={(event) => onHeaders(event.target.value)} placeholder="Accept: application/json" />
            </Field>
            {bodyMethod && <Field label="Request body (JSON or text)"><textarea rows={6} value={body} onChange={(event) => onBody(event.target.value)} placeholder='{"example": true}' /></Field>}
            {operation.schemaComplete === false && (
              <label className="check-row incomplete-check"><input type="checkbox" checked={acceptIncomplete} onChange={(event) => onAcceptIncomplete(event.target.checked)} /><span><strong>Accept incomplete API contract</strong><small>Reqzen will still check the request destination and environment before sending.</small></span></label>
            )}
            {collections.length > 0 && (
              <Field label="Add to collection"><select value="" onChange={(event) => { if (event.target.value) onAddToCollection(event.target.value); }}>
                <option value="">Choose a collection</option>{collections.map((collection) => <option key={collection.id} value={collection.id}>{collection.name}</option>)}
              </select></Field>
            )}
          </section>
          <section className="response-section" aria-live="polite">
            <div className="request-section-head"><div><h3>Response</h3><p>Results are redacted before they are shown.</p></div>{response && typeof response.status === 'number' && <span className={`response-status ${response.status < 400 ? 'ok' : 'bad'}`}>{response.status} {response.status < 400 ? 'OK' : 'Error'}</span>}</div>
            {busy ? <div className="response-placeholder"><span className="spinner" />Waiting for the server…</div>
              : response ? (
                <div className="response-result">
                  {resultProblems.length > 0 && <div className="problem-list">{resultProblems.map((problem) => <p key={problem}>{problem}</p>)}</div>}
                  {typeof response.durationMs === 'number' && <p className="response-meta">{response.durationMs} ms</p>}
                  <pre>{typeof response.body === 'string' ? response.body : JSON.stringify(response.body || response, null, 2)}</pre>
                </div>
              ) : <div className="response-placeholder"><span className="response-placeholder-icon">↗</span><strong>Ready when you are</strong><p>Review the request, then select Send.</p></div>}
          </section>
        </div>
      </section>
    </div>
  );
}

function Collections({
  library,
  customRequests,
  operations,
  onCreate,
  onNewRequest,
  onOpen,
  onNotify,
  onRemoveFavourite,
  onRemoveCollectionItem,
}: {
  library: Library;
  customRequests: Array<Record<string, unknown>>;
  operations: Operation[];
  onCreate: () => void;
  onNewRequest: () => void;
  onOpen: (operation: Operation) => void;
  onNotify: (message: string, severity?: Severity) => void;
  onRemoveFavourite: (item: LibraryItem) => void;
  onRemoveCollectionItem: (collectionId: string, item: LibraryItem) => void;
}) {
  const desktop = window.desktop;
  const [importing, setImporting] = useState(false);
  const importCollection = async () => {
    setImporting(true);
    try {
      const result = record(await desktop.importCollection());
      const problem = resultError(result);
      if (problem) {
        if (!record(result).cancelled) onNotify(problem, 'error');
      } else onNotify('Collection imported.', 'success');
    } catch (error) {
      onNotify(`Could not import collection: ${errorMessage(error)}`, 'error');
    } finally {
      setImporting(false);
    }
  };
  const exportCollection = async (collectionId: string, kind: 'app' | 'postman') => {
    try {
      const result = record(await desktop.exportCollection({ collectionId, kind }));
      const problem = resultError(result);
      if (problem && !result.cancelled) onNotify(problem, 'error');
      else if (!problem) onNotify('Collection exported.', 'success');
    } catch (error) {
      onNotify(`Could not export collection: ${errorMessage(error)}`, 'error');
    }
  };
  const savedOperations = [...library.favourites, ...library.collections.flatMap((collection) => collection.items)];
  return (
    <div className="settings-page collections-page">
      <div className="page-heading">
        <div><p className="breadcrumb">WORKSPACE <span>/</span> COLLECTIONS</p><h1>Collections</h1><p className="page-description">Organize the APIs you use often and keep useful requests close.</p></div>
        <div className="page-actions"><Button onClick={() => { void importCollection(); }} disabled={importing}>Import file</Button><Button variant="primary" onClick={onCreate}>＋ New collection</Button></div>
      </div>
      <div className="collection-content">
        <section className="settings-card">
          <div className="card-title-row"><div><h2>Favourites</h2><p>Quick access to pinned API operations.</p></div><span className="count-chip">{library.favourites.length}</span></div>
          {library.favourites.length ? <div className="saved-items">{library.favourites.map((item) => {
            const operation = operations.find((row) => row.operationId === item.operationId);
            return <div key={item.operationId} className="saved-item"><button type="button" className="saved-item-main" onClick={() => operation && onOpen(operation)}><MethodBadge method={item.httpMethod} /><code>{item.pathTemplate}</code><span>{item.serviceName}</span><b>→</b></button><button type="button" className="icon-button remove-saved-button" aria-label={`Remove ${item.pathTemplate} from favourites`} onClick={() => onRemoveFavourite(item)}>×</button></div>;
          })}</div> : <EmptyState title="No favourites yet" text="Open an API and select Favourite to pin it here." />}
        </section>
        <section className="settings-card">
          <div className="card-title-row"><div><h2>Your collections</h2><p>Export as Reqzen or Postman v2.1 when you need to share.</p></div></div>
          {library.collections.length ? library.collections.map((collection) => (
            <div className="collection-card" key={collection.id}>
              <div className="card-title-row"><div><h3>{collection.name}</h3><p>{collection.items.length} APIs</p></div><div className="button-row"><button type="button" className="text-button" onClick={() => { void exportCollection(collection.id, 'app'); }}>Export Reqzen</button><button type="button" className="text-button" onClick={() => { void exportCollection(collection.id, 'postman'); }}>Export Postman</button></div></div>
              {collection.items.map((item) => {
                const operation = operations.find((row) => row.operationId === item.operationId);
                return <div key={item.operationId} className="saved-item"><button type="button" className="saved-item-main" onClick={() => operation && onOpen(operation)}><MethodBadge method={item.httpMethod} /><code>{item.pathTemplate}</code><span>{item.serviceName}</span><b>→</b></button><button type="button" className="icon-button remove-saved-button" aria-label={`Remove ${item.pathTemplate} from ${collection.name}`} onClick={() => onRemoveCollectionItem(collection.id, item)}>×</button></div>;
              })}
            </div>
          )) : <EmptyState title="Start a collection" text="Group related APIs together for a repeatable workflow." action={<Button onClick={onCreate}>Create collection</Button>} />}
        </section>
        <section className="settings-card">
          <div className="card-title-row"><div><h2>Saved requests</h2><p>Requests you created without a catalog.</p></div><Button onClick={onNewRequest}>＋ New request</Button></div>
          {customRequests.length ? customRequests.map((item, index) => (
            <div className="saved-item saved-request" key={String(item.id || index)}><MethodBadge method={String(item.method || 'GET')} /><span className="saved-request-name">{String(item.name || 'Request')}</span><code>{String(item.url || '')}</code></div>
          )) : <EmptyState title="No saved requests" text="Create a standalone request and save it for future use." />}
        </section>
        {savedOperations.length > 0 && <p className="privacy-note">Exports contain API identities and request templates, not access tokens or environment values.</p>}
      </div>
    </div>
  );
}

function EmptyState({ title, text, action }: { title: string; text: string; action?: ReactNode }) {
  return <div className="empty-state"><span className="empty-icon">▤</span><strong>{title}</strong><p>{text}</p>{action}</div>;
}

function DocumentationProgress({ job }: { job: Record<string, unknown> }) {
  const state = String(job.state || 'idle');
  const total = Number(job.total || 0);
  const done = Math.min(Number(job.done || 0), total);
  const percentage = total > 0 ? Math.round((done / total) * 100) : 0;
  if (state === 'idle' && total === 0) return null;
  return (
    <section className={`documentation-progress documentation-progress-${state}`} aria-live="polite">
      <div className="documentation-progress-head">
        <strong>{state === 'running' ? 'Generating documentation' : state === 'done' ? 'Documentation complete' : state === 'failed' ? 'Documentation failed' : state === 'stopped' ? 'Documentation stopped' : 'Documentation status'}</strong>
        <span>{done} / {total} · {percentage}%</span>
      </div>
      <div className="documentation-progress-bar" role="progressbar" aria-label="Documentation progress" aria-valuemin={0} aria-valuemax={Math.max(total, 1)} aria-valuenow={done}>
        <span style={{ width: `${percentage}%` }} />
      </div>
      {job.reason ? <p>{String(job.reason)}</p> : null}
      <small>{Number(job.fromModel || 0)} AI-written · {Number(job.factual || 0)} factual</small>
    </section>
  );
}

function Settings({
  section,
  onSection,
  preferences,
  onPreferences,
  environments,
  variables,
  confirmations,
  onAddEnvironment,
  onEditEnvironment,
  onDeleteEnvironment,
  onAddVariable,
  onEditVariable,
  onDeleteVariable,
  onConfirmation,
  docsSettings,
  aiKey,
  onAiKey,
  aiStatus,
  onSaveAi,
  onTestAi,
  tokenTypes,
  onAddToken,
  onEditToken,
  onDeleteToken,
  scanRulesText,
  onScanRulesText,
  onSaveScanRules,
  onResetScanRules,
  docJob,
  documentationMode,
  onDocumentationMode,
  keptClones,
  onDeleteClone,
  onScanClone,
  onStopDocs,
  onGenerateDocs,
  hasSnapshot,
  onCopyExternalPrompt,
  onExportExternalCatalog,
  onImportExternalSnapshot,
  busy,
}: {
  section: SettingsSection;
  onSection: (section: SettingsSection) => void;
  preferences: Preferences;
  onPreferences: (patch: Partial<Preferences>) => void;
  environments: Environment[];
  variables: Variable[];
  confirmations: Array<Record<string, unknown>>;
  onAddEnvironment: () => void;
  onEditEnvironment: (environment: Environment) => void;
  onDeleteEnvironment: (environment: Environment) => void;
  onAddVariable: () => void;
  onEditVariable: (variable: Variable) => void;
  onDeleteVariable: (variable: Variable) => void;
  onConfirmation: (id: string, method: string, checked: boolean) => void;
  docsSettings: Record<string, unknown>;
  aiKey: string;
  onAiKey: (key: string) => void;
  aiStatus: string;
  onSaveAi: (event: FormEvent<HTMLFormElement>) => void;
  onTestAi: () => void;
  tokenTypes: TokenType[];
  onAddToken: () => void;
  onEditToken: (token: TokenType) => void;
  onDeleteToken: (token: TokenType) => void;
  scanRulesText: string;
  onScanRulesText: (text: string) => void;
  onSaveScanRules: () => void;
  onResetScanRules: (presetId?: string) => void;
  docJob: Record<string, unknown>;
  documentationMode: 'automatic' | 'manual';
  onDocumentationMode: (mode: 'automatic' | 'manual') => void;
  keptClones: string[];
  onDeleteClone: (clone: string) => void;
  onScanClone: (clone: string) => void;
  onStopDocs: () => void;
  onGenerateDocs: () => void;
  hasSnapshot: boolean;
  onCopyExternalPrompt: (kind: 'source' | 'enrich') => void;
  onExportExternalCatalog: () => void;
  onImportExternalSnapshot: () => void;
  busy: boolean;
}) {
  const [provider, setProvider] = useState(String(docsSettings.provider || 'local'));
  const [scanPreset, setScanPreset] = useState('spring');
  useEffect(() => setProvider(String(docsSettings.provider || 'local')), [docsSettings.provider]);
  const nav: Array<{ id: SettingsSection; title: string; caption: string; icon: string }> = [
    { id: 'appearance', title: 'Appearance', caption: 'Theme and accent', icon: '◐' },
    { id: 'environments', title: 'Environments', caption: 'Hosts and confirmations', icon: '◎' },
    { id: 'variables', title: 'Variables', caption: 'Reusable values', icon: '⌗' },
    { id: 'tokens', title: 'Token types', caption: 'Authentication setups', icon: '◈' },
    { id: 'ai', title: 'AI model and provider', caption: 'Optional assistance', icon: '✳' },
    { id: 'documentation', title: 'Documentation', caption: 'Generated descriptions', icon: '▤' },
    { id: 'scan-rules', title: 'Scan rules', caption: 'Source annotations', icon: '⌘' },
    { id: 'privacy', title: 'Privacy and data', caption: 'Local data and safeguards', icon: '◇' },
  ];
  const methodsRows = (environment: Environment) => {
    const row = confirmations.find((item) => item.environmentId === environment.environmentId);
    const settings = record(row?.methods);
    return ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map((method) => (
      <label className="method-confirm" key={method}><input type="checkbox" checked={settings[method] === true} onChange={(event) => onConfirmation(environment.environmentId || environment.id || '', method, event.target.checked)} /><span>{method}</span></label>
    ));
  };
  return (
    <div className="settings-page">
      <div className="page-heading settings-heading"><div><p className="breadcrumb">WORKSPACE <span>/</span> SETTINGS</p><h1>Settings</h1><p className="page-description">Make Reqzen work the way you do.</p></div></div>
      <div className="settings-layout">
        <nav className="settings-nav" aria-label="Settings sections">
          {nav.map((item) => <button key={item.id} className={section === item.id ? 'active' : ''} type="button" aria-current={section === item.id ? 'page' : undefined} onClick={() => onSection(item.id)}><span className="settings-nav-icon">{item.icon}</span><span><strong>{item.title}</strong><small>{item.caption}</small></span><span className="settings-chevron">›</span></button>)}
        </nav>
        <div className="settings-content">
          {section === 'appearance' && (
            <section className="settings-card">
              <div className="card-title-row"><div><h2>Appearance</h2><p>Comfortable to read in every light.</p></div></div>
              <Field label="Theme"><div className="segmented-control" role="group" aria-label="Theme">
                {(['system', 'light', 'dark'] as const).map((mode) => <button type="button" key={mode} className={preferences.mode === mode ? 'selected' : ''} aria-pressed={preferences.mode === mode} onClick={() => onPreferences({ mode })}>{mode === 'system' ? 'System' : mode === 'light' ? 'Light' : 'Dark'}</button>)}
              </div></Field>
              <Field label="Accent colour" hint="Colour is used for focus, primary actions, and selection.">
                <div className="palette-choices">
                  {(['blue', 'teal', 'violet', 'amber', 'graphite'] as const).map((palette) => <button key={palette} type="button" className={`palette-choice palette-${palette} ${preferences.palette === palette ? 'selected' : ''}`} aria-pressed={preferences.palette === palette} onClick={() => onPreferences({ palette })}><span />{palette === 'blue' ? 'Ocean blue' : palette[0].toUpperCase() + palette.slice(1)}</button>)}
                </div>
              </Field>
              <div className="text-size-setting">
                <div><strong>Text and interface size</strong><p>Uses your system font. Scaling also enlarges controls for readability.</p></div>
                <div className="text-size-controls" role="group" aria-label="Text and interface size">
                  <Button type="button" aria-label="Decrease text size" disabled={preferences.textScale <= 80} onClick={() => onPreferences({ textScale: preferences.textScale - 10 })}>A−</Button>
                  <output aria-live="polite">{preferences.textScale}%</output>
                  <Button type="button" aria-label="Increase text size" disabled={preferences.textScale >= 150} onClick={() => onPreferences({ textScale: preferences.textScale + 10 })}>A＋</Button>
                  <Button type="button" onClick={() => onPreferences({ textScale: 100 })} disabled={preferences.textScale === 100}>Reset</Button>
                </div>
              </div>
            </section>
          )}
          {section === 'environments' && (
            <>
              <section className="settings-card">
                <div className="card-title-row"><div><h2>Environments</h2><p>HTTPS requests are limited to enabled environment hosts.</p></div><Button variant="primary" onClick={onAddEnvironment}>＋ Add environment</Button></div>
                {environments.length ? environments.map((environment) => (
                  <div className="environment-card" key={environment.id || environment.environmentId}>
                    <div className="environment-card-head"><span className={`environment-avatar ${environment.production ? 'is-prod' : ''}`}>{environment.name.slice(0, 1).toUpperCase()}</span><div className="environment-card-name"><strong>{environment.name}{environment.production && <span className="prod-badge">PROD</span>}</strong><code>{environment.baseUrl}</code><small>{environment.yours ? 'Your environment' : environment.overridden ? 'Snapshot environment · address overridden' : 'From snapshot'}</small></div><div className="environment-card-actions">{environment.yours && <><button type="button" className="text-button" onClick={() => onEditEnvironment(environment)}>Edit</button><button type="button" className="text-button text-danger" onClick={() => onDeleteEnvironment(environment)}>Remove</button></>}</div></div>
                    <div className="confirmation-settings"><strong>Ask before sending</strong><div>{methodsRows(environment)}</div><small>Production environments should keep confirmations on for write requests.</small></div>
                  </div>
                )) : <EmptyState title="No environments yet" text="Add a base address to prepare requests. Requests will never be sent automatically." action={<Button onClick={onAddEnvironment}>Add environment</Button>} />}
              </section>
            </>
          )}
          {section === 'variables' && (
            <section className="settings-card">
              <div className="card-title-row"><div><h2>Variables</h2><p>Use reusable values such as organization IDs in request inputs.</p></div><Button variant="primary" onClick={onAddVariable}>＋ Add variable</Button></div>
              {variables.length ? <div className="variable-list">{variables.map((variable) => <div className="variable-row" key={variable.id}><code>{`{{${variable.name}}}`}</code><span>{variable.value ? 'Shared value saved' : 'Environment-specific values saved'}</span><button className="text-button" type="button" onClick={() => onEditVariable(variable)}>Edit</button><button className="text-button text-danger" type="button" onClick={() => onDeleteVariable(variable)}>Remove</button></div>)}</div> : <EmptyState title="No variables yet" text="Add a variable for values you reuse across API requests." action={<Button onClick={onAddVariable}>Add variable</Button>} />}
            </section>
          )}
          {section === 'tokens' && (
            <section className="settings-card">
              <div className="card-title-row"><div><h2>Token types</h2><p>Reusable access-token setup for API environments.</p></div><Button variant="primary" onClick={onAddToken}>＋ Add token type</Button></div>
              {tokenTypes.length ? <div className="token-list">{tokenTypes.map((token) => (
                <div className="token-card" key={token.id}>
                  <span className="environment-avatar">{token.name.slice(0, 1).toUpperCase()}</span>
                  <div className="token-card-main"><strong>{token.name}</strong><code>{token.url || (token.operation?.pathTemplate || 'Saved API token operation')}</code><small>{token.method || 'API'} · {token.auth === 'none' ? 'No access-token auth' : token.auth === 'bearer' ? 'Bearer access token' : 'Basic access token'}</small></div>
                  <div className="environment-card-actions"><button type="button" className="text-button" onClick={() => onEditToken(token)}>Edit</button><button type="button" className="text-button text-danger" onClick={() => onDeleteToken(token)}>Remove</button></div>
                </div>
              ))}</div> : <EmptyState title="No token types" text="Add a token endpoint or saved API operation to generate credentials for a request." action={<Button onClick={onAddToken}>Add token type</Button>} />}
            </section>
          )}
          {section === 'ai' && (
            <>
              <form className="settings-card" onSubmit={onSaveAi}>
                <div className="card-title-row"><div><h2>AI model and provider</h2><p>AI is optional. Basic scanning and request building work without it.</p></div><span className="optional-chip">OPTIONAL</span></div>
                <Field label="Provider"><select name="provider" value={provider} onChange={(event) => setProvider(event.target.value)}><option value="local">Local model (Ollama)</option><option value="openai">OpenAI-compatible</option><option value="claude">Claude API</option></select></Field>
                {provider === 'local' && <>
                  <Field label="Local Ollama server URL" hint="Use a URL reachable from this computer. The server stays local unless you configure otherwise."><input name="baseUrl" defaultValue={String(docsSettings.baseUrl || 'http://127.0.0.1:11434')} placeholder="http://127.0.0.1:11434" /></Field>
                  <Field label="Local model ID"><input name="model" defaultValue={String(docsSettings.model || '')} placeholder="llama3.2" /></Field>
                </>}
                {provider === 'openai' && <>
                  <Field label="OpenAI-compatible API base URL"><input name="baseUrl" defaultValue={String(docsSettings.baseUrl || 'http://127.0.0.1:11434/v1')} placeholder="https://api.example.com/v1" /></Field>
                  <Field label="Model ID"><input name="model" defaultValue={String(docsSettings.model || '')} placeholder="Model identifier" /></Field>
                </>}
                {provider !== 'local' && <Field label="API key" hint="Held in memory only. Re-enter it after restarting Reqzen."><input type="password" autoComplete="off" value={aiKey} onChange={(event) => onAiKey(event.target.value)} placeholder={docsSettings.hasKey ? 'Key set for this session' : 'Not saved'} /></Field>}
                <label className="check-row"><input name="generateAfterScan" type="checkbox" defaultChecked={docsSettings.generateAfterScan !== false} /><span><strong>Write descriptions after scanning</strong><small>Uses the selected model to draft API descriptions after you review the scan.</small></span></label>
                <Field label="After-scan instructions"><textarea name="afterScanInstructions" rows={4} defaultValue={String(docsSettings.afterScanInstructions || '')} placeholder="Optional instructions for generated API descriptions" /></Field>
                <Field label="Manual-run instructions"><textarea name="instructions" rows={4} defaultValue={String(docsSettings.instructions || '')} placeholder="Optional instructions for documentation drafts" /></Field>
                {aiStatus && <p className="model-status"><span className="status-dot" />{aiStatus}</p>}
                <div className="button-row"><Button type="button" onClick={onTestAi} disabled={busy}>Check saved connection</Button><Button variant="primary" type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save settings'}</Button></div>
              </form>
            </>
          )}
          {section === 'documentation' && (
            <form className="settings-card" onSubmit={onSaveAi}>
              <input type="hidden" name="provider" value={String(docsSettings.provider || 'local')} />
              <input type="hidden" name="baseUrl" value={String(docsSettings.baseUrl || '')} />
              <input type="hidden" name="model" value={String(docsSettings.model || '')} />
              <div className="card-title-row"><div><h2>Documentation</h2><p>Choose what Reqzen writes after a scan or manual run.</p></div></div>
              <div className="segmented-control" role="group" aria-label="Documentation mode">
                <button type="button" className={documentationMode === 'automatic' ? 'selected' : ''} aria-pressed={documentationMode === 'automatic'} onClick={() => onDocumentationMode('automatic')}>Automatic</button>
                <button type="button" className={documentationMode === 'manual' ? 'selected' : ''} aria-pressed={documentationMode === 'manual'} onClick={() => onDocumentationMode('manual')}>Manual</button>
              </div>
              {documentationMode === 'automatic' ? <>
                <label className="check-row"><input name="generateAfterScan" type="checkbox" defaultChecked={docsSettings.generateAfterScan !== false} /><span><strong>Write descriptions after scanning</strong><small>Draft API descriptions after a successful scan.</small></span></label>
                <Field label="After-scan instructions"><textarea name="afterScanInstructions" rows={7} defaultValue={String(docsSettings.afterScanInstructions || '')} placeholder="Optional instructions for generated API descriptions" /></Field>
              </> : <>
                <div className="documentation-status manual-status">
                  <span className={`status-dot ${docJob.state === 'running' ? 'running' : ''}`} />
                  <div><strong>{docJob.state === 'running' ? `Writing documentation · ${String(docJob.done || 0)} / ${String(docJob.total || 0)}` : 'Manual documentation run'}</strong><small>{docJob.state === 'running' ? 'Descriptions are being generated for the current catalog.' : 'Generate descriptions for APIs in the currently loaded catalog.'}</small></div>
                  {docJob.state === 'running' ? <Button type="button" onClick={onStopDocs}>Stop</Button> : <Button type="button" variant="primary" onClick={onGenerateDocs}>Generate now</Button>}
                </div>
                <DocumentationProgress job={docJob} />
                <Field label="Manual-run instructions"><textarea name="instructions" rows={7} defaultValue={String(docsSettings.instructions || '')} placeholder="Optional instructions for documentation drafts" /></Field>
              </>}
              <div className="privacy-note">Documentation generation uses the AI provider selected in AI model and provider. Review generated text before sharing.</div>
              <div className="scan-secondary-panel">
                <h3>Use an external AI tool</h3>
                <p>Copy a prompt to generate a snapshot from source, or export the current catalog and enrich it externally. Save the complete JSON response and import it as a snapshot.</p>
                <p>Prompts use your saved manual instructions. Snapshot exports can include selected environments, token types, and variables. Review all source and catalog data before sharing.</p>
                <div className="external-workflows">
                  <div className="external-workflow">
                    <strong>Start from source</strong>
                    <span>Use with a tool that can inspect your project.</span>
                    <Button type="button" onClick={() => onCopyExternalPrompt('source')}>Copy source prompt</Button>
                  </div>
                  <div className="external-workflow">
                    <strong>Enrich this catalog</strong>
                    <span>Export your catalog and provide it with the prompt.</span>
                    <div className="button-row">
                      <Button type="button" onClick={() => onCopyExternalPrompt('enrich')}>Copy enrichment prompt</Button>
                      <Button type="button" disabled={!hasSnapshot} onClick={onExportExternalCatalog}>Export catalog</Button>
                    </div>
                  </div>
                </div>
                <div className="external-import"><span>Have a generated snapshot?</span><Button type="button" onClick={onImportExternalSnapshot}>Import snapshot</Button></div>
              </div>
              <div className="button-row"><Button type="button" onClick={() => onSection('ai')}>Configure AI provider</Button><Button variant="primary" type="submit" disabled={busy}>Save documentation settings</Button></div>
            </form>
          )}
          {section === 'scan-rules' && (
            <section className="settings-card">
              <div className="card-title-row"><div><h2>Scan rules</h2><p>Choose a framework preset or edit annotation and route rules.</p></div></div>
              <div className="scan-preset-grid" role="radiogroup" aria-label="Source scanning approach">
                {[
                  ['spring', 'Spring', 'Java annotations'],
                  ['nestjs', 'NestJS', 'TypeScript decorators'],
                  ['fastapi', 'FastAPI', 'Python routes'],
                  ['express', 'Express', 'JavaScript / TypeScript'],
                  ['flask', 'Flask', 'Python routes'],
                  ['django', 'Django', 'Python URL patterns'],
                ].map(([id, title, detail]) => (
                  <button type="button" key={id} role="radio" aria-checked={scanPreset === id} className={`scan-preset ${scanPreset === id ? 'selected' : ''}`} onClick={() => setScanPreset(id)}>
                    <strong>{title}</strong><span>{detail}</span>
                  </button>
                ))}
              </div>
              <div className="scan-rule-toolbar">
                <Field label="Framework preset"><select value={scanPreset} onChange={(event) => setScanPreset(event.target.value)}><option value="spring">Spring MVC · Java</option><option value="nestjs">NestJS · TypeScript</option><option value="fastapi">FastAPI · Python</option><option value="express">Express · JavaScript</option><option value="flask">Flask · Python</option><option value="django">Django · Python</option></select></Field>
                <div className="button-row">
                  <Button onClick={() => onResetScanRules(scanPreset)}>Load preset</Button>
                  <Button onClick={() => onScanRulesText(JSON.stringify({
                    name: 'My custom framework',
                    fileExtensions: ['.custom'],
                    skipFilePattern: '',
                    skipPathPattern: '(^|/)(src/test|test|tests|__tests__)/',
                    classMarkers: ['Resource'],
                    basePathAnnotation: 'Resource',
                    mappings: [{ annotation: 'Get', method: 'GET' }, { annotation: 'Post', method: 'POST' }],
                    defaultMethod: 'GET',
                    methodArgument: null,
                    pathArguments: ['path', 'value'],
                    pathParamStyle: 'braces',
                    parameters: [],
                    deprecatedMarkers: ['Deprecated'],
                    visibilityMarkers: [{ annotation: 'Hidden', visibility: 'HIDDEN' }, { annotation: 'InternalApi', visibility: 'HIDDEN' }],
                    versionPattern: '(?:^|/)(v\\d+(?:\\.\\d+)?)(?=/|$)',
                  }, null, 2))}>＋ Add custom rule</Button>
                </div>
              </div>
              <Field label="Rule set JSON" hint="Built-in Python and JavaScript route scanning remains available alongside custom rules.">
                <textarea className="code-editor" rows={18} spellCheck={false} value={scanRulesText} onChange={(event) => onScanRulesText(event.target.value)} />
              </Field>
              <div className="button-row"><Button variant="primary" onClick={onSaveScanRules} disabled={busy || !scanRulesText.trim()}>Save scan rules</Button></div>
              <div className="scan-secondary-panel">
                <div className="card-title-row"><div><h3>Documentation</h3><p>Automatic and manual API descriptions.</p></div></div>
                <div className="documentation-status">
                  <span className={`status-dot ${docJob.state === 'running' ? 'running' : ''}`} />
                  <div><strong>{docJob.state === 'running' ? `Writing documentation · ${String(docJob.done || 0)} / ${String(docJob.total || 0)}` : docJob.state === 'failed' ? 'Documentation run failed' : 'Documentation ready'}</strong><small>{String(docJob.reason || 'Use the configured AI provider to describe APIs.')}</small></div>
                  {docJob.state === 'running' ? <Button onClick={onStopDocs}>Stop</Button> : <Button variant="primary" onClick={onGenerateDocs}>Generate documentation</Button>}
                </div>
                <DocumentationProgress job={docJob} />
              </div>
              {keptClones.length > 0 && (
                <div className="scan-secondary-panel">
                  <div className="card-title-row"><div><h3>Kept cloned projects</h3><p>Local copies from completed scans.</p></div></div>
                  {keptClones.map((clone) => <div className="kept-clone-row" key={clone}><code>{clone}</code><div className="button-row"><button type="button" className="text-button" onClick={() => onScanClone(clone)}>Scan</button><button type="button" className="text-button text-danger" onClick={() => onDeleteClone(clone)}>Delete</button></div></div>)}
                </div>
              )}
            </section>
          )}
          {section === 'privacy' && (
            <section className="settings-card privacy-settings">
              <div className="card-title-row"><div><h2>Privacy and data</h2><p>Reqzen is designed to keep you in control of your code and requests.</p></div></div>
              <div className="privacy-point"><span>01</span><div><strong>Local-first by default</strong><p>Scans run on this computer. GitHub scanning only contacts GitHub; request calls only run after you choose Send.</p></div></div>
              <div className="privacy-point"><span>02</span><div><strong>Credentials are protected</strong><p>Request tokens stay in memory for the current session. Known credentials are redacted from AI prompts and request responses.</p></div></div>
              <div className="privacy-point"><span>03</span><div><strong>Requests are checked</strong><p>HTTPS destinations are checked against enabled environments. Production, write methods, and incomplete contracts may require extra confirmation.</p></div></div>
              <div className="privacy-note">Environment and variable values are stored locally. Protect your operating-system account and review exports before sharing.</div>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}

export default App;
