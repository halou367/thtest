(function (root) {
  "use strict";

  const DEFAULT_API_BASE = "https://th.629717.cc.cd";
  const DEFAULT_API_KEY = "1234567890";
  const TIER_ORDER = ["low", "medium", "high", "max"];
  const TIER_CN = { low: "低 Low", medium: "中 Med", high: "高 High", max: "极高 Max" };
  const TIER_SHORT = { low: "LOW", medium: "MED", high: "HIGH", max: "MAX" };

  // Multi-subject visual benchmark keyword signatures (Pelican, Toucan, White Dove, Motorcycle, Bicycle, Birds/Animals + Vehicles/Anatomy)
  const DEFAULT_CAPTURE_KEYWORDS = [
    // 核心鸟类与动物主体
    "鹈鹕, pelican, 大嘴鸟, 巨嘴鸟, 鵎鵼, toucan, 白鸽, 和平鸽, 鸽子, 信鸽, dove, pigeon",
    "火烈鸟, flamingo, 企鹅, penguin, 猫头鹰, owl, 鹦鹉, parrot, 天鹅, swan, 仙鹤, crane, 海鸥, seagull, 孔雀, peacock, 蜂鸟, hummingbird, 鸵鸟, ostrich, 飞鸟, 小鸟, bird",
    "猫咪, 熊猫, panda, 狐狸, 青蛙, 章鱼, 宇航员, astronaut, 机器人, robot, 恐龙, 飞龙, dragon",
    // 摩托车、自行车与各类骑行载具
    "摩托车, 机车, 重机, 铁骑, 电摩, 踏板车, 小绵羊, motorcycle, motorbike, moto, scooter, vespa, chopper, cruiser",
    "自行车, 单车, 骑行, 骑车, 骑着, bicycle, bike, cyclist, riding, 三轮车, tricycle, 滑板, skateboard, 跑车, 赛车, 卡丁车",
    // 高频生物解剖与机械部件特征（即使代码未写动物全名也能精准命中）
    "喉囊, pouch, gular, 鸟喙, 巨喙, 大嘴, beak, bill, 橄榄枝, olive, 翅膀, 羽翼, wing, 羽毛, 尾羽, feather, plumage",
    "头盔, 风镜, helmet, visor, 排气管, 尾气, exhaust, muffler, 引擎, 发动机, 气缸, engine, motor, 油箱, 车灯, 大灯, headlight, taillight",
    "挡泥板, fender, 油门, throttle, 脚踏, 踏板, pedal, 车把, 把手, handlebar, 车轮, 轮胎, 前轮, 后轮, wheel, tire, tyre, 辐条, 轮毂, spoke, rim, 车座, 坐垫, saddle, 链条, 曲柄, crank, chain"
  ].join(", ");

  const AI_OR_PREVIEW_HOST_RE = /(?:^|\.)(arena\.ai|lmarena\.ai|lmsys\.org|chatgpt\.com|openai\.com|claude\.ai|claudeusercontent\.com|gemini\.google\.com|usercontent\.goog|aistudio\.google\.com|deepseek\.com|kimi\.com|moonshot\.cn|qwen\.ai|aliyun\.com|doubao\.com|grok\.com|x\.com|poe\.com|chatglm\.cn|zhipuai\.cn|yuanbao\.tencent\.com|baidu\.com|minimaxi\.com|hailuoai\.com|mistral\.ai|huggingface\.co|e2b\.app|webcontainer\.io|bolt\.new|v0\.dev|localhost|127\.0\.0\.1)$/i;

  // Aligned with th.629717.cc.cd 3-level Vendor -> Short Model catalog
  const SHORT_VENDOR_CATALOG = [
    { id: "Claude", models: ["opus-5.5", "opus-5.6", "fable-5.1", "sonnet-5.5", "haiku-5.5", "opus-5", "sonnet-5", "fable-5", "opus-4.8", "opus-4.6", "haiku-4.5"] },
    { id: "GPT", models: ["6.1-sol", "6-sol", "6-astra", "6-luna", "6.1-terra", "5.6-sol", "5.6-terra", "5.6-codex", "5.5", "5.4", "5.4-mini"] },
    { id: "Gemini", models: ["4-carbon", "4-argon", "4-barium", "3.8-flash", "3.7-flash", "3.1-pro", "gemma-4-31b"] },
    { id: "DeepSeek", models: ["v4.1-flash", "v4.1", "v3.2", "r1"] },
    { id: "Qwen", models: ["3.8-max", "3.8-27b", "3.7-max", "3.5-397b-a17b", "3.6-plus", "3.5-plus", "3-coder"] },
    { id: "GLM", models: ["5.3", "5.3-flash", "5.2", "5.1", "5", "5-turbo"] },
    { id: "Grok", models: ["4.7", "4.6", "4.5"] },
    { id: "Kimi", models: ["k3", "k3.1-pro", "k2.6", "k2.5"] },
    { id: "Muse", models: ["spark-1.3", "spark-1.2", "spark-1.1", "spark-open", "wonder", "wonder-1.0", "llama-4-maverick"] },
    { id: "MiniMax", models: ["m3", "m3.1", "m2.7", "m2.5", "m2.1"] },
    { id: "MiMo", models: ["v2.6-pro", "v2.5-pro", "v2.6-flash"] },
    { id: "Hunyuan", models: ["4", "4-preview", "3", "t1"] },
    { id: "Doubao", models: ["seed-2.0-pro", "seed-2.0", "1.6-pro"] },
    { id: "Mistral", models: ["large-4", "large-3", "medium-3.5", "medium-3.1"] },
    { id: "Other", models: [] }
  ];

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

  function isRichClipboardFragment(txt) {
    if (!txt) return false;
    if (txt.includes("<!--StartFragment-->") || txt.includes("<!--EndFragment-->")) return true;
    if (/^<meta\s+charset=/i.test(txt) && !/<svg[\s>]/i.test(txt) && !/<canvas[\s>]/i.test(txt)) return true;
    return false;
  }

  function parseSingleCodeBlock(candidate) {
    if (!candidate || typeof candidate !== "string") return null;
    const txt = candidate.trim();
    if (txt.length < 24 || txt.length > 3500000) return null;
    if (isRichClipboardFragment(txt)) return null;

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

    // 3. Interactive HTML/Canvas snippet without <html> wrapper
    if (
      /^<(div|section|main|style|canvas|header)[\s>]/i.test(txt) &&
      /<(style|canvas|script)[\s>]/i.test(txt) &&
      /<\/(div|section|main|style|canvas|script)>/i.test(txt)
    ) {
      return { type: "HTML", code: txt };
    }

    // 4. Standalone SVG
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

  function extractRenderableCode(rawText) {
    if (!rawText || typeof rawText !== "string") return null;
    const raw = rawText.trim();
    if (raw.length < 24 || raw.length > 3500000) return null;
    if (isRichClipboardFragment(raw)) return null;

    if (/^(?:<!doctype\s+html|<html[\s>]|<\?xml|<svg[\s>])/i.test(raw)) {
      const direct = parseSingleCodeBlock(raw);
      if (direct) return direct;
    }

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

    const inlineFence = raw.match(/```(?:html|htm|svg|xml)?\s*([\s\S]*?)```/i);
    if (inlineFence && inlineFence[1]) {
      const parsedInline = parseSingleCodeBlock(inlineFence[1]);
      if (parsedInline) return parsedInline;
    }

    return parseSingleCodeBlock(raw);
  }

  // Ensure streaming LLM code blocks have closed cleanly before auto-capturing
  function isCompleteSpecimenCode(parsed) {
    if (!parsed || !parsed.code || parsed.code.length < 60) return false;
    const c = parsed.code.trim();
    if (parsed.type === "SVG") {
      return /<\/svg>\s*$/i.test(c);
    }
    if (/^(?:<!doctype\s+html|<html[\s>])/i.test(c)) {
      return /<\/html>\s*$/i.test(c);
    }
    return /<\/(svg|div|section|main|script|body|canvas)>\s*$/i.test(c);
  }

  function parseKeywordsList(keywordsRaw) {
    const src = typeof keywordsRaw === "string" ? keywordsRaw : DEFAULT_CAPTURE_KEYWORDS;
    const parts = src
      .split(/[,，;；\r\n]+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    return Array.from(new Set(parts));
  }

  function mergeWithDefaultKeywords(existingRaw) {
    const userList = parseKeywordsList(existingRaw || "");
    const defList = parseKeywordsList(DEFAULT_CAPTURE_KEYWORDS);
    const seen = new Set(userList.map((x) => x.toLowerCase()));
    for (let i = 0; i < defList.length; i++) {
      const k = defList[i];
      if (!seen.has(k.toLowerCase())) {
        seen.add(k.toLowerCase());
        userList.push(k);
      }
    }
    return userList.join(", ");
  }

  function isAiOrPreviewHost(hostname) {
    if (!hostname) return false;
    return AI_OR_PREVIEW_HOST_RE.test(String(hostname).trim());
  }

  function isArenaHost(hostname) {
    if (!hostname) return false;
    return /(?:^|\.)(arena\.ai|lmarena\.ai|lmsys\.org)$/i.test(String(hostname).trim());
  }

  // Detect Arena.ai open-source thinking marker (e.g. "Thought for 1 second" / Brain icon + exposed CoT)
  function parseOpenThinkingMarker(buttonTexts, hasBrainIcon = false, cotTextSample = "") {
    const texts = Array.isArray(buttonTexts) ? buttonTexts : [];
    const hasCot = Boolean(cotTextSample && String(cotTextSample).trim().length > 8);

    for (let i = 0; i < texts.length; i++) {
      const raw = String(texts[i] || "").replace(/\s+/g, " ").trim();
      if (!raw || raw.length > 80) continue;

      const mEn = raw.match(/\b(Thought\s+for\s+[0-9a-zA-Z.<>\s]{1,36}|Thought\s+briefly)\b/i);
      if (mEn) {
        return { detected: true, label: mEn[1].trim(), hasCot };
      }

      const mCn = raw.match(/((?:已思考|思考了?)\s*\d+\s*(?:秒|分钟|分|s\b))/i);
      if (mCn) {
        return { detected: true, label: mCn[1].trim(), hasCot };
      }

      if ((hasBrainIcon || hasCot) && /^(?:Thought|Thinking|深度思考|思考过程)(?:[.…\s:：0-9sms秒]*)$/i.test(raw)) {
        return { detected: true, label: raw, hasCot };
      }
    }

    if (hasBrainIcon && hasCot) {
      return { detected: true, label: "Thought (Open CoT)", hasCot: true };
    }

    return { detected: false, label: "", hasCot: false };
  }

  function escapeRegExp(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  // High-precision keyword signature matcher (camelCase & identifier boundary safe for English, direct for CJK)
  function matchKeywordFeatures(code, keywordsRaw, contextHint = "") {
    if ((!code || typeof code !== "string") && !contextHint) {
      return { hit: false, matched: [], shapeCount: 0, hasCanvas: false, score: 0 };
    }
    const list = Array.isArray(keywordsRaw) ? keywordsRaw : parseKeywordsList(keywordsRaw);
    const safeCode = typeof code === "string" ? code : "";
    const sample = safeCode.length > 250000 ? safeCode.slice(0, 250000) : safeCode;
    const ctxSample = typeof contextHint === "string" && contextHint.length > 0 ? "\n" + contextHint.slice(0, 1600) : "";

    const shapeMatches = sample.match(/<(path|circle|ellipse|rect|line|polygon|polyline|use)\b/gi);
    const shapeCount = shapeMatches ? shapeMatches.length : 0;
    const hasCanvas = /<canvas[\s>]/i.test(sample);

    if (!list.length) {
      return { hit: false, matched: [], shapeCount, hasCanvas, score: Math.min(80, shapeCount * 2) };
    }

    // Split camelCase / PascalCase into space-separated words before lowercasing
    const normalized = (sample + ctxSample)
      .replace(/([a-z])([A-Z])/g, "$1 $2")
      .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
      .toLowerCase();
    const matched = [];

    for (let i = 0; i < list.length; i++) {
      const kw = list[i];
      if (!kw) continue;
      const lowerKw = kw.toLowerCase();
      if (!normalized.includes(lowerKw)) continue;

      if (/^[a-z]+$/i.test(kw)) {
        const wordRe = new RegExp(`(?:^|[^a-z])${escapeRegExp(lowerKw)}(?:s|es)?(?=$|[^a-z])`);
        if (wordRe.test(normalized)) {
          matched.push(kw);
        }
      } else {
        matched.push(kw);
      }
    }

    const score =
      matched.length * 100 +
      (hasCanvas ? 35 : 0) +
      Math.min(80, shapeCount * 2) +
      Math.min(30, Math.round(sample.length / 1024));

    return {
      hit: matched.length > 0,
      matched,
      shapeCount,
      hasCanvas,
      score
    };
  }

  // Decide whether a captured page specimen should automatically pop up the identification panel
  function isAutoTriggerSpecimen(item, opts = {}) {
    if (!item || !item.code) return false;
    if (opts.keywordOnlyAuto === true) {
      return Boolean(item.kwHit);
    }
    // 1. Any specimen matching subject/anatomy/vehicle keywords triggers immediately
    if (item.kwHit) return true;

    // 2. Complete visual SVG / HTML artworks in code blocks, preview iframes, subframes, or local files trigger even without keywords!
    if (/(预览|内嵌帧|子帧|代码块|本地文档|小窗|视窗)/.test(String(item.origin || ""))) {
      if (item.hasCanvas) return true;
      if ((item.shapeCount || 0) >= 4) return true;
      if (/<svg[\s>]/i.test(item.code) && item.code.length >= 260) return true;
      if (/(requestAnimationFrame|getContext\s*\(\s*['"](?:2d|webgl)|three\.|d3\.)/i.test(item.code)) return true;
      return false;
    }

    // 3. Direct rendered inline <svg> in DOM: auto-trigger on AI chat / preview hosts if rich illustration
    if (item.origin === "页面SVG" && opts.isAiHost && (item.shapeCount || 0) >= 8) {
      return true;
    }
    return false;
  }

  // Extract largest sanitized static <svg> from SVG or HTML for instant zero-flash / CSP-resilient fallback
  function extractSanitizedSvgMarkup(rawCode) {
    if (!rawCode || typeof rawCode !== "string") return "";
    const svgRe = /<svg\b[\s\S]*?<\/svg>/gi;
    let best = "";
    let m;
    while ((m = svgRe.exec(rawCode)) !== null) {
      if (m[0].length > best.length) best = m[0];
    }
    if (!best || best.length < 24) return "";

    let safe = best
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<foreignObject[\s\S]*?<\/foreignObject>/gi, "")
      .replace(/\son[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "");

    safe = safe.replace(/^<svg\b([^>]*)>/i, (_full, attrs) => {
      let next = attrs;
      if (!/viewBox\s*=/i.test(next)) {
        const wm = next.match(/\bwidth\s*=\s*["'](\d+(?:\.\d+)?)(?:px)?["']/i);
        const hm = next.match(/\bheight\s*=\s*["'](\d+(?:\.\d+)?)(?:px)?["']/i);
        if (wm && hm) next += ` viewBox="0 0 ${wm[1]} ${hm[1]}"`;
      }
      if (/viewBox\s*=/i.test(next)) {
        next = next
          .replace(/\s+\bwidth\s*=\s*["'][^"']*["']/gi, "")
          .replace(/\s+\bheight\s*=\s*["'][^"']*["']/gi, "");
        if (!/preserveAspectRatio\s*=/i.test(next)) {
          next += ' preserveAspectRatio="xMidYMid meet"';
        }
      }
      return `<svg${next}>`;
    });
    return safe;
  }

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

    if (/\b(gpt-oss|gemma|muse-spark-open|llama|nemotron|olmo|falcon|yi-|baichuan)\b/.test(combined)) {
      return true;
    }
    if (/\b(claude|anthropic|opus|sonnet|haiku|fable)\b/.test(combined)) return false;
    if (/\b(gpt-5|gpt-6|openai|o1|o3|o4|sol|astra|luna|terra|codex)\b/.test(combined)) return false;
    if (/\b(gemini|google|argon|carbon|barium)\b/.test(combined)) return false;
    if (/\b(grok|xai)\b/.test(combined)) return false;
    if (/\b(doubao|bytedance|seed-2)\b/.test(combined)) return false;
    if (/\b(muse-spark-1|muse-wonder)\b/.test(combined)) return false;
    if (/\b(step-5|vierra|rotten-apple|inkling|cynosure|union-alpha|ox-alpha|\bbeam\b|solar-pro)\b/.test(combined)) return false;

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
    if (v.includes("openai") || v.includes("gpt") || /\b(sol|astra|luna|terra|codex|o[134])\b/.test(v)) return "GPT";
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
    if (v.includes("bytedance") || v.includes("doubao") || v.includes("seed")) return "Doubao";
    if (v.includes("mistral")) return "Mistral";
    return "Other";
  }

  function splitToShortVendorAndModel(vendorRaw, displayModelRaw) {
    const dm = String(displayModelRaw || "").trim();
    const sv = inferShortVendor(`${vendorRaw || ""} ${dm}`);
    const stripMap = {
      Claude: /^claude[-\s]*/i,
      GPT: /^gpt[-\s]*/i,
      Gemini: /^gemini[-\s]*/i,
      Muse: /^muse[-\s]*/i,
      DeepSeek: /^deepseek[-\s]*/i,
      Qwen: /^qwen[-\s]*/i,
      GLM: /^glm[-\s]*/i,
      Grok: /^grok[-\s]*/i,
      Kimi: /^kimi[-\s]*/i,
      MiMo: /^mimo[-\s]*/i,
      MiniMax: /^minimax[-\s]*/i,
      Hunyuan: /^(?:tencent\s+)?hunyuan[-\s]*/i,
      Doubao: /^doubao[-\s]*/i,
      Mistral: /^mistral[-\s]*/i
    };
    let shortModel = dm;
    if (stripMap[sv]) {
      shortModel = dm.replace(stripMap[sv], "").trim() || dm;
    }
    shortModel = shortModel.toLowerCase().replace(/\s+/g, "-");
    return {
      shortVendor: sv === "Other" && vendorRaw && String(vendorRaw).toLowerCase() !== "other" ? String(vendorRaw) : sv,
      shortModel: shortModel || "custom"
    };
  }

  function getModelsForVendor(shortVendor, extraCandidates) {
    const key = String(shortVendor || "").trim().toLowerCase();
    const found = SHORT_VENDOR_CATALOG.find((x) => x.id.toLowerCase() === key);
    const set = new Set(found ? found.models : []);
    if (Array.isArray(extraCandidates)) {
      extraCandidates.forEach((m) => {
        if (!m) return;
        const sp = splitToShortVendorAndModel(m.vendor, m.label || m.id);
        if (sp.shortVendor.toLowerCase() === key && sp.shortModel) {
          set.add(sp.shortModel);
        }
      });
    }
    return Array.from(set);
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
    DEFAULT_CAPTURE_KEYWORDS,
    TIER_ORDER,
    TIER_CN,
    TIER_SHORT,
    SHORT_VENDOR_CATALOG,
    escapeHtml,
    fastHash,
    extractRenderableCode,
    isCompleteSpecimenCode,
    parseKeywordsList,
    mergeWithDefaultKeywords,
    isAiOrPreviewHost,
    isArenaHost,
    parseOpenThinkingMarker,
    matchKeywordFeatures,
    isAutoTriggerSpecimen,
    extractSanitizedSvgMarkup,
    isModelOpenSource,
    inferShortVendor,
    splitToShortVendorAndModel,
    getModelsForVendor,
    getVendorLogoSvg,
    computeFilteredVerdict
  };
})(typeof globalThis !== "undefined" ? globalThis : window);
