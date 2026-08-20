import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";

/** A small router, so the service stays dependency-free and easy to read. */

export type Handler = (ctx: RequestContext) => Promise<unknown> | unknown;

export interface RequestContext {
  params: Record<string, string>;
  query: URLSearchParams;
  body: unknown;
  request: IncomingMessage;
  response: ServerResponse;
}

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

interface Route {
  method: string;
  pattern: RegExp;
  keys: string[];
  handler: Handler;
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
};

export class Router {
  private readonly routes: Route[] = [];

  constructor(
    private readonly options: {
      staticDir?: string;
      serialize: (value: unknown) => string;
      parse: (text: string) => unknown;
    },
  ) {}

  add(method: string, path: string, handler: Handler): this {
    const keys: string[] = [];
    const pattern = new RegExp(
      `^${path.replace(/:([A-Za-z0-9_]+)/g, (_m, key: string) => {
        keys.push(key);
        return "([^/]+)";
      })}$`,
    );
    this.routes.push({ method, pattern, keys, handler });
    return this;
  }

  get(path: string, handler: Handler) {
    return this.add("GET", path, handler);
  }

  post(path: string, handler: Handler) {
    return this.add("POST", path, handler);
  }

  listen(port: number, onReady?: (port: number) => void) {
    const server = createServer((request, response) => {
      void this.handle(request, response);
    });
    server.listen(port, () => onReady?.(port));
    return server;
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);

    // The dashboard is served from the same origin as the API, so no CORS dance is needed
    // locally; the header is here for agents calling the API from elsewhere.
    response.setHeader("Access-Control-Allow-Origin", "*");
    response.setHeader("Access-Control-Allow-Headers", "content-type");
    if (request.method === "OPTIONS") {
      response.writeHead(204).end();
      return;
    }

    for (const route of this.routes) {
      if (route.method !== request.method) continue;
      const match = route.pattern.exec(url.pathname);
      if (!match) continue;

      const params = Object.fromEntries(route.keys.map((key, i) => [key, decodeURIComponent(match[i + 1]!)]));
      try {
        const body = request.method === "POST" ? this.options.parse(await readBody(request)) : undefined;
        const result = await route.handler({ params, query: url.searchParams, body, request, response });
        if (response.writableEnded) return;
        response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        response.end(this.options.serialize(result ?? {}));
      } catch (error) {
        const status = error instanceof HttpError ? error.status : 500;
        response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
        response.end(JSON.stringify({ error: (error as Error).message }));
      }
      return;
    }

    if (request.method === "GET" && this.options.staticDir) {
      const served = await this.serveStatic(url.pathname, response);
      if (served) return;
    }

    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: `no route for ${request.method} ${url.pathname}` }));
  }

  private async serveStatic(pathname: string, response: ServerResponse): Promise<boolean> {
    const relative = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
    // Contain the path: a static server that follows `..` out of its root is a file disclosure.
    if (relative.includes("..")) return false;

    try {
      const file = join(this.options.staticDir!, relative);
      const content = await readFile(file);
      response.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
      response.end(content);
      return true;
    } catch {
      return false;
    }
  }
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      // An intent draft is a few kilobytes; anything near a megabyte is not one.
      if (size > 1_000_000) {
        reject(new HttpError(413, "request body too large"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8") || "null"));
    request.on("error", reject);
  });
}
