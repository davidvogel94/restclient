import type * as vscode from 'vscode';

/**
 * Bridges Postman `secret`-typed variables (and, later, `pm.vault`) onto VS
 * Code's SecretStorage, which is backed by the OS keychain.
 *
 * Keys are namespaced by environment id so two environments may hold different
 * values for the same variable name.
 */
export class SecretsBroker {
  constructor(private readonly storage: vscode.SecretStorage) {}

  private key(environmentId: string, variable: string): string {
    return `restclient:env:${environmentId}:${variable}`;
  }

  async set(environmentId: string, variable: string, value: string): Promise<void> {
    await this.storage.store(this.key(environmentId, variable), value);
  }

  async get(environmentId: string, variable: string): Promise<string | undefined> {
    return this.storage.get(this.key(environmentId, variable));
  }

  async delete(environmentId: string, variable: string): Promise<void> {
    await this.storage.delete(this.key(environmentId, variable));
  }

  async storeAll(environmentId: string, secrets: Record<string, string>): Promise<void> {
    await Promise.all(Object.entries(secrets).map(([k, v]) => this.set(environmentId, k, v)));
  }

  /**
   * Resolve every `secret`-typed variable of an environment for a run.
   * Missing entries are simply omitted so the variable stays unresolved rather
   * than silently becoming an empty string.
   */
  async resolveFor(
    environmentId: string,
    values: Array<{ key?: string; type?: string; enabled?: boolean }>
  ): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    await Promise.all(
      values
        .filter((v) => v?.type === 'secret' && v.key && v.enabled !== false)
        .map(async (v) => {
          const value = await this.get(environmentId, String(v.key));
          if (value !== undefined) { out[String(v.key)] = value; }
        })
    );
    return out;
  }
}
