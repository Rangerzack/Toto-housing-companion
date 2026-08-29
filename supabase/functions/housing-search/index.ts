// ---------------------------------------------------------------------------
// housing-search — server-side proxy for the rental listings API
// ---------------------------------------------------------------------------
// The screener's rental-search path (web/housing.js) needs listings from a
// housing data API whose key must not ship to the browser: web/config.js is
// public, so anything in it is public. This function keeps the key here on
// the server. The frontend calls this function with the public anon key, and
// this function calls the real API with the private one.
//
// Configuration lives in function secrets (Dashboard -> Edge Functions ->
// Secrets, or `supabase secrets set`), never in the repo:
//
//   HOUSING_API_URL         The upstream endpoint. `{state}` and `{county}`
//                           placeholders are filled from the request, e.g.
//                           https://api.example.org/listings?state={state}&county={county}
//   HOUSING_API_KEY         The private API key.
//   HOUSING_API_KEY_HEADER  Header to carry the key (default X-Api-Key).
//                           Set to "Authorization" for APIs expecting
//                           "Bearer <key>" — the prefix is added here.
//
// The upstream response body passes through untouched: web/housing.js
// already unwraps envelopes and maps field names, so this function has no
// opinions about the API's shape.

// The screener is a public site, so the proxy is callable from any origin —
// exactly as public as the listings themselves. The key stays private; rate
// limiting, if the API's quota ever needs guarding, belongs here too.
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
};

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') {
    return new Response('ok', { headers: CORS_HEADERS });
  }
  if (request.method !== 'GET') {
    return json({ error: 'Only GET is supported' }, 405);
  }

  const upstreamUrl = Deno.env.get('HOUSING_API_URL');
  const apiKey = Deno.env.get('HOUSING_API_KEY');
  if (!upstreamUrl) {
    // Surfaced verbatim in the screener's error notice, so say what to do.
    return json(
      {
        error:
          'Housing search is not configured yet — set the HOUSING_API_URL ' +
          'and HOUSING_API_KEY secrets on the housing-search function in Supabase.',
      },
      503,
    );
  }

  const { searchParams } = new URL(request.url);
  const target = upstreamUrl
    .replace('{state}', encodeURIComponent(searchParams.get('state') ?? ''))
    .replace('{county}', encodeURIComponent(searchParams.get('county') ?? ''));

  const headers: Record<string, string> = {};
  if (apiKey) {
    const headerName = Deno.env.get('HOUSING_API_KEY_HEADER') ?? 'X-Api-Key';
    headers[headerName] =
      headerName.toLowerCase() === 'authorization' ? `Bearer ${apiKey}` : apiKey;
  }

  let upstream: Response;
  try {
    upstream = await fetch(target, { headers });
  } catch (error) {
    return json(
      { error: `Could not reach the housing API: ${(error as Error).message}` },
      502,
    );
  }

  let body = await upstream.text();

  // A page-capped API (Range Lab caps JSON at 100 rows) would silently drop
  // everything past the first page while the frontend narrows client-side —
  // "no rentals found" with rentals sitting on page two. When the response
  // carries the {data, meta.total} pagination shape, follow it, up to a cap
  // that stays well inside the per-minute quota. Anything else passes
  // through untouched.
  if (upstream.ok) {
    try {
      const parsed = JSON.parse(body);
      if (
        parsed &&
        Array.isArray(parsed.data) &&
        typeof parsed?.meta?.total === 'number' &&
        parsed.data.length < parsed.meta.total
      ) {
        const MAX_ROWS = 500;
        const MAX_EXTRA_PAGES = 5;
        const sep = target.includes('?') ? '&' : '?';
        let offset = (parsed.meta.offset ?? 0) + parsed.data.length;
        for (let page = 0; page < MAX_EXTRA_PAGES; page++) {
          if (parsed.data.length >= Math.min(parsed.meta.total, MAX_ROWS)) break;
          const next = await fetch(`${target}${sep}offset=${offset}`, { headers });
          if (!next.ok) break;
          const nextPage = await next.json();
          if (!Array.isArray(nextPage?.data) || nextPage.data.length === 0) break;
          parsed.data.push(...nextPage.data);
          offset += nextPage.data.length;
        }
        body = JSON.stringify(parsed);
      }
    } catch {
      /* not JSON or an unexpected shape — pass through as-is */
    }
  }

  // Listings change often but not by the minute; a short cache absorbs a
  // burst of screeners without hammering the upstream API's quota. Errors
  // must never be cached — that would defeat the UI's "Try again".
  const cache = upstream.ok ? { 'Cache-Control': 'public, max-age=300' } : {};
  return new Response(body, {
    status: upstream.status,
    headers: {
      ...CORS_HEADERS,
      'Content-Type': upstream.headers.get('Content-Type') ?? 'application/json',
      ...cache,
    },
  });
});
