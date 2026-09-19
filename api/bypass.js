// Vercel Serverless: POST /api/bypass { url }  or  GET /api/bypass?url=...
// Handles GPLinks-engine shortlinks (gplinks, just2earn clones, rocklinks, droplink):
// GET page -> parse <input> fields -> wait -> POST {origin}/links/go -> { url }
// Falls back to generic redirect / meta-refresh / JS-redirect resolving.

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Optional residential proxy (e.g. HTTP_PROXY=http://user:pass@host:port).
// Set in Render Dashboard → Environment (never commit the key).
// When unset, requests go direct. The proxy URL is never logged.
let _dispatcher;
function getDispatcher() {
  if (_dispatcher !== undefined) return _dispatcher;
  const proxyUrl =
    process.env.HTTP_PROXY ||
    process.env.HTTPS_PROXY ||
    process.env.http_proxy ||
    process.env.https_proxy;
  if (!proxyUrl) {
    _dispatcher = null;
    return _dispatcher;
  }
  try {
    const { ProxyAgent } = require("undici");
    _dispatcher = new ProxyAgent(proxyUrl);
  } catch {
    _dispatcher = null;
  }
  return _dispatcher;
}

// Proxy-aware fetch: global fetch when direct; the matching undici fetch
// when a proxy dispatcher is set (global fetch rejects foreign dispatchers
// and undici ProxyAgent also speaks SOCKS5 experimentally).
function httpFetch(url, opts) {
  const d = getDispatcher();
  if (!d) return fetch(url, opts);
  const { fetch: uFetch } = require("undici");
  return uFetch(url, { ...opts, dispatcher: d });
}

function getCookies(res) {
  // undici: res.headers.getSetCookie() (Node 18+)
  if (typeof res.headers.getSetCookie === "function") {
    return res.headers.getSetCookie();
  }
  const raw = res.headers.get("set-cookie");
  return raw ? [raw] : [];
}

function jarToHeader(jar) {
  return jar.map((c) => c.split(";")[0].trim()).filter(Boolean).join("; ");
}

function parseInputs(html) {
  // Prefer #go-link scope, else whole page
  const scopeMatch = html.match(
    /<form[^>]*id=["']go-link["'][\s\S]*?<\/form>/i
  );
  const scope = scopeMatch ? scopeMatch[0] : html;
  const data = {};
  const re = /<input[^>]*name=["']([^"']+)["'][^>]*value=["']([^"']*)["'][^>]*>/gi;
  let m;
  while ((m = re.exec(scope))) data[m[1]] = m[2];
  // also catch value-before-name order
  const re2 = /<input[^>]*value=["']([^"']*)["'][^>]*name=["']([^"']+)["'][^>]*>/gi;
  while ((m = re2.exec(scope))) data[m[2]] = m[1];
  return data;
}

function findMetaRefresh(html, base) {
  const m = html.match(
    /<meta[^>]*http-equiv=["']refresh["'][^>]*content=["'][^"']*url=(.*?)["']/i
  );
  if (!m) return null;
  try {
    return new URL(m[1].trim().replace(/['"]/g, ""), base).toString();
  } catch {
    return null;
  }
}

function findJsRedirect(html, base) {
  const patterns = [
    /window\.location(?:\.href)?\s*=\s*["']([^"']+)["']/i,
    /location\.replace\(\s*["']([^"']+)["']\s*\)/i,
    /top\.location\.href\s*=\s*["']([^"']+)["']/i,
  ];
  for (const p of patterns) {
    const m = html.match(p);
    if (m) {
      try {
        const u = new URL(m[1], base).toString();
        if (u.startsWith("http")) return u;
      } catch {}
    }
  }
  return null;
}

function detectPaywall(html) {
  const h = html.toLowerCase();
  if (
    h.includes("gate-container") &&
    (h.includes("subscription/initiate") || h.includes("gplinks premium"))
  ) {
    return "This link requires GPlinks Premium subscription (paywall gate) — it cannot be bypassed server-side. Open it in browser instead.";
  }
  if (h.includes("turnstile") && h.includes("verify you are human")) {
    return "This link is behind a Cloudflare/human-verification challenge — automated bypass blocked.";
  }
  return null;
}

async function fetchWithCookies(url, jar, options = {}) {
  const headers = {
    "User-Agent": UA,
    Accept:
      "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    ...(options.headers || {}),
  };
  const cookie = jarToHeader(jar);
  if (cookie) headers["Cookie"] = cookie;
  const res = await httpFetch(url, {
    ...options,
    headers,
    redirect: "manual",
  });
  jar.push(...getCookies(res));
  return res;
}

async function gplinksEngineBypass(startUrl, dbg = {}) {
  const jar = [];
  const u0 = new URL(startUrl);
  dbg.trace = dbg.trace || [];
  const step = (s) => dbg.trace.push(s);

  // Step 1: initial GET (manual redirect to capture vid flow)
  let res = await fetchWithCookies(startUrl, jar);
  dbg.initialStatus = res.status;
  step(`GET ${u0.host} → HTTP ${res.status}`);
  if ([403, 503].includes(res.status)) {
    const err = new Error(
      `Upstream blocked this server's IP (HTTP ${res.status} from ${u0.host}). Datacenter IPs get a Cloudflare challenge — open the link in your browser with the userscript instead.`
    );
    err.code = "UPSTREAM_BLOCKED";
    throw err;
  }
  // follow up to 5 manual redirects, preserving cookies
  let currentUrl = startUrl;
  for (let i = 0; i < 5; i++) {
    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const loc = res.headers.get("location");
      if (!loc) break;
      currentUrl = new URL(loc, currentUrl).toString();
      res = await fetchWithCookies(currentUrl, jar, {
        headers: { Referer: startUrl },
      });
      step(`redirect → ${currentUrl} (HTTP ${res.status})`);
    } else break;
  }

  let html = await res.text();
  currentUrl = res.url || currentUrl;
  dbg.afterRedirects = currentUrl;
  dbg.htmlLen = html.length;
  dbg.proxy = !!getDispatcher();
  // First 400 chars so we can identify block/challenge variants remotely.
  dbg.htmlHead = html.slice(0, 400).replace(/\s+/g, " ");

  // New GPLinks "subscription gate" has a "Continue with ads" skip link
  // e.g. <a href="/x6jlK?skip_sub=1" class="gate-btn-skip"> — follow it,
  // it 302s to the ad-flow / destination. Then continue with that page.
  const skipMatch = html.match(/href="([^"]*skip_sub=1[^"]*)"/i);
  dbg.hasSkipLink = !!skipMatch;
  dbg.hasGate = /gate-container/i.test(html);
  dbg.hasCloudflare = /challenge-platform|cf-challenge|just a moment/i.test(html);
  step(
    `page: ${currentUrl} (${html.length} bytes, gate=${dbg.hasGate}, skipLink=${dbg.hasSkipLink}, cf=${dbg.hasCloudflare})`
  );
  if (skipMatch) step(`following skip link → ${skipMatch[1]}`);
  if (skipMatch) {
    const skipUrl = new URL(skipMatch[1], currentUrl).toString();
    let skipRes = await fetchWithCookies(skipUrl, jar, {
      headers: { Referer: currentUrl },
    });
    // follow redirects from skip link, preserving cookies
    for (let i = 0; i < 5; i++) {
      if ([301, 302, 303, 307, 308].includes(skipRes.status)) {
        const loc = skipRes.headers.get("location");
        if (!loc) break;
        currentUrl = new URL(loc, currentUrl).toString();
        skipRes = await fetchWithCookies(currentUrl, jar, {
          headers: { Referer: skipUrl },
        });
      } else break;
    }
    if ([301, 302, 303, 307, 308].includes(skipRes.status)) {
      // still redirecting (non-HTML destination) — that's the answer
      step(`skip target redirects → ${skipRes.headers.get("location")} (final answer)`);
      return skipRes.headers.get("location");
    }
    html = await skipRes.text();
    currentUrl = skipRes.url || currentUrl;
    step(`skip landed: ${currentUrl} (${html.length} bytes)`);
  }

  const paywall = detectPaywall(html);
  if (paywall) {
    const err = new Error(paywall);
    err.code = "PAYWALL";
    throw err;
  }

  const data = parseInputs(html);
  // Only GPLinks-engine pages have the #go-link form + /links/go endpoint.
  // (WordPress landing pages also contain <input>s — ignore those.)
  const hasEngine =
    /id=["']go-link["']/i.test(html) || /links\/go/i.test(html);
  if (!hasEngine || !data || Object.keys(data).length === 0) {
    // If we already followed a skip link to a different page, that page
    // IS the destination (e.g. skip_sub=1 → 302 to advertiser site).
    if (skipMatch && currentUrl !== startUrl) return currentUrl;
    dbg.hasEngine = false;
    dbg.finalUrl = currentUrl;
    step("no token form / redirect found — stuck here");
    return null;
  }
  dbg.hasEngine = true;
  step(`token form found, POST ${goUrl} after wait`);
  dbg.hasEngine = true;

  const origin = new URL(currentUrl).origin || `${u0.protocol}//${u0.host}`;
  const goUrl = `${origin}/links/go`;

  // Required wait (server enforces ~10s; Vercel hobby times out at 10s so use 8s)
  const waitMs = parseInt(process.env.BYPASS_WAIT_MS || "8000", 10);
  await sleep(waitMs);

  const body = new URLSearchParams(data).toString();
  const postRes = await fetchWithCookies(goUrl, jar, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "X-Requested-With": "XMLHttpRequest",
      Referer: currentUrl,
      Origin: origin,
    },
    body,
  });
  const text = await postRes.text();
  try {
    const json = JSON.parse(text);
    if (json.url) {
      step(`links/go → ${json.url}`);
      return json.url;
    }
    if (json.message && json.message.startsWith("http")) {
      step(`links/go → ${json.message}`);
      return json.message;
    }
    throw new Error(json.message || text.slice(0, 200));
  } catch (e) {
    // if server says "wait" / token error / captcha, surface it
    step(`links/go failed: ${(e.message || text).slice(0, 160)}`);
    throw new Error(`links/go failed: ${text.slice(0, 300)}`);
  }
}

async function deepBypass(startUrl, dbg = {}) {
  // Full server-side chain: gate → skip → waits + ad steps → countdown page.
  // Ends at captcha-required (Turnstile is human-only) or done. Needs a
  // persistent host (Render) — far beyond serverless timeouts.
  const jar = [];
  dbg.trace = dbg.trace || [];
  const step = (s) => dbg.trace.push(s);
  const cookies = () => {
    const m = {};
    for (const c of jar) {
      const pair = c.split(";")[0];
      const i = pair.indexOf("=");
      if (i > 0) m[pair.slice(0, i).trim()] = pair.slice(i + 1);
    }
    return m;
  };

  step("deep mode: gate → skip → waits + ad steps → countdown (≈2 min)");
  const u0 = new URL(startUrl);
  let res = await fetchWithCookies(startUrl, jar);
  if ([403, 503].includes(res.status)) {
    const err = new Error(
      `Upstream blocked this server's IP (HTTP ${res.status} from ${u0.host}). Use the browser userscript instead.`
    );
    err.code = "UPSTREAM_BLOCKED";
    throw err;
  }
  let currentUrl = startUrl;
  for (
    let i = 0;
    i < 5 && [301, 302, 303, 307, 308].includes(res.status);
    i++
  ) {
    const loc = res.headers.get("location");
    if (!loc) break;
    currentUrl = new URL(loc, currentUrl).toString();
    res = await fetchWithCookies(currentUrl, jar, {
      headers: { Referer: startUrl },
    });
  }
  let html = await res.text();
  currentUrl = res.url || currentUrl;
  step(`gate: ${currentUrl} (${html.length} bytes)`);

  const skipMatch = html.match(/href="([^"]*skip_sub=1[^"]*)"/i);
  if (skipMatch) {
    const skipUrl = new URL(skipMatch[1], currentUrl).toString();
    step(`skip → ${skipUrl}`);
    let skipRes = await fetchWithCookies(skipUrl, jar, {
      headers: { Referer: currentUrl },
    });
    for (
      let i = 0;
      i < 5 && [301, 302, 303, 307, 308].includes(skipRes.status);
      i++
    ) {
      const loc = skipRes.headers.get("location");
      if (!loc) break;
      currentUrl = new URL(loc, currentUrl).toString();
      skipRes = await fetchWithCookies(currentUrl, jar, {
        headers: { Referer: skipUrl },
      });
    }
    if ([301, 302, 303, 307, 308].includes(skipRes.status)) {
      const loc = skipRes.headers.get("location");
      step(`skip redirects onward → ${loc} (taking it)`);
      return { dest: loc, status: "done" };
    }
    html = await skipRes.text();
    currentUrl = skipRes.url || currentUrl;
  }
  step(`ad page: ${currentUrl} (${html.length} bytes)`);

  const cm = cookies();
  if (!cm.lid || !cm.pid || !cm.vid || !cm.pages) {
    throw new Error(
      `no tracking cookies issued (got: ${Object.keys(cm).join(",") || "none"}) — steps impossible`
    );
  }
  const pages = Math.min(parseInt(cm.pages, 10) || 0, 5);
  if (!pages) throw new Error("pages cookie invalid");
  const waitMs = pages * 30000 + 5000;
  step(
    `cookies: lid=${cm.lid} pages=${pages} — waiting ${Math.round(waitMs / 1000)}s (server-enforced)...`
  );
  await sleep(waitMs);

  const stepBase = currentUrl;
  for (let i = 1; i <= pages; i++) {
    const body = new URLSearchParams({
      form_name: "ads-track-data",
      step_id: String(i),
      ad_impressions: "2",
      visitor_id: cm.vid,
      next_target: "",
    }).toString();
    const rp = await fetchWithCookies(stepBase, jar, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Referer: stepBase,
      },
      body,
    });
    await rp.text();
    await sleep(1200);
    step(`step ${i}/${pages} posted (HTTP ${rp.status})`);
  }

  const finalUrl = `https://gplinks.co/${cm.lid}?pid=${cm.pid}&vid=${cm.vid}`;
  step(`opening countdown page…`);
  const rf = await fetchWithCookies(finalUrl, jar, {
    headers: { Referer: stepBase },
  });
  if ([301, 302, 303, 307, 308].includes(rf.status)) {
    const loc = rf.headers.get("location");
    step(`countdown redirects → ${loc}`);
    if (/link-error|not_enough_steps/i.test(loc))
      throw new Error("rejected: not_enough_steps — waits/steps not accepted");
    return { dest: new URL(loc, finalUrl).toString(), status: "done" };
  }
  const hf = await rf.text();
  const hasGo = /id=["']go-link["']/i.test(hf);
  const hasTs = /cf-turnstile/i.test(hf);
  step(
    `countdown page HTTP ${rf.status} (${hf.length} bytes, go-link=${hasGo}, turnstile=${hasTs})`
  );
  if (hasGo)
    return { dest: finalUrl, status: "captcha-required" };
  throw new Error("unexpected countdown page — no token form");
}

async function genericResolve(startUrl) {
  // Simple redirect + meta/JS redirect follower (for non-GPLinks links)
  let url = startUrl;
  for (let i = 0; i < 10; i++) {
    const res = await httpFetch(url, {
      headers: { "User-Agent": UA },
      redirect: "manual",
    });
    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const loc = res.headers.get("location");
      if (!loc) break;
      url = new URL(loc, url).toString();
      continue;
    }
    const ct = res.headers.get("content-type") || "";
    if (!ct.includes("html")) return url;
    const html = await res.text();
    const paywall = detectPaywall(html);
    if (paywall) {
      const err = new Error(paywall);
      err.code = "PAYWALL";
      throw err;
    }
    const meta = findMetaRefresh(html, url);
    if (meta && meta !== url) {
      url = meta;
      continue;
    }
    const js = findJsRedirect(html, url);
    if (js && js !== url && !js.includes("/links/go")) {
      url = js;
      continue;
    }
    return url;
  }
  return url;
}

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  const url = req.method === "POST" ? req.body?.url : req.query.url;
  const full =
    req.method === "POST"
      ? !!req.body?.full
      : /^(1|true)$/i.test(req.query.full || "");
  if (!url || typeof url !== "string" || !/^https?:\/\//i.test(url)) {
    return res.status(400).json({ error: "Provide a valid http(s) url" });
  }

  const dbg = {};
  try {
    // Deep mode: full chain with waits + ad steps (Render only, ~2 min).
    if (full) {
      const r = await deepBypass(url, dbg);
      if (r.status === "done")
        return res
          .status(200)
          .json({ original: url, bypassed: r.dest, mode: "deep", trace: dbg.trace });
      return res.status(200).json({
        original: url,
        status: "captcha-required",
        countdownUrl: r.dest,
        mode: "deep",
        trace: dbg.trace,
        note: "Countdown page reached. Its Turnstile must be solved in a browser tab (userscript v12+ clicks Get Link right after).",
      });
    }
    // Try GPLinks-engine first, fall back to generic resolving
    let dest = null;
    try {
      dest = await gplinksEngineBypass(url, dbg);
    } catch (e) {
      // Paywall / challenge / links/go failures are definitive — surface them
      if (e.code === "PAYWALL" || e.code === "UPSTREAM_BLOCKED" || (e.message && e.message.includes("links/go failed"))) throw e;
    }
    if (!dest) dest = await genericResolve(url);
    if (!dest || dest === url) {
      return res.status(422).json({
        error: "No bypassable destination found — page has no redirect or token form (this gplinks link shows a Premium paywall gate).",
        original: url,
        bypassed: dest || url,
        debug: dbg,
        trace: dbg.trace,
      });
    }
    return res.status(200).json({ original: url, bypassed: dest, trace: dbg.trace });
  } catch (err) {
    return res.status(500).json({
      error: err.message || "Bypass failed",
      original: url,
      trace: dbg.trace,
    });
  }
};
