"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// apps/desktop/src/system-speech.ts
var system_speech_exports = {};
__export(system_speech_exports, {
  SPEECH_EVENT_CHANNEL: () => SPEECH_EVENT_CHANNEL,
  createSystemSpeech: () => createSystemSpeech
});
module.exports = __toCommonJS(system_speech_exports);

// apps/desktop/src/app-frame.ts
function fromAppFrame(target, event) {
  try {
    if (!target || target.webContents.isDestroyed() || event.sender !== target.webContents || event.senderFrame !== event.sender.mainFrame || !event.senderFrame)
      return false;
    const origin = new URL(target.url).origin;
    return origin !== "null" && new URL(event.senderFrame.url).origin === origin;
  } catch {
    return false;
  }
}

// apps/desktop/src/system-speech.ts
var SPEECH_EVENT_CHANNEL = "desktop.speech.event";
var LANGUAGE_TAG = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,3}$/;
var ERROR_CODES = /* @__PURE__ */ new Set([
  "aborted",
  "audio-capture",
  "language-not-supported",
  "network",
  "no-speech",
  "not-allowed",
  "service-not-allowed"
]);
var MAX_LINE_CHARS = 64 * 1024;
function createSystemSpeech(getTarget, spawnRecognizer) {
  let active = null;
  const watched = /* @__PURE__ */ new WeakSet();
  const owner = (event, session) => active !== null && active.session === session && active.sender === event.sender && fromAppFrame(getTarget(), event) ? active : null;
  function close(listening, pageGone = false) {
    if (active === listening) active = null;
    if (pageGone) listening.cancel();
    listening.child.kill();
  }
  return {
    start(event, language, session) {
      if (!fromAppFrame(getTarget(), event) || typeof language !== "string" || language.length > 35 || !LANGUAGE_TAG.test(language) || !Number.isSafeInteger(session) || session <= 0)
        return false;
      if (active) close(active);
      const sender = event.sender;
      const send = (message) => {
        if (!ended && !sender.isDestroyed()) sender.send(SPEECH_EVENT_CHANNEL, message);
      };
      let ended = false;
      const end = (error) => {
        if (ended) return;
        if (error) send({ session, type: "error", error });
        send({ session, type: "end" });
        ended = true;
        if (active?.child === child) active = null;
      };
      let child;
      try {
        child = spawnRecognizer(language);
      } catch {
        setImmediate(() => end("service-not-allowed"));
        return true;
      }
      const listening = {
        sender,
        session,
        child,
        cancel: () => {
          ended = true;
        }
      };
      active = listening;
      if (!watched.has(sender)) {
        watched.add(sender);
        sender.on("did-start-navigation", (_event, _url, isInPlace, isMainFrame) => {
          if (isMainFrame && !isInPlace && active?.sender === sender) close(active, true);
        });
        sender.once("destroyed", () => {
          if (active?.sender === sender) close(active, true);
        });
      }
      let pending = "";
      const read = (line) => {
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          return;
        }
        if (typeof message !== "object" || message === null) return;
        const { type, text, error } = message;
        if (type === "result" && typeof text === "string") {
          send({ session, type: "result", text });
        } else if (type === "error" && typeof error === "string" && ERROR_CODES.has(error)) {
          send({ session, type: "error", error });
        } else if (type === "end") {
          end();
        }
      };
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        if (ended || active !== listening) return;
        pending += chunk;
        let newline = pending.indexOf("\n");
        while (newline >= 0) {
          if (newline > MAX_LINE_CHARS) break;
          read(pending.slice(0, newline));
          pending = pending.slice(newline + 1);
          if (ended || active !== listening) return;
          newline = pending.indexOf("\n");
        }
        if (pending.length > MAX_LINE_CHARS) {
          pending = "";
          end("network");
          close(listening);
        }
      });
      child.stderr.resume();
      child.stdin.on("error", () => void 0);
      child.on("error", () => end("service-not-allowed"));
      child.on("close", () => end());
      return true;
    },
    stop(event, session) {
      owner(event, session)?.child.stdin.write("stop\n");
    },
    abort(event, session) {
      const listening = owner(event, session);
      if (listening) close(listening);
    }
  };
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  SPEECH_EVENT_CHANNEL,
  createSystemSpeech
});
