async function timingSafeEqual(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const aBytes = enc.encode(a);
  const bBytes = enc.encode(b);
  // Hash both first so comparison length never leaks the real secret's length.
  const [aHash, bHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", aBytes),
    crypto.subtle.digest("SHA-256", bBytes),
  ]);
  // Constant-time over the two fixed-length digests. Written out rather than
  // crypto.subtle.timingSafeEqual, which is a Cloudflare Workers extension that Node (the AWS
  // deployment, issue #28) does not have.
  const x = new Uint8Array(aHash);
  const y = new Uint8Array(bHash);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i]! ^ y[i]!;
  return diff === 0;
}

export async function requireBasicAuth(req: Request, user: string, password: string): Promise<Response | null> {
  // Unset secrets would otherwise compare as "" and admit `Basic Og==` (#32): refuse instead.
  if (!user || !password) return new Response("not configured", { status: 503 });
  const header = req.headers.get("Authorization");
  if (header?.startsWith("Basic ")) {
    const decoded = atob(header.slice(6));
    const sep = decoded.indexOf(":");
    const gotUser = decoded.slice(0, sep);
    const gotPass = decoded.slice(sep + 1);
    if ((await timingSafeEqual(gotUser, user)) && (await timingSafeEqual(gotPass, password))) {
      return null;
    }
  }
  return new Response("Authentication required", {
    status: 401,
    headers: { "WWW-Authenticate": 'Basic realm="runner-fleet-dashboard"' },
  });
}

export async function requireBearer(req: Request, token: string): Promise<Response | null> {
  if (!token) return new Response("not configured", { status: 503 });
  const header = req.headers.get("Authorization");
  const got = header?.startsWith("Bearer ") ? header.slice(7) : "";
  if (got && (await timingSafeEqual(got, token))) return null;
  return new Response("Unauthorized", { status: 401 });
}
