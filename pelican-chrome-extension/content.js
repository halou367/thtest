(function () {
  "use strict";
  if (window.__pelicanContentScriptLoaded) return;
  window.__pelicanContentScriptLoaded = true;

  const {
    DEFAULT_CAPTURE_KEYWORDS,
    TIER_ORDER,
    TIER_SHORT,
    SHORT_VENDOR_CATALOG,
    escapeHtml,
    fastHash,
    extractRenderableCode,
    isCompleteSpecimenCode,
    matchKeywordFeatures,
    extractSanitizedSvgMarkup,
    splitToShortVendorAndModel,
    getModelsForVendor,
    getVendorLogoSvg,
    computeFilteredVerdict
  } = window.PelicanShared;

  let hostEl = null;
  let shadow = null;

  // Monotonic counters
  let renderSeq = 0;
  let identifySeq = 0;
  let gestureSeq = 0;
  let lastHookHandledTs = 0;
  let lastTriggerHash = "";
  let lastTriggerTs = 0;
  let lastKnownOsClipHash = "";

  const ackedRenderIds = new Set();
  const activeTimers = new Map();

  // Page Auto-Capture state
  let activeConfig = {
    autoPopup: true,
    autoPageCapture: true,
    keywordOnlyAuto: true,
    captureKeywords: DEFAULT_CAPTURE_KEYWORDS,
    sourceFilter: "all"
  };
  const autoCapturedPageHashes = new Set();
  const subframeSpecimensMap = new Map();
  let lastObservedHref = location.href;
  let domSettleTimer = null;
  let lastMutationBurstTs = 0;

  const uiState = {
    visible: false,
    minimized: false,
    detailsOpen: false,
    correctOpen: false,
    kwDrawerOpen: false,
    submittingSample: false,
    sourceFilter: "all",
    currentCode: "",
    currentHash: "",
    currentType: "SVG",
    currentOrigin: "",
    currentMatchedKws: [],
    currentVerdict: null,
    pageSpecimens: [],
    corrVendor: "Claude",
    corrModel: "opus-5.5",
    corrTier: "high",
    detectedVendor: "",
    detectedModel: "",
    detectedTier: "high"
  };

  // Load initial config early for background page auto-capture
  (async function bootstrapConfig() {
    try {
      const st = await chrome.runtime.sendMessage({ type: "GET_STATE" });
      if (st && st.config) {
        activeConfig = { ...activeConfig, ...st.config };
        uiState.sourceFilter = activeConfig.sourceFilter || "all";
      }
    } catch (_) {}
    schedulePageAutoCapture(650);
  })();

  // Global listener for sandbox render ACKs & Subframe Specimens
  window.addEventListener("message", (ev) => {
    const d = ev && ev.data;
    if (!d || typeof d !== "object") return;

    if (d.type === "PELICAN_RENDER_ACK" && d.renderId) {
      ackedRenderIds.add(d.renderId);
      const timer = activeTimers.get(d.renderId);
      if (timer) {
        clearInterval(timer);
        activeTimers.delete(d.renderId);
      }
      if (shadow && d.cid === "preview") {
        const frame = shadow.getElementById("previewFrame");
        const fb = shadow.getElementById("svgFallbackStage");
        if (frame) frame.style.opacity = "1";
        if (fb) fb.style.display = "none";
      }
      return;
    }

    if (d.source === "__PELICAN_SUBFRAME_SPECIMENS__" && Array.isArray(d.items)) {
      let addedNew = false;
      d.items.forEach((it) => {
        if (!it || !it.code) return;
        const parsed = extractRenderableCode(it.code);
        if (!parsed) return;
        const h = fastHash(parsed.code);
        if (!subframeSpecimensMap.has(h)) addedNew = true;
        subframeSpecimensMap.set(h, {
          hash: h,
          type: parsed.type,
          code: parsed.code,
          origin: it.origin || "子帧预览"
        });
      });
      if (addedNew && !d.manualScan) {
        schedulePageAutoCapture(300);
      }
    }
  });

  function pingSubframesForSpecimens() {
    try {
      const frames = document.querySelectorAll("iframe");
      for (let i = 0; i < frames.length; i++) {
        const f = frames[i];
        if (hostEl && hostEl.contains(f)) continue;
        try {
          if (f.contentWindow) {
            f.contentWindow.postMessage({ source: "__PELICAN_SCAN_SUBFRAMES_REQ__" }, "*");
          }
        } catch (_) {}
      }
    } catch (_) {}
  }

  function isStandaloneIllustrationSvg(svgEl) {
    if (!svgEl || (hostEl && hostEl.contains(svgEl))) return false;
    if (svgEl.closest("button, a, nav, header, footer, [role='button'], [aria-hidden='true']")) {
      return false;
    }
    const cls = String(svgEl.getAttribute("class") || "").toLowerCase();
    if (/\b(lucide|feather|heroicon|octicon|fa-|icon|avatar|logo|spinner)\b/.test(cls)) {
      return false;
    }
    const shapes = svgEl.querySelectorAll("path,circle,ellipse,rect,line,polygon,polyline").length;
    if (shapes < 8) return false;

    let w = 0, h = 0;
    try {
      const rect = svgEl.getBoundingClientRect();
      w = rect.width;
      h = rect.height;
    } catch (_) {}

    if (w < 140 || h < 100) {
      const vb = (svgEl.getAttribute("viewBox") || "").trim().split(/[\s,]+/).map(Number);
      if (vb.length === 4 && vb[2] >= 160 && vb[3] >= 110 && w === 0 && h === 0) {
        // Offscreen / hidden tab content SVG with full illustration viewBox
      } else {
        return false;
      }
    }

    return true;
  }

  // Scan the current DOM + iframes + code blocks for SVG / HTML specimens and score by keyword features
  function scanPageSpecimens(opts = {}) {
    const requireComplete = Boolean(opts.requireComplete);
    const rawCandidates = [];

    // 1. iframe[srcdoc] & accessible blob/about preview iframes (Arena / Claude / DeepSeek preview panes!)
    const iframes = document.querySelectorAll("iframe");
    for (let i = 0; i < iframes.length; i++) {
      const f = iframes[i];
      if (hostEl && hostEl.contains(f)) continue;
      const srcdoc = f.getAttribute("srcdoc");
      if (srcdoc && srcdoc.length >= 60) {
        const parsed = extractRenderableCode(srcdoc);
        if (parsed && (!requireComplete || isCompleteSpecimenCode(parsed))) {
          rawCandidates.push({ type: parsed.type, code: parsed.code, origin: "预览框" });
        }
        continue;
      }
      const fSrc = String(f.getAttribute("src") || "");
      if (!fSrc || fSrc.startsWith("about:") || fSrc.startsWith("blob:")) {
        try {
          const doc = f.contentDocument;
          if (doc && doc.documentElement) {
            const innerSvgs = doc.querySelectorAll("svg");
            const innerCanvas = doc.querySelectorAll("canvas");
            if (innerSvgs.length > 0 || innerCanvas.length > 0) {
              const htmlStr = "<!DOCTYPE html>\n" + doc.documentElement.outerHTML;
              if (!htmlStr.includes("__tihu_fit_css")) {
                const parsed = extractRenderableCode(htmlStr);
                if (parsed && (!requireComplete || isCompleteSpecimenCode(parsed))) {
                  rawCandidates.push({ type: parsed.type, code: parsed.code, origin: "内嵌帧" });
                }
              }
            }
          }
        } catch (_) {}
      }
    }

    // 2. Code blocks & editors (Markdown <pre><code>, CodeMirror .cm-content, <textarea>)
    const codeEls = document.querySelectorAll("pre code, pre, .cm-content, textarea");
    const visitedPre = new Set();
    for (let i = 0; i < codeEls.length; i++) {
      const el = codeEls[i];
      if (hostEl && hostEl.contains(el)) continue;
      if (el.tagName === "PRE" && visitedPre.has(el)) continue;
      if (el.tagName === "CODE" && el.parentElement && el.parentElement.tagName === "PRE") {
        visitedPre.add(el.parentElement);
      }

      const txt = typeof el.value === "string" ? el.value : el.textContent || "";
      if (txt.length < 60 || txt.length > 3200000) continue;
      if (!/<svg[\s>]|<!doctype\s+html|<html[\s>]|<(canvas|style)[\s>]/i.test(txt)) continue;

      const parsed = extractRenderableCode(txt);
      if (parsed && (!requireComplete || isCompleteSpecimenCode(parsed))) {
        rawCandidates.push({ type: parsed.type, code: parsed.code, origin: "代码块" });
      }
    }

    // 3. Subframe reported specimens (cross-origin sandbox preview frames)
    for (const item of subframeSpecimensMap.values()) {
      rawCandidates.push({ type: item.type, code: item.code, origin: item.origin });
    }

    // 4. Standalone rendered <svg> illustrations in page DOM
    const svgs = document.querySelectorAll("svg");
    for (let i = 0; i < svgs.length; i++) {
      const s = svgs[i];
      if (!isStandaloneIllustrationSvg(s)) continue;
      let markup = s.outerHTML || "";
      if (markup.length < 260 || markup.length > 2500000) continue;
      if (!/\bxmlns\s*=/i.test(markup)) {
        markup = markup.replace(/^<svg\b/i, '<svg xmlns="http://www.w3.org/2000/svg"');
      }
      rawCandidates.push({ type: "SVG", code: markup, origin: "页面SVG" });
    }

    // Deduplicate by exact hash AND suppress standalone SVG if already embedded inside a captured full HTML
    const byHash = new Map();
    const htmlCodes = [];
    for (let i = 0; i < rawCandidates.length; i++) {
      const c = rawCandidates[i];
      const h = fastHash(c.code);
      if (byHash.has(h)) continue;
      if (c.type === "HTML") htmlCodes.push(c.code);
      const kw = matchKeywordFeatures(c.code, activeConfig.captureKeywords);
      byHash.set(h, {
        hash: h,
        type: c.type,
        code: c.code,
        origin: c.origin,
        kwHit: kw.hit,
        matchedKws: kw.matched,
        shapeCount: kw.shapeCount,
        score: kw.score + (c.type === "HTML" ? 15 : 0)
      });
    }

    const deduped = [];
    for (const item of byHash.values()) {
      if (item.type === "SVG" && htmlCodes.length > 0) {
        const core = item.code.replace(/\s+xmlns="http:\/\/www\.w3\.org\/2000\/svg"/i, "").slice(0, 180);
        const insideHtml = htmlCodes.some((hc) => hc.includes(item.code) || (core.length > 60 && hc.includes(core)));
        if (insideHtml) continue;
      }
      deduped.push(item);
    }

    // Sort: keyword-matched specimens FIRST, then by keyword score & size
    deduped.sort((a, b) => {
      if (a.kwHit !== b.kwHit) return a.kwHit ? -1 : 1;
      if (b.score !== a.score) return b.score - a.score;
      return b.code.length - a.code.length;
    });

    return deduped.slice(0, 12);
  }

  function schedulePageAutoCapture(delayMs = 950) {
    if (!activeConfig.autoPageCapture) return;
    if (location.href !== lastObservedHref) {
      lastObservedHref = location.href;
      autoCapturedPageHashes.clear();
      subframeSpecimensMap.clear();
    }
    if (domSettleTimer) clearTimeout(domSettleTimer);
    domSettleTimer = setTimeout(() => {
      runAutoPageCaptureCheck();
    }, delayMs);
  }

  function runAutoPageCaptureCheck() {
    if (!activeConfig.autoPageCapture) return;
    const allFound = scanPageSpecimens({ requireComplete: true });
    if (!allFound.length) return;

    const eligible = activeConfig.keywordOnlyAuto
      ? allFound.filter((x) => x.kwHit)
      : allFound.filter((x) => x.kwHit || x.origin !== "页面SVG" || x.shapeCount >= 14);

    if (!eligible.length) {
      // Still update header badge count quietly if UI already exists
      if (shadow) {
        uiState.pageSpecimens = allFound;
        renderPageSpecimensBar();
      }
      return;
    }

    const unseen = eligible.filter((x) => !autoCapturedPageHashes.has(x.hash));
    if (!unseen.length) {
      if (shadow) {
        uiState.pageSpecimens = allFound;
        renderPageSpecimensBar();
      }
      return;
    }

    unseen.forEach((x) => autoCapturedPageHashes.add(x.hash));
    uiState.pageSpecimens = allFound;

    const chosen = unseen[0];
    showWindowAndIdentify(chosen.code, {
      autoTriggered: true,
      forceRefresh: true,
      originLabel: chosen.origin,
      matchedKws: chosen.matchedKws
    });
  }

  // Throttled MutationObserver watching page for newly generated/streamed SVG & HTML
  if (typeof MutationObserver !== "undefined") {
    const startObserver = () => {
      const rootTarget = document.body || document.documentElement;
      if (!rootTarget) return;
      const obs = new MutationObserver((mutations) => {
        if (!activeConfig.autoPageCapture) return;
        // Ignore mutations exclusively inside our own extension host
        let externalChange = false;
        for (let i = 0; i < mutations.length; i++) {
          const t = mutations[i].target;
          if (!hostEl || (t !== hostEl && !hostEl.contains(t))) {
            externalChange = true;
            break;
          }
        }
        if (!externalChange) return;

        const now = Date.now();
        if (now - lastMutationBurstTs < 220 && domSettleTimer) {
          // Reset settle timer during active LLM token streaming so we capture once streaming finishes!
          clearTimeout(domSettleTimer);
          domSettleTimer = setTimeout(runAutoPageCaptureCheck, 950);
          return;
        }
        lastMutationBurstTs = now;
        schedulePageAutoCapture(950);
      });
      obs.observe(rootTarget, { childList: true, subtree: true, characterData: true });
    };

    if (document.body) startObserver();
    else window.addEventListener("DOMContentLoaded", startObserver);
  }

  function deliverToSandbox(frameId, cid, code) {
    if (!shadow) return;
    const frame = shadow.getElementById(frameId);
    if (!frame) return;

    for (const [rid, t] of activeTimers.entries()) {
      if (String(rid).startsWith(cid + "_")) {
        clearInterval(t);
        activeTimers.delete(rid);
      }
    }

    if (cid === "preview") {
      const fb = shadow.getElementById("svgFallbackStage");
      const safeSvg = extractSanitizedSvgMarkup(code);
      if (fb) {
        if (safeSvg) {
          fb.innerHTML = safeSvg;
          fb.style.display = "flex";
        } else {
          fb.innerHTML = "";
          fb.style.display = "none";
        }
      }
    }

    const renderId = `${cid}_${++renderSeq}`;
    let attempts = 0;

    const tryPost = () => {
      attempts++;
      if (ackedRenderIds.has(renderId) || attempts > 30) {
        const t = activeTimers.get(renderId);
        if (t) {
          clearInterval(t);
          activeTimers.delete(renderId);
        }
        return;
      }
      try {
        if (frame.contentWindow) {
          frame.contentWindow.postMessage(
            {
              type: "PELICAN_RENDER_CODE",
              cid,
              renderId,
              code
            },
            "*"
          );
        }
      } catch (_) {}
    };

    tryPost();
    const timer = setInterval(tryPost, 75);
    activeTimers.set(renderId, timer);
  }

  const SHADOW_CSS = `
    :host {
      all: initial;
      font-family: -apple-system, BlinkMacSystemFont, "Inter", "SF Pro Text", "PingFang SC", "Microsoft YaHei", sans-serif;
      color: #1f2a37;
      line-height: 1.42;
      -webkit-font-smoothing: antialiased;
    }
    * { box-sizing: border-box; }

    .pelican-root {
      --ink: #1f2a37;
      --ink-soft: #526275;
      --muted: #7c8b9c;
      --line: rgba(100, 116, 139, 0.16);
      --line-strong: rgba(100, 116, 139, 0.26);
      --open-ink: #1c624c;
      --open-bg: rgba(16, 185, 129, 0.14);
      --closed-ink: #384e66;
      --closed-bg: rgba(79, 109, 138, 0.13);

      position: fixed;
      right: 20px;
      bottom: 20px;
      z-index: 2147483646;
      pointer-events: none;
    }

    .ext-window {
      width: 356px;
      max-width: calc(100vw - 24px);
      max-height: calc(100vh - 32px);
      display: none;
      flex-direction: column;
      border-radius: 18px;
      background: rgba(249, 251, 254, 0.96);
      backdrop-filter: blur(24px) saturate(140%);
      -webkit-backdrop-filter: blur(24px) saturate(140%);
      border: 1px solid rgba(255, 255, 255, 0.95);
      box-shadow: 0 20px 50px rgba(15, 26, 40, 0.20), 0 4px 14px rgba(15, 26, 40, 0.08);
      overflow: hidden;
      pointer-events: auto;
    }
    .ext-window.show { display: flex; }

    .ext-header {
      padding: 8px 10px;
      background: rgba(241, 245, 250, 0.92);
      border-bottom: 1px solid var(--line);
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 5px;
      cursor: grab;
      user-select: none;
      flex-shrink: 0;
    }
    .ext-header:active { cursor: grabbing; }
    .ext-header-left { display: flex; align-items: center; gap: 6px; min-width: 0; }

    .brand-mark {
      width: 22px;
      height: 22px;
      border-radius: 6px;
      background: linear-gradient(145deg, #334354, #51657a);
      color: #ffffff;
      display: grid;
      place-items: center;
      font-size: 11.5px;
      font-weight: 700;
      flex-shrink: 0;
    }
    .win-title { font-size: 12.2px; font-weight: 750; color: var(--ink); white-space: nowrap; }
    .meta-chip {
      font-size: 9.8px;
      font-weight: 600;
      color: var(--ink-soft);
      background: rgba(255, 255, 255, 0.85);
      border: 1px solid var(--line);
      padding: 1px 5.5px;
      border-radius: 999px;
      white-space: nowrap;
      max-width: 112px;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .win-controls { display: flex; align-items: center; gap: 2px; flex-shrink: 0; }
    .elapsed-lbl { font-size: 9.8px; color: var(--muted); margin-right: 2px; white-space: nowrap; }
    .head-pill-btn {
      appearance: none;
      border: 1px solid var(--line-strong);
      background: rgba(255, 255, 255, 0.88);
      color: var(--ink);
      font-size: 10.2px;
      font-weight: 700;
      padding: 2px 6.5px;
      border-radius: 6px;
      cursor: pointer;
      font-family: inherit;
      white-space: nowrap;
    }
    .head-pill-btn:hover { background: #ffffff; border-color: #64748b; }
    .head-pill-btn.active { background: #24466b; color: #ffffff; border-color: #24466b; }
    .icon-btn {
      appearance: none;
      border: 0;
      background: transparent;
      color: var(--ink-soft);
      width: 22px;
      height: 22px;
      border-radius: 6px;
      display: grid;
      place-items: center;
      cursor: pointer;
      font-size: 12.5px;
      padding: 0;
      transition: background 0.14s ease, color 0.14s ease;
    }
    .icon-btn:hover { background: rgba(100, 116, 139, 0.14); color: var(--ink); }
    .icon-btn.active { background: rgba(36, 70, 107, 0.14); color: #1e40af; }

    .scroll-body {
      padding: 9px 11px 11px;
      overflow-y: auto;
      scrollbar-width: thin;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }

    /* Multi-Specimen Page Switcher Bar (Hidden when <= 1 specimen) */
    .specimens-bar {
      display: none;
      gap: 4px;
      overflow-x: auto;
      padding-bottom: 1px;
      scrollbar-width: none;
    }
    .specimens-bar.show { display: flex; }
    .specimens-bar::-webkit-scrollbar { display: none; }
    .spec-tab {
      appearance: none;
      border: 1px solid var(--line-strong);
      background: #ffffff;
      color: var(--ink-soft);
      font-size: 10.2px;
      font-weight: 680;
      padding: 3px 7.5px;
      border-radius: 7px;
      cursor: pointer;
      white-space: nowrap;
      font-family: inherit;
      flex-shrink: 0;
    }
    .spec-tab:hover { color: var(--ink); border-color: #64748b; }
    .spec-tab.active {
      background: #24466b;
      color: #ffffff;
      border-color: #24466b;
    }

    /* Clean Unobstructed Live Preview Stage */
    .preview-stage-wrap {
      position: relative;
      border-radius: 12px;
      overflow: hidden;
      border: 1px solid var(--line-strong);
      background: #f8fafc;
      aspect-ratio: 16 / 10;
      flex-shrink: 0;
    }
    .svg-fallback-stage {
      position: absolute;
      inset: 0;
      display: none;
      align-items: center;
      justify-content: center;
      background: #f8fafc;
      z-index: 1;
      padding: 6px;
    }
    .svg-fallback-stage svg {
      width: 94% !important;
      height: 94% !important;
      max-width: 94% !important;
      max-height: 94% !important;
      display: block;
    }
    .preview-stage-wrap iframe {
      position: relative;
      z-index: 2;
      width: 100%;
      height: 100%;
      border: 0;
      display: block;
      background: #f8fafc;
      transition: opacity 0.12s ease;
    }
    .drag-shield { position: absolute; inset: 0; display: none; z-index: 10; }
    .dragging .drag-shield { display: block; }

    .stage-corner-btn {
      position: absolute;
      top: 6px;
      right: 6px;
      z-index: 6;
      appearance: none;
      border: 1px solid rgba(255, 255, 255, 0.9);
      background: rgba(255, 255, 255, 0.85);
      backdrop-filter: blur(8px);
      color: var(--ink-soft);
      font-size: 10.5px;
      font-weight: 650;
      padding: 2.5px 7px;
      border-radius: 6px;
      cursor: pointer;
      font-family: inherit;
      box-shadow: 0 2px 6px rgba(15, 26, 40, 0.08);
      opacity: 0.82;
      transition: opacity 0.15s ease, background 0.15s ease;
    }
    .preview-stage-wrap:hover .stage-corner-btn { opacity: 1; }
    .stage-corner-btn:hover { background: #ffffff; color: var(--ink); }

    /* Compact Filter Strip */
    .pill-group {
      display: flex;
      align-items: center;
      gap: 2px;
      background: rgba(223, 230, 239, 0.72);
      padding: 2.5px;
      border-radius: 9px;
    }
    .source-pill-btn {
      flex: 1;
      appearance: none;
      border: 0;
      background: transparent;
      color: var(--ink-soft);
      font-size: 11px;
      font-weight: 680;
      padding: 4px 6px;
      border-radius: 7px;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 4px;
      font-family: inherit;
      transition: all 0.15s ease;
    }
    .source-pill-btn.active {
      background: #ffffff;
      color: var(--ink);
      box-shadow: 0 1px 4px rgba(15, 26, 40, 0.08);
    }
    .source-pill-btn.active[data-filter="open"] { background: #226650; color: #ffffff; }
    .source-pill-btn.active[data-filter="closed"] { background: #364b63; color: #ffffff; }
    .pill-pct { font-size: 9.8px; opacity: 0.78; }

    /* Unified Single Verdict Card */
    .verdict-card {
      border-radius: 12px;
      padding: 10px 11px;
      background: #ffffff;
      border: 1px solid var(--line-strong);
      box-shadow: 0 2px 8px rgba(15, 26, 40, 0.03);
    }
    .verdict-card.rarity-gold {
      background: linear-gradient(135deg, #fffcf2 0%, #f9efd8 100%);
      border-color: rgba(196, 149, 69, 0.52);
    }
    .verdict-card.rarity-silver {
      background: linear-gradient(135deg, #f9fbff 0%, #eaeff7 100%);
      border-color: rgba(132, 152, 175, 0.54);
    }

    .verdict-main {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
    }
    .verdict-left {
      display: flex;
      align-items: center;
      gap: 9px;
      min-width: 0;
    }
    .logo-box {
      width: 36px;
      height: 36px;
      border-radius: 10px;
      background: rgba(248, 250, 252, 0.95);
      border: 1px solid var(--line);
      display: grid;
      place-items: center;
      flex-shrink: 0;
    }
    .model-title {
      font-size: 14.5px;
      font-weight: 800;
      color: var(--ink);
      line-height: 1.2;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .badge-row {
      display: flex;
      align-items: center;
      gap: 4px;
      margin-top: 3px;
      flex-wrap: wrap;
    }
    .tag {
      font-size: 9.8px;
      font-weight: 700;
      padding: 1px 5.5px;
      border-radius: 5px;
      white-space: nowrap;
    }
    .tag.open { background: var(--open-bg); color: var(--open-ink); }
    .tag.closed { background: var(--closed-bg); color: var(--closed-ink); }
    .tag.tier { background: rgba(31, 42, 55, 0.08); color: var(--ink); }
    .tag.gold { background: rgba(196, 149, 69, 0.2); color: #7c581c; }
    .tag.silver { background: rgba(120, 139, 161, 0.2); color: #3d4f63; }
    .tag.ingested { background: rgba(16, 185, 129, 0.18); color: #0f5c41; }
    .tag.kw { background: rgba(245, 158, 11, 0.16); color: #92400e; }

    .conf-num {
      font-size: 18px;
      font-weight: 850;
      color: var(--ink);
      letter-spacing: -0.02em;
      flex-shrink: 0;
    }

    .verdict-actions {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 6px;
      margin-top: 8px;
      padding-top: 8px;
      border-top: 1px dashed var(--line);
    }
    .act-btn {
      appearance: none;
      border: 1px solid var(--line-strong);
      background: #f8fafc;
      color: var(--ink-soft);
      font-size: 11px;
      font-weight: 680;
      padding: 4.5px 10px;
      border-radius: 7px;
      cursor: pointer;
      font-family: inherit;
      display: inline-flex;
      align-items: center;
      gap: 4px;
      transition: all 0.14s ease;
    }
    .act-btn:hover { background: #ffffff; color: var(--ink); border-color: #94a3b8; }
    .act-btn.active { background: #2b3b4e; color: #ffffff; border-color: #2b3b4e; }
    .act-btn.correct-btn { color: #1e4b7a; border-color: rgba(43, 76, 111, 0.3); background: rgba(235, 243, 252, 0.65); }
    .act-btn.correct-btn:hover { background: rgba(224, 237, 252, 0.95); }
    .act-btn.correct-btn.active { background: #24466b; color: #ffffff; border-color: #24466b; }

    .toast-inline {
      display: none;
      font-size: 11px;
      font-weight: 650;
      padding: 6px 9px;
      border-radius: 8px;
      background: rgba(16, 185, 129, 0.13);
      border: 1px solid rgba(16, 150, 108, 0.3);
      color: #0f5c41;
    }
    .toast-inline.err {
      background: rgba(239, 68, 68, 0.11);
      border-color: rgba(220, 38, 38, 0.28);
      color: #991b1b;
    }
    .toast-inline.show { display: block; }

    .drawer-card {
      display: none;
      border-radius: 11px;
      padding: 9px 10px;
      background: #ffffff;
      border: 1px solid var(--line-strong);
      flex-direction: column;
      gap: 7px;
    }
    .drawer-card.open { display: flex; }
    .drawer-lbl {
      font-size: 10.2px;
      font-weight: 700;
      color: var(--muted);
      display: flex;
      align-items: center;
      justify-content: space-between;
    }

    .chip-scroll {
      display: flex;
      gap: 4px;
      overflow-x: auto;
      padding-bottom: 2px;
      scrollbar-width: none;
    }
    .chip-scroll::-webkit-scrollbar { display: none; }
    .quick-chip {
      appearance: none;
      border: 1px solid var(--line);
      background: #f4f7fa;
      color: var(--ink);
      font-size: 10.3px;
      font-weight: 650;
      padding: 2.5px 7px;
      border-radius: 999px;
      cursor: pointer;
      white-space: nowrap;
      font-family: inherit;
      flex-shrink: 0;
    }
    .quick-chip:hover { background: #e8eef5; border-color: #94a3b8; }
    .quick-chip.sel { background: #24466b; color: #ffffff; border-color: #24466b; }

    .form-grid-2 {
      display: grid;
      grid-template-columns: 104px 1fr;
      gap: 6px;
    }
    .inp-ctrl {
      width: 100%;
      padding: 5px 7px;
      border-radius: 7px;
      border: 1px solid var(--line-strong);
      background: #f9fbfd;
      color: var(--ink);
      font-size: 11.3px;
      font-weight: 650;
      font-family: inherit;
      outline: none;
    }
    .inp-ctrl:focus { border-color: #3b6b9c; background: #ffffff; }
    .kw-textarea {
      width: 100%;
      height: 50px;
      resize: vertical;
      padding: 5px 7px;
      border-radius: 7px;
      border: 1px solid var(--line-strong);
      background: #f9fbfd;
      color: var(--ink);
      font-size: 10.8px;
      line-height: 1.4;
      font-family: inherit;
      outline: none;
    }
    .chk-line {
      display: flex;
      align-items: center;
      justify-content: space-between;
      font-size: 10.8px;
      color: var(--ink-soft);
    }

    .corr-bottom-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 6px;
    }
    .tier-pick-group {
      display: flex;
      gap: 3px;
      background: #eef2f7;
      padding: 2px;
      border-radius: 7px;
      flex: 1;
    }
    .tier-pick-btn {
      flex: 1;
      appearance: none;
      border: 0;
      background: transparent;
      color: var(--ink-soft);
      font-size: 10px;
      font-weight: 750;
      padding: 4px 2px;
      border-radius: 5px;
      cursor: pointer;
      font-family: inherit;
    }
    .tier-pick-btn.active {
      background: #ffffff;
      color: var(--ink);
      box-shadow: 0 1px 3px rgba(15, 26, 40, 0.1);
    }
    .submit-ingest-btn {
      appearance: none;
      border: 0;
      background: #1f5f4b;
      color: #ffffff;
      font-size: 11.2px;
      font-weight: 720;
      padding: 5.5px 11px;
      border-radius: 7px;
      cursor: pointer;
      white-space: nowrap;
      font-family: inherit;
      transition: opacity 0.15s ease;
    }
    .submit-ingest-btn:hover { opacity: 0.92; }
    .submit-ingest-btn:disabled { opacity: 0.55; cursor: not-allowed; }

    .tier-mini-bar {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 4px;
    }
    .tier-mini-cell {
      text-align: center;
      padding: 3.5px 2px;
      border-radius: 6px;
      background: #f4f7fa;
      border: 1px solid var(--line);
      font-size: 10px;
      color: var(--ink-soft);
    }
    .tier-mini-cell.active {
      background: #eef4fb;
      border-color: rgba(59, 107, 156, 0.45);
      color: var(--ink);
      font-weight: 750;
    }
    .cand-row {
      display: grid;
      grid-template-columns: 18px 1fr auto;
      align-items: center;
      gap: 6px;
      padding: 3px 2px;
      border-radius: 6px;
      cursor: pointer;
    }
    .cand-row:hover { background: #f4f7fb; }
    .cand-name { font-size: 11px; font-weight: 650; color: var(--ink); display: flex; align-items: center; gap: 4px; }
    .prob-track { height: 4px; border-radius: 999px; background: #e6ecf3; overflow: hidden; margin-top: 2px; }
    .prob-fill { height: 100%; border-radius: 999px; background: #5a738e; }
    .cand-pct { font-size: 10.5px; font-weight: 700; color: var(--ink-soft); }
    .vlogo { display: inline-grid; place-items: center; flex-shrink: 0; }

    .minimized-fab {
      display: none;
      align-items: center;
      gap: 7px;
      padding: 6px 12px 6px 7px;
      border-radius: 999px;
      background: rgba(255, 255, 255, 0.95);
      backdrop-filter: blur(18px);
      border: 1px solid #ffffff;
      box-shadow: 0 10px 28px rgba(15, 26, 40, 0.18);
      cursor: pointer;
      pointer-events: auto;
    }
    .minimized-fab.show { display: inline-flex; }

    .lightbox-backdrop {
      position: fixed;
      inset: 0;
      z-index: 2147483647;
      background: rgba(18, 28, 40, 0.52);
      backdrop-filter: blur(12px);
      display: none;
      align-items: center;
      justify-content: center;
      padding: 22px;
      pointer-events: auto;
    }
    .lightbox-backdrop.open { display: flex; }
    .lightbox-dialog {
      width: min(980px, 94vw);
      height: min(680px, 88vh);
      background: #ffffff;
      border-radius: 16px;
      box-shadow: 0 28px 70px rgba(15, 23, 42, 0.32);
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }
    .lightbox-head {
      padding: 10px 15px;
      background: #f8fafc;
      border-bottom: 1px solid var(--line);
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    .lightbox-stage { flex: 1; background: #f8fafc; }
    .lightbox-stage iframe { width: 100%; height: 100%; border: 0; display: block; }
    .close-lb-btn {
      appearance: none;
      border: 0;
      background: #2b3b4e;
      color: #ffffff;
      font-size: 12px;
      font-weight: 650;
      padding: 5.5px 13px;
      border-radius: 7px;
      cursor: pointer;
      font-family: inherit;
    }
  `;

  function ensureUI() {
    if (hostEl) return;
    hostEl = document.createElement("div");
    hostEl.id = "__pelican_model_id_ext_host__";
    shadow = hostEl.attachShadow({ mode: "open" });

    const vendorOptsHtml = SHORT_VENDOR_CATALOG.map(
      (v) => `<option value="${escapeHtml(v.id)}">${escapeHtml(v.id)}</option>`
    ).join("");

    shadow.innerHTML = `
      <style>${SHADOW_CSS}</style>
      <div class="pelican-root" id="pelicanRoot">
        <div class="minimized-fab" id="minimizedFab" title="点击展开鹈鹕鉴定面板">
          <div class="brand-mark">鹈</div>
          <span id="fabText" style="font-size:11.8px;font-weight:720;color:#1f2a37;">已捕获代码 · 点击展开</span>
        </div>

        <div class="ext-window" id="extWin">
          <div class="ext-header" id="dragHandle" title="拖拽移动面板（双击复位右下角）">
            <div class="ext-header-left">
              <div class="brand-mark">鹈</div>
              <span class="win-title">鹈鹕鉴定</span>
              <span class="meta-chip" id="formatChip">就绪</span>
            </div>
            <div class="win-controls">
              <span class="elapsed-lbl" id="elapsedLbl"></span>
              <button class="head-pill-btn" id="btnScanPage" type="button" title="自动扫描并捕获本页全部 SVG / HTML 代码（关键词特征优先）">🔍 本页</button>
              <button class="icon-btn" id="btnToggleKwCfg" type="button" title="页面自动捕获与关键词特征设置">🎯</button>
              <button class="icon-btn" id="btnRefreshClip" type="button" title="强制重读系统剪贴板并刷新">↻</button>
              <button class="icon-btn" id="btnMinimize" type="button" title="最小化">—</button>
              <button class="icon-btn" id="btnClose" type="button" title="关闭">×</button>
            </div>
          </div>

          <div class="scroll-body">
            <!-- 多样本切换条（仅在本页捕获到 >=2 份样本时自动显示，如 Arena 左右盲测对战） -->
            <div class="specimens-bar" id="pageSpecimensBar"></div>

            <!-- 关键词自动捕获快捷配置抽屉（点击右上角 🎯 展开） -->
            <div class="drawer-card" id="kwConfigDrawer">
              <div class="drawer-lbl">
                <span>网页自动捕获与关键词特征</span>
                <button type="button" class="quick-chip" id="btnResetKwDefault">恢复默认词</button>
              </div>
              <div class="chk-line">
                <label for="chkAutoPage" style="cursor:pointer;">自动捕获页面生成的 SVG / HTML</label>
                <input id="chkAutoPage" type="checkbox" checked />
              </div>
              <div class="chk-line">
                <label for="chkKwOnly" style="cursor:pointer;">自动弹出仅限命中关键词特征</label>
                <input id="chkKwOnly" type="checkbox" checked />
              </div>
              <textarea class="kw-textarea" id="inpCaptureKws" spellcheck="false" placeholder="逗号分隔关键词，如：鹈鹕, pelican, 自行车, bicycle..."></textarea>
              <div style="display:flex;justify-content:flex-end;gap:6px;">
                <button type="button" class="submit-ingest-btn" id="btnSaveKwAndScan" style="background:#24466b;">保存并扫描本页</button>
              </div>
            </div>

            <!-- 1. 纯净实时预览舞台 -->
            <div class="preview-stage-wrap">
              <div class="drag-shield"></div>
              <div class="svg-fallback-stage" id="svgFallbackStage"></div>
              <iframe id="previewFrame" title="SVG/HTML 实时预览"></iframe>
              <button class="stage-corner-btn" id="btnOpenLb" type="button" title="放大全屏预览">⤢ 放大</button>
            </div>

            <!-- 2. 极简开源/闭源过滤条 -->
            <div class="pill-group">
              <button class="source-pill-btn active" data-filter="all" type="button">
                <span>全部</span><span class="pill-pct" id="pctAll"></span>
              </button>
              <button class="source-pill-btn" data-filter="open" type="button">
                <span>开源</span><span class="pill-pct" id="pctOpen">--%</span>
              </button>
              <button class="source-pill-btn" data-filter="closed" type="button">
                <span>闭源</span><span class="pill-pct" id="pctClosed">--%</span>
              </button>
            </div>

            <!-- 3. 合一精简鉴定结果卡 -->
            <div class="verdict-card" id="verdictCard">
              <div class="verdict-main">
                <div class="verdict-left">
                  <div class="logo-box" id="heroLogo"></div>
                  <div style="min-width:0;">
                    <div class="model-title" id="heroTitle">正在识别模型...</div>
                    <div class="badge-row" id="heroBadges">
                      <span class="tag closed">读取中</span>
                    </div>
                  </div>
                </div>
                <div class="conf-num" id="confPct">--%</div>
              </div>

              <div class="verdict-actions">
                <button class="act-btn correct-btn" id="btnToggleCorrect" type="button">✎ 纠正 / 入库</button>
                <button class="act-btn" id="btnToggleDetails" type="button">详情 ▾</button>
              </div>
            </div>

            <div class="toast-inline" id="inlineToast"></div>

            <!-- 4. 一键纠正 / 归档入库抽屉 -->
            <div class="drawer-card" id="correctDrawer">
              <div class="drawer-lbl">
                <span>点选候选或手动指定真实模型入库</span>
                <span id="corrModeHint" style="color:#1f5f4b;">归档入库</span>
              </div>
              <div class="chip-scroll" id="candidateQuickChips"></div>

              <div class="form-grid-2">
                <select class="inp-ctrl" id="corrVendorSelect" aria-label="厂商">${vendorOptsHtml}</select>
                <input class="inp-ctrl" id="corrModelInput" type="text" placeholder="输入或点选型号，如 opus-5.5" autocomplete="off" />
              </div>

              <div class="chip-scroll" id="vendorModelChips"></div>

              <div class="corr-bottom-row">
                <div class="tier-pick-group" id="corrTierGroup">
                  <button type="button" class="tier-pick-btn" data-tier="low">LOW</button>
                  <button type="button" class="tier-pick-btn" data-tier="medium">MED</button>
                  <button type="button" class="tier-pick-btn active" data-tier="high">HIGH</button>
                  <button type="button" class="tier-pick-btn" data-tier="max">MAX</button>
                </div>
                <button type="button" class="submit-ingest-btn" id="btnSubmitIngest">确认入库</button>
              </div>
            </div>

            <!-- 5. 按需展开：强度分布 + Top-5 候选 -->
            <div class="drawer-card" id="detailsDrawer">
              <div class="drawer-lbl">
                <span>推理强度概率</span>
                <span id="effortSummaryLbl">--</span>
              </div>
              <div class="tier-mini-bar" id="tierGrid"></div>

              <div class="drawer-lbl" style="margin-top:3px;">
                <span id="candTitle">Top-5 候选模型</span>
                <span style="font-weight:500;">点击可带入纠错</span>
              </div>
              <div id="candBars"></div>
            </div>
          </div>
        </div>
      </div>

      <div class="lightbox-backdrop" id="lbBackdrop">
        <div class="lightbox-dialog">
          <div class="lightbox-head">
            <div style="display:flex;align-items:center;gap:8px;">
              <span id="lbLogo"></span>
              <strong id="lbTitle" style="font-size:14px;color:#1f2a37;">预览</strong>
            </div>
            <button class="close-lb-btn" id="btnCloseLb" type="button">关闭预览</button>
          </div>
          <div class="lightbox-stage">
            <iframe id="lbFrame" title="全屏预览"></iframe>
          </div>
        </div>
      </div>
    `;

    (document.documentElement || document.body).appendChild(hostEl);

    shadow.getElementById("previewFrame").src = chrome.runtime.getURL("sandbox-preview.html?cid=preview");
    shadow.getElementById("lbFrame").src = chrome.runtime.getURL("sandbox-preview.html?cid=lightbox");

    syncKwDrawerUI();
    bindShadowEvents();
  }

  function syncKwDrawerUI() {
    if (!shadow) return;
    shadow.getElementById("chkAutoPage").checked = activeConfig.autoPageCapture !== false;
    shadow.getElementById("chkKwOnly").checked = activeConfig.keywordOnlyAuto !== false;
    shadow.getElementById("inpCaptureKws").value = activeConfig.captureKeywords || DEFAULT_CAPTURE_KEYWORDS;
  }

  function renderPageSpecimensBar() {
    if (!shadow) return;
    const bar = shadow.getElementById("pageSpecimensBar");
    const btnScan = shadow.getElementById("btnScanPage");
    const list = uiState.pageSpecimens || [];

    btnScan.textContent = list.length > 0 ? `🔍 本页 ${list.length}` : "🔍 本页";

    if (list.length <= 1) {
      bar.classList.remove("show");
      bar.innerHTML = "";
      return;
    }

    bar.classList.add("show");
    bar.innerHTML = list
      .map((it, idx) => {
        const kb = (it.code.length / 1024).toFixed(1);
        const kwTag = it.kwHit ? ` 🎯${it.matchedKws[0]}` : "";
        const isAct = it.hash === uiState.currentHash ? "active" : "";
        return `<button type="button" class="spec-tab ${isAct}" data-spec-idx="${idx}" title="${escapeHtml(
          it.origin + (it.matchedKws.length ? " · 命中特征: " + it.matchedKws.join(", ") : "")
        )}">#${idx + 1} ${it.type} ${kb}K${escapeHtml(kwTag)}</button>`;
      })
      .join("");

    bar.querySelectorAll("[data-spec-idx]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const item = list[Number(btn.dataset.specIdx)];
        if (!item) return;
        showWindowAndIdentify(item.code, {
          autoTriggered: false,
          forceRefresh: true,
          originLabel: item.origin,
          matchedKws: item.matchedKws
        });
      });
    });
  }

  let toastTimer = null;
  function showInlineToast(text, isErr = false) {
    if (!shadow) return;
    const el = shadow.getElementById("inlineToast");
    el.textContent = text;
    el.className = `toast-inline show${isErr ? " err" : ""}`;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      el.classList.remove("show");
    }, 4200);
  }

  function syncCorrectionModeLabel() {
    if (!shadow) return;
    const v = shadow.getElementById("corrVendorSelect").value.trim();
    const m = shadow.getElementById("corrModelInput").value.trim();
    const isChanged =
      v.toLowerCase() !== uiState.detectedVendor.toLowerCase() ||
      m.toLowerCase() !== uiState.detectedModel.toLowerCase() ||
      uiState.corrTier !== uiState.detectedTier;

    const hint = shadow.getElementById("corrModeHint");
    const btn = shadow.getElementById("btnSubmitIngest");
    if (isChanged) {
      hint.textContent = "已修改 · 纠错入库";
      hint.style.color = "#b45309";
      if (!uiState.submittingSample) btn.textContent = "纠正并入库";
    } else {
      hint.textContent = "一致 · 确认归档";
      hint.style.color = "#1f5f4b";
      if (!uiState.submittingSample) btn.textContent = "确认入库";
    }
  }

  function renderVendorPresetChips() {
    if (!shadow) return;
    const vendor = shadow.getElementById("corrVendorSelect").value;
    const curModel = shadow.getElementById("corrModelInput").value.trim().toLowerCase();
    const extra = uiState.currentVerdict && uiState.currentVerdict.allModels ? uiState.currentVerdict.allModels : [];
    const models = getModelsForVendor(vendor, extra);

    const wrap = shadow.getElementById("vendorModelChips");
    if (!models.length) {
      wrap.style.display = "none";
      wrap.innerHTML = "";
      return;
    }
    wrap.style.display = "flex";
    wrap.innerHTML = models
      .slice(0, 12)
      .map(
        (m) =>
          `<button type="button" class="quick-chip ${m.toLowerCase() === curModel ? "sel" : ""}" data-preset-model="${escapeHtml(m)}">${escapeHtml(m)}</button>`
      )
      .join("");

    wrap.querySelectorAll("[data-preset-model]").forEach((btn) => {
      btn.addEventListener("click", () => {
        shadow.getElementById("corrModelInput").value = btn.dataset.presetModel;
        renderVendorPresetChips();
        syncCorrectionModeLabel();
      });
    });
  }

  function applyCorrectionSelection(vendorRaw, labelOrShortModel, tierOpt) {
    if (!shadow) return;
    const sp = splitToShortVendorAndModel(vendorRaw, labelOrShortModel);
    const vSel = shadow.getElementById("corrVendorSelect");
    const hasOpt = Array.from(vSel.options).some((o) => o.value.toLowerCase() === sp.shortVendor.toLowerCase());
    vSel.value = hasOpt ? SHORT_VENDOR_CATALOG.find((x) => x.id.toLowerCase() === sp.shortVendor.toLowerCase()).id : "Other";
    shadow.getElementById("corrModelInput").value = sp.shortModel;
    if (tierOpt && TIER_ORDER.includes(tierOpt)) {
      uiState.corrTier = tierOpt;
      shadow.querySelectorAll("#corrTierGroup .tier-pick-btn").forEach((b) => {
        b.classList.toggle("active", b.dataset.tier === uiState.corrTier);
      });
    }
    renderVendorPresetChips();
    syncCorrectionModeLabel();
  }

  async function executeManualPageScanAndOpen() {
    ensureUI();
    pingSubframesForSpecimens();
    // Wait briefly so any cross-frame postMessage specimen arrives
    await new Promise((r) => setTimeout(r, 85));
    const found = scanPageSpecimens({ requireComplete: false });
    uiState.pageSpecimens = found;
    renderPageSpecimensBar();

    if (found.length > 0) {
      const top = found[0];
      await showWindowAndIdentify(top.code, {
        autoTriggered: false,
        forceRefresh: true,
        originLabel: top.origin,
        matchedKws: top.matchedKws
      });
      if (found.length > 1) {
        showInlineToast(`✓ 本页共捕获 ${found.length} 份代码（可在顶部标签切换）`);
      }
      return found;
    } else {
      uiState.visible = true;
      uiState.minimized = false;
      shadow.getElementById("minimizedFab").classList.remove("show");
      shadow.getElementById("extWin").classList.add("show");
      showInlineToast("当前页面未检测到可渲染的 SVG 或 HTML 代码", true);
      return [];
    }
  }

  function bindShadowEvents() {
    const win = shadow.getElementById("extWin");
    const fab = shadow.getElementById("minimizedFab");
    const handle = shadow.getElementById("dragHandle");
    const root = shadow.getElementById("pelicanRoot");

    // Dragging
    let dragging = false, startX = 0, startY = 0, dx = 0, dy = 0;
    handle.addEventListener("mousedown", (e) => {
      if (e.target.closest("button")) return;
      dragging = true;
      startX = e.clientX - dx;
      startY = e.clientY - dy;
      win.classList.add("dragging");
    });
    window.addEventListener("mousemove", (e) => {
      if (!dragging) return;
      dx = e.clientX - startX;
      dy = e.clientY - startY;
      root.style.transform = `translate(${dx}px, ${dy}px)`;
    });
    window.addEventListener("mouseup", () => {
      if (!dragging) return;
      dragging = false;
      win.classList.remove("dragging");
    });
    handle.addEventListener("dblclick", () => {
      dx = 0; dy = 0;
      root.style.transform = "";
    });

    // Scan Page Button
    shadow.getElementById("btnScanPage").addEventListener("click", () => {
      executeManualPageScanAndOpen();
    });

    // Toggle Keyword Config Drawer
    const btnKw = shadow.getElementById("btnToggleKwCfg");
    btnKw.addEventListener("click", () => {
      uiState.kwDrawerOpen = !uiState.kwDrawerOpen;
      shadow.getElementById("kwConfigDrawer").classList.toggle("open", uiState.kwDrawerOpen);
      btnKw.classList.toggle("active", uiState.kwDrawerOpen);
      if (uiState.kwDrawerOpen) syncKwDrawerUI();
    });

    shadow.getElementById("btnResetKwDefault").addEventListener("click", () => {
      shadow.getElementById("inpCaptureKws").value = DEFAULT_CAPTURE_KEYWORDS;
    });

    shadow.getElementById("btnSaveKwAndScan").addEventListener("click", async () => {
      const nextPatch = {
        autoPageCapture: shadow.getElementById("chkAutoPage").checked,
        keywordOnlyAuto: shadow.getElementById("chkKwOnly").checked,
        captureKeywords: shadow.getElementById("inpCaptureKws").value.trim() || DEFAULT_CAPTURE_KEYWORDS
      };
      activeConfig = { ...activeConfig, ...nextPatch };
      uiState.kwDrawerOpen = false;
      shadow.getElementById("kwConfigDrawer").classList.remove("open");
      btnKw.classList.remove("active");
      try {
        await chrome.runtime.sendMessage({ type: "SAVE_CONFIG", patch: nextPatch });
      } catch (_) {}
      await executeManualPageScanAndOpen();
    });

    // Manual Refresh Clipboard Button
    shadow.getElementById("btnRefreshClip").addEventListener("click", async () => {
      try {
        const raw = await chrome.runtime.sendMessage({ type: "READ_RAW_CLIPBOARD" });
        if (raw && raw.ok && raw.hasCode && raw.code) {
          lastKnownOsClipHash = raw.hash || "";
          showWindowAndIdentify(raw.code, { autoTriggered: false, forceRefresh: true, originLabel: "剪贴板" });
        } else if (uiState.currentCode) {
          deliverToSandbox("previewFrame", "preview", uiState.currentCode);
        }
      } catch (_) {}
    });

    // Source Filter Pills
    shadow.querySelectorAll(".source-pill-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const target = btn.dataset.filter;
        uiState.sourceFilter = uiState.sourceFilter === target && target !== "all" ? "all" : target;
        syncPillButtons();
        renderVerdictUI();
        chrome.runtime.sendMessage({
          type: "SAVE_CONFIG",
          patch: { sourceFilter: uiState.sourceFilter }
        }).catch(() => {});
      });
    });

    // Toggle Correction Drawer
    const btnCorrect = shadow.getElementById("btnToggleCorrect");
    btnCorrect.addEventListener("click", () => {
      uiState.correctOpen = !uiState.correctOpen;
      shadow.getElementById("correctDrawer").classList.toggle("open", uiState.correctOpen);
      btnCorrect.classList.toggle("active", uiState.correctOpen);
    });

    // Toggle Details Drawer
    const btnDetails = shadow.getElementById("btnToggleDetails");
    btnDetails.addEventListener("click", () => {
      uiState.detailsOpen = !uiState.detailsOpen;
      shadow.getElementById("detailsDrawer").classList.toggle("open", uiState.detailsOpen);
      btnDetails.classList.toggle("active", uiState.detailsOpen);
      btnDetails.textContent = uiState.detailsOpen ? "收起 ▴" : "详情 ▾";
    });

    // Vendor / Model / Tier controls
    shadow.getElementById("corrVendorSelect").addEventListener("change", (e) => {
      const models = getModelsForVendor(e.target.value, uiState.currentVerdict?.allModels);
      if (models.length) {
        shadow.getElementById("corrModelInput").value = models[0];
      }
      renderVendorPresetChips();
      syncCorrectionModeLabel();
    });

    shadow.getElementById("corrModelInput").addEventListener("input", () => {
      renderVendorPresetChips();
      syncCorrectionModeLabel();
    });

    shadow.querySelectorAll("#corrTierGroup .tier-pick-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        uiState.corrTier = btn.dataset.tier;
        shadow.querySelectorAll("#corrTierGroup .tier-pick-btn").forEach((b) => {
          b.classList.toggle("active", b.dataset.tier === uiState.corrTier);
        });
        syncCorrectionModeLabel();
      });
    });

    // Submit Correction / Archive
    shadow.getElementById("btnSubmitIngest").addEventListener("click", async () => {
      if (uiState.submittingSample || !uiState.currentCode) return;
      const vendor = shadow.getElementById("corrVendorSelect").value.trim();
      const model = shadow.getElementById("corrModelInput").value.trim();
      const tier = uiState.corrTier || "high";
      if (!model) {
        showInlineToast("请输入或点选正确的模型型号", true);
        return;
      }

      const isCorrection =
        vendor.toLowerCase() !== uiState.detectedVendor.toLowerCase() ||
        model.toLowerCase() !== uiState.detectedModel.toLowerCase() ||
        tier !== uiState.detectedTier;

      const submitBtn = shadow.getElementById("btnSubmitIngest");
      uiState.submittingSample = true;
      submitBtn.disabled = true;
      submitBtn.textContent = "入库中...";

      try {
        const res = await chrome.runtime.sendMessage({
          type: "SUBMIT_SAMPLE",
          code: uiState.currentCode,
          codeType: uiState.currentType,
          vendor,
          model,
          tier,
          isCorrection,
          baseVerdict: uiState.currentVerdict
        });

        if (res && res.ok) {
          if (res.verdict) {
            uiState.currentVerdict = res.verdict;
            renderVerdictUI();
          }
          uiState.correctOpen = false;
          shadow.getElementById("correctDrawer").classList.remove("open");
          shadow.getElementById("btnToggleCorrect").classList.remove("active");
          showInlineToast(
            `✓ 已${isCorrection ? "纠错" : "归档"}入库：${res.displayModel} (${tier.toUpperCase()})`
          );
        } else {
          showInlineToast((res && res.error) || "入库失败，请检查网络或密钥设置", true);
        }
      } catch (err) {
        showInlineToast(`入库异常：${err.message || err}`, true);
      } finally {
        uiState.submittingSample = false;
        submitBtn.disabled = false;
        syncCorrectionModeLabel();
      }
    });

    // Minimize / Restore / Close
    shadow.getElementById("btnMinimize").addEventListener("click", () => {
      uiState.minimized = true;
      win.classList.remove("show");
      fab.classList.add("show");
    });
    fab.addEventListener("click", () => {
      uiState.minimized = false;
      fab.classList.remove("show");
      win.classList.add("show");
      if (uiState.currentCode) {
        deliverToSandbox("previewFrame", "preview", uiState.currentCode);
      }
    });
    shadow.getElementById("btnClose").addEventListener("click", () => {
      uiState.visible = false;
      uiState.minimized = false;
      win.classList.remove("show");
      fab.classList.remove("show");
    });

    // Fullscreen Lightbox
    const lb = shadow.getElementById("lbBackdrop");
    shadow.getElementById("btnOpenLb").addEventListener("click", () => {
      lb.classList.add("open");
      deliverToSandbox("lbFrame", "lightbox", uiState.currentCode);
      shadow.getElementById("lbTitle").textContent = shadow.getElementById("heroTitle").textContent;
      shadow.getElementById("lbLogo").innerHTML = shadow.getElementById("heroLogo").innerHTML;
    });
    shadow.getElementById("btnCloseLb").addEventListener("click", () => lb.classList.remove("open"));
    lb.addEventListener("click", (e) => {
      if (e.target === lb) lb.classList.remove("open");
    });
  }

  function syncPillButtons() {
    if (!shadow) return;
    shadow.querySelectorAll(".source-pill-btn").forEach((b) => {
      b.classList.toggle("active", b.dataset.filter === uiState.sourceFilter);
    });
  }

  function renderVerdictUI() {
    if (!shadow || !uiState.currentVerdict) return;
    const res = uiState.currentVerdict;
    const calc = computeFilteredVerdict(res, uiState.sourceFilter);
    if (!calc) return;

    const { rawList, filtered, poolSum, openSharePct, closedSharePct, overallTop, activeTop, probPct, exactHit } = calc;

    shadow.getElementById("pctAll").textContent = `${rawList.length}`;
    shadow.getElementById("pctOpen").textContent = `${openSharePct}%`;
    shadow.getElementById("pctClosed").textContent = `${closedSharePct}%`;

    const rarity = activeTop.rarity || "normal";
    const rank = activeTop.arenaRank || null;
    const tierKey = TIER_ORDER.includes(res.effortTier) ? res.effortTier : "high";
    const tierStr = TIER_SHORT[tierKey] || tierKey.toUpperCase();

    const card = shadow.getElementById("verdictCard");
    card.className = `verdict-card rarity-${rarity}`;
    shadow.getElementById("heroLogo").innerHTML = getVendorLogoSvg(activeTop.vendor || activeTop.label, 24);
    shadow.getElementById("heroTitle").textContent = activeTop.label;
    shadow.getElementById("confPct").textContent = `${probPct}%`;

    const badges = [];
    if (rarity === "gold") badges.push(`<span class="tag gold">🥇 #${rank || 1}</span>`);
    else if (rarity === "silver") badges.push(`<span class="tag silver">🥈 #${rank || 4}</span>`);
    badges.push(`<span class="tag ${activeTop.isOpen ? "open" : "closed"}">${activeTop.isOpen ? "开源" : "闭源"}</span>`);
    badges.push(`<span class="tag tier">强度 ${tierStr}</span>`);
    if (uiState.currentMatchedKws && uiState.currentMatchedKws.length > 0) {
      const kwBrief = uiState.currentMatchedKws.slice(0, 2).join("·");
      const kwMore = uiState.currentMatchedKws.length > 2 ? `+${uiState.currentMatchedKws.length - 2}` : "";
      badges.push(
        `<span class="tag kw" title="命中关键词特征: ${escapeHtml(uiState.currentMatchedKws.join(", "))}">🎯 ${escapeHtml(kwBrief + kwMore)}</span>`
      );
    }
    if (res.userIngested) {
      badges.push(`<span class="tag ingested">✓ 已${res.userIngested.isCorrection ? "纠错" : "归档"}入库</span>`);
    } else if (exactHit && activeTop.id === overallTop.id) {
      badges.push(`<span class="tag ingested">馆藏命中</span>`);
    }
    shadow.getElementById("heroBadges").innerHTML = badges.join("");

    // Sync default detected model into Correction Drawer
    const detSplit = splitToShortVendorAndModel(activeTop.vendor, activeTop.label);
    uiState.detectedVendor = detSplit.shortVendor;
    uiState.detectedModel = detSplit.shortModel;
    uiState.detectedTier = tierKey;
    applyCorrectionSelection(activeTop.vendor, activeTop.label, tierKey);

    // Quick-pick chips
    const quickCands = filtered.slice(0, 4);
    const qcWrap = shadow.getElementById("candidateQuickChips");
    qcWrap.innerHTML = quickCands
      .map((m, i) => `<button type="button" class="quick-chip" data-cand-idx="${i}">${escapeHtml(m.label)}</button>`)
      .join("");
    qcWrap.querySelectorAll("[data-cand-idx]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const chosen = quickCands[Number(btn.dataset.candIdx)];
        if (chosen) applyCorrectionSelection(chosen.vendor, chosen.label, uiState.corrTier);
      });
    });

    // Collapsible Details
    const tierMap = {};
    (res.tierProbabilities || []).forEach((tp) => { tierMap[tp.tier] = tp.probability; });
    const effConf = res.effortConfidence ?? tierMap[tierKey] ?? 0;
    shadow.getElementById("effortSummaryLbl").textContent = `${tierStr} (${Math.round(effConf * 100)}%)`;

    shadow.getElementById("tierGrid").innerHTML = TIER_ORDER.map((t) => {
      const p = (tierMap[t] || 0) * 100;
      return `<div class="tier-mini-cell ${t === tierKey ? "active" : ""}">${TIER_SHORT[t]} ${p.toFixed(0)}%</div>`;
    }).join("");

    shadow.getElementById("candTitle").textContent =
      uiState.sourceFilter === "open" ? "开源候选 Top-5" : uiState.sourceFilter === "closed" ? "闭源候选 Top-5" : "全库候选 Top-5";

    const top5 = filtered.slice(0, 5);
    shadow.getElementById("candBars").innerHTML = top5
      .map((m, idx) => {
        const normP =
          uiState.sourceFilter === "all"
            ? (Number(m.probability) || 0) * 100
            : poolSum > 0.0005
            ? ((Number(m.probability) || 0) / poolSum) * 100
            : 0;
        const pct = Math.min(100, Math.max(0, normP));
        const fillCol = m.isOpen ? "#2b7a61" : "#4f6d8a";
        return `<div class="cand-row" data-pick-top="${idx}" title="点击将该模型填入纠错栏">
          ${getVendorLogoSvg(m.vendor || m.label, 17)}
          <div>
            <div class="cand-name"><span>${escapeHtml(m.label)}</span></div>
            <div class="prob-track"><div class="prob-fill" style="width:${pct.toFixed(1)}%;background:${fillCol};"></div></div>
          </div>
          <div class="cand-pct">${pct.toFixed(1)}%</div>
        </div>`;
      })
      .join("");

    shadow.querySelectorAll("[data-pick-top]").forEach((row) => {
      row.addEventListener("click", () => {
        const picked = top5[Number(row.dataset.pickTop)];
        if (!picked) return;
        uiState.correctOpen = true;
        shadow.getElementById("correctDrawer").classList.add("open");
        shadow.getElementById("btnToggleCorrect").classList.add("active");
        applyCorrectionSelection(picked.vendor, picked.label, uiState.corrTier);
      });
    });

    shadow.getElementById("fabText").textContent = `${activeTop.label} · ${tierStr} (${probPct}%)`;
  }

  async function showWindowAndIdentify(rawCode, opts = {}) {
    const autoTriggered = opts.autoTriggered !== false;
    const forceRefresh = Boolean(opts.forceRefresh);
    const parsed = extractRenderableCode(rawCode);
    if (!parsed) return;

    const h = fastHash(parsed.code);
    const now = Date.now();
    if (!forceRefresh && h === lastTriggerHash && now - lastTriggerTs < 180) return;
    if (forceRefresh && h === lastTriggerHash && now - lastTriggerTs < 90) return;
    lastTriggerHash = h;
    lastTriggerTs = now;

    const myReqSeq = ++identifySeq;

    try {
      const st = await chrome.runtime.sendMessage({ type: "GET_STATE" });
      if (myReqSeq !== identifySeq) return;
      if (st && st.config) {
        activeConfig = { ...activeConfig, ...st.config };
        if (autoTriggered && !opts.originLabel && activeConfig.autoPopup === false) return;
        uiState.sourceFilter = activeConfig.sourceFilter || "all";
      }
    } catch (_) {}

    const kwRes = matchKeywordFeatures(parsed.code, activeConfig.captureKeywords);
    const matchedKws = Array.isArray(opts.matchedKws) ? opts.matchedKws : kwRes.matched;

    ensureUI();
    syncPillButtons();

    uiState.visible = true;
    uiState.minimized = false;
    uiState.currentCode = parsed.code;
    uiState.currentHash = h;
    uiState.currentType = parsed.type;
    uiState.currentOrigin = opts.originLabel || "";
    uiState.currentMatchedKws = matchedKws;
    autoCapturedPageHashes.add(h);

    renderPageSpecimensBar();

    const win = shadow.getElementById("extWin");
    const fab = shadow.getElementById("minimizedFab");
    fab.classList.remove("show");
    win.classList.add("show");
    shadow.getElementById("inlineToast").classList.remove("show");

    const kb = (parsed.code.length / 1024).toFixed(1);
    const prefix = uiState.currentOrigin ? `${uiState.currentOrigin} · ` : "";
    shadow.getElementById("formatChip").textContent = `${prefix}${parsed.type} ${kb}K`;
    shadow.getElementById("elapsedLbl").textContent = "识别中...";
    shadow.getElementById("heroTitle").textContent = "正在识别模型...";

    deliverToSandbox("previewFrame", "preview", parsed.code);

    try {
      const res = await chrome.runtime.sendMessage({
        type: "IDENTIFY_CODE",
        code: parsed.code,
        autoTriggered: false
      });

      if (myReqSeq !== identifySeq) return;

      if (res && res.ok && res.verdict) {
        uiState.currentVerdict = res.verdict;
        shadow.getElementById("elapsedLbl").textContent = `${res.verdict.elapsedMs || 10}ms`;
        renderVerdictUI();
      } else {
        shadow.getElementById("elapsedLbl").textContent = "异常";
        shadow.getElementById("heroTitle").textContent = "识别请求失败";
        shadow.getElementById("heroBadges").innerHTML = `<span class="tag closed">${escapeHtml((res && res.error) || "请检查网络或配置")}</span>`;
      }
    } catch (_) {
      if (myReqSeq !== identifySeq) return;
      shadow.getElementById("elapsedLbl").textContent = "需刷新网页";
      shadow.getElementById("heroTitle").textContent = "插件已更新，请按 F5 刷新网页";
    }
  }

  // Unified Copy-Gesture Clipboard Poller
  function pollClipboardForCopyGesture(fallbackSelection = "") {
    const myGesture = ++gestureSeq;
    const gestureStartTs = Date.now();
    const baselineHash = lastKnownOsClipHash || uiState.currentHash || "";
    let resolved = false;

    const delays = [65, 200, 460, 880];
    delays.forEach((delay, idx) => {
      setTimeout(async () => {
        if (resolved || myGesture !== gestureSeq) return;
        if (lastHookHandledTs >= gestureStartTs - 35) {
          resolved = true;
          return;
        }
        try {
          const raw = await chrome.runtime.sendMessage({ type: "READ_RAW_CLIPBOARD" });
          if (resolved || myGesture !== gestureSeq || lastHookHandledTs >= gestureStartTs - 35) return;

          if (raw && raw.ok) {
            if (raw.hash) lastKnownOsClipHash = raw.hash;
            if (raw.hasCode && raw.code) {
              if (raw.hash !== baselineHash || idx >= 2) {
                resolved = true;
                await showWindowAndIdentify(raw.code, { autoTriggered: true, forceRefresh: true });
                return;
              }
            }
          }

          if (idx === delays.length - 1 && !resolved && fallbackSelection && extractRenderableCode(fallbackSelection)) {
            resolved = true;
            await showWindowAndIdentify(fallbackSelection, { autoTriggered: true, forceRefresh: true });
          }
        } catch (_) {}
      }, delay);
    });
  }

  // ==================== CLIPBOARD LISTENERS ====================
  window.addEventListener("message", (ev) => {
    const d = ev && ev.data;
    if (!d || d.source !== "__PELICAN_EXT_CLIPBOARD__" || typeof d.text !== "string") return;
    const parsed = extractRenderableCode(d.text);
    if (!parsed) return;

    lastHookHandledTs = Date.now();
    lastKnownOsClipHash = fastHash(parsed.code);
    showWindowAndIdentify(parsed.code, { autoTriggered: true, forceRefresh: true });

    setTimeout(async () => {
      try {
        const raw = await chrome.runtime.sendMessage({ type: "READ_RAW_CLIPBOARD" });
        if (raw && raw.ok && raw.hasCode && raw.hash) {
          lastKnownOsClipHash = raw.hash;
          if (raw.hash !== uiState.currentHash) {
            showWindowAndIdentify(raw.code, { autoTriggered: true, forceRefresh: true });
          }
        }
      } catch (_) {}
    }, 240);
  });

  document.addEventListener("copy", () => {
    const selFallback = window.getSelection ? window.getSelection().toString() : "";
    pollClipboardForCopyGesture(selFallback);
  }, false);

  function isLikelyCopyButton(target) {
    if (!target || typeof target.closest !== "function") return false;
    const btn = target.closest("button, [role='button'], a, [data-clipboard-text], [class*='copy'], [class*='Copy']");
    if (!btn) return false;
    if (hostEl && hostEl.contains(btn)) return false;
    const hint = [
      btn.textContent || "",
      btn.getAttribute("aria-label") || "",
      btn.getAttribute("title") || "",
      btn.getAttribute("data-tooltip") || "",
      btn.className || ""
    ].join(" ");
    return /copy|复制|拷贝|clipboard/i.test(hint);
  }

  document.addEventListener("click", (ev) => {
    if (!isLikelyCopyButton(ev.target)) return;
    pollClipboardForCopyGesture("");
  }, true);

  function checkOnReturnToTab() {
    setTimeout(async () => {
      try {
        const res = await chrome.runtime.sendMessage({
          type: "CHECK_SYSTEM_CLIPBOARD",
          autoTriggered: true,
          onlyIfChanged: true
        });
        if (res && res.ok && res.verdict && res.code) {
          lastKnownOsClipHash = res.hash || fastHash(res.code);
          const st = await chrome.runtime.sendMessage({ type: "GET_STATE" });
          if (st && st.config) {
            activeConfig = { ...activeConfig, ...st.config };
            uiState.sourceFilter = activeConfig.sourceFilter || "all";
          }
          const kwRes = matchKeywordFeatures(res.code, activeConfig.captureKeywords);
          ensureUI();
          syncPillButtons();
          uiState.visible = true;
          uiState.minimized = false;
          uiState.currentCode = res.code;
          uiState.currentHash = lastKnownOsClipHash;
          uiState.currentType = res.codeType || "SVG";
          uiState.currentOrigin = "剪贴板";
          uiState.currentMatchedKws = kwRes.matched;
          uiState.currentVerdict = res.verdict;
          const win = shadow.getElementById("extWin");
          shadow.getElementById("minimizedFab").classList.remove("show");
          win.classList.add("show");
          shadow.getElementById("formatChip").textContent = `${uiState.currentType} · ${(res.code.length / 1024).toFixed(1)}K`;
          shadow.getElementById("elapsedLbl").textContent = `${res.verdict.elapsedMs || 10}ms`;
          deliverToSandbox("previewFrame", "preview", res.code);
          renderVerdictUI();
        }
      } catch (_) {}
    }, 90);
  }

  window.addEventListener("focus", checkOnReturnToTab);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") checkOnReturnToTab();
  });

  // Messages from Background / Popup
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || !msg.type) return false;

    if (msg.type === "SHOW_PELICAN_FLOATING_PREVIEW" && msg.code) {
      showWindowAndIdentify(msg.code, { autoTriggered: false, forceRefresh: true });
      sendResponse({ ok: true });
      return false;
    }

    if (msg.type === "TRIGGER_PAGE_SCAN_UI") {
      executeManualPageScanAndOpen().then((found) => {
        sendResponse({ ok: true, count: found.length });
      });
      return true;
    }

    if (msg.type === "SCAN_PAGE_SPECIMENS") {
      (async () => {
        pingSubframesForSpecimens();
        await new Promise((r) => setTimeout(r, 85));
        const found = scanPageSpecimens({ requireComplete: false });
        uiState.pageSpecimens = found;
        if (shadow) renderPageSpecimensBar();
        sendResponse({
          ok: true,
          specimens: found.map((x) => ({
            hash: x.hash,
            type: x.type,
            code: x.code,
            origin: x.origin,
            kwHit: x.kwHit,
            matchedKws: x.matchedKws
          }))
        });
      })();
      return true;
    }

    if (msg.type === "TOGGLE_PELICAN_WINDOW") {
      ensureUI();
      const win = shadow.getElementById("extWin");
      const isShown = win.classList.contains("show");
      if (isShown) {
        win.classList.remove("show");
        uiState.visible = false;
      } else {
        shadow.getElementById("minimizedFab").classList.remove("show");
        win.classList.add("show");
        uiState.visible = true;
        if (uiState.currentCode) {
          deliverToSandbox("previewFrame", "preview", uiState.currentCode);
        }
      }
      sendResponse({ ok: true });
      return false;
    }
    return false;
  });

  // Sync config & latest verdict updates across Popup and Webpage Panel
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes.pelican_ext_config_v1 && changes.pelican_ext_config_v1.newValue) {
      activeConfig = { ...activeConfig, ...changes.pelican_ext_config_v1.newValue };
      const nextFilter = activeConfig.sourceFilter || "all";
      if (nextFilter !== uiState.sourceFilter) {
        uiState.sourceFilter = nextFilter;
        syncPillButtons();
        renderVerdictUI();
      }
      syncKwDrawerUI();
    }
    if (changes.pelican_ext_latest_v1 && changes.pelican_ext_latest_v1.newValue) {
      const latest = changes.pelican_ext_latest_v1.newValue;
      if (uiState.visible && latest.hash === uiState.currentHash && latest.verdict && latest.verdict.userIngested) {
        uiState.currentVerdict = latest.verdict;
        renderVerdictUI();
      }
    }
  });
})();
