import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    // The `vscode` module only exists inside VS Code. Tests get its Uri (from
    // the same package VS Code's own Uri comes from) and nothing else, so code
    // reaching the real workspace fails loudly instead of being faked.
    alias: { vscode: fileURLToPath(new URL('./test/vscode.ts', import.meta.url)) },
  },
  test: {
    include: ['test/**/*.test.ts'],
  },
});
