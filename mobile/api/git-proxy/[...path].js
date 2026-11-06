// Git proxy for JaniX Mobile. Browsers block cross-origin requests to Git
// hosts, so the app's clone/pull/push requests come through here. Only the
// Git smart-HTTP endpoints of a few public hosts are allowed, so this cannot
// be used as a general-purpose proxy. Nothing is stored or logged.
const HOSTS = new Set(["github.com", "gitlab.com", "bitbucket.org", "codeberg.org"]);
const GIT_PATH = /\/(info\/refs|git-upload-pack|git-receive-pack)$/;
const FORWARD = ["accept", "content-type", "authorization", "git-protocol"];
const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "accept, content-type, authorization, git-protocol, x-http-method-override",
  "access-control-expose-headers": "content-type, content-length, git-protocol",
  "access-control-max-age": "86400",
};

async function proxy(request) {
  const url = new URL(request.url);
  const rest = url.pathname.replace(/^\/api\/git-proxy\//, "");
  const host = rest.split("/")[0].toLowerCase();
  const path = rest.slice(host.length);
  if (!HOSTS.has(host) || !GIT_PATH.test(path) || path.includes("..")) {
    return new Response("JaniX git proxy: only Git requests to GitHub, GitLab, Bitbucket and Codeberg are allowed.", { status: 403, headers: CORS });
  }
  const service = url.searchParams.get("service");
  if (path.endsWith("/info/refs") && service !== "git-upload-pack" && service !== "git-receive-pack") {
    return new Response("Bad request", { status: 400, headers: CORS });
  }
  const headers = { "user-agent": "git/isomorphic-git (JaniX)" };
  for (const name of FORWARD) { const v = request.headers.get(name); if (v) headers[name] = v; }
  const upstream = await fetch(`https://${host}${path}${url.search}`, {
    method: request.method, headers, redirect: "follow",
    body: request.method === "POST" ? await request.arrayBuffer() : undefined,
  });
  const out = new Headers(CORS);
  for (const name of ["content-type", "cache-control", "www-authenticate"]) { const v = upstream.headers.get(name); if (v) out.set(name, v); }
  return new Response(upstream.body, { status: upstream.status, headers: out });
}

export function OPTIONS() { return new Response(null, { status: 204, headers: CORS }); }
export const GET = proxy;
export const POST = proxy;
