/*
 * Offline web-app archiver
 * ------------------------
 * Run in the page's DevTools console (or any runner that provides a `completion(html)`
 * callback). If `completion` does not exist, the archive is downloaded as an .html file.
 *
 * Modes (override before running: `window.ARCHIVE_OPTIONS = { mode: "snapshot" }`)
 *   "app"      Re-fetches the page's original HTML, inlines every static asset and script,
 *              and embeds every resource the app requested at runtime (fetch/XHR/chunks/
 *              images/CSS) together with a small shim that serves them back offline.
 *              The archived page boots again like the real app.
 *   "snapshot" Freezes what is on screen right now (live DOM, form values, canvases,
 *              shadow DOM, CSS-in-JS rules, same-origin iframes) and removes scripts.
 *              Always renders offline, but is no longer interactive.
 *
 * Service workers (app mode, enabled by default):
 *   The worker script(s) the app registers are downloaded as separate files (e.g. sw.js)
 *   next to the archive, and the shim redirects `navigator.serviceWorker.register()` to
 *   them. Browsers only allow workers from a real same-origin URL, so host the .html and
 *   the worker file(s) together over https:// or http://localhost (not file://).
 *   If `completion` is used, the worker files are returned in `report.serviceWorkerFiles`.
 *
 * Known limits: ES-module graphs with relative imports (including module workers),
 * WebSockets, cross-origin resources without CORS headers, and SPA routes that rely on
 * the real origin/path (hash routing works best). Workers that precache absolute paths
 * of the original site will only cache what exists at the new location.
 */
(async () => {
  "use strict";

  /* ───────────────────────── configuration ───────────────────────── */
  const CONFIG = {
    mode: "app",                      // "app" | "snapshot"
    replayNetwork: true,              // app mode: embed runtime requests + replay shim
    allowServiceWorkers: true,        // app mode: let the archived page register service workers
    emitServiceWorkerFiles: true,     // app mode: save worker scripts as sidecar files
    concurrency: 10,                  // parallel downloads
    timeoutMs: 20000,
    retries: 1,
    maxResourceBytes: 15 * 1024 * 1024,
    maxTotalBytes: 200 * 1024 * 1024,
    maxFrameDepth: 3,
    preferWoff2: true,                // keep only the woff2 source in @font-face (saves size)
    ignore: [/google-analytics\.com|googletagmanager\.com|doubleclick\.net|facebook\.net|hotjar\.com|sentry\.io|segment\.(?:io|com)|clarity\.ms/i],
  };
  if (typeof ARCHIVE_OPTIONS !== "undefined") Object.assign(CONFIG, ARCHIVE_OPTIONS);

  let mode = CONFIG.mode;
  const report = { mode, resources: 0, bytes: 0, failed: {}, warnings: [], serviceWorkerFiles: {} };
  const fail = (url, err) => { report.failed[url] = String((err && err.message) || err); };
  const warn = (msg) => { if (!report.warnings.includes(msg)) report.warnings.push(msg); };

  /* ───────────────────────── small helpers ───────────────────────── */
  const SKIP = /^\s*(?:data:|blob:|javascript:|about:|mailto:|tel:|#)/i;
  const abs = (u, base) => { try { return new URL(String(u).trim(), base).href; } catch { return null; } };
  const docBase = (doc, fallback) => {
    const b = doc.querySelector("base[href]");
    return (b && abs(b.getAttribute("href"), fallback)) || fallback;
  };

  const MIME = {
    css: "text/css", js: "text/javascript", mjs: "text/javascript", json: "application/json",
    svg: "image/svg+xml", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
    webp: "image/webp", avif: "image/avif", ico: "image/x-icon", woff: "font/woff", woff2: "font/woff2",
    ttf: "font/ttf", otf: "font/otf", mp4: "video/mp4", webm: "video/webm", mp3: "audio/mpeg",
    wav: "audio/wav", ogg: "audio/ogg", wasm: "application/wasm", vtt: "text/vtt",
  };
  const guessType = (href, type) => {
    if (type && !/octet-stream|text\/plain/i.test(type)) return type;
    const ext = new URL(href).pathname.split(".").pop().toLowerCase();
    return MIME[ext] || type || "application/octet-stream";
  };

  const blobToDataUrl = (blob) => new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });

  /** Async String.replace: all callbacks run in parallel, output is rebuilt by index (no `$` pitfalls). */
  async function replaceAsync(str, re, fn) {
    const matches = [...str.matchAll(re)];
    if (!matches.length) return str;
    const parts = await Promise.all(matches.map(fn));
    let out = "", last = 0;
    matches.forEach((m, i) => { out += str.slice(last, m.index) + parts[i]; last = m.index + m[0].length; });
    return out + str.slice(last);
  }

  /* ───────────────────── network layer (deduped, limited) ───────────────────── */
  const limit = (() => {
    let active = 0;
    const queue = [];
    const pump = () => {
      while (active < CONFIG.concurrency && queue.length) {
        const { fn, resolve, reject } = queue.shift();
        active++;
        fn().then(resolve, reject).finally(() => { active--; pump(); });
      }
    };
    return (fn) => new Promise((resolve, reject) => { queue.push({ fn, resolve, reject }); pump(); });
  })();

  const blobCache = new Map();   // href -> Promise<Blob>
  const dataCache = new Map();   // href -> Promise<string>

  /** Only the network call itself holds a slot, so nested CSS/@import fetching cannot deadlock. */
  function fetchBlob(href) {
    if (!blobCache.has(href)) {
      blobCache.set(href, limit(async () => {
        let lastErr;
        for (let attempt = 0; attempt <= CONFIG.retries; attempt++) {
          const ctl = new AbortController();
          const timer = setTimeout(() => ctl.abort(), CONFIG.timeoutMs);
          try {
            const sameOrigin = new URL(href).origin === location.origin;
            const res = await fetch(href, {
              credentials: sameOrigin ? "include" : "omit",
              cache: "force-cache",
              signal: ctl.signal,
            });
            if (!res.ok) throw new Error("HTTP " + res.status);
            const raw = await res.blob();
            if (raw.size > CONFIG.maxResourceBytes) throw new Error("too large (" + raw.size + " bytes)");
            if (report.bytes + raw.size > CONFIG.maxTotalBytes) throw new Error("total size budget exceeded");
            report.bytes += raw.size;
            report.resources++;
            return new Blob([raw], { type: guessType(href, raw.type) });
          } catch (e) {
            lastErr = e;
            if (/^HTTP 4|too large|budget/.test(e.message)) break;   // retrying will not help
          } finally {
            clearTimeout(timer);
          }
        }
        throw lastErr;
      }));
    }
    return blobCache.get(href);
  }
  const fetchText = async (href) => (await fetchBlob(href)).text();
  const toDataUrl = (href) => {
    if (!dataCache.has(href)) dataCache.set(href, fetchBlob(href).then(blobToDataUrl));
    return dataCache.get(href);
  };

  /* ───────────────────────── service workers ───────────────────────── */
  const SW_REG_RE = /serviceWorker\s*\.\s*register\(\s*(?:"([^"]+)"|'([^']+)'|`([^`$]+)`)/g;
  const swCandidates = new Set();        // absolute worker script URLs found in scripts / registrations
  const swFiles = new Map();             // absolute worker URL -> { name, text }
  const swNames = new Set();

  /** Remember literal `serviceWorker.register("…")` targets found in script source. */
  function scanForWorkers(text, base) {
    if (!CONFIG.allowServiceWorkers || !text) return;
    for (const m of text.matchAll(SW_REG_RE)) {
      const u = abs(m[1] || m[2] || m[3], base);
      if (u) swCandidates.add(u);
    }
  }

  function workerFileName(u) {
    let base = (new URL(u).pathname.split("/").pop() || "sw.js").replace(/[^\w.\-]/g, "_");
    if (!/\.m?js$/i.test(base)) base += ".js";
    let name = base, i = 2;
    while (swNames.has(name)) name = base.replace(/(\.m?js)$/i, `-${i++}$1`);
    swNames.add(name);
    return name;
  }

  /** Download a worker script; same-origin importScripts("…") targets become sidecar files too. */
  async function bundleWorker(u, depth) {
    if (swFiles.has(u)) return swFiles.get(u).name;
    const entry = { name: workerFileName(u), text: "" };
    swFiles.set(u, entry);
    try {
      let text = (await fetchText(u)).replace(/\n?\/\/[#@]\s*sourceMappingURL=[^\n]*\s*$/, "");
      if (/^\s*import\s[^(]*from\s*["']\.{0,2}\//m.test(text)) warn(`Module worker with relative imports may not run: ${u}`);
      if (depth < 3) {
        text = await replaceAsync(text, /importScripts\s*\(([^)]*)\)/g, async (m) => {
          const args = await replaceAsync(m[1], /"([^"]+)"|'([^']+)'/g, async (a) => {
            const href = abs(a[1] || a[2], u);
            if (!href || new URL(href).origin !== location.origin) return a[0];   // CDN imports stay remote
            try { return JSON.stringify(await bundleWorker(href, depth + 1)); }
            catch (e) { fail(href, e); return a[0]; }
          });
          return `importScripts(${args})`;
        });
      }
      entry.text = text;
      return entry.name;
    } catch (e) {
      swFiles.delete(u); swNames.delete(entry.name);
      throw e;
    }
  }

  /** Returns { absoluteWorkerUrl: sidecarFileName } for every worker this page uses. */
  async function collectWorkers() {
    if (!CONFIG.allowServiceWorkers) return {};
    try {
      const regs = await navigator.serviceWorker.getRegistrations();
      for (const r of regs) {
        if (!location.href.startsWith(r.scope)) continue;          // only workers that control this page
        for (const w of [r.active, r.waiting, r.installing]) if (w && w.scriptURL) swCandidates.add(w.scriptURL);
      }
    } catch { /* service workers unavailable here */ }
    const map = {};
    for (const u of swCandidates) {
      try { if (new URL(u).origin !== location.origin) continue; } catch { continue; }   // workers must be same-origin
      try { map[u] = await bundleWorker(u, 0); } catch (e) { fail(u, e); }
    }
    for (const f of swFiles.values()) if (f.text) report.serviceWorkerFiles[f.name] = f.text;
    return map;
  }

  /* ───────────────────────────── CSS ───────────────────────────── */
  const IMPORT_RE = /@import\s+(?:url\(\s*)?(?:"([^"]+)"|'([^']+)'|([^)'"\s;]+))\s*\)?([^;]*);/gi;
  const URL_RE = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)'"]*?))\s*\)/gi;

  const sheetText = (sheet) => {
    try { return Array.from(sheet.cssRules, (r) => r.cssText).join("\n"); } catch { return null; }
  };

  function splitTopLevel(s) {
    const out = []; let depth = 0, quote = null, cur = "";
    for (const ch of s) {
      if (quote) { if (ch === quote) quote = null; }
      else if (ch === '"' || ch === "'") quote = ch;
      else if (ch === "(") depth++;
      else if (ch === ")") depth--;
      else if (ch === "," && depth === 0) { out.push(cur); cur = ""; continue; }
      cur += ch;
    }
    out.push(cur);
    return out;
  }

  /** Inside @font-face keep local() + the first woff2 source; every modern browser uses it. */
  function pruneFontSources(css) {
    return css.replace(/(@font-face\s*\{)([^}]*)(\})/gi, (all, open, body, close) =>
      open + body.replace(/(src\s*:\s*)([^;]+)(;?)/i, (m, prefix, list, end) => {
        if (/data:/i.test(list)) return m;
        const items = splitTopLevel(list);
        if (items.length < 2) return m;
        const woff2 = items.find((it) => /format\(\s*["']?woff2["']?\s*\)/i.test(it) || /\.woff2(?:[?#"')\s]|$)/i.test(it));
        if (!woff2) return m;
        const locals = items.filter((it) => /^\s*local\(/i.test(it));
        return prefix + [...locals, woff2.trim()].join(",") + end;
      }) + close);
  }

  /** Wrap an inlined @import's content in the media / supports / layer conditions it carried. */
  function wrapImport(css, tail) {
    css = css.replace(/^\uFEFF?\s*@charset[^;]*;/i, "");
    let layer = null, supports = null;
    tail = tail.replace(/\blayer(?:\(([^)]*)\))?/i, (_, n) => { layer = (n || "").trim(); return " "; });
    tail = tail.replace(/\bsupports\(((?:[^()]|\([^()]*\))*)\)/i, (_, s) => { supports = s.trim(); return " "; });
    const media = tail.trim();
    if (media) css = `@media ${media}{${css}}`;
    if (supports) css = `@supports ${/^\(|^not\b/i.test(supports) ? supports : `(${supports})`}{${css}}`;
    if (layer !== null) css = `@layer ${layer}{${css}}`;
    return css + "\n";
  }

  /** Resolve @import chains and url() references relative to the stylesheet that contains them. */
  async function inlineCss(css, baseUrl, chain = []) {
    if (CONFIG.preferWoff2) css = pruneFontSources(css);
    css = await replaceAsync(css, IMPORT_RE, async (m) => {
      const href = abs(m[1] || m[2] || m[3], baseUrl);
      const tail = (m[4] || "").trim();
      if (!href || chain.includes(href)) return "";             // circular import
      try {
        return wrapImport(await inlineCss(await fetchText(href), href, [...chain, href]), tail);
      } catch (e) {
        fail(href, e);
        return `@import url("${href}") ${tail};`;               // keep it working online
      }
    });
    return replaceAsync(css, URL_RE, async (m) => {
      const raw = (m[1] ?? m[2] ?? m[3] ?? "").trim();
      if (!raw || SKIP.test(raw)) return m[0];
      const href = abs(raw, baseUrl);
      if (!href) return m[0];
      try { return `url("${await toDataUrl(href)}")`; }
      catch (e) { fail(href, e); return `url("${href}")`; }
    });
  }

  /* ─────────────────────── per-element processing ─────────────────────── */
  const safeScript = (t) => t
    .replace(/<\/(script)/gi, "<\\/$1")                  // would otherwise terminate the inline script
    .replace(/<!--/g, "<\\!--")
    .replace(/\n?\/\/[#@]\s*sourceMappingURL=[^\n]*\s*$/, "");

  function inlineAttr(c, attr, ctx) {
    const v = c.getAttribute(attr);
    if (!v || SKIP.test(v)) return;
    const full = abs(v, ctx.base);
    if (!full) return;
    const i = full.indexOf("#");
    const href = i < 0 ? full : full.slice(0, i);
    const hash = i < 0 ? "" : full.slice(i);              // keep #fragment (SVG sprites)
    ctx.tasks.push(toDataUrl(href).then(
      (d) => c.setAttribute(attr, d + hash),
      (e) => { fail(href, e); c.setAttribute(attr, full); }));
  }

  function canvasToDataUrl(el) {
    try {
      const cv = document.createElement("canvas");
      cv.width = el.naturalWidth; cv.height = el.naturalHeight;
      cv.getContext("2d").drawImage(el, 0, 0);
      return cv.toDataURL();
    } catch { return null; }
  }

  async function processLink(o, c, ctx) {
    const rel = (o.getAttribute("rel") || "").toLowerCase().split(/\s+/);
    if (rel.includes("stylesheet")) {
      if (o.disabled || rel.includes("alternate")) { c.remove(); return; }
      const href = abs(o.getAttribute("href"), ctx.base);
      if (!href) return;
      let css;
      try { css = await fetchText(href); }
      catch (e) {
        css = ctx.live ? sheetText(o.sheet) : null;           // fall back to the browser's parsed copy
        if (css == null) { fail(href, e); c.setAttribute("href", href); return; }
      }
      const style = document.createElement("style");
      for (const a of o.attributes) if (/^(?:id|media|data-.+)$/i.test(a.name)) style.setAttribute(a.name, a.value);
      style.textContent = await inlineCss(css, href);
      c.replaceWith(style);
    } else if (rel.some((r) => /^(?:icon|shortcut|apple-touch-icon(?:-precomposed)?|mask-icon|apple-touch-startup-image)$/.test(r))) {
      inlineAttr(c, "href", ctx);
    } else if (rel.some((r) => /^(?:preload|prefetch|modulepreload|dns-prefetch|preconnect|prerender|manifest)$/.test(r))) {
      c.remove();
    }
  }

  async function processStyle(o, c, ctx) {
    let css = ctx.live ? sheetText(o.sheet) : null;           // includes rules added via insertRule()
    if (css == null || !css.trim()) css = o.textContent;
    if (css && css.trim()) c.textContent = await inlineCss(css, ctx.base);
  }

  function processScript(o, c, ctx) {
    const type = (o.getAttribute("type") || "").split(";")[0].trim().toLowerCase();
    const isJs = !type || type === "module" || /^(?:text|application)\/(?:x-)?(?:java|ecma|j|live)script(?:1\.\d)?$/.test(type);
    if (!isJs) return;                                         // JSON / templates / importmap: keep as-is
    if (!ctx.keepScripts || o.hasAttribute("nomodule")) { c.remove(); return; }
    c.removeAttribute("async");
    const src = o.getAttribute("src");
    if (!src) { scanForWorkers(o.textContent, ctx.base); c.textContent = safeScript(o.textContent); return; }
    const href = abs(src, ctx.base);
    if (!href) return;
    if (o.hasAttribute("defer") && type !== "module") { c.removeAttribute("defer"); ctx.deferred.push(c); }
    ctx.tasks.push(fetchText(href).then((txt) => {
      if (type === "module" && /\bfrom\s*["']\.{0,2}\//.test(txt)) warn(`Module with relative imports may not run offline: ${href}`);
      scanForWorkers(txt, ctx.base);
      c.removeAttribute("src");
      c.setAttribute("data-archive-src", href);                // lets the shim fake document.currentScript.src
      c.textContent = safeScript(txt);
    }, (e) => { fail(href, e); c.setAttribute("src", href); }));
  }

  function processImg(o, c, ctx) {
    const parent = o.parentElement;
    const pic = parent && parent.localName === "picture" ? parent.querySelector("source[srcset]") : null;
    const first = (set) => (set || "").split(",")[0].trim().split(/\s+/)[0];
    const src = ctx.live
      ? (o.currentSrc || o.getAttribute("src"))                // the candidate the browser actually chose
      : (o.getAttribute("src") || first(o.getAttribute("srcset")) || (pic && first(pic.getAttribute("srcset"))));
    c.removeAttribute("srcset"); c.removeAttribute("sizes");
    if (!src) return;
    if (/^blob:/i.test(src)) { const d = ctx.live && canvasToDataUrl(o); if (d) c.setAttribute("src", d); return; }
    c.setAttribute("src", src);
    inlineAttr(c, "src", ctx);
  }

  async function processFrame(o, c, ctx) {
    if (ctx.depth >= CONFIG.maxFrameDepth || o.hasAttribute("srcdoc")) return;
    const src = o.getAttribute("src");
    let doc = null, fbase = null, live = false;
    if (ctx.live) {
      try {
        const d = o.contentDocument;
        if (d && d.documentElement && !(d.URL === "about:blank" && src && !SKIP.test(src))) { doc = d; fbase = d.baseURI; live = true; }
      } catch { /* cross-origin */ }
    }
    if (!doc) {
      if (!src || SKIP.test(src)) return;
      const href = abs(src, ctx.base);
      if (!href) return;
      try {
        const b = await fetchBlob(href);
        if (!/html|xml/i.test(b.type)) { c.setAttribute("src", await blobToDataUrl(b)); return; }
        doc = new DOMParser().parseFromString(await b.text(), "text/html");
        fbase = docBase(doc, href);
      } catch (e) { fail(href, e); c.setAttribute("src", href); return; }
    }
    c.setAttribute("srcdoc", await archiveDocument(doc, { live, base: fbase, depth: ctx.depth + 1 }));
    c.removeAttribute("src");
  }

  function handle(o, c, ctx) {
    const tag = o.localName;
    const T = (p) => ctx.tasks.push(p.catch((e) => fail(`<${tag}>`, e)));

    c.removeAttribute("integrity"); c.removeAttribute("crossorigin"); c.removeAttribute("nonce");
    if (!ctx.keepScripts) for (const a of [...c.attributes]) if (/^on/i.test(a.name)) c.removeAttribute(a.name);

    const style = o.getAttribute("style");
    if (style && /url\(/i.test(style)) T(inlineCss(style, ctx.base).then((v) => c.setAttribute("style", v)));

    switch (tag) {
      case "meta": {
        const he = (o.getAttribute("http-equiv") || "").toLowerCase();
        if (o.hasAttribute("charset") || /^(?:content-security-policy(?:-report-only)?|refresh|content-type)$/.test(he)) c.remove();
        break;
      }
      case "base": c.remove(); break;
      case "a": case "area": case "form": {
        const attr = tag === "form" ? "action" : "href";
        const v = o.getAttribute(attr);
        if (v && !SKIP.test(v)) { const u = abs(v, ctx.base); if (u) c.setAttribute(attr, u); }
        break;
      }
      case "link": T(processLink(o, c, ctx)); break;
      case "style": T(processStyle(o, c, ctx)); break;
      case "script": processScript(o, c, ctx); break;
      case "img": processImg(o, c, ctx); break;
      case "source":
        if (o.parentElement && o.parentElement.localName === "picture") { c.remove(); break; }
        inlineAttr(c, "src", ctx); break;
      case "video": inlineAttr(c, "poster", ctx); inlineAttr(c, "src", ctx); break;
      case "audio": case "track": case "embed": inlineAttr(c, "src", ctx); break;
      case "object": inlineAttr(c, "data", ctx); break;
      case "image": case "use": case "feimage":
        inlineAttr(c, "href", ctx); inlineAttr(c, "xlink:href", ctx); break;
      case "iframe": case "frame": T(processFrame(o, c, ctx)); break;
      case "canvas":
        if (ctx.live) {
          try {
            const img = document.createElement("img");
            for (const a of ["id", "class", "style", "width", "height", "title", "role", "aria-label"])
              if (o.hasAttribute(a)) img.setAttribute(a, o.getAttribute(a));
            img.src = o.toDataURL();
            c.replaceWith(img);
          } catch { warn("A canvas could not be captured (tainted or blank)."); }
        }
        break;
      case "input": {
        const t = (o.getAttribute("type") || "").toLowerCase();
        if (t === "image") { inlineAttr(c, "src", ctx); break; }
        if (!ctx.live || /^(?:password|file|hidden)$/.test(t)) break;
        if (t === "checkbox" || t === "radio") o.checked ? c.setAttribute("checked", "") : c.removeAttribute("checked");
        else c.setAttribute("value", o.value);
        break;
      }
      case "textarea": if (ctx.live) c.textContent = o.value; break;
      case "select":
        if (ctx.live) [...o.options].forEach((op, i) => {
          const co = c.options && c.options[i];
          if (co) op.selected ? co.setAttribute("selected", "") : co.removeAttribute("selected");
        });
        break;
    }

    if (ctx.live && o.shadowRoot) {                           // open shadow DOM -> declarative shadow DOM
      const sr = o.shadowRoot, tpl = document.createElement("template");
      tpl.setAttribute("shadowrootmode", sr.mode);
      for (const n of sr.childNodes) tpl.content.appendChild(n.cloneNode(true));
      walk(sr, tpl.content, ctx);
      adopt(sr, tpl.content, ctx);
      c.prepend(tpl);
    }
  }

  const listEls = (n) => (n.nodeType === 1 ? [n] : []).concat([...n.querySelectorAll("*")]);
  function walk(origRoot, copyRoot, ctx) {
    const os = listEls(origRoot), cs = listEls(copyRoot);
    os.forEach((o, i) => { if (cs[i]) handle(o, cs[i], ctx); });
  }

  function adopt(root, container, ctx) {
    for (const sh of root.adoptedStyleSheets || []) {
      const t = sheetText(sh);
      if (!t) continue;
      ctx.tasks.push(inlineCss(t, ctx.base).then((css) => ctx.post.push(() => {
        const s = document.createElement("style");
        s.setAttribute("data-archive-adopted", "");
        s.textContent = css;
        container.append(s);
      })));
    }
  }

  /* ─────────────────────────── document ─────────────────────────── */
  function serialize(srcDoc, clone) {
    const dt = srcDoc.doctype;
    const doctype = dt
      ? `<!DOCTYPE ${dt.name}${dt.publicId ? ` PUBLIC "${dt.publicId}"` : ""}${dt.systemId ? `${dt.publicId ? "" : " SYSTEM"} "${dt.systemId}"` : ""}>\n`
      : "";                                                    // keep quirks mode if the original had no doctype
    const note = `<!-- Archived from ${location.href.replace(/--/g, "-%2D")} on ${new Date().toISOString()} (${report.mode} mode) -->\n`;
    return doctype + note + clone.outerHTML;
  }

  async function archiveDocument(srcDoc, { live, base, depth = 0, finalize }) {
    const root = srcDoc.documentElement;
    const clone = root.cloneNode(true);
    const ctx = { live, base, depth, keepScripts: mode === "app", tasks: [], post: [], deferred: [] };

    walk(root, clone, ctx);                                    // schedules all work synchronously
    if (live) adopt(srcDoc, clone.querySelector("head") || clone, ctx);
    await Promise.all(ctx.tasks);

    const body = clone.querySelector("body") || clone;
    for (const s of ctx.deferred) if (clone.contains(s)) body.append(s);   // preserve `defer` ordering
    ctx.post.forEach((fn) => fn());

    const head = clone.querySelector("head") || clone.insertBefore(document.createElement("head"), clone.firstChild);
    if (finalize) await finalize(clone, head);
    const meta = document.createElement("meta");
    meta.setAttribute("charset", "utf-8");                     // output is always UTF-8
    head.prepend(meta);
    return serialize(srcDoc, clone);
  }

  /* ───────────────── runtime-request replay (app mode) ───────────────── */
  const SHIM_SRC = `(function(){
var D=/*__DATA__*/null,B=D.b;
function abs(u){try{return new URL(String(u),B).href}catch(e){return String(u)}}
function look(u){
  if(/^(data|blob):/i.test(String(u)))return null;
  var a=abs(u),i=D.m[a];
  if(i===undefined){try{var x=new URL(a);i=D.p[x.origin+x.pathname]}catch(e){}}
  return i===undefined?null:D.d[i];
}
var f=window.fetch;
if(f)window.fetch=function(i,n){
  try{
    var u=(typeof i==='string'||i instanceof URL)?String(i):i.url;
    var m=String((n&&n.method)||(i&&i.method)||'GET').toUpperCase();
    var h=(m==='GET'||m==='HEAD')?look(u):null;
    if(h)return f.call(this,h);
  }catch(e){}
  return f.apply(this,arguments);
};
var xo=XMLHttpRequest.prototype.open;
XMLHttpRequest.prototype.open=function(m,u){
  var a=[].slice.call(arguments);
  try{if(String(m).toUpperCase()==='GET'){var h=look(u);if(h)a[1]=h}}catch(e){}
  return xo.apply(this,a);
};
var T={SCRIPT:'src',IMG:'src',SOURCE:'src',VIDEO:'src',AUDIO:'src',LINK:'href'};
var sa=Element.prototype.setAttribute;
Element.prototype.setAttribute=function(n,v){
  if(typeof v==='string'&&T[this.tagName]===String(n).toLowerCase()){var h=look(v);if(h)v=h}
  return sa.call(this,n,v);
};
[[HTMLScriptElement,'src'],[HTMLImageElement,'src'],[HTMLLinkElement,'href'],[HTMLSourceElement,'src'],[HTMLMediaElement,'src']].forEach(function(p){
  var d=Object.getOwnPropertyDescriptor(p[0].prototype,p[1]);
  if(d&&d.set)Object.defineProperty(p[0].prototype,p[1],{configurable:true,enumerable:d.enumerable,get:d.get,set:function(v){var h=typeof v==='string'&&look(v);d.set.call(this,h||v)}});
});
['pushState','replaceState'].forEach(function(k){var o=history[k];history[k]=function(){try{return o.apply(this,arguments)}catch(e){}}});
try{
  var sw=navigator.serviceWorker;
  if(sw&&sw.register){
    var reg=sw.register;
    if(!D.a){
      sw.register=function(){return Promise.reject(new Error('Service workers are disabled in the archived copy'))};
    }else{
      sw.register=function(u,o){
        try{
          var n=D.w[abs(u)];
          if(n){
            var p=new URL(n,location.href).href,o2={};
            for(var k in (o||{}))o2[k]=o[k];
            delete o2.scope;
            return reg.call(sw,p,o2);
          }
        }catch(e){}
        return reg.apply(sw,arguments);
      };
    }
  }
}catch(e){}
try{
  var cd=Object.getOwnPropertyDescriptor(Document.prototype,'currentScript');
  Object.defineProperty(Document.prototype,'currentScript',{configurable:true,get:function(){
    var s=cd.get.call(this);
    if(s&&s.getAttribute&&s.getAttribute('data-archive-src'))return new Proxy(s,{get:function(t,k){
      if(k==='src')return t.getAttribute('data-archive-src');
      var v=t[k];return typeof v==='function'?v.bind(t):v}});
    return s;
  }});
}catch(e){}
})();`;

  async function buildReplayShim(base) {
    const entries = (performance.getEntriesByType && performance.getEntriesByType("resource")) || [];
    if (entries.length >= 250) warn("Resource Timing buffer is full (250 entries); some runtime requests may be missing.");
    const urls = !CONFIG.replayNetwork ? [] : [...new Set(entries.map((e) => e.name))].filter((u) =>
      /^https?:/i.test(u) && !blobCache.has(u) && !CONFIG.ignore.some((re) => re.test(u)));   // skip already-inlined

    const data = [], byUrl = {};
    await Promise.all(urls.map(async (u) => {
      try {
        let blob = await fetchBlob(u);
        if (/^text\/css/i.test(blob.type)) blob = new Blob([await inlineCss(await blob.text(), u)], { type: "text/css" });
        else if (/javascript/i.test(blob.type)) scanForWorkers(await blob.text(), base);   // lazily loaded chunks
        byUrl[u] = data.push(await blobToDataUrl(blob)) - 1;
      } catch (e) { fail(u, e); }
    }));

    // Fallback index by origin+path, only where the path is unambiguous (cache-busting query strings).
    const byPath = {}, count = {};
    for (const u of Object.keys(byUrl)) {
      try { const x = new URL(u), k = x.origin + x.pathname; count[k] = (count[k] || 0) + 1; byPath[k] = byUrl[u]; } catch { /* ignore */ }
    }
    for (const k of Object.keys(count)) if (count[k] > 1) delete byPath[k];

    const workers = await collectWorkers();                    // { workerUrl: sidecar file name }

    const json = JSON.stringify({ b: base, d: data, m: byUrl, p: byPath, a: !!CONFIG.allowServiceWorkers, w: workers })
      .replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
    return SHIM_SRC.replace("/*__DATA__*/null", () => json);   // function replacer: no `$` expansion
  }

  /* ───────────────────────────── main ───────────────────────────── */
  let srcDoc = document, base = document.baseURI, live = true;
  if (mode === "app") {
    try {
      const res = await fetch(location.href, { credentials: "include", cache: "force-cache" });
      if (!res.ok) throw new Error("HTTP " + res.status);
      if (!/html/i.test(res.headers.get("content-type") || "")) throw new Error("response is not HTML");
      srcDoc = new DOMParser().parseFromString(await res.text(), "text/html");
      base = docBase(srcDoc, location.href);
      live = false;
    } catch (e) {
      warn(`App mode unavailable (${e.message}); fell back to snapshot mode.`);
      mode = report.mode = "snapshot";
    }
  }

  const html = await archiveDocument(srcDoc, {
    live, base,
    finalize: async (clone, head) => {
      if (mode === "app" && (CONFIG.replayNetwork || CONFIG.allowServiceWorkers)) {
        const s = document.createElement("script");
        s.setAttribute("data-archive-shim", "");
        s.textContent = await buildReplayShim(base);
        head.prepend(s);                                       // must run before any app script
      }
    },
  });

  const mb = (n) => (n / 1048576).toFixed(1) + " MB";
  const swNamesOut = Object.keys(report.serviceWorkerFiles);
  console.info(`[archive] ${report.mode} mode: ${report.resources} resources fetched (${mb(report.bytes)}), output ${mb(html.length)}`);
  if (swNamesOut.length) console.info(`[archive] service worker files (host next to the .html over https/localhost): ${swNamesOut.join(", ")}`);
  if (Object.keys(report.failed).length) console.warn("[archive] not embedded (left as absolute URLs):", report.failed);
  if (report.warnings.length) console.warn("[archive] warnings:", report.warnings);
  window.__archiveReport = report;

  const save = (name, text, type) => {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([text], { type }));
    a.download = name;
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 100000);
  };

  if (typeof completion === "function") {
    completion(html);                                          // worker files: see report.serviceWorkerFiles
  } else {
    save(`${location.hostname || "page"}-${new Date().toISOString().slice(0, 10)}.html`, html, "text/html");
    if (CONFIG.emitServiceWorkerFiles) {
      for (const name of swNamesOut) {                         // staggered so browsers allow multiple downloads
        await new Promise((r) => setTimeout(r, 400));
        save(name, report.serviceWorkerFiles[name], "text/javascript");
      }
    }
  }
  return { html, report };
})();
