// Runs the preview webview in Chromium (what VS Code's webviews run in) with
// the real page, scripts and PlantUML engine. The VS Code side is a stand-in:
// the test sends the extension's messages and reads what the page posts back.

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer, Server } from 'node:http';
import { AddressInfo } from 'node:net';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Browser, chromium, Page } from 'playwright';
import { previewHtml, PreviewPage } from '../../src/previewHtml';
import type { FromWebview, ToWebview } from '../../src/protocol';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const MEDIA = path.join(ROOT, 'media');
/** Where screenshots go, for a look at what the tests saw. */
export const SCREENSHOTS = path.join(ROOT, 'test-results', 'webview');

const TYPES: Record<string, string> = {
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.wasm': 'application/wasm',
  '.ttf': 'font/ttf',
};

declare global {
  interface Window {
    /** The messages the page posted to the extension, oldest first. */
    posted: FromWebview[];
  }
}

/** A browser and a server for the extension's `media` folder, shared by the previews a test file opens. */
export class Harness {
  private pages = new Map<string, string>();
  private nextPage = 0;

  private constructor(
    private readonly server: Server,
    private readonly browser: Browser,
    private readonly origin: string
  ) {}

  static async start(): Promise<Harness> {
    if (!existsSync(path.join(MEDIA, 'vendor', 'plantuml.js'))) {
      throw new Error('The PlantUML engine is missing: run `npm run fetch-runtime` (and `npm run copy-monaco`) first.');
    }
    let harness: Harness | undefined;
    const server = createServer((request, response) => void harness!.serve(request.url ?? '/', response));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    harness = new Harness(server, await chromium.launch(), origin);
    return harness;
  }

  /** Opens a preview page, as `Preview` creates it, and waits until its engine is loaded. */
  async open(options: Partial<Pick<PreviewPage, 'format' | 'kind' | 'readOnly'>> = {}): Promise<Webview> {
    const id = `page-${this.nextPage++}`;
    this.pages.set(
      id,
      previewHtml({
        media: (...parts) => `${this.origin}/media/${parts.join('/')}`,
        cspSource: this.origin,
        nonce: 'test-nonce',
        format: options.format ?? 'plantuml',
        kind: options.kind ?? 'editor',
        split: false,
        readOnly: options.readOnly ?? false,
      })
    );
    const page = await this.browser.newPage({ viewport: { width: 1000, height: 800 } });
    const webview = new Webview(page);
    await page.addInitScript(() => {
      window.posted = [];
      // Webview scripts reach VS Code only through this API.
      (window as unknown as { acquireVsCodeApi: () => unknown }).acquireVsCodeApi = () => ({
        postMessage: (message: FromWebview) => window.posted.push(message),
        getState: () => undefined,
        setState: () => undefined,
      });
      // Report what the Content-Security-Policy blocks: VS Code would block it too.
      document.addEventListener('securitypolicyviolation', (e) => console.error(`CSP blocked ${e.blockedURI} (${e.violatedDirective})`));
    });
    await page.goto(`${this.origin}/${id}`);
    await webview.next('ready', 30_000);
    return webview;
  }

  async stop(): Promise<void> {
    await this.browser.close();
    await new Promise((resolve) => this.server.close(resolve));
  }

  private async serve(url: string, response: import('node:http').ServerResponse): Promise<void> {
    const pathname = decodeURIComponent(new URL(url, this.origin).pathname);
    const page = this.pages.get(pathname.slice(1));
    if (page !== undefined) {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(page);
      return;
    }
    const file = path.join(ROOT, pathname);
    if (!file.startsWith(MEDIA + path.sep)) {
      response.writeHead(404).end();
      return;
    }
    try {
      const body = await readFile(file);
      response.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] ?? 'application/octet-stream' }).end(body);
    } catch {
      response.writeHead(404).end();
    }
  }
}

/** One preview page. */
export class Webview {
  /** Errors in the page: uncaught exceptions, console errors, blocked resources. */
  readonly errors: string[] = [];

  constructor(readonly page: Page) {
    page.on('pageerror', (e) => this.errors.push(e.message));
    page.on('console', (m) => m.type() === 'error' && this.errors.push(m.text()));
  }

  /** Sends a message from the extension. */
  async send(message: ToWebview): Promise<void> {
    await this.page.evaluate((m) => window.postMessage(m, '*'), message);
  }

  /** Waits for the page to post a message of `type`, and takes it. */
  async next<T extends FromWebview['type']>(type: T, timeout = 10_000): Promise<Extract<FromWebview, { type: T }>> {
    await this.page.waitForFunction((t) => window.posted.some((m) => m.type === t), type, { timeout });
    return (await this.page.evaluate((t) => {
      const i = window.posted.findIndex((m) => m.type === t);
      return window.posted.splice(i, 1)[0];
    }, type)) as Extract<FromWebview, { type: T }>;
  }

  /** The messages posted and not taken yet. */
  async posted(): Promise<FromWebview[]> {
    return this.page.evaluate(() => window.posted);
  }

  /** Waits until `count` diagrams show an SVG and nothing is rendering. */
  async rendered(count: number): Promise<void> {
    await this.page.waitForFunction(
      (n) => document.querySelectorAll('.diagram[data-svg] > svg').length === n && !/Rendering/.test(document.getElementById('status')?.textContent ?? ''),
      count,
      { timeout: 30_000 }
    );
  }

  async screenshot(name: string): Promise<void> {
    await this.page.screenshot({ path: path.join(SCREENSHOTS, `${name}.png`), fullPage: true });
  }

  async close(): Promise<void> {
    await this.page.close();
  }
}
