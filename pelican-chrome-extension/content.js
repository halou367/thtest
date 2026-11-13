(function () {
  "use strict";
  if (window.__pelicanContentScriptLoaded) return;
  window.__pelicanContentScriptLoaded = true;

  const {
    TIER_ORDER,
    TIER_CN,
    escapeHtml,
    fastHash,
    extractRenderableCode,
    getVendorLogoSvg,
    computeFilteredVerdict
  } = window.PelicanShared;

  let hostEl = null;
  let shadow = null;

  // Monotonic counters to prevent stale async responses or dropped iframe renders
  let renderSeq = 0;
  let identifySeq = 0;
  const ackedRenderIds = new Set();
  const activeTimers = new Map();

  // Short-window dedupe (only suppresses duplicate hook+copy event from the SAME single user action within 380ms)
  let lastTriggerHash = "";
  let lastTriggerTs = 0;

  const uiState = {
    visible: false,
    minimized: false,
    expanded: false,
    showAnnot: true,
    sourceFilter: "all",
    currentCode: "",
    currentHash: "",
    currentType: "SVG",
    currentVerdict: null
  };

  // Global listener for sandbox render ACKs (registered before any iframe is created!)
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
    }
  });

  function deliverToSandbox(frameId, cid, code) {
    if (!shadow) return;
    const frame = shadow.getElementById(frameId);
    if (!frame) return;

    // Cancel any previous retry loop on the same channel
    for (const [rid, t] of activeTimers.entries()) {
      if (String(rid).startsWith(cid + "_")) {
        clearInterval(t);
        activeTimers.delete(rid);
      }
    }

    const renderId = `${cid}_${++renderSeq}`;
    let attempts = 0;

    const tryPost = () => {
      attempts++;
      if (ackedRenderIds.has(renderId) || attempts > 35) {
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
    const timer = setInterval(tryPost, 55);
    activeTimers.set(renderId, timer);
  }

  const SHADOW_CSS = `
    :host {
      all: initial;
      font-family: -apple-system, BlinkMacSystemFont, "Inter", "SF Pro Text", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
      color: #25303d;
      line-height: 1.45;
      -webkit-font-smoothing: antialiased;
    }
    * { box-sizing: border-box; }

    .pelican-root {
      --ink: #25303d;
      --ink-soft: #506072;
      --muted: #7a8899;
      --glass-hairline: rgba(100, 116, 139, 0.15);
      --glass-hairline-strong: rgba(100, 116, 139, 0.25);
      --gold-border: rgba(196, 149, 69, 0.56);
      --gold-bg: linear-gradient(135deg, rgba(255, 251, 240, 0.96) 0%, rgba(246, 234, 204, 0.86) 52%, rgba(255, 250, 238, 0.95) 100%);
      --gold-glow: 0 10px 28px rgba(188, 140, 58, 0.16), inset 0 1px 0 rgba(255, 255, 255, 0.94);
      --silver-border: rgba(132, 152, 175, 0.58);
      --silver-bg: linear-gradient(135deg, rgba(248, 251, 255, 0.96) 0%, rgba(226, 234, 244, 0.88) 52%, rgba(246, 249, 253, 0.95) 100%);
      --silver-glow: 0 10px 26px rgba(96, 118, 144, 0.15), inset 0 1px 0 rgba(255, 255, 255, 0.96);
      --open-ink: #1f5f4b;
      --open-bg: rgba(16, 185, 129, 0.14);
      --open-border: rgba(16, 150, 108, 0.34);
      --open-pill-active: linear-gradient(135deg, #276e59, #1e5645);
      --closed-ink: #384d66;
      --closed-bg: rgba(79, 109, 138, 0.13);
      --closed-border: rgba(79, 109, 138, 0.32);
      --closed-pill-active: linear-gradient(135deg, #3c526b, #2c3e52);

      position: fixed;
      right: 22px;
      bottom: 22px;
      z-index: 2147483646;
      pointer-events: none;
    }

    .ext-window {
      width: 392px;
      max-width: calc(100vw - 28px);
      max-height: calc(100vh - 36px);
      display: none;
      flex-direction: column;
      border-radius: 20px;
      background: rgba(248, 250, 253, 0.94);
      backdrop-filter: blur(26px) saturate(140%);
      -webkit-backdrop-filter: blur(26px) saturate(140%);
      border: 1.5px solid rgba(255, 255, 255, 0.95);
      box-shadow: 0 24px 60px rgba(20, 32, 48, 0.22), 0 6px 18px rgba(20, 32, 48, 0.10), inset 0 1px 0 rgba(255, 255, 255, 0.95);
      overflow: hidden;
      pointer-events: auto;
    }
    .ext-window.show { display: flex; }
    .ext-window.pop-anim { animation: pelicanPop 0.24s cubic-bezier(0.22, 1, 0.36, 1); }
    @keyframes pelicanPop {
      0% { opacity: 0.78; transform: translateY(8px); }
      100% { opacity: 1; transform: translateY(0); }
    }

    .ext-header {
      padding: 10px 12px;
      background: rgba(241, 245, 250, 0.92);
      border-bottom: 1px solid var(--glass-hairline);
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 6px;
      cursor: grab;
      user-select: none;
      flex-shrink: 0;
    }
    .ext-header:active { cursor: grabbing; }
    .ext-header-left { display: flex; align-items: center; gap: 7px; min-width: 0; }

    .brand-mark {
      width: 25px;
      height: 25px;
      border-radius: 8px;
      background: linear-gradient(145deg, #3b4a5b, #56697e);
      color: #ffffff;
      display: grid;
      place-items: center;
      font-size: 12px;
      font-weight: 700;
      box-shadow: 0 2px 6px rgba(45, 58, 74, 0.18);
      flex-shrink: 0;
    }
    .win-title { font-size: 12.8px; font-weight: 750; color: var(--ink); white-space: nowrap; }
    .meta-chip {
      font-size: 10px;
      font-weight: 650;
      color: var(--ink-soft);
      background: rgba(255, 255, 255, 0.85);
      border: 1px solid var(--glass-hairline);
      padding: 1.5px 6.5px;
      border-radius: 999px;
      white-space: nowrap;
    }

    .win-controls { display: flex; align-items: center; gap: 2px; flex-shrink: 0; }
    .elapsed-lbl { font-size: 10.2px; color: var(--muted); margin-right: 3px; white-space: nowrap; }
    .icon-btn {
      appearance: none;
      border: 0;
      background: transparent;
      color: var(--ink-soft);
      width: 24px;
      height: 24px;
      border-radius: 7px;
      display: grid;
      place-items: center;
      cursor: pointer;
      font-size: 13px;
      padding: 0;
      transition: background 0.14s ease, color 0.14s ease;
    }
    .icon-btn:hover { background: rgba(100, 116, 139, 0.14); color: var(--ink); }

    .source-pill-bar { padding: 9px 13px 7px; flex-shrink: 0; }
    .pill-group {
      display: flex;
      align-items: center;
      gap: 3px;
      background: rgba(220, 228, 237, 0.72);
      border: 1px solid rgba(255, 255, 255, 0.88);
      padding: 3px;
      border-radius: 999px;
    }
    .source-pill-btn {
      flex: 1;
      appearance: none;
      border: 0;
      background: transparent;
      color: var(--ink-soft);
      font-size: 11.5px;
      font-weight: 720;
      padding: 5px 8px;
      border-radius: 999px;
      cursor: pointer;
      transition: all 0.18s ease;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 4px;
      white-space: nowrap;
      font-family: inherit;
    }
    .source-pill-btn:hover { color: var(--ink); }
    .source-pill-btn.active[data-filter="all"] {
      background: #ffffff;
      color: var(--ink);
      box-shadow: 0 2px 7px rgba(31, 43, 58, 0.09);
    }
    .source-pill-btn.active[data-filter="open"] {
      background: var(--open-pill-active);
      color: #ffffff;
      box-shadow: 0 3px 10px rgba(31, 95, 75, 0.25);
    }
    .source-pill-btn.active[data-filter="closed"] {
      background: var(--closed-pill-active);
      color: #ffffff;
      box-shadow: 0 3px 10px rgba(44, 62, 82, 0.24);
    }
    .pill-pct {
      font-size: 10px;
      font-weight: 650;
      opacity: 0.8;
      padding: 0.5px 5px;
      border-radius: 999px;
      background: rgba(100, 116, 139, 0.12);
    }
    .source-pill-btn.active .pill-pct {
      background: rgba(255, 255, 255, 0.22);
      color: inherit;
      opacity: 0.96;
    }

    .scroll-body {
      padding: 0 13px 13px;
      overflow-y: auto;
      scrollbar-width: thin;
    }

    .preview-stage-wrap {
      position: relative;
      border-radius: 13px;
      overflow: hidden;
      border: 1px solid var(--glass-hairline-strong);
      background: #ffffff;
      aspect-ratio: 16 / 10;
    }
    .preview-stage-wrap iframe {
      width: 100%;
      height: 100%;
      border: 0;
      display: block;
      background: #ffffff;
    }
    .drag-shield {
      position: absolute;
      inset: 0;
      display: none;
      z-index: 10;
    }
    .dragging .drag-shield { display: block; }

    .preview-top-actions {
      position: absolute;
      top: 7px;
      right: 7px;
      display: flex;
      gap: 4px;
      z-index: 5;
    }
    .stage-mini-btn {
      appearance: none;
      border: 1px solid rgba(255, 255, 255, 0.88);
      background: rgba(255, 255, 255, 0.84);
      backdrop-filter: blur(10px);
      color: var(--ink-soft);
      font-size: 10.2px;
      font-weight: 650;
      padding: 2.5px 7px;
      border-radius: 7px;
      cursor: pointer;
      font-family: inherit;
      box-shadow: 0 2px 6px rgba(31, 43, 58, 0.08);
    }
    .stage-mini-btn:hover { background: #ffffff; color: var(--ink); }

    .preview-model-annot {
      position: absolute;
      left: 8px;
      right: 8px;
      bottom: 8px;
      z-index: 5;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 6px;
      padding: 5.5px 9px;
      border-radius: 10px;
      background: rgba(255, 255, 255, 0.91);
      backdrop-filter: blur(14px) saturate(135%);
      -webkit-backdrop-filter: blur(14px) saturate(135%);
      border: 1px solid rgba(255, 255, 255, 0.95);
      box-shadow: 0 6px 16px rgba(24, 36, 52, 0.13);
    }
    .preview-model-annot.annot-gold {
      background: linear-gradient(135deg, rgba(255, 251, 240, 0.94), rgba(248, 237, 210, 0.9));
      border-color: rgba(196, 149, 69, 0.56);
    }
    .preview-model-annot.annot-silver {
      background: linear-gradient(135deg, rgba(248, 251, 255, 0.95), rgba(230, 238, 247, 0.9));
      border-color: rgba(132, 152, 175, 0.56);
    }
    .annot-left { display: flex; align-items: center; gap: 6px; min-width: 0; }
    .annot-model-name {
      font-size: 12px;
      font-weight: 780;
      color: var(--ink);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .annot-right { display: flex; align-items: center; gap: 4px; flex-shrink: 0; }

    .micro-badge {
      font-size: 9.8px;
      font-weight: 750;
      padding: 1.5px 5.5px;
      border-radius: 999px;
      white-space: nowrap;
    }
    .micro-badge.open { background: var(--open-bg); color: var(--open-ink); border: 1px solid var(--open-border); }
    .micro-badge.closed { background: var(--closed-bg); color: var(--closed-ink); border: 1px solid var(--closed-border); }
    .micro-badge.tier { background: rgba(54, 69, 86, 0.11); color: var(--ink); text-transform: uppercase; }
    .micro-badge.conf { background: #364556; color: #ffffff; }

    @keyframes foilSweep {
      0% { transform: translateX(-130%) skewX(-22deg); }
      100% { transform: translateX(230%) skewX(-22deg); }
    }
    .gacha-hero {
      position: relative;
      overflow: hidden;
      border-radius: 14px;
      padding: 11px 12px;
      margin-top: 9px;
      border: 1px solid var(--glass-hairline-strong);
      background: rgba(255, 255, 255, 0.8);
    }
    .gacha-hero::after {
      content: "";
      position: absolute;
      top: 0; bottom: 0; left: 0;
      width: 48%;
      background: linear-gradient(90deg, transparent, rgba(255, 255, 255, 0.62), transparent);
      transform: translateX(-140%) skewX(-22deg);
      pointer-events: none;
    }
    .gacha-hero.rarity-gold { background: var(--gold-bg); border: 1.5px solid var(--gold-border); box-shadow: var(--gold-glow); }
    .gacha-hero.rarity-gold::after { animation: foilSweep 1.15s cubic-bezier(0.22, 1, 0.36, 1) 1; }
    .gacha-hero.rarity-silver { background: var(--silver-bg); border: 1.5px solid var(--silver-border); box-shadow: var(--silver-glow); }
    .gacha-hero.rarity-silver::after { animation: foilSweep 1.15s cubic-bezier(0.22, 1, 0.36, 1) 1; }

    .gacha-top-row { display: flex; align-items: center; justify-content: space-between; gap: 6px; margin-bottom: 7px; flex-wrap: wrap; }
    .rarity-pill {
      display: inline-flex;
      align-items: center;
      font-size: 10.2px;
      font-weight: 750;
      padding: 2px 8.5px;
      border-radius: 999px;
      background: rgba(100, 116, 139, 0.14);
      color: var(--ink-soft);
    }
    .rarity-gold .rarity-pill { background: linear-gradient(135deg, #c99a49, #ad7e2f); color: #fffdf8; }
    .rarity-silver .rarity-pill { background: linear-gradient(135deg, #7d92a8, #5e7389); color: #f8fafc; }

    .archive-hit-tag {
      font-size: 10px;
      font-weight: 650;
      color: var(--ink-soft);
      background: rgba(255, 255, 255, 0.78);
      border: 1px solid rgba(100, 116, 139, 0.18);
      padding: 1.5px 7.5px;
      border-radius: 999px;
    }

    .gacha-main-row { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
    .gacha-identity { display: flex; align-items: center; gap: 10px; min-width: 0; }
    .gacha-logo-frame {
      width: 42px;
      height: 42px;
      border-radius: 12px;
      display: grid;
      place-items: center;
      background: rgba(255, 255, 255, 0.9);
      border: 1px solid rgba(100, 116, 139, 0.16);
      flex-shrink: 0;
    }
    .gacha-model-name { font-size: 16.5px; font-weight: 800; color: var(--ink); line-height: 1.2; }
    .rarity-gold .gacha-model-name { color: #463210; }
    .gacha-model-sub { font-size: 11px; color: var(--ink-soft); margin-top: 2px; }

    .conf-ring-wrap { position: relative; width: 48px; height: 48px; flex-shrink: 0; display: grid; place-items: center; }
    .conf-ring-pct { position: absolute; font-size: 11px; font-weight: 800; color: var(--ink); }

    .filter-notice {
      margin-top: 7px;
      padding: 5.5px 8px;
      border-radius: 8px;
      font-size: 10.6px;
      background: rgba(245, 158, 11, 0.13);
      border: 1px solid rgba(217, 119, 6, 0.28);
      color: #92400e;
      display: none;
    }

    .vis-block {
      margin-top: 8px;
      padding: 9px 11px;
      border-radius: 12px;
      background: rgba(255, 255, 255, 0.66);
      border: 1px solid var(--glass-hairline);
    }
    .vis-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      font-size: 11px;
      font-weight: 700;
      color: var(--ink-soft);
      margin-bottom: 6px;
    }
    .tier-segments { display: grid; grid-template-columns: repeat(4, 1fr); gap: 5px; }
    .tier-seg {
      border-radius: 8px;
      padding: 4.5px 4px;
      text-align: center;
      background: rgba(255, 255, 255, 0.65);
      border: 1px solid var(--glass-hairline);
    }
    .tier-seg.active {
      background: #ffffff;
      border-color: rgba(79, 109, 138, 0.55);
      box-shadow: 0 2px 8px rgba(54, 69, 86, 0.08);
    }
    .tier-seg-label { font-size: 9.6px; font-weight: 700; text-transform: uppercase; color: var(--muted); }
    .tier-seg.active .tier-seg-label { color: var(--ink); }
    .tier-seg-val { font-size: 11.5px; font-weight: 750; color: var(--ink); }

    .cand-row { display: grid; grid-template-columns: 20px 1fr auto; align-items: center; gap: 7px; padding: 3.5px 0; }
    .cand-name-line { display: flex; align-items: center; gap: 4px; font-size: 11.2px; font-weight: 660; color: var(--ink); margin-bottom: 2.5px; flex-wrap: wrap; }
    .mini-rank-tag { font-size: 9.2px; font-weight: 750; padding: 0.5px 4.5px; border-radius: 4px; }
    .mini-rank-tag.gold { background: rgba(196, 149, 69, 0.18); color: #7d5b22; }
    .mini-rank-tag.silver { background: rgba(122, 143, 166, 0.18); color: #3d4f63; }
    .mini-rank-tag.open { background: var(--open-bg); color: var(--open-ink); }
    .mini-rank-tag.closed { background: rgba(100, 116, 139, 0.12); color: var(--ink-soft); }
    .prob-track { height: 5px; border-radius: 999px; background: rgba(148, 163, 184, 0.18); overflow: hidden; }
    .prob-fill { height: 100%; border-radius: 999px; transition: width 0.25s ease; }
    .cand-pct { font-size: 11px; font-weight: 720; color: var(--ink-soft); min-width: 38px; text-align: right; }
    .vlogo { display: inline-grid; place-items: center; flex-shrink: 0; }

    .minimized-fab {
      display: none;
      align-items: center;
      gap: 8px;
      padding: 7px 13px 7px 8px;
      border-radius: 999px;
      background: rgba(255, 255, 255, 0.94);
      backdrop-filter: blur(20px);
      border: 1.5px solid #ffffff;
      box-shadow: 0 12px 32px rgba(20, 32, 48, 0.2);
      cursor: pointer;
      pointer-events: auto;
    }
    .minimized-fab.show { display: inline-flex; }

    .lightbox-backdrop {
      position: fixed;
      inset: 0;
      z-index: 2147483647;
      background: rgba(24, 34, 46, 0.48);
      backdrop-filter: blur(14px);
      display: none;
      align-items: center;
      justify-content: center;
      padding: 24px;
      pointer-events: auto;
    }
    .lightbox-backdrop.open { display: flex; }
    .lightbox-dialog {
      width: min(980px, 94vw);
      height: min(680px, 88vh);
      background: #ffffff;
      border-radius: 18px;
      box-shadow: 0 28px 70px rgba(15, 23, 42, 0.3);
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }
    .lightbox-head {
      padding: 11px 16px;
      background: #f8fafc;
      border-bottom: 1px solid var(--glass-hairline);
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    .lightbox-stage { flex: 1; background: #ffffff; }
    .lightbox-stage iframe { width: 100%; height: 100%; border: 0; display: block; }
    .close-lb-btn {
      appearance: none;
      border: 0;
      background: #364556;
      color: #ffffff;
      font-size: 12px;
      font-weight: 650;
      padding: 6px 14px;
      border-radius: 8px;
      cursor: pointer;
      font-family: inherit;
    }
  `;

  function ensureUI() {
    if (hostEl) return;
    hostEl = document.createElement("div");
    hostEl.id = "__pelican_model_id_ext_host__";
    shadow = hostEl.attachShadow({ mode: "open" });

    shadow.innerHTML = `
      <style>${SHADOW_CSS}</style>
      <div class="pelican-root" id="pelicanRoot">
        <div class="minimized-fab" id="minimizedFab" title="点击展开鹈鹕鉴定预览小窗">
          <div class="brand-mark">鹈</div>
          <span id="fabText" style="font-size:12px;font-weight:720;color:#25303d;">已捕获代码 · 点击展开</span>
        </div>

        <div class="ext-window" id="extWin">
          <div class="ext-header" id="dragHandle" title="拖拽移动窗口（双击复位右下角）">
            <div class="ext-header-left">
              <div class="brand-mark">鹈</div>
              <span class="win-title">鹈鹕剪贴板鉴定</span>
              <span class="meta-chip" id="formatChip">SVG</span>
            </div>
            <div class="win-controls">
              <span class="elapsed-lbl" id="elapsedLbl">就绪</span>
              <button class="icon-btn" id="btnRefreshClip" type="button" title="强制重新读取最新剪贴板并刷新预览">↻</button>
              <button class="icon-btn" id="btnExpand" type="button" title="展开 / 收起 Top-5 概率分布">▾</button>
              <button class="icon-btn" id="btnMinimize" type="button" title="最小化为悬浮球">—</button>
              <button class="icon-btn" id="btnClose" type="button" title="关闭悬浮窗">×</button>
            </div>
          </div>

          <div class="source-pill-bar">
            <div class="pill-group">
              <button class="source-pill-btn active" data-filter="all" type="button">
                <span>全部模型</span>
                <span class="pill-pct" id="pctAll">--</span>
              </button>
              <button class="source-pill-btn" data-filter="open" type="button" title="仅筛选开源模型（再次点击切回全部）">
                <span>开源</span>
                <span class="pill-pct" id="pctOpen">--%</span>
              </button>
              <button class="source-pill-btn" data-filter="closed" type="button" title="仅筛选闭源商业模型（再次点击切回全部）">
                <span>闭源</span>
                <span class="pill-pct" id="pctClosed">--%</span>
              </button>
            </div>
          </div>

          <div class="scroll-body">
            <div class="preview-stage-wrap">
              <div class="drag-shield"></div>
              <iframe id="previewFrame" title="SVG/HTML 实时预览"></iframe>
              <div class="preview-top-actions">
                <button class="stage-mini-btn" id="btnToggleAnnot" type="button">注释: 开</button>
                <button class="stage-mini-btn" id="btnOpenLb" type="button">⤢ 放大</button>
              </div>
              <div class="preview-model-annot" id="annotBar">
                <div class="annot-left">
                  <span id="annotLogo"></span>
                  <span class="annot-model-name" id="annotName">识别中...</span>
                </div>
                <div class="annot-right">
                  <span class="micro-badge closed" id="annotSrc">--</span>
                  <span class="micro-badge tier" id="annotTier">--</span>
                  <span class="micro-badge conf" id="annotConf">--%</span>
                </div>
              </div>
            </div>

            <div class="gacha-hero rarity-normal" id="verdictHero">
              <div class="gacha-top-row">
                <span class="rarity-pill" id="rarityPill">正在连接 th.629717.cc.cd...</span>
                <div style="display:flex;gap:4px;align-items:center;">
                  <span class="micro-badge closed" id="heroSrcTag">--</span>
                  <span class="archive-hit-tag" id="confBandTag">--</span>
                </div>
              </div>
              <div class="gacha-main-row">
                <div class="gacha-identity">
                  <div class="gacha-logo-frame" id="heroLogo"></div>
                  <div style="min-width:0;">
                    <div class="gacha-model-name" id="heroTitle">正在识别型号...</div>
                    <div class="gacha-model-sub" id="heroSub">已捕获剪贴板源码</div>
                  </div>
                </div>
                <div class="conf-ring-wrap">
                  <svg width="48" height="48" viewBox="0 0 54 54">
                    <circle cx="27" cy="27" r="22" fill="none" stroke="rgba(148,163,184,0.22)" stroke-width="4.5"/>
                    <circle id="confRing" cx="27" cy="27" r="22" fill="none" stroke="#4f6d8a" stroke-width="4.5" stroke-linecap="round" stroke-dasharray="138.2" stroke-dashoffset="138.2" transform="rotate(-90 27 27)"/>
                  </svg>
                  <span class="conf-ring-pct" id="confPct">--</span>
                </div>
              </div>
              <div class="filter-notice" id="filterNotice"></div>
            </div>

            <div class="vis-block">
              <div class="vis-head">
                <span>推理强度档位</span>
                <span id="effortHeadline" style="color:#25303d;">--</span>
              </div>
              <div class="tier-segments" id="tierGrid"></div>
            </div>

            <div id="expandedWrap" style="display:none;">
              <div class="vis-block">
                <div class="vis-head">
                  <span id="candTitle">模型概率分布</span>
                  <span id="candHint" style="font-weight:500;font-size:10.2px;color:#7a8899;">Top-5 候选</span>
                </div>
                <div id="candBars"></div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div class="lightbox-backdrop" id="lbBackdrop">
        <div class="lightbox-dialog">
          <div class="lightbox-head">
            <div style="display:flex;align-items:center;gap:8px;">
              <span id="lbLogo"></span>
              <strong id="lbTitle" style="font-size:14px;color:#25303d;">预览</strong>
              <span class="archive-hit-tag" id="lbMeta"></span>
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

    // Assign exact sandbox page URL AFTER message listeners are ready
    const exactSandboxUrl = chrome.runtime.getURL("sandbox-preview.html");
    shadow.getElementById("previewFrame").src = exactSandboxUrl;
    shadow.getElementById("lbFrame").src = exactSandboxUrl;

    bindShadowEvents();
  }

  function bindShadowEvents() {
    const win = shadow.getElementById("extWin");
    const fab = shadow.getElementById("minimizedFab");
    const handle = shadow.getElementById("dragHandle");
    const root = shadow.getElementById("pelicanRoot");

    // Smooth dragging
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

    // Manual Refresh Clipboard Button
    shadow.getElementById("btnRefreshClip").addEventListener("click", async () => {
      try {
        const raw = await chrome.runtime.sendMessage({ type: "READ_RAW_CLIPBOARD" });
        if (raw && raw.ok && raw.hasCode && raw.code) {
          showWindowAndIdentify(raw.code, { autoTriggered: false, forceRefresh: true });
        } else if (uiState.currentCode) {
          deliverToSandbox("previewFrame", "preview", uiState.currentCode);
        }
      } catch (_) {}
    });

    // Source Filter Pills (全部 / 开源 / 闭源)
    shadow.querySelectorAll(".source-pill-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const target = btn.dataset.filter;
        uiState.sourceFilter = (uiState.sourceFilter === target && target !== "all") ? "all" : target;
        syncPillButtons();
        renderVerdictUI();
        chrome.runtime.sendMessage({
          type: "SAVE_CONFIG",
          patch: { sourceFilter: uiState.sourceFilter }
        }).catch(() => {});
      });
    });

    // Expand / Collapse
    const btnExpand = shadow.getElementById("btnExpand");
    btnExpand.addEventListener("click", () => {
      uiState.expanded = !uiState.expanded;
      shadow.getElementById("expandedWrap").style.display = uiState.expanded ? "block" : "none";
      btnExpand.textContent = uiState.expanded ? "▴" : "▾";
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

    // Toggle Annotation
    shadow.getElementById("btnToggleAnnot").addEventListener("click", (e) => {
      uiState.showAnnot = !uiState.showAnnot;
      e.currentTarget.textContent = `注释: ${uiState.showAnnot ? "开" : "关"}`;
      shadow.getElementById("annotBar").style.display = uiState.showAnnot ? "flex" : "none";
    });

    // Fullscreen Lightbox
    const lb = shadow.getElementById("lbBackdrop");
    shadow.getElementById("btnOpenLb").addEventListener("click", () => {
      lb.classList.add("open");
      deliverToSandbox("lbFrame", "lightbox", uiState.currentCode);
      shadow.getElementById("lbTitle").textContent = shadow.getElementById("annotName").textContent;
      shadow.getElementById("lbLogo").innerHTML = shadow.getElementById("annotLogo").innerHTML;
      shadow.getElementById("lbMeta").textContent =
        `${shadow.getElementById("annotSrc").textContent} · ${shadow.getElementById("annotTier").textContent} · ${shadow.getElementById("annotConf").textContent}`;
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

    const { rawList, filtered, poolSum, openSharePct, closedSharePct, overallTop, activeTop, displayProb, probPct, exactHit } = calc;

    shadow.getElementById("pctAll").textContent = `${rawList.length}款`;
    shadow.getElementById("pctOpen").textContent = `${openSharePct}%`;
    shadow.getElementById("pctClosed").textContent = `${closedSharePct}%`;

    const rarity = activeTop.rarity || "normal";
    const rank = activeTop.arenaRank || null;
    const tierStr = (res.effortTier || "high").toUpperCase();

    const notice = shadow.getElementById("filterNotice");
    if (uiState.sourceFilter !== "all" && overallTop.isOpen !== (uiState.sourceFilter === "open") && (overallTop.probability || 0) >= 0.85) {
      const oppName = overallTop.isOpen ? "开源" : "闭源";
      notice.style.display = "block";
      notice.textContent = `提示：全库高把握命中${oppName}模型 ${overallTop.label} (${Math.round(overallTop.probability * 100)}%)，当前强制仅显示${uiState.sourceFilter === "open" ? "开源" : "闭源"}池候选。`;
    } else {
      notice.style.display = "none";
    }

    // 1. Preview Annotation Overlay
    const annotBar = shadow.getElementById("annotBar");
    annotBar.style.display = uiState.showAnnot ? "flex" : "none";
    annotBar.className = `preview-model-annot annot-${rarity}`;
    shadow.getElementById("annotLogo").innerHTML = getVendorLogoSvg(activeTop.vendor || activeTop.label, 19);
    shadow.getElementById("annotName").textContent = activeTop.label;
    const annotSrc = shadow.getElementById("annotSrc");
    annotSrc.className = `micro-badge ${activeTop.isOpen ? "open" : "closed"}`;
    annotSrc.textContent = activeTop.isOpen ? "开源" : "闭源";
    shadow.getElementById("annotTier").textContent = tierStr;
    shadow.getElementById("annotConf").textContent = `${probPct}%`;

    // 2. Gacha Verdict Hero Card
    const hero = shadow.getElementById("verdictHero");
    hero.className = "gacha-hero";
    void hero.offsetWidth;
    hero.classList.add(`rarity-${rarity}`);

    const rarityPill = shadow.getElementById("rarityPill");
    const heroSub = shadow.getElementById("heroSub");
    if (rarity === "gold") {
      rarityPill.textContent = `🥇 金色传说 · ARENA #${rank || 1} 主推`;
      heroSub.textContent = `榜单前三主推 · 强度 ${tierStr}`;
    } else if (rarity === "silver") {
      rarityPill.textContent = `🥈 银色主推 · ARENA #${rank || 4} 推荐`;
      heroSub.textContent = `榜单 4–6 推荐 · 强度 ${tierStr}`;
    } else {
      rarityPill.textContent = uiState.sourceFilter === "open" ? "开源模型池 · 首位命中" : uiState.sourceFilter === "closed" ? "闭源商业池 · 首位命中" : "常规模型池 · 细分归属";
      heroSub.textContent = `推理强度 ${tierStr} · 原始得分 ${((activeTop.probability || 0) * 100).toFixed(1)}%`;
    }

    const heroSrcTag = shadow.getElementById("heroSrcTag");
    heroSrcTag.className = `micro-badge ${activeTop.isOpen ? "open" : "closed"}`;
    heroSrcTag.textContent = activeTop.isOpen ? "开源权重" : "闭源商业";

    const confBandTag = shadow.getElementById("confBandTag");
    if (exactHit && activeTop.id === overallTop.id) confBandTag.textContent = "馆藏精确命中";
    else if (displayProb >= 0.88) confBandTag.textContent = "高把握";
    else if (displayProb >= 0.55) confBandTag.textContent = "倾向判断";
    else confBandTag.textContent = "多候选竞争";

    shadow.getElementById("heroLogo").innerHTML = getVendorLogoSvg(activeTop.vendor || activeTop.label, 26);
    shadow.getElementById("heroTitle").textContent = activeTop.label;

    const circum = 138.2;
    const offset = circum * (1 - Math.max(0.03, Math.min(1, displayProb)));
    const ring = shadow.getElementById("confRing");
    ring.style.strokeDashoffset = offset.toFixed(1);
    ring.setAttribute(
      "stroke",
      rarity === "gold" ? "#c49545" : rarity === "silver" ? "#6d849c" : activeTop.isOpen ? "#276e59" : "#4f6d8a"
    );
    shadow.getElementById("confPct").textContent = `${probPct}%`;

    // 3. Effort Tier Segments
    const tierMap = {};
    (res.tierProbabilities || []).forEach((tp) => { tierMap[tp.tier] = tp.probability; });
    const effConf = res.effortConfidence ?? tierMap[res.effortTier] ?? 0;
    shadow.getElementById("effortHeadline").textContent =
      `${TIER_CN[res.effortTier] || tierStr} (${Math.round(effConf * 100)}%)`;

    shadow.getElementById("tierGrid").innerHTML = TIER_ORDER.map((t) => {
      const p = (tierMap[t] || 0) * 100;
      const isTop = t === res.effortTier;
      return `<div class="tier-seg ${isTop ? "active" : ""}">
        <div class="tier-seg-label">${t}</div>
        <div class="tier-seg-val">${p.toFixed(0)}%</div>
      </div>`;
    }).join("");

    // 4. Top-5 Candidate Bars
    shadow.getElementById("candTitle").textContent =
      uiState.sourceFilter === "open" ? "开源模型概率分布" : uiState.sourceFilter === "closed" ? "闭源模型概率分布" : "全库模型概率分布";
    shadow.getElementById("candHint").textContent =
      uiState.sourceFilter === "all" ? "Top-5 候选" : `池内归一化 · 共 ${filtered.length} 款`;

    shadow.getElementById("candBars").innerHTML = filtered.slice(0, 5).map((m) => {
      const normP = uiState.sourceFilter === "all"
        ? (Number(m.probability) || 0) * 100
        : poolSum > 0.0005 ? ((Number(m.probability) || 0) / poolSum) * 100 : 0;
      const pct = Math.min(100, Math.max(0, normP));
      const r = m.rarity || "normal";
      const barColor =
        r === "gold" ? "linear-gradient(90deg, #cda052, #b48332)"
        : r === "silver" ? "linear-gradient(90deg, #879cb2, #637991)"
        : m.isOpen ? "linear-gradient(90deg, #348f73, #236852)" : "#6d8094";
      const rankTag =
        r === "gold" ? `<span class="mini-rank-tag gold">#${m.arenaRank} 金</span>`
        : r === "silver" ? `<span class="mini-rank-tag silver">#${m.arenaRank} 银</span>` : "";
      const srcTag = `<span class="mini-rank-tag ${m.isOpen ? "open" : "closed"}">${m.isOpen ? "开源" : "闭源"}</span>`;

      return `<div class="cand-row">
        ${getVendorLogoSvg(m.vendor || m.label, 19)}
        <div>
          <div class="cand-name-line"><span>${escapeHtml(m.label)}</span>${rankTag}${srcTag}</div>
          <div class="prob-track"><div class="prob-fill" style="width:${pct.toFixed(1)}%;background:${barColor};"></div></div>
        </div>
        <div class="cand-pct">${pct.toFixed(1)}%</div>
      </div>`;
    }).join("");

    shadow.getElementById("fabText").textContent = `${activeTop.label} · ${tierStr} (${probPct}%)`;
  }

  async function showWindowAndIdentify(rawCode, opts = {}) {
    const autoTriggered = opts.autoTriggered !== false;
    const forceRefresh = Boolean(opts.forceRefresh);
    const parsed = extractRenderableCode(rawCode);
    if (!parsed) return;

    const h = fastHash(parsed.code);
    const now = Date.now();
    // Only suppress duplicate callbacks within 380ms caused by the SAME copy action firing both hook + copy event
    if (!forceRefresh && h === lastTriggerHash && now - lastTriggerTs < 380) {
      return;
    }
    lastTriggerHash = h;
    lastTriggerTs = now;

    const myReqSeq = ++identifySeq;

    try {
      const st = await chrome.runtime.sendMessage({ type: "GET_STATE" });
      if (myReqSeq !== identifySeq) return;
      if (st && st.config) {
        if (autoTriggered && st.config.autoPopup === false) return;
        uiState.sourceFilter = st.config.sourceFilter || "all";
      }
    } catch (_) {}

    ensureUI();
    syncPillButtons();

    uiState.visible = true;
    uiState.minimized = false;
    uiState.currentCode = parsed.code;
    uiState.currentHash = h;
    uiState.currentType = parsed.type;

    const win = shadow.getElementById("extWin");
    const fab = shadow.getElementById("minimizedFab");
    fab.classList.remove("show");
    win.classList.add("show");
    win.classList.remove("pop-anim");
    void win.offsetWidth;
    win.classList.add("pop-anim");

    const kb = (parsed.code.length / 1024).toFixed(1);
    shadow.getElementById("formatChip").textContent = `${parsed.type} · ${kb} KB`;
    shadow.getElementById("elapsedLbl").textContent = "识别中...";
    shadow.getElementById("heroTitle").textContent = "正在识别模型...";
    shadow.getElementById("annotName").textContent = "识别中...";

    // Render into sandbox AFTER window has display:flex so layout dimensions are real, with ACK retry
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
        shadow.getElementById("elapsedLbl").textContent = `${res.verdict.elapsedMs || 12} ms`;
        renderVerdictUI();
      } else {
        shadow.getElementById("elapsedLbl").textContent = "失败";
        shadow.getElementById("heroTitle").textContent = "识别请求失败";
        shadow.getElementById("heroSub").textContent = (res && res.error) || "请检查网络或插件连接配置";
      }
    } catch (_) {
      if (myReqSeq !== identifySeq) return;
      shadow.getElementById("elapsedLbl").textContent = "需刷新页面";
      shadow.getElementById("heroTitle").textContent = "扩展刚刚更新";
      shadow.getElementById("heroSub").textContent = "请按 F5 刷新当前网页一次即可正常使用";
    }
  }

  // Verify against the actual live OS clipboard so stale page selections NEVER win
  async function syncFromTrueSystemClipboard(fallbackText = "") {
    try {
      const raw = await chrome.runtime.sendMessage({ type: "READ_RAW_CLIPBOARD" });
      if (raw && raw.ok && raw.hasCode && raw.code) {
        await showWindowAndIdentify(raw.code, { autoTriggered: true });
        return true;
      }
    } catch (_) {}

    if (fallbackText && extractRenderableCode(fallbackText)) {
      await showWindowAndIdentify(fallbackText, { autoTriggered: true });
      return true;
    }
    return false;
  }

  // ==================== CLIPBOARD LISTENERS ====================
  // 1. MAIN-world clipboard.writeText / clipboard.write / DataTransfer.setData / execCommand('copy') hook
  window.addEventListener("message", (ev) => {
    const d = ev && ev.data;
    if (!d || d.source !== "__PELICAN_EXT_CLIPBOARD__" || typeof d.text !== "string") return;
    showWindowAndIdentify(d.text, { autoTriggered: true });

    // Double-check actual OS clipboard 180ms later in case an async step overwrote clipboard right after
    setTimeout(async () => {
      try {
        const raw = await chrome.runtime.sendMessage({ type: "READ_RAW_CLIPBOARD" });
        if (raw && raw.ok && raw.hasCode && raw.hash && raw.hash !== uiState.currentHash) {
          showWindowAndIdentify(raw.code, { autoTriggered: true, forceRefresh: true });
        }
      } catch (_) {}
    }, 180);
  });

  // 2. Native DOM copy event (Ctrl+C / Cmd+C / button execCommand)
  // Always read the REAL system clipboard AFTER the copy completes (bubble phase + 45ms/180ms)
  document.addEventListener("copy", () => {
    const selFallback = window.getSelection ? window.getSelection().toString() : "";
    setTimeout(async () => {
      const ok = await syncFromTrueSystemClipboard("");
      if (!ok) {
        setTimeout(() => syncFromTrueSystemClipboard(selFallback), 140);
      }
    }, 45);
  }, false);

  // 3. Detect clicks on "Copy / 复制" buttons (catches async fetch -> clipboard buttons in 80ms/260ms/600ms!)
  function isLikelyCopyButton(target) {
    if (!target || typeof target.closest !== "function") return false;
    const btn = target.closest("button, [role='button'], a, [data-clipboard-text], [class*='copy'], [class*='Copy']");
    if (!btn) return false;
    // Ignore clicks inside our own host element
    if (hostEl && hostEl.contains(btn)) return false;
    const hint = [
      btn.textContent || "",
      btn.getAttribute("aria-label") || "",
      btn.getAttribute("title") || "",
      btn.getAttribute("data-tooltip") || "",
      btn.className || ""
    ].join(" ");
    return /copy|复制|拷贝|源码|clipboard/i.test(hint);
  }

  document.addEventListener("click", (ev) => {
    if (!isLikelyCopyButton(ev.target)) return;
    const clickTs = Date.now();
    const prevHashAtClick = uiState.currentHash;

    // Poll real OS clipboard at 80ms, 260ms, and 600ms to catch both sync and async-fetch copy buttons!
    [80, 260, 600].forEach((delay, idx) => {
      setTimeout(async () => {
        // Stop polling if a trigger already handled this click!
        if (lastTriggerTs >= clickTs) return;
        try {
          const raw = await chrome.runtime.sendMessage({ type: "READ_RAW_CLIPBOARD" });
          if (!raw || !raw.ok || !raw.hasCode || !raw.code) return;
          // At 80ms/260ms, prefer changed clipboard; by 260ms if user re-copied the SAME code, still open/refresh!
          if (raw.hash !== prevHashAtClick || idx >= 1 || !uiState.visible) {
            if (lastTriggerTs < clickTs) {
              showWindowAndIdentify(raw.code, { autoTriggered: true, forceRefresh: true });
            }
          }
        } catch (_) {}
      }, delay);
    });
  }, true);

  // 4. Window focus: detect NEW SVG/HTML copied from external desktop apps (VS Code / WeChat / Notepad)
  window.addEventListener("focus", () => {
    setTimeout(async () => {
      try {
        const res = await chrome.runtime.sendMessage({
          type: "CHECK_SYSTEM_CLIPBOARD",
          autoTriggered: true,
          onlyIfChanged: true
        });
        if (res && res.ok && res.verdict && res.code) {
          const st = await chrome.runtime.sendMessage({ type: "GET_STATE" });
          if (st && st.config) uiState.sourceFilter = st.config.sourceFilter || "all";
          ensureUI();
          syncPillButtons();
          uiState.visible = true;
          uiState.minimized = false;
          uiState.currentCode = res.code;
          uiState.currentHash = res.hash || fastHash(res.code);
          uiState.currentType = res.codeType || "SVG";
          uiState.currentVerdict = res.verdict;
          const win = shadow.getElementById("extWin");
          shadow.getElementById("minimizedFab").classList.remove("show");
          win.classList.add("show", "pop-anim");
          shadow.getElementById("formatChip").textContent = `${uiState.currentType} · ${(res.code.length / 1024).toFixed(1)} KB`;
          shadow.getElementById("elapsedLbl").textContent = `${res.verdict.elapsedMs || 12} ms`;
          deliverToSandbox("previewFrame", "preview", res.code);
          renderVerdictUI();
        }
      } catch (_) {}
    }, 100);
  });

  // 5. Messages from Background / Popup
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || !msg.type) return false;
    if (msg.type === "SHOW_PELICAN_FLOATING_PREVIEW" && msg.code) {
      showWindowAndIdentify(msg.code, { autoTriggered: false, forceRefresh: true });
      sendResponse({ ok: true });
      return false;
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

  // Sync pill filter across tabs & popup automatically
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.pelican_ext_config_v1 && changes.pelican_ext_config_v1.newValue) {
      const nextFilter = changes.pelican_ext_config_v1.newValue.sourceFilter || "all";
      if (nextFilter !== uiState.sourceFilter) {
        uiState.sourceFilter = nextFilter;
        syncPillButtons();
        renderVerdictUI();
      }
    }
  });
})();
