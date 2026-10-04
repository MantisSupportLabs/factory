// Minimal in-process router for the existing, synchronous feature handlers.
export function Router() {
  const routes = [];
  const router = { routes };
  for (const method of ['get', 'post', 'patch', 'put', 'delete']) {
    router[method] = (path, ...handlers) => { routes.push({ method: method.toUpperCase(), path, handlers }); return router; };
  }
  return router;
}
export async function dispatch(routers, method, path, body, tenant) {
  const url = new URL(path, 'https://demo.invalid');
  for (const route of routers.flatMap(router => router.routes)) {
    if (route.method !== method) continue;
    const keys = [];
    const pattern = route.path.split('/').map(segment => {
      if (segment.startsWith(':')) { keys.push(segment.slice(1)); return '([^/]+)'; }
      return segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }).join('/');
    const match = url.pathname.match(new RegExp(`^${pattern}/?$`));
    if (!match) continue;
    const req = { method, path: url.pathname, body: body ?? {}, tenant,
      params: Object.fromEntries(keys.map((key, index) => [key, decodeURIComponent(match[index + 1])])),
      query: Object.fromEntries(url.searchParams), authUser: undefined };
    let status = 200, output, ended = false;
    const headers = new Headers();
    const res = {
      status(value) { status = value; return this; },
      set(key, value) { headers.set(key, value); return this; },
      type(value) { headers.set('Content-Type', value); return this; },
      attachment(name) { headers.set('Content-Disposition', `attachment; filename="${name}"`); return this; },
      json(value) { headers.set('Content-Type', 'application/json'); output = JSON.stringify(value); ended = true; return this; },
      send(value) { output = value; ended = true; return this; },
    };
    for (const handler of route.handlers) {
      let nextError;
      await handler(req, res, error => { nextError = error; });
      if (nextError) throw nextError;
      if (ended) break;
    }
    return new Response(status === 204 ? null : output, { status, headers });
  }
  return Response.json({ error: 'This action is unavailable in the browser demo.' }, { status: 404 });
}
