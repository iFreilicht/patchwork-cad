import type { BrowserContext, ConsoleMessage } from "@playwright/test";

export interface PageError {
  /** the context it came from: "default" or "user-<i>" */
  context: string;
  url: string;
  message: string;
  /** a stack trace, or for console errors the logging location */
  stack: string | undefined;
}

const text = (e: PageError) => `${e.message}\n${e.stack ?? ""}`;

/** Uncaught errors that aren't the page's. */
const UNCAUGHT_NOISE: ((e: PageError) => boolean)[] = [
  // Firefox's Playwright also reports a page.evaluate() that rejects as uncaught, though the rejection reaches the test.
  (e) => e.stack?.includes("chrome://juggler/") ?? false,
];

/** Console errors that aren't the page's: browser, harness and library noise. */
const CONSOLE_NOISE: ((e: PageError) => boolean)[] = [
  // The harness rewrites remote URLs in the base modules to 404s (site/vite.config.ts); Firefox reports them as service worker errors.
  (e) => text(e).includes("/harness-blocked/"),
  // Firefox logs this when Patchwork's service worker answers an automerge: URL with a 307 to its heads, though the fetch follows the redirect.
  (e) => e.message.includes("Failed to load ‘’. A ServiceWorker intercepted the request and encountered an unexpected error."),
  // replicad-evaluator logs every model error it returns (formatException); the tool shows it, and tests check it there.
  (e) => /\/packages\/cad\/dist\/assets\/worker-[\w-]+\.js:/.test(e.stack ?? ""),
  // Patchwork's drafts provider (@inkandswitch/patchwork-pkg-base) logs when a model's main draft hasn't reached a second profile yet.
  (e) => /^\[drafts\] rewalk failed: Error: Document \w+ is unavailable/.test(e.message),
];

/** The message with Error arguments as name and message: Firefox renders them as just "Error". */
async function describe(m: ConsoleMessage): Promise<string | undefined> {
  const args = await Promise.all(
    m.args().map((arg) => arg.evaluate((v) => (v instanceof Error ? { error: true, text: `${v.name}: ${v.message}` } : { error: false, text: String(v) }))),
  );
  const errors = args.filter((a) => a.error);
  if (!errors.length || errors.every((a) => m.text().includes(a.text))) return undefined;
  return args.map((a) => a.text).join(" ");
}

/**
 * Collects what pages report as broken: uncaught errors and unhandled
 * rejections (Playwright's weberror covers every page of a context, popups
 * included, in all three browsers) and, separately, console errors.
 */
export class PageErrors {
  readonly uncaught: PageError[] = [];
  readonly console: PageError[] = [];
  readonly #pending: Promise<void>[] = [];

  watch(context: BrowserContext, name: string): void {
    context.on("weberror", (e) => {
      const error = e.error();
      this.uncaught.push({ context: name, url: e.page()?.url() ?? "", message: error.message, stack: error.stack });
    });
    context.on("console", (m) => {
      if (m.type() !== "error") return;
      const { url, lineNumber, columnNumber } = m.location();
      const entry: PageError = { context: name, url: m.page()?.url() ?? "", message: m.text(), stack: url ? `${url}:${lineNumber}:${columnNumber}` : undefined };
      this.console.push(entry);
      this.#pending.push(describe(m).then((message) => void (message && (entry.message = message)), () => {}));
    });
  }

  /** Waits for console messages to be described; call before closing a context. */
  async settled(): Promise<void> {
    await Promise.all(this.#pending);
  }

  /** Errors that count: uncaught ones and console errors that aren't noise, minus those whose message or location matches an allowed pattern. */
  unexpected(allowed: (string | RegExp)[]): PageError[] {
    const matches = (e: PageError, pattern: string | RegExp) => (typeof pattern === "string" ? text(e).includes(pattern) : pattern.test(text(e)));
    return [...this.uncaught.filter((e) => !UNCAUGHT_NOISE.some((n) => n(e))), ...this.console.filter((e) => !CONSOLE_NOISE.some((n) => n(e)))].filter(
      (e) => !allowed.some((pattern) => matches(e, pattern)),
    );
  }
}
