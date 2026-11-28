// AI Awaaz (and AI provider) relay for Documentary Studio: a free Cloudflare Worker.
// Your server (e.g. MilesWeb) can't reach app.aiawaaz.io directly, so it sends its voice requests here,
// and this passes them on to AI Awaaz and sends the answer back. Nothing is stored.
//
// Set up (once, about 5 minutes):
//  1. dash.cloudflare.com → Workers & Pages → Create → Start with Hello World → name it e.g. "aiawaaz-relay" → Deploy.
//  2. Edit code → delete everything → paste this whole file → Deploy.
//  3. The worker's Settings → Variables and Secrets → Add → type "Secret", name RELAY_KEY,
//     value: the relay key shown in Documentary Studio (Settings → Narration voice → AI Awaaz) → Deploy.
//  4. Copy the worker address (https://aiawaaz-relay.<you>.workers.dev) into Documentary Studio → Relay address → Save.

const MCP_URL = 'https://app.aiawaaz.io/api/mcp';
// Other services it may forward to (AI providers, ElevenLabs, Wikimedia), only with the relay key
const ALLOWED = /^(api\.anthropic\.com|api\.openai\.com|generativelanguage\.googleapis\.com|openrouter\.ai|api\.deepseek\.com|api\.groq\.com|api\.mistral\.ai|api\.x\.ai|gen\.pollinations\.ai|text\.pollinations\.ai|api\.elevenlabs\.io|commons\.wikimedia\.org|upload\.wikimedia\.org)$/;
// Audio files may be served from AI Awaaz or its storage; only https downloads are relayed, and only with the key.

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/health' || url.pathname === '/') return Response.json({
      ok: true, relay: 'aiawaaz', version: 2, key_set: !!env.RELAY_KEY,
      note: env.RELAY_KEY ? 'The relay is running. Only Documentary Studio (with the relay key) can use it, so opening it in a browser shows nothing else.' : 'Add a Secret named RELAY_KEY in this worker\'s Settings → Variables and Secrets.',
    });

    // Only your app may use this relay
    if (!env.RELAY_KEY) return Response.json({ error: 'RELAY_KEY secret is not set on this worker' }, { status: 500 });
    if (!safeEqual(request.headers.get('x-relay-key') || '', env.RELAY_KEY)) return Response.json({ error: 'Wrong relay key' }, { status: 401 });

    let target;
    if (url.pathname === '/proxy') {
      // AI providers and other services the app uses, for servers whose firewall blocks them
      target = url.searchParams.get('u') || '';
      let host = ''; try { host = new URL(target).host; } catch (_) { /* bad url */ }
      if (!/^https:\/\//i.test(target) || !ALLOWED.test(host)) return Response.json({ error: `Not allowed through this relay: ${host || target}` }, { status: 403 });
    } else if (url.pathname === '/mcp') target = MCP_URL;
    else if (url.pathname === '/file') {
      target = url.searchParams.get('u') || '';
      if (!/^https:\/\//i.test(target)) return Response.json({ error: 'Only https file links are relayed' }, { status: 400 });
      if (request.method !== 'GET') return Response.json({ error: 'Files are GET only' }, { status: 405 });
    } else return Response.json({ error: 'Not found' }, { status: 404 });

    const headers = new Headers(request.headers);
    for (const h of ['x-relay-key', 'host', 'cf-connecting-ip', 'x-forwarded-for', 'x-real-ip']) headers.delete(h);
    const init = { method: request.method, headers, redirect: 'follow' };
    if (!['GET', 'HEAD'].includes(request.method)) init.body = await request.arrayBuffer();
    try {
      const r = await fetch(target, init);
      // stream the answer straight back (keeps MCP session headers and text/event-stream)
      return new Response(r.body, { status: r.status, headers: r.headers });
    } catch (e) {
      return Response.json({ error: `Relay could not reach ${new URL(target).host}: ${e.message}` }, { status: 502 });
    }
  },
};

function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
