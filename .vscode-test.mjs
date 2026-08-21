import { defineConfig } from '@vscode/test-cli';

/**
 * Two windows, because a workspace's *shape* is not something a test can change
 * from inside it.
 *
 * The main suite runs against a single folder, which is what almost every user
 * has. The second runs against a real `.code-workspace` with two folders —
 * declared up front rather than assembled at runtime, since converting a
 * single-folder window into a workspace is persistent state that would outlive
 * the run and poison the next one.
 */
export default defineConfig([
  {
    label: 'workspace',
    files: ['out/test/integration/extension.test.js'],
    version: 'stable',
    workspaceFolder: './fixtures/workspace',
    mocha: { ui: 'tdd', timeout: 60000 }
  },
  {
    label: 'multiroot',
    files: ['out/test/integration/multiroot.test.js'],
    version: 'stable',
    workspaceFolder: './fixtures/multiroot/multiroot.code-workspace',
    mocha: { ui: 'tdd', timeout: 60000 }
  }
]);
