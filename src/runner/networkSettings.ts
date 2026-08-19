import * as vscode from 'vscode';
import type { CertificateConfig, ProxyConfig } from './protocol';

/**
 * Client certificates, from `restclient.certificates`.
 *
 * Paths are handed to the runner as-is and read through the workspace-scoped
 * file resolver, so a certificate outside the workspace is refused just like any
 * other file a collection asks for.
 */
export function readCertificates(): CertificateConfig[] {
  const configured = vscode.workspace
    .getConfiguration('restclient')
    .get<CertificateConfig[]>('certificates', []);

  return (configured ?? []).filter((c) => Array.isArray(c?.matches) && c.matches.length);
}

/**
 * Proxy configuration.
 *
 * Explicit `restclient.proxies` entries win. Otherwise VS Code's own `http.proxy`
 * is used, so the extension obeys the same proxy as the rest of the editor
 * without asking the user to configure it twice.
 */
export function readProxies(): ProxyConfig[] {
  const own = vscode.workspace.getConfiguration('restclient').get<ProxyConfig[]>('proxies', []);
  if (own?.length) { return own.filter((p) => p?.host); }

  const http = vscode.workspace.getConfiguration('http');
  const proxyUrl = http.get<string>('proxy', '');
  if (!proxyUrl) { return []; }

  let parsed: URL;
  try {
    parsed = new URL(proxyUrl);
  } catch {
    return []; // a malformed setting should not break every request
  }

  const noProxy = http.get<string[]>('noProxy', []) ?? [];

  return [
    {
      match: 'http+https://*/*',
      host: parsed.hostname,
      port: parsed.port ? Number(parsed.port) : parsed.protocol === 'https:' ? 443 : 80,
      // VS Code's setting is a forward proxy; HTTPS through it needs CONNECT.
      tunnel: true,
      ...(parsed.username ? { username: decodeURIComponent(parsed.username) } : {}),
      ...(parsed.password ? { password: decodeURIComponent(parsed.password) } : {}),
      ...(noProxy.length ? { bypass: noProxy } : {})
    }
  ];
}

/**
 * Whether to verify TLS certificates.
 *
 * Postman ships with verification off, and `http.proxyStrictSSL` is VS Code's
 * closest equivalent, so honour that unless the user sets ours explicitly.
 */
export function readStrictSSL(): boolean {
  const config = vscode.workspace.getConfiguration('restclient');
  const inspected = config.inspect<boolean>('strictSSL');
  const explicit =
    inspected?.workspaceFolderValue ?? inspected?.workspaceValue ?? inspected?.globalValue;
  if (typeof explicit === 'boolean') { return explicit; }
  return false;
}
