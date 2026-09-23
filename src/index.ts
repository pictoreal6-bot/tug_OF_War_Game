export interface Env {
  KV: KVNamespace;
  ASSETS: Fetcher;
}

type StoredRecord = {
  data: unknown;
  ownerToken?: string;
  createdAt: string;
  updatedAt: string;
};

const CODE_LENGTH = 6;
const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function makeCode(): string {
  const bytes = new Uint8Array(CODE_LENGTH);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => CODE_CHARS[b % CODE_CHARS.length]).join("");
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

async function createRecord(env: Env, type: "g" | "t", data: any) {
  let code = "";
  for (let attempt = 0; attempt < 10; attempt++) {
    const candidate = makeCode();
    const exists = await env.KV.get(`${type}:${candidate}`);
    if (!exists) {
      code = candidate;
      break;
    }
  }
  if (!code) return json({ error: "Could not create a unique short code." }, 503);

  const now = new Date().toISOString();
  const record: StoredRecord = {
    data: data?.data ?? data,
    ownerToken: typeof data?.ownerToken === "string" ? data.ownerToken : undefined,
    createdAt: now,
    updatedAt: now,
  };

  await env.KV.put(`${type}:${code}`, JSON.stringify(record));
  return json({ code, url: `/${type}/${code}` }, 201);
}

async function getRecord(env: Env, type: "g" | "t", code: string) {
  const raw = await env.KV.get(`${type}:${code.toUpperCase()}`);
  if (!raw) return json({ error: "Link not found or expired." }, 404);
  try {
    const record = JSON.parse(raw) as StoredRecord;
    return json({ ...record, code: code.toUpperCase() });
  } catch {
    return json({ error: "Stored record is invalid." }, 500);
  }
}

async function updateRecord(request: Request, env: Env, type: "g" | "t", code: string) {
  const key = `${type}:${code.toUpperCase()}`;
  const raw = await env.KV.get(key);
  if (!raw) return json({ error: "Link not found or expired." }, 404);

  let existing: StoredRecord;
  try {
    existing = JSON.parse(raw) as StoredRecord;
  } catch {
    return json({ error: "Stored record is invalid." }, 500);
  }

  const body: any = await request.json().catch(() => null);
  const token = request.headers.get("x-owner-token") || body?.ownerToken;
  if (!existing.ownerToken || token !== existing.ownerToken) {
    return json({ error: "Creator permission required." }, 403);
  }

  const now = new Date().toISOString();
  const updated: StoredRecord = {
    ...existing,
    data: body?.data ?? body,
    updatedAt: now,
  };
  await env.KV.put(key, JSON.stringify(updated));
  return json({ ok: true, code: code.toUpperCase() });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const method = request.method.toUpperCase();

    if (path === "/api/health" && method === "GET") {
      return json({ ok: true, service: "tug-of-war-game" });
    }

    const createMatch = path.match(/^\/api\/(games|tournaments)$/);
    if (createMatch && method === "POST") {
      const body = await request.json().catch(() => null);
      if (!body) return json({ error: "Request body must be valid JSON." }, 400);
      return createRecord(env, createMatch[1] === "games" ? "g" : "t", body);
    }

    const recordMatch = path.match(/^\/api\/(games|tournaments)\/([A-Za-z0-9_-]+)$/);
    if (recordMatch) {
      const type = recordMatch[1] === "games" ? "g" : "t";
      const code = recordMatch[2];
      if (method === "GET") return getRecord(env, type, code);
      if (method === "PUT" || method === "PATCH") return updateRecord(request, env, type, code);
    }

    const shortLinkMatch = path.match(/^\/(g|t)\/([A-Za-z0-9_-]+)$/);
    if (shortLinkMatch && method === "GET") {
      const type = shortLinkMatch[1] === "g" ? "g" : "t";
      const code = shortLinkMatch[2].toUpperCase();
      const raw = await env.KV.get(type + ":" + code);
      if (!raw) return new Response("Link not found or expired.", { status: 404 });
      let record: StoredRecord;
      try {
        record = JSON.parse(raw) as StoredRecord;
      } catch {
        return new Response("Stored record is invalid.", { status: 500 });
      }

      const data: any = record.data || {};
      const title = type === "g"
        ? String(data.title || "History Tug of War Quiz")
        : String(data.name || "History Tug of War Tournament");
      const description = type === "g"
        ? String(data.teamA || "Team A") + " vs " + String(data.teamB || "Team B") + " • Interactive Tug of War quiz"
        : String(data.name || "Interactive Tug of War tournament");

      const response = await env.ASSETS.fetch(
        new Request(new URL("/index.html", url), request)
      );

      return new HTMLRewriter()
        .on("title", {
          text(text) {
            if (text.lastInTextNode) text.replace(title);
            else text.replace(title);
          },
        })
        .on('meta[property="og:title"]', {
          element(el) { el.setAttribute("content", title); },
        })
        .on('meta[name="twitter:title"]', {
          element(el) { el.setAttribute("content", title); },
        })
        .on('meta[property="og:description"]', {
          element(el) { el.setAttribute("content", description); },
        })
        .on('meta[name="twitter:description"]', {
          element(el) { el.setAttribute("content", description); },
        })
        .on('meta[name="description"]', {
          element(el) { el.setAttribute("content", description); },
        })
        .transform(response);
    }

    return env.ASSETS.fetch(request);
  },
};
