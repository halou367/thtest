(function () {
  "use strict";
  if (window.__pelicanClipboardHookInstalled) return;
  window.__pelicanClipboardHookInstalled = true;

  let hookSeq = 0;
  let lastPlainSetDataText = "";
  let lastPlainSetDataTs = 0;

  function looksLikeRenderableCode(text) {
    if (typeof text !== "string" || text.length < 24 || text.length > 3500000) return false;
    // Reject browser rich-text clipboard HTML wrappers (e.g. <!--StartFragment-->)
    if (text.includes("<!--StartFragment-->") || /^<meta\s+charset=/i.test(text.trim())) {
      return false;
    }
    return /<svg[\s>]|<!doctype\s+html|<html[\s>]|<(canvas|style|script)[\s>]/i.test(text);
  }

  function emitCopiedText(text, method) {
    try {
      if (!looksLikeRenderableCode(text)) return;
      const payload = {
        source: "__PELICAN_EXT_CLIPBOARD__",
        text: text,
        method: method || "hook",
        seq: ++hookSeq,
        ts: Date.now()
      };
      const targetWin = window.top || window;
      targetWin.postMessage(payload, "*");
      if (targetWin !== window && window.parent && window.parent !== targetWin) {
        try {
          window.parent.postMessage(payload, "*");
        } catch (_) {}
      }
    } catch (_) {}
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

    // 2. Hook Clipboard.prototype.write (STRICTLY text/plain only, never rich-text text/html wrapper!)
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

  // 3. Hook DataTransfer.prototype.setData (STRICTLY text/plain or text — never browser rich-text text/html!)
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
})();
