import * as vscode from 'vscode';

export const VISUALIZER_VIEW_TYPE = 'restclient.visualizer';

/**
 * Renders `pm.visualizer.set()` output.
 *
 * postman-runtime has already run the handlebars template, so what arrives is
 * the author's finished HTML. It gets its own webview rather than being injected
 * into the request editor, for two reasons:
 *
 *  - Visualizer templates are arbitrary author HTML and routinely need inline
 *    scripts and styles, which the request editor's strict CSP forbids — and
 *    should keep forbidding.
 *  - Isolating it means a hostile template cannot reach the request editor's
 *    state or its message channel.
 *
 * The panel ignores every message the content sends, so `acquireVsCodeApi` is
 * inert here. Network access stays blocked, which means templates that pull a
 * charting library from a CDN will not render — a documented limitation.
 */
export class VisualizerPanel implements vscode.Disposable {
  private static current: VisualizerPanel | undefined;

  static show(title: string, html: string): VisualizerPanel {
    if (VisualizerPanel.current) {
      VisualizerPanel.current.update(title, html);
      VisualizerPanel.current.panel.reveal(undefined, true);
      return VisualizerPanel.current;
    }
    VisualizerPanel.current = new VisualizerPanel(title, html);
    return VisualizerPanel.current;
  }

  private readonly panel: vscode.WebviewPanel;

  private constructor(title: string, html: string) {
    this.panel = vscode.window.createWebviewPanel(
      VISUALIZER_VIEW_TYPE,
      `Visualize: ${title}`,
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [] }
    );
    this.panel.iconPath = new vscode.ThemeIcon('graph');
    this.panel.onDidDispose(() => {
      if (VisualizerPanel.current === this) { VisualizerPanel.current = undefined; }
    });
    this.update(title, html);
  }

  update(title: string, html: string): void {
    this.panel.title = `Visualize: ${title}`;
    this.panel.webview.html = wrap(html);
  }

  dispose(): void {
    this.panel.dispose();
  }
}

/**
 * Wrap author HTML in a document that inherits VS Code's theme.
 *
 * `script-src 'unsafe-inline'` is deliberate and scoped to this panel only:
 * visualizer templates are inline scripts by design. `connect-src 'none'` keeps
 * them from calling out, and `default-src 'none'` blocks remote script/style.
 */
function wrap(html: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'none'; form-action 'none';">
<style>
  body {
    margin: 0;
    padding: 12px;
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--vscode-foreground);
    background: var(--vscode-editor-background);
  }
  table { border-collapse: collapse; }
  th, td { border: 1px solid var(--vscode-panel-border, #8884); padding: 4px 8px; text-align: left; }
</style>
</head>
<body>
${html}
</body>
</html>`;
}
