import type { MiddlewareHandler } from "hono";

/**
 * Server-side session checks can renew the database session. Preserve the
 * accompanying cookies on the actual HTTP response so the browser renews too.
 */
export function createRequestSessions<T>(
  lookup: (input: {
    headers: Headers;
    returnHeaders: true;
  }) => Promise<{ response: T; headers: Headers }>,
) {
  const pending = new WeakMap<Request, ReturnType<typeof lookup>>();
  const getSession = async (request: Request): Promise<T> => {
    let result = pending.get(request);
    if (!result) {
      result = lookup({ headers: request.headers, returnHeaders: true });
      pending.set(request, result);
    }
    return (await result).response;
  };
  const middleware: MiddlewareHandler = async (c, next) => {
    await next();
    const result = pending.get(c.req.raw);
    if (!result) return;
    const { headers } = await result;
    for (const cookie of headers.getSetCookie()) {
      c.header("set-cookie", cookie, { append: true });
    }
    // Session replies must not be cached, including non-RPC authenticated routes.
    c.header("cache-control", "no-store");
  };
  return { getSession, middleware };
}
