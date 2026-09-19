// Vercel Serverless: POST /api/bypass { url }  or  GET /api/bypass?url=...
// Handles GPLinks-engine shortlinks (gplinks, just2earn clones, rocklinks, droplink):
// GET page -> parse <input> fields -> wait -> POST {origin}/links/go -> { url }
// Falls back to generic redirect / meta-refresh / JS-redirect resolving.

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
  const res = await fetch(url, {
    ...options,
    headers,
    redirect: "manual",
  });
  jar.push(...getCookies(res));
  return res;
}

async function gplinksEngineBypass(startUrl) {
  const jar = [];
  const u0 = new URL(startUrl);

  // Step 1: initial GET (manual redirect to capture vid flow)
  let res = await fetchWithCookies(startUrl, jar);
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
    } else break;
  }

  let html = await res.text();
  currentUrl = res.url || currentUrl;

  // New GPLinks "subscription gate" has a "Continue with ads" skip link
  // e.g. <a href="/x6jlK?skip_sub=1" class="gate-btn-skip"> — follow it,
  // it 302s to the ad-flow / destination. Then continue with that page.
  const skipMatch = html.match(/href="([^"]*skip_sub=1[^"]*)"/i);
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
      return skipRes.headers.get("location");
    }
    html = await skipRes.text();
    currentUrl = skipRes.url || currentUrl;
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
    return null;
  }

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
    if (json.url) return json.url;
    if (json.message && json.message.startsWith("http")) return json.message;
    throw new Error(json.message || text.slice(0, 200));
  } catch (e) {
    // if server says "wait" / token error, surface it
    throw new Error(`links/go failed: ${text.slice(0, 300)}`);
  }
}

async function genericResolve(startUrl) {
  // Simple redirect + meta/JS redirect follower (for non-GPLinks links)
  let url = startUrl;
  for (let i = 0; i < 10; i++) {
    const res = await fetch(url, {
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
  if (!url || typeof url !== "string" || !/^https?:\/\//i.test(url)) {
    return res.status(400).json({ error: "Provide a valid http(s) url" });
  }

  try {
    // Try GPLinks-engine first, fall back to generic resolving
    let dest = null;
    try {
      dest = await gplinksEngineBypass(url);
    } catch (e) {
      // Paywall / challenge / links/go failures are definitive — surface them
      if (e.code === "PAYWALL" || (e.message && e.message.includes("links/go failed"))) throw e;
    }
    if (!dest) dest = await genericResolve(url);
    if (!dest || dest === url) {
      return res.status(422).json({
        error: "No bypassable destination found — page has no redirect or token form (this gplinks link shows a Premium paywall gate).",
        original: url,
        bypassed: dest || url,
      });
    }
    return res.status(200).json({ original: url, bypassed: dest });
  } catch (err) {
    return res
      .status(500)
      .json({ error: err.message || "Bypass failed", original: url });
  }
};
