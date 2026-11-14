(function () {
  "use strict";
  // Only run inside child frames (top frame runs full content.js)
  if (window === window.top) return;
  if (window.__pelicanSubframeScannerLoaded) return;
  window.__pelicanSubframeScannerLoaded = true;
  if (location.protocol === "chrome-extension:") return;

  const { extractRenderableCode, isCompleteSpecimenCode } = window.PelicanShared || {};
  if (!extractRenderableCode) return;

  let lastReportedHash = "";
  let settleTimer = null;

  function simpleHash(s) {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return (h >>> 0).toString(16) + "_" + s.length;
  }

  function isLikelyArtifactPreviewFrame() {
    const href = String(location.href || "");
    if (href.startsWith("about:srcdoc") || href.startsWith("about:blank") || href.startsWith("blob:") || href.startsWith("data:")) {
      return true;
    }
    const host = String(location.hostname || "").toLowerCase();
    if (
      host.endsWith(".claudeusercontent.com") ||
      host.endsWith(".usercontent.goog") ||
      host.endsWith(".e2b.app") ||
      host.endsWith(".webcontainer.io") ||
      host.includes("sandbox") ||
      host.includes("preview")
    ) {
      return true;
    }
    return false;
  }

  function collectSubframeSpecimens() {
    const found = [];

    // 1. Code blocks inside child frame
    const codeNodes = document.querySelectorAll("pre code, pre, textarea");
    for (let i = 0; i < codeNodes.length; i++) {
      const el = codeNodes[i];
      const raw = typeof el.value === "string" ? el.value : el.textContent || "";
      if (raw.length < 60 || raw.length > 3000000) continue;
      const parsed = extractRenderableCode(raw);
      if (parsed && isCompleteSpecimenCode(parsed)) {
        found.push({ type: parsed.type, code: parsed.code, origin: "子帧代码块" });
      }
    }

    // 2. If this subframe itself IS a rendered SVG/HTML artifact preview (e.g. about:srcdoc / Claude Artifact / Sandbox)
    if (isLikelyArtifactPreviewFrame() && document.documentElement) {
      const svgs = document.querySelectorAll("svg");
      const canvases = document.querySelectorAll("canvas");
      let bigSvgShapes = 0;
      for (let i = 0; i < svgs.length; i++) {
        bigSvgShapes += svgs[i].querySelectorAll("path,circle,ellipse,rect,line,polygon,polyline").length;
      }
      const hasVisualStage = bigSvgShapes >= 4 || canvases.length > 0;
      if (hasVisualStage) {
        if (document.documentElement.tagName.toLowerCase() === "svg") {
          const svgOut = document.documentElement.outerHTML;
          if (svgOut.length >= 80 && svgOut.length <= 2500000) {
            found.push({ type: "SVG", code: svgOut, origin: "子帧SVG" });
          }
        } else {
          const docHtml = "<!DOCTYPE html>\n" + document.documentElement.outerHTML;
          if (!docHtml.includes("__tihu_fit_css") && docHtml.length >= 80 && docHtml.length <= 2500000) {
            found.push({ type: "HTML", code: docHtml, origin: "子帧预览" });
          }
        }
      }
    }

    return found;
  }

  function reportToTop(manualScan) {
    try {
      const list = collectSubframeSpecimens();
      if (!list.length) return;
      const sig = list.map((x) => simpleHash(x.code)).join("|");
      if (!manualScan && sig === lastReportedHash) return;
      lastReportedHash = sig;

      window.top.postMessage(
        {
          source: "__PELICAN_SUBFRAME_SPECIMENS__",
          manualScan: Boolean(manualScan),
          items: list
        },
        "*"
      );
    } catch (_) {}
  }

  window.addEventListener("message", (ev) => {
    const d = ev && ev.data;
    if (d && d.source === "__PELICAN_SCAN_SUBFRAMES_REQ__") {
      reportToTop(true);
    }
  });

  function scheduleAutoReport() {
    if (!isLikelyArtifactPreviewFrame()) return;
    if (settleTimer) clearTimeout(settleTimer);
    settleTimer = setTimeout(() => reportToTop(false), 950);
  }

  if (document.readyState === "complete") {
    scheduleAutoReport();
  } else {
    window.addEventListener("load", scheduleAutoReport);
  }

  if (isLikelyArtifactPreviewFrame() && typeof MutationObserver !== "undefined" && document.documentElement) {
    const obs = new MutationObserver(scheduleAutoReport);
    obs.observe(document.documentElement, { childList: true, subtree: true });
  }
})();
