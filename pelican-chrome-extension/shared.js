(function (root) {
  "use strict";

  const DEFAULT_API_BASE = "https://th.629717.cc.cd";
  const DEFAULT_API_KEY = "1234567890";
  const TIER_ORDER = ["low", "medium", "high", "max"];
  const TIER_CN = { low: "低 Low", medium: "中 Med", high: "高 High", max: "极高 Max" };

  let svgLogoUid = 0;

  function escapeHtml(s) {
    return String(s || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function fastHash(str) {
    let h = 2166136261;
    const s = String(str || "");
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return (h >>> 0).toString(16) + "_" + s.length;
  }

  function parseSingleCodeBlock(candidate) {
    if (!candidate || typeof candidate !== "string") return null;
    const txt = candidate.trim();
    if (txt.length < 24 || txt.length > 3500000) return null;

    // 1. Full HTML document: cleanly slice from <!DOCTYPE html or <html to last </html> if present
    const doctypeIdx = txt.search(/<!doctype\s+html/i);
    const htmlOpenIdx = txt.search(/<html[\s>]/i);
    const startIdx = doctypeIdx >= 0 ? doctypeIdx : htmlOpenIdx;
    if (startIdx >= 0) {
      const lower = txt.toLowerCase();
      const endTagIdx = lower.lastIndexOf("</html>");
      if (endTagIdx > startIdx) {
        return { type: "HTML", code: txt.slice(startIdx, endTagIdx + 7).trim() };
      }
      return { type: "HTML", code: txt.slice(startIdx).trim() };
    }

    // 2. HTML snippet containing <svg> plus <style> / <script> / <body> / <div>
    if (/<(body|style|script|head|canvas)[\s>]/i.test(txt) && /<svg[\s>][\s\S]*<\/svg>/i.test(txt)) {
      return { type: "HTML", code: txt };
    }

    // 3. Interactive HTML/Canvas snippet without <html> wrapper (must have closing tags and visual/style/script structure)
    if (
      /^<(div|section|main|style|canvas|header)[\s>]/i.test(txt) &&
      /<(style|canvas|script)[\s>]/i.test(txt) &&
      /<\/(div|section|main|style|canvas|script)>/i.test(txt)
    ) {
      return { type: "HTML", code: txt };
    }

    // 4. Standalone SVG (supports <?xml ...?> and <!DOCTYPE svg ...> headers, takes from first <svg to last </svg>)
    const svgStart = txt.search(/(?:<\?xml[\s\S]*?\?>\s*)?(?:<!doctype\s+svg[\s\S]*?>\s*)?<svg[\s>]/i);
    if (svgStart >= 0) {
      const lower = txt.toLowerCase();
      const svgEnd = lower.lastIndexOf("</svg>");
      if (svgEnd > svgStart) {
        return { type: "SVG", code: txt.slice(svgStart, svgEnd + 6).trim() };
      }
    }

    return null;
  }

  // Extract valid SVG or HTML code from clipboard text (supports multiple Markdown ```html / ```svg fences)
  function extractRenderableCode(rawText) {
    if (!rawText || typeof rawText !== "string") return null;
    const raw = rawText.trim();
    if (raw.length < 24 || raw.length > 3500000) return null;

    // If raw text itself starts directly as pure HTML or SVG, parse directly without stripping internal backticks in JS template literals!
    if (/^(?:<!doctype\s+html|<html[\s>]|<\?xml|<svg[\s>])/i.test(raw)) {
      const direct = parseSingleCodeBlock(raw);
      if (direct) return direct;
    }

    // Otherwise scan all Markdown code fences and pick the largest valid HTML/SVG fence
    const fenceRe = /```(?:[a-zA-Z0-9_-]*)?[ \t]*\r?\n([\s\S]*?)```/g;
    let bestFence = null;
    let match;
    while ((match = fenceRe.exec(raw)) !== null) {
      const parsed = parseSingleCodeBlock(match[1]);
      if (parsed && (!bestFence || parsed.code.length > bestFence.code.length)) {
        bestFence = parsed;
      }
    }
    if (bestFence) return bestFence;

    // Also handle single-line / inline ```<svg...></svg>``` fences
    const inlineFence = raw.match(/```(?:html|htm|svg|xml)?\s*([\s\S]*?)```/i);
    if (inlineFence && inlineFence[1]) {
      const parsedInline = parseSingleCodeBlock(inlineFence[1]);
      if (parsedInline) return parsedInline;
    }

    return parseSingleCodeBlock(raw);
  }

  // Accurate Open-Source vs Closed-Source Model Classifier across th.629717.cc.cd's 94+ models
  function isModelOpenSource(modelOrId, vendorArg, labelArg) {
    let id = "", label = "", vendor = "";
    if (typeof modelOrId === "string") {
      id = modelOrId.toLowerCase();
      vendor = String(vendorArg || "").toLowerCase();
      label = String(labelArg || "").toLowerCase();
    } else if (modelOrId && typeof modelOrId === "object") {
      id = String(modelOrId.id || "").toLowerCase();
      label = String(modelOrId.label || "").toLowerCase();
      vendor = String(modelOrId.vendor || "").toLowerCase();
    }
    const combined = id + " " + label + " " + vendor;

    // Explicit open-weight releases inside mixed/proprietary vendors
    if (/\b(gpt-oss|gemma|muse-spark-open|llama|nemotron|olmo|falcon|yi-|baichuan)\b/.test(combined)) {
      return true;
    }

    // Proprietary closed-source families
    if (/\b(claude|anthropic|opus|sonnet|haiku|fable)\b/.test(combined)) return false;
    if (/\b(gpt-5|gpt-6|openai|o1|o3|o4|sol|astra|luna|terra|codex)\b/.test(combined)) return false;
    if (/\b(gemini|google|argon|carbon|barium)\b/.test(combined)) return false;
    if (/\b(grok|xai)\b/.test(combined)) return false;
    if (/\b(doubao|bytedance|seed-2)\b/.test(combined)) return false;
    if (/\b(muse-spark-1|muse-wonder)\b/.test(combined)) return false;
    if (/\b(step-5|vierra|rotten-apple|inkling|cynosure|union-alpha|ox-alpha|\bbeam\b|solar-pro)\b/.test(combined)) return false;

    // Hybrid open-weight labs (distinguish commercial API-only -max / -plus / -pro-preview)
    if (/\b(qwen|alibaba)\b/.test(combined)) {
      if (/\b(max|plus)\b/.test(combined)) return false;
      return true;
    }
    if (/\b(deepseek)\b/.test(combined)) return true;
    if (/\b(glm|zhipu)\b/.test(combined)) return true;
    if (/\b(kimi|moonshot)\b/.test(combined)) {
      if (/\b(k3\.1-pro)\b/.test(combined)) return false;
      return true;
    }
    if (/\b(minimax)\b/.test(combined)) return true;
    if (/\b(mimo|xiaomi)\b/.test(combined)) {
      if (/\bx-pro-preview\b/.test(combined)) return false;
      return true;
    }
    if (/\b(hunyuan|hy3|hy4|tencent)\b/.test(combined)) {
      if (/\bhy4-preview\b/.test(combined)) return false;
      return true;
    }
    if (/\b(mistral)\b/.test(combined)) {
      if (/\bmedium-3\b/.test(combined)) return false;
      return true;
    }
    if (/\blongcat\b/.test(combined)) return true;

    return false;
  }

  function inferShortVendor(vendorOrLabel) {
    const v = String(vendorOrLabel || "").toLowerCase();
    if (v.includes("anthropic") || v.includes("claude") || /\b(opus|sonnet|haiku|fable)\b/.test(v)) return "Claude";
    if (v.includes("openai") || v.includes("gpt") || /\b(sol|astra|luna|terra|codex)\b/.test(v)) return "GPT";
    if (v.includes("google") || v.includes("gemini") || v.includes("gemma") || /\b(argon|carbon|barium)\b/.test(v)) return "Gemini";
    if (v.includes("meta") || v.includes("muse") || v.includes("llama")) return "Muse";
    if (v.includes("deepseek")) return "DeepSeek";
    if (v.includes("alibaba") || v.includes("qwen")) return "Qwen";
    if (v.includes("zhipu") || v.includes("glm")) return "GLM";
    if (v.includes("xai") || v.includes("grok")) return "Grok";
    if (v.includes("moonshot") || v.includes("kimi")) return "Kimi";
    if (v.includes("xiaomi") || v.includes("mimo")) return "MiMo";
    if (v.includes("minimax")) return "MiniMax";
    if (v.includes("tencent") || v.includes("hunyuan")) return "Hunyuan";
    if (v.includes("mistral")) return "Mistral";
    return "Other";
  }

  function getVendorLogoSvg(vendorRaw, size = 20) {
    const sv = inferShortVendor(vendorRaw);
    const s = Number(size) || 20;
    const tip = escapeHtml(sv === "Other" ? (vendorRaw || "Model") : sv);

    switch (sv) {
      case "Claude":
        return `<span class="vlogo" title="${tip}" style="width:${s}px;height:${s}px;">
          <svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none">
            <rect width="24" height="24" rx="6" fill="#F3E8DC"/>
            <path d="M14.7 5.5h2.3L21 18.5h-2.4l-2.8-9.6-2.8 9.6h-2.3l4-13zM7.6 5.5h2.5l4 13h-2.4l-.8-2.8H6.7l-.8 2.8H3.5l4.1-13zm-.3 8.1h3l-1.5-5.2-1.5 5.2z" fill="#A65E38"/>
          </svg></span>`;
      case "GPT":
        return `<span class="vlogo" title="${tip}" style="width:${s}px;height:${s}px;">
          <svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none">
            <rect width="24" height="24" rx="6" fill="#E6ECEA"/>
            <g stroke="#284B43" stroke-width="1.55" stroke-linecap="round" stroke-linejoin="round">
              <path d="M12 4.6a3.6 3.6 0 0 1 3.3 2.1l2.2 3.8a3.6 3.6 0 0 1-.8 4.4"/>
              <path d="M18.4 8.3a3.6 3.6 0 0 1 .4 3.9l-2.2 3.8a3.6 3.6 0 0 1-4.2 1.6"/>
              <path d="M18.4 15.7a3.6 3.6 0 0 1-2.9 1.8H11a3.6 3.6 0 0 1-3.4-2.8"/>
              <path d="M12 19.4a3.6 3.6 0 0 1-3.3-2.1l-2.2-3.8a3.6 3.6 0 0 1 .8-4.4"/>
              <path d="M5.6 15.7a3.6 3.6 0 0 1-.4-3.9l2.2-3.8A3.6 3.6 0 0 1 11.6 6.4"/>
              <path d="M5.6 8.3A3.6 3.6 0 0 1 8.5 6.5H13a3.6 3.6 0 0 1 3.4 2.8"/>
            </g>
          </svg></span>`;
      case "Gemini": {
        const gid = `gemGrad_${++svgLogoUid}`;
        return `<span class="vlogo" title="${tip}" style="width:${s}px;height:${s}px;">
          <svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none">
            <rect width="24" height="24" rx="6" fill="#E6EEF8"/>
            <path d="M12 3.6c.4 4.5 3.9 8 8.4 8.4-4.5.4-8 3.9-8.4 8.4-.4-4.5-3.9-8-8.4-8.4 4.5-.4 8-3.9 8.4-8.4z" fill="url(#${gid})"/>
            <defs>
              <linearGradient id="${gid}" x1="4" y1="4" x2="20" y2="20" gradientUnits="userSpaceOnUse">
                <stop stop-color="#4A76B8"/><stop offset="0.6" stop-color="#6B7EB8"/><stop offset="1" stop-color="#56949F"/>
              </linearGradient>
            </defs>
          </svg></span>`;
      }
      case "Muse":
        return `<span class="vlogo" title="${tip}" style="width:${s}px;height:${s}px;">
          <svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none">
            <rect width="24" height="24" rx="6" fill="#E6EEF7"/>
            <path d="M4.8 14.3c0-2.9 1.9-5.3 4.1-5.3 1.5 0 2.6 1 3.9 2.9 1.3-1.9 2.4-2.9 3.9-2.9 2.2 0 4.1 2.4 4.1 5.3 0 1.8-1 3.1-2.5 3.1-1.3 0-2.3-.9-3.6-2.9l-.7-1.1-.7 1.1c-1.3 2-2.3 2.9-3.6 2.9-1.5 0-2.9-1.3-2.9-3.1z" stroke="#39669E" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round"/>
          </svg></span>`;
      case "DeepSeek":
        return `<span class="vlogo" title="${tip}" style="width:${s}px;height:${s}px;">
          <svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none">
            <rect width="24" height="24" rx="6" fill="#E4EDF7"/>
            <path d="M5.5 13.8c1.4-4 5.2-6 9.3-5.2 1.8.4 3.2 1.4 4 2.8-1.8-.3-3.2.2-4.1 1.4 1.1.5 1.8 1.5 1.9 2.8-2.6.8-5.9.8-8.4-.5l-2.2 1.6.5-2.9z" fill="#3B689C"/>
          </svg></span>`;
      case "Qwen":
        return `<span class="vlogo" title="${tip}" style="width:${s}px;height:${s}px;">
          <svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none">
            <rect width="24" height="24" rx="6" fill="#EAE8F6"/>
            <polygon points="12,4.5 18.5,8.2 18.5,15.8 12,19.5 5.5,15.8 5.5,8.2" stroke="#5B5496" stroke-width="1.75" fill="none"/>
            <circle cx="12" cy="12" r="2.6" fill="#5B5496"/>
          </svg></span>`;
      case "Grok":
        return `<span class="vlogo" title="${tip}" style="width:${s}px;height:${s}px;">
          <svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none">
            <rect width="24" height="24" rx="6" fill="#E5E8EC"/>
            <path d="M6.2 6h2.8l3.5 5 3.6-5h2.5l-4.9 6.6L19 18h-2.8l-3.8-5.3L8.5 18H6l5.1-6.9L6.2 6z" fill="#2B3440"/>
          </svg></span>`;
      case "GLM":
        return `<span class="vlogo" title="${tip}" style="width:${s}px;height:${s}px;">
          <svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none">
            <rect width="24" height="24" rx="6" fill="#E5EFF4"/>
            <path d="M6.5 7.2h11L9 16.8h8.5" stroke="#36677D" stroke-width="2.0" stroke-linecap="round" stroke-linejoin="round"/>
          </svg></span>`;
      case "Kimi":
        return `<span class="vlogo" title="${tip}" style="width:${s}px;height:${s}px;">
          <svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none">
            <rect width="24" height="24" rx="6" fill="#E7EAF2"/>
            <path d="M15.6 15.8A6 6 0 0 1 9.2 6.4a6.2 6.2 0 1 0 8.4 8.4c-.6.6-1.3.9-2 1z" fill="#435274"/>
          </svg></span>`;
      case "MiMo":
        return `<span class="vlogo" title="${tip}" style="width:${s}px;height:${s}px;">
          <svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none">
            <rect width="24" height="24" rx="6" fill="#F5EAE2"/>
            <path d="M6 16.5v-8h5.2c1.4 0 2.3.9 2.3 2.3v5.7M9.6 11.5v5M16.8 8.5v8" stroke="#B2623B" stroke-width="1.9" stroke-linecap="round"/>
          </svg></span>`;
      case "MiniMax":
        return `<span class="vlogo" title="${tip}" style="width:${s}px;height:${s}px;">
          <svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none">
            <rect width="24" height="24" rx="6" fill="#F3E8EE"/>
            <path d="M5.5 16.2V8.2l3.3 4.6 3.2-4.6 3.2 4.6 3.3-4.6v8" stroke="#8C4F6E" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round"/>
          </svg></span>`;
      default: {
        const ch = escapeHtml(String(vendorRaw || "M").trim().slice(0, 1).toUpperCase() || "M");
        return `<span class="vlogo" title="${tip}" style="width:${s}px;height:${s}px;">
          <svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none">
            <rect width="24" height="24" rx="6" fill="#E7ECF2"/>
            <text x="12" y="16" text-anchor="middle" font-size="11.5" font-weight="700" fill="#48586A">${ch}</text>
          </svg></span>`;
      }
    }
  }

  function computeFilteredVerdict(res, sourceFilter) {
    if (!res || !res.detectedModel) return null;
    const rawList = (res.allModels && res.allModels.length ? res.allModels : res.topModels || [res.detectedModel]).map((m) => ({
      ...m,
      isOpen: isModelOpenSource(m)
    }));

    let openSum = 0;
    let closedSum = 0;
    rawList.forEach((m) => {
      const p = Number(m.probability) || 0;
      if (m.isOpen) openSum += p;
      else closedSum += p;
    });
    const totalSum = openSum + closedSum || 1;
    const openSharePct = Math.round((openSum / totalSum) * 100);
    const closedSharePct = Math.max(0, 100 - openSharePct);

    let filtered = rawList;
    if (sourceFilter === "open") filtered = rawList.filter((m) => m.isOpen);
    else if (sourceFilter === "closed") filtered = rawList.filter((m) => !m.isOpen);

    const poolSum = filtered.reduce((acc, m) => acc + (Number(m.probability) || 0), 0);
    const overallTop = rawList[0] || { ...res.detectedModel, isOpen: isModelOpenSource(res.detectedModel) };
    const activeTop = filtered[0] || overallTop;
    const displayProb =
      sourceFilter === "all"
        ? Number(activeTop.probability) || 0
        : poolSum > 0.001
        ? (Number(activeTop.probability) || 0) / poolSum
        : Number(activeTop.probability) || 0;

    return {
      rawList,
      filtered,
      poolSum,
      openSharePct,
      closedSharePct,
      overallTop,
      activeTop,
      displayProb,
      probPct: Math.round(displayProb * 100),
      exactHit: Boolean(res.exactArchiveMatch && res.exactArchiveMatch.matched)
    };
  }

  root.PelicanShared = {
    DEFAULT_API_BASE,
    DEFAULT_API_KEY,
    TIER_ORDER,
    TIER_CN,
    escapeHtml,
    fastHash,
    extractRenderableCode,
    isModelOpenSource,
    inferShortVendor,
    getVendorLogoSvg,
    computeFilteredVerdict
  };
})(typeof globalThis !== "undefined" ? globalThis : window);
