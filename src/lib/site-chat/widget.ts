// The embeddable widget's client-side JS, as a string.
//
// Why a string module instead of public/site-chat.js: with this app's
// `basePath: "/app"`, Next 16 does NOT reliably serve public/*.js at
// /app/site-chat.js (it falls through to the app router). Static .png /
// .html under public work; .js does not. So the widget is served by an
// explicit route handler (src/app/site-chat.js/route.ts) that returns
// this string with a JS content-type. Bundled as code → identical
// behaviour in dev and on Vercel, no fs reads, no routing ambiguity.
//
// This is plain browser JS (no build step, no framework). String.raw
// keeps the regex backslashes (\/  \.) literal. The source contains no
// backticks or ${...}, so the template literal is safe.

export const SITE_CHAT_WIDGET_JS = String.raw`/*
 * LeadStart site chat widget — embeddable, dependency-free.
 *
 * Drop ONE line onto leadstart.io (or any site):
 *
 *   <script src="https://leadstart-ebon.vercel.app/app/site-chat.js" async></script>
 *
 * It renders a floating chat button + panel, isolated in a Shadow DOM so
 * the host site's CSS can't break it (and vice versa). It talks back to
 * the /app/api/site-chat endpoint on whatever origin served this script,
 * so the marketing site never needs to know the API URL or be redeployed
 * when the bot changes.
 *
 * Optional config via data-* attributes on the <script> tag:
 *   data-title    — header text       (default: "Chat with LeadStart")
 *   data-greeting — first bot message (default: generic welcome)
 *   data-accent   — primary hex color (default: LeadStart indigo)
 */
(function () {
  "use strict";

  if (window.__leadstartSiteChatLoaded) return;
  window.__leadstartSiteChatLoaded = true;

  // --- Resolve our own script tag → derive the API URL from its origin.
  var me =
    document.currentScript ||
    (function () {
      var all = document.getElementsByTagName("script");
      for (var i = all.length - 1; i >= 0; i--) {
        if (all[i].src && all[i].src.indexOf("site-chat.js") !== -1) {
          return all[i];
        }
      }
      return null;
    })();

  if (!me || !me.src) {
    // Can't figure out where we're served from — bail quietly rather
    // than guess an API URL.
    return;
  }

  var scriptUrl = new URL(me.src);
  var base =
    scriptUrl.origin +
    scriptUrl.pathname.replace(/\/site-chat\.js.*$/, "");
  var API_URL = base + "/api/site-chat";

  var TITLE = me.getAttribute("data-title") || "Chat with LeadStart";
  var GREETING =
    me.getAttribute("data-greeting") ||
    "Hi there. Ask me anything about LeadStart and I'll help you out.";
  var ACCENT = me.getAttribute("data-accent") || "#4f46e5";
  var ACCENT_2 = "#7c3aed";
  var MAX_TURNS = 24;

  // Conversation state (resets on page reload — fine for an MVP).
  var convo = [];
  var busy = false;

  // --- Build the widget inside a shadow root for full style isolation.
  var host = document.createElement("div");
  host.setAttribute("data-leadstart-site-chat", "");
  document.body.appendChild(host);
  var root = host.attachShadow({ mode: "open" });

  var style = document.createElement("style");
  style.textContent = [
    ":host{all:initial}",
    "*{box-sizing:border-box;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif}",
    ".launcher{position:fixed;bottom:20px;right:20px;width:60px;height:60px;border-radius:50%;border:0;cursor:pointer;" +
      "background:linear-gradient(135deg," +
      ACCENT +
      "," +
      ACCENT_2 +
      ");box-shadow:0 8px 24px rgba(79,70,229,.4);display:flex;align-items:center;justify-content:center;z-index:2147483646;transition:transform .15s ease}",
    ".launcher:hover{transform:scale(1.06)}",
    ".launcher svg{width:26px;height:26px;fill:#fff}",
    ".panel{position:fixed;bottom:90px;right:20px;width:380px;max-width:calc(100vw - 32px);height:560px;max-height:calc(100vh - 120px);" +
      "background:#fff;border-radius:16px;box-shadow:0 16px 48px rgba(0,0,0,.22);display:none;flex-direction:column;overflow:hidden;z-index:2147483647}",
    ".panel.open{display:flex}",
    ".header{background:linear-gradient(135deg," +
      ACCENT +
      "," +
      ACCENT_2 +
      ");color:#fff;padding:16px 18px;display:flex;align-items:center;justify-content:space-between}",
    ".header h1{margin:0;font-size:15px;font-weight:600}",
    ".header button{background:transparent;border:0;color:#fff;cursor:pointer;font-size:20px;line-height:1;opacity:.85;padding:4px}",
    ".header button:hover{opacity:1}",
    ".msgs{flex:1;overflow-y:auto;padding:16px;background:#f7f7fb;display:flex;flex-direction:column;gap:10px}",
    ".bubble{max-width:82%;padding:10px 13px;border-radius:14px;font-size:14px;line-height:1.45;white-space:pre-wrap;word-wrap:break-word}",
    ".bubble.bot{background:#fff;color:#1f2330;border:1px solid #e8e8f0;align-self:flex-start;border-bottom-left-radius:4px}",
    ".bubble.user{background:linear-gradient(135deg," +
      ACCENT +
      "," +
      ACCENT_2 +
      ");color:#fff;align-self:flex-end;border-bottom-right-radius:4px}",
    ".bubble.err{background:#fdecec;color:#b42318;border:1px solid #f5c6c6;align-self:flex-start}",
    ".typing{align-self:flex-start;display:flex;gap:4px;padding:12px 14px;background:#fff;border:1px solid #e8e8f0;border-radius:14px;border-bottom-left-radius:4px}",
    ".typing span{width:7px;height:7px;border-radius:50%;background:#b5b5c5;animation:blink 1.3s infinite both}",
    ".typing span:nth-child(2){animation-delay:.2s}.typing span:nth-child(3){animation-delay:.4s}",
    "@keyframes blink{0%,80%,100%{opacity:.3}40%{opacity:1}}",
    ".composer{display:flex;gap:8px;padding:12px;border-top:1px solid #ececf2;background:#fff}",
    ".composer input{flex:1;border:1px solid #d8d8e2;border-radius:10px;padding:10px 12px;font-size:14px;outline:none}",
    ".composer input:focus{border-color:" + ACCENT + "}",
    ".composer button{border:0;border-radius:10px;padding:0 16px;cursor:pointer;color:#fff;font-size:14px;font-weight:600;" +
      "background:linear-gradient(135deg," +
      ACCENT +
      "," +
      ACCENT_2 +
      ")}",
    ".composer button:disabled{opacity:.5;cursor:not-allowed}",
    ".credit{text-align:center;font-size:11px;color:#9a9aa8;padding:0 0 8px;background:#fff}",
  ].join("");
  root.appendChild(style);

  var wrap = document.createElement("div");
  wrap.innerHTML =
    '<button class="launcher" aria-label="Open chat">' +
    '<svg viewBox="0 0 24 24"><path d="M12 3C6.5 3 2 6.8 2 11.5c0 2.4 1.2 4.6 3.1 6.1-.2 1.4-.8 2.7-1.8 3.8 1.7-.2 3.3-.8 4.7-1.7 1.2.4 2.6.6 4 .6 5.5 0 10-3.8 10-8.8S17.5 3 12 3z"/></svg>' +
    "</button>" +
    '<div class="panel" role="dialog" aria-label="' +
    TITLE.replace(/"/g, "&quot;") +
    '">' +
    '<div class="header"><h1></h1><button class="close" aria-label="Close chat">&times;</button></div>' +
    '<div class="msgs"></div>' +
    '<div class="composer"><input type="text" placeholder="Type your question..." aria-label="Your message" /><button class="send">Send</button></div>' +
    '<div class="credit">Powered by LeadStart</div>' +
    "</div>";
  root.appendChild(wrap);

  var launcher = root.querySelector(".launcher");
  var panel = root.querySelector(".panel");
  var msgs = root.querySelector(".msgs");
  var input = root.querySelector(".composer input");
  var sendBtn = root.querySelector(".send");
  root.querySelector(".header h1").textContent = TITLE;

  function scrollDown() {
    msgs.scrollTop = msgs.scrollHeight;
  }

  function addBubble(text, kind) {
    var b = document.createElement("div");
    b.className = "bubble " + kind;
    b.textContent = text;
    msgs.appendChild(b);
    scrollDown();
  }

  function showTyping() {
    var t = document.createElement("div");
    t.className = "typing";
    t.innerHTML = "<span></span><span></span><span></span>";
    msgs.appendChild(t);
    scrollDown();
    return t;
  }

  var opened = false;
  function openPanel() {
    panel.classList.add("open");
    if (!opened) {
      opened = true;
      addBubble(GREETING, "bot");
    }
    setTimeout(function () {
      input.focus();
    }, 50);
  }
  function closePanel() {
    panel.classList.remove("open");
  }

  launcher.addEventListener("click", function () {
    panel.classList.contains("open") ? closePanel() : openPanel();
  });
  root.querySelector(".close").addEventListener("click", closePanel);

  function send() {
    if (busy) return;
    var text = (input.value || "").trim();
    if (!text) return;

    addBubble(text, "user");
    convo.push({ role: "user", content: text });
    // Keep the client-side history within the server's cap.
    if (convo.length > MAX_TURNS) convo = convo.slice(-MAX_TURNS);

    input.value = "";
    busy = true;
    sendBtn.disabled = true;
    var typing = showTyping();

    fetch(API_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: convo }),
    })
      .then(function (res) {
        return res
          .json()
          .catch(function () {
            return {};
          })
          .then(function (data) {
            return { ok: res.ok, data: data };
          });
      })
      .then(function (r) {
        typing.remove();
        if (r.ok && r.data && r.data.reply) {
          addBubble(r.data.reply, "bot");
          convo.push({ role: "assistant", content: r.data.reply });
        } else {
          var msg =
            (r.data && r.data.error) ||
            "Sorry, something went wrong. Please try again.";
          addBubble(msg, "err");
        }
      })
      .catch(function () {
        typing.remove();
        addBubble(
          "I couldn't reach the server. Please check your connection and try again.",
          "err"
        );
      })
      .then(function () {
        busy = false;
        sendBtn.disabled = false;
        input.focus();
      });
  }

  sendBtn.addEventListener("click", send);
  input.addEventListener("keydown", function (e) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  });
})();
`;
