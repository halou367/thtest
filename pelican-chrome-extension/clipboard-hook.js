(function () {
  "use strict";
  if (window.__pelicanClipboardHookInstalled) return;
  window.__pelicanClipboardHookInstalled = true;

  let hookSeq = 0;
  let lastPlainSetDataText = "";
  let lastPlainSetDataTs = 0;

  function looksLikeRenderableCode(text) {
    if (typeof text !== "string" || text.length < 24 || text.length > 3500000) return false;
    if (text.includes("<!--StartFragment-->") || /^<meta\s+charset=/i.test(text.trim())) {
      return false;
    }
    return /<svg[\s>]|<!doctype\s+html|<html[\s>]|<(canvas|style|script)[\s>]/i.test(text);
  }

  function looksLikeCompleteLargeSpecimen(text) {
    if (!looksLikeRenderableCode(text) || text.length < 120) return false;
    return /<\/svg>|<\/html>/i.test(text);
  }

  function postToTop(payload) {
    try {
      const targetWin = window.top || window;
      targetWin.postMessage(payload, "*");
      if (targetWin !== window && window.parent && window.parent !== targetWin) {
        try {
          window.parent.postMessage(payload, "*");
        } catch (_) {}
      }
    } catch (_) {}
  }

  function emitCopiedText(text, method) {
    if (!looksLikeRenderableCode(text)) return;
    postToTop({
      source: "__PELICAN_EXT_CLIPBOARD__",
      text: text,
      method: method || "hook",
      seq: ++hookSeq,
      ts: Date.now()
    });
  }

  // 1. Hook Clipboard.prototype.writeText & navigator.clipboard.writeText
  try {
    const proto = typeof Clipboard !== "undefined" && Clipboard.prototype ? Clipboard.prototype : null;
    const origWriteText =
      (proto && proto.writeText) ||
      (navigator.clipboard && navigator.clipboard.writeText);

    if (typeof origWriteText === "function") {
      const wrappedWriteText = function (data) {
        const str = typeof data === "string" ? data : String(data ?? "");
        const ret = origWriteText.apply(this, arguments);
        if (ret && typeof ret.then === "function") {
          ret.then(
            function () { emitCopiedText(str, "writeText"); },
            function () { emitCopiedText(str, "writeText-fallback"); }
          );
        } else {
          emitCopiedText(str, "writeText-sync");
        }
        return ret;
      };
      if (proto) proto.writeText = wrappedWriteText;
      try {
        if (navigator.clipboard) navigator.clipboard.writeText = wrappedWriteText;
      } catch (_) {}
    }

    // 2. Hook Clipboard.prototype.write (STRICTLY text/plain only)
    const origWrite =
      (proto && proto.write) ||
      (navigator.clipboard && navigator.clipboard.write);

    if (typeof origWrite === "function") {
      const wrappedWrite = function (items) {
        const ret = origWrite.apply(this, arguments);
        try {
          if (items && typeof items[Symbol.iterator] === "function") {
            for (const item of items) {
              if (!item || typeof item.getType !== "function" || !Array.isArray(item.types)) continue;
              if (item.types.includes("text/plain")) {
                Promise.resolve(item.getType("text/plain"))
                  .then((blob) => (blob && typeof blob.text === "function" ? blob.text() : ""))
                  .then((txt) => {
                    if (txt) emitCopiedText(txt, "clipboardWrite");
                  })
                  .catch(() => {});
              }
            }
          }
        } catch (_) {}
        return ret;
      };
      if (proto) proto.write = wrappedWrite;
      try {
        if (navigator.clipboard) navigator.clipboard.write = wrappedWrite;
      } catch (_) {}
    }
  } catch (_) {}

  // 3. Hook DataTransfer.prototype.setData (STRICTLY text/plain or text)
  try {
    if (
      typeof DataTransfer !== "undefined" &&
      DataTransfer.prototype &&
      typeof DataTransfer.prototype.setData === "function"
    ) {
      const origSetData = DataTransfer.prototype.setData;
      DataTransfer.prototype.setData = function (format, data) {
        try {
          const fmt = String(format || "").toLowerCase().trim();
          if ((fmt === "text/plain" || fmt === "text") && typeof data === "string" && data) {
            lastPlainSetDataText = data;
            lastPlainSetDataTs = Date.now();
            emitCopiedText(data, "setData");
          }
        } catch (_) {}
        return origSetData.apply(this, arguments);
      };
    }
  } catch (_) {}

  // 4. Hook document.execCommand("copy")
  try {
    const origExecCommand = document.execCommand;
    if (typeof origExecCommand === "function") {
      document.execCommand = function (cmd) {
        const beforeTs = Date.now();
        const res = origExecCommand.apply(this, arguments);
        try {
          if (String(cmd).toLowerCase() === "copy") {
            if (lastPlainSetDataTs >= beforeTs && lastPlainSetDataText) {
              emitCopiedText(lastPlainSetDataText, "execCommand-setData");
              return res;
            }
            let val = "";
            const active = document.activeElement;
            if (active && typeof active.value === "string") {
              const s = active.selectionStart ?? 0;
              const e = active.selectionEnd ?? active.value.length;
              val = active.value.substring(s, e) || active.value;
            }
            if (!val && window.getSelection) {
              val = window.getSelection().toString() || "";
            }
            if (val) emitCopiedText(val, "execCommand-selection");
          }
        } catch (_) {}
        return res;
      };
    }
  } catch (_) {}

  // 5. Hook URL.createObjectURL(blob) to capture sandboxed blob: preview mini-windows (e.g. Arena.ai sandbox="allow-scripts" previews)
  try {
    if (typeof URL !== "undefined" && typeof URL.createObjectURL === "function") {
      const origCreateObjectURL = URL.createObjectURL;
      URL.createObjectURL = function (obj) {
        const blobUrl = origCreateObjectURL.apply(this, arguments);
        try {
          if (
            obj &&
            typeof Blob !== "undefined" &&
            obj instanceof Blob &&
            obj.size >= 100 &&
            obj.size <= 3500000 &&
            (!obj.type || /^(text\/(html|plain|xml)|image\/svg|application\/xhtml)/i.test(obj.type)) &&
            typeof obj.text === "function"
          ) {
            obj
              .text()
              .then((txt) => {
                if (looksLikeCompleteLargeSpecimen(txt) && !txt.includes("__tihu_fit_css")) {
                  postToTop({
                    source: "__PELICAN_BLOB_SPECIMEN__",
                    blobUrl: String(blobUrl || ""),
                    text: txt,
                    ts: Date.now()
                  });
                }
              })
              .catch(() => {});
          }
        } catch (_) {}
        return blobUrl;
      };
    }
  } catch (_) {}

  // 6. Arena.ai React Fiber / Props Code Recovery for collapsed preview mini-windows & workspace viewer
  function getReactFiberFromDom(el) {
    if (!el || typeof el !== "object") return null;
    try {
      const keys = Object.keys(el);
      for (let i = 0; i < keys.length; i++) {
        const k = keys[i];
        if (k.startsWith("__reactFiber$") || k.startsWith("__reactInternalInstance$")) {
          return el[k];
        }
      }
    } catch (_) {}
    return null;
  }

  function scanValueForSpecimens(val, bucket, seenObjs, depth) {
    if (!val || depth > 3) return;
    if (typeof val === "string") {
      if (looksLikeCompleteLargeSpecimen(val) && !val.includes("__tihu_fit_css")) {
        bucket.push(val);
      }
      return;
    }
    if (typeof val !== "object") return;
    if (val instanceof Node || val instanceof Window) return;
    if (seenObjs.has(val)) return;
    seenObjs.add(val);

    if (Array.isArray(val)) {
      const len = Math.min(val.length, 30);
      for (let i = 0; i < len; i++) {
        scanValueForSpecimens(val[i], bucket, seenObjs, depth + 1);
      }
      return;
    }

    // Prioritize high-signal prop names used by Arena / Markdown / Artifact / File Viewer components
    const priorityKeys = [
      "code",
      "content",
      "srcDoc",
      "srcdoc",
      "html",
      "svg",
      "value",
      "text",
      "raw",
      "markdown",
      "fileContent",
      "source",
      "output",
      "result",
      "children",
      "artifact",
      "file",
      "files",
      "args",
      "input"
    ];
    for (let i = 0; i < priorityKeys.length; i++) {
      const pk = priorityKeys[i];
      if (Object.prototype.hasOwnProperty.call(val, pk)) {
        try {
          scanValueForSpecimens(val[pk], bucket, seenObjs, depth + 1);
        } catch (_) {}
      }
    }
  }

  function extractSpecimensFromElementFiber(rootEl, maxFibers) {
    const startFiber = getReactFiberFromDom(rootEl);
    if (!startFiber) return [];

    const foundStrings = [];
    const visitedFibers = new WeakSet();
    const seenObjs = new WeakSet();
    let count = 0;

    // Walk up 3 ancestors lightly (in case wrapper component holds full message markdown/artifact)
    let anc = startFiber;
    for (let up = 0; up < 3 && anc; up++) {
      if (!visitedFibers.has(anc)) {
        visitedFibers.add(anc);
        scanValueForSpecimens(anc.memoizedProps, foundStrings, seenObjs, 0);
      }
      anc = anc.return;
    }

    // DFS subtree of rootEl ONLY (strictly do NOT walk rootFiber's siblings, which would bleed into other turns!)
    const stack = startFiber.child ? [startFiber.child] : [];
    while (stack.length > 0 && count < maxFibers) {
      const f = stack.pop();
      if (!f || visitedFibers.has(f)) continue;
      visitedFibers.add(f);
      count++;

      scanValueForSpecimens(f.memoizedProps, foundStrings, seenObjs, 0);
      // Check memoizedState.memoizedState for useState/useMemo strings
      let st = f.memoizedState;
      let stSteps = 0;
      while (st && stSteps < 8) {
        if (typeof st.memoizedState === "string") {
          scanValueForSpecimens(st.memoizedState, foundStrings, seenObjs, 0);
        } else if (st.memoizedState && typeof st.memoizedState === "object") {
          scanValueForSpecimens(st.memoizedState, foundStrings, seenObjs, 1);
        }
        st = st.next;
        stSteps++;
      }

      if (f.sibling) stack.push(f.sibling);
      if (f.child) stack.push(f.child);
    }

    return foundStrings;
  }

  window.addEventListener("message", (ev) => {
    const d = ev && ev.data;
    if (!d || d.source !== "__PELICAN_SCAN_ARENA_FIBER_REQ__") return;

    try {
      const results = [];
      const seenLenHead = new Set();
      const pushCandidate = (rawStr, msgId, origin) => {
        const key = rawStr.length + ":" + rawStr.slice(0, 64);
        if (seenLenHead.has(key)) return;
        seenLenHead.add(key);
        results.push({ text: rawStr, msgId: msgId || "", origin });
      };

      // 1. Scan targeted latest assistant message elements first
      const targetIds = Array.isArray(d.targetIds) ? d.targetIds : [];
      for (let i = 0; i < targetIds.length; i++) {
        const id = targetIds[i];
        const el =
          document.getElementById(id) ||
          document.querySelector(`[data-chat-message-id="${CSS.escape(id)}"]`);
        if (!el) continue;
        const strs = extractSpecimensFromElementFiber(el, 700);
        for (let j = 0; j < strs.length; j++) {
          pushCandidate(strs[j], id, "对话预览小窗");
        }
      }

      // 2. Scan Arena's active Artifact / Workspace Preview split-pane containers outside chat transcript
      const viewerPanels = document.querySelectorAll(
        '[data-panel], [role="tabpanel"], [class*="artifact"], [class*="preview"], iframe[sandbox]'
      );
      for (let i = 0; i < Math.min(viewerPanels.length, 8); i++) {
        const vp = viewerPanels[i];
        if (vp.closest && vp.closest('[data-chat-message-id], [id^="chat-message-"]')) continue;
        const hostNode = vp.tagName === "IFRAME" && vp.parentElement ? vp.parentElement : vp;
        const strs = extractSpecimensFromElementFiber(hostNode, 350);
        for (let j = 0; j < strs.length; j++) {
          pushCandidate(strs[j], "", "预览视窗");
        }
      }

      if (results.length > 0) {
        window.postMessage(
          {
            source: "__PELICAN_ARENA_FIBER_RES__",
            reqId: d.reqId || 0,
            items: results.slice(0, 10)
          },
          "*"
        );
      } else {
        window.postMessage(
          {
            source: "__PELICAN_ARENA_FIBER_RES__",
            reqId: d.reqId || 0,
            items: []
          },
          "*"
        );
      }
    } catch (_) {
      window.postMessage(
        {
          source: "__PELICAN_ARENA_FIBER_RES__",
          reqId: d.reqId || 0,
          items: []
        },
        "*"
      );
    }
  });
})();
