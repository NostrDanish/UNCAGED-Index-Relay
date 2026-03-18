import type { NostrRelayInfo } from "@nostrify/nostrify";

/** Escape HTML special characters to prevent XSS. */
function esc(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

/** Generate a polished single-page HTML landing page from NIP-11 relay info. */
export function renderLandingPage(
  info: NostrRelayInfo,
  relayUrl: string,
): string {
  const name = esc(String(info.name ?? "Nostr Relay"));
  const description = esc(String(info.description ?? ""));
  const banner = info.banner ? esc(String(info.banner)) : "";
  const icon = info.icon ? esc(String(info.icon)) : "";
  const version = info.version ? esc(String(info.version)) : "";
  const contact = info.contact ? esc(String(info.contact)) : "";
  const software = info.software ? esc(String(info.software)) : "";
  const relay = esc(relayUrl);

  const contactHtml = contact
    ? contact.startsWith("mailto:")
      ? `<a href="${contact}">${esc(contact.replace(/^mailto:/, ""))}</a>`
      : contact.includes("@")
        ? `<a href="mailto:${contact}">${contact}</a>`
        : contact.startsWith("http")
          ? `<a href="${contact}" target="_blank" rel="noopener">${contact}</a>`
          : contact
    : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${name}</title>
  ${description ? `<meta name="description" content="${description}">` : ""}
  <link rel="icon" href="/favicon.ico">
  ${icon ? `<link rel="apple-touch-icon" href="${icon}">` : ""}
  <meta property="og:type" content="website">
  <meta property="og:title" content="${name}">
  ${description ? `<meta property="og:description" content="${description}">` : ""}
  ${banner ? `<meta property="og:image" content="${banner}">` : icon ? `<meta property="og:image" content="${icon}">` : ""}
  <meta name="twitter:card" content="${banner ? "summary_large_image" : "summary"}">
  <meta name="twitter:title" content="${name}">
  ${description ? `<meta name="twitter:description" content="${description}">` : ""}
  ${banner ? `<meta name="twitter:image" content="${banner}">` : icon ? `<meta name="twitter:image" content="${icon}">` : ""}
  <style>
    *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
    :root{
      --bg:#0a0a0c;
      --surface:#12121a;
      --border:#1e1e2e;
      --text:#e0e0e8;
      --text-dim:#7f7f96;
      --accent:#7c5cfc;
      --radius:16px;
    }
    html{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
      background:var(--bg);color:var(--text);line-height:1.6;-webkit-font-smoothing:antialiased}
    body{min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:24px}

    /* Card */
    .card{width:100%;max-width:600px;background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);overflow:visible}

    /* Banner */
    .banner-wrap{position:relative;aspect-ratio:21/9;overflow:hidden;border-radius:var(--radius) var(--radius) 0 0;background:var(--border)}
    .banner-img{width:100%;height:100%;object-fit:cover;display:block}

    /* Icon */
    .icon-row{position:relative;height:0}
    .icon{position:absolute;bottom:0;left:24px;transform:translateY(50%);width:80px;height:80px;border-radius:20px;
      border:4px solid var(--surface);object-fit:cover;background:var(--border);box-shadow:0 4px 24px #0004}

    /* Body */
    .card-body{padding:56px 24px 24px}
    .no-banner-body{padding:32px 24px 24px}
    .relay-name{font-size:1.4rem;font-weight:700;letter-spacing:-0.02em}
    .description{margin-top:8px;color:var(--text-dim);font-size:0.92rem;line-height:1.55}

    /* Meta */
    .meta{margin-top:12px;display:flex;flex-wrap:wrap;gap:6px 20px;font-size:0.82rem;color:var(--text-dim)}
    .meta a{color:var(--accent);text-decoration:none}
    .meta a:hover{text-decoration:underline}
    .version{opacity:0.7}

    /* Relay URL input */
    .relay-url-wrap{padding:0 24px 24px}
    .relay-url-group{display:flex;align-items:center;background:#0a0a0c;border:1px solid var(--border);
      border-radius:100px;overflow:hidden;transition:border-color .15s}
    .relay-url-group:hover{border-color:#2a2a40}
    .relay-url-group:focus-within{border-color:var(--accent);box-shadow:0 0 0 2px rgba(124,92,252,0.15)}
    .relay-url-input{flex:1;background:none;border:none;color:var(--text);font-size:0.88rem;
      padding:12px 0 12px 20px;outline:none;font-family:inherit;min-width:0;letter-spacing:0.01em}
    .relay-url-input::selection{background:rgba(124,92,252,0.3)}
    .copy-btn{display:flex;align-items:center;gap:6px;background:none;border:none;color:var(--text-dim);
      cursor:pointer;padding:10px 16px 10px 12px;font-size:0.78rem;font-family:inherit;
      border-radius:0 100px 100px 0;transition:color .15s,background .15s;white-space:nowrap;letter-spacing:0.02em}
    .copy-btn:hover{color:var(--text);background:rgba(255,255,255,0.04)}
    .copy-btn:active{background:rgba(255,255,255,0.07)}
    .copy-btn svg{width:16px;height:16px;flex-shrink:0}
    .copy-btn .label{transition:opacity .1s}

    /* Footer */
    .footer{margin-top:24px;text-align:center;color:var(--text-dim);font-size:0.7rem}
    .footer a{color:inherit;text-decoration:none}
    .footer a:hover{text-decoration:underline}
  </style>
</head>
<body>
  <div class="card">
    ${
      banner
        ? `<div class="banner-wrap"><img class="banner-img" src="${banner}" alt=""></div>
    <div class="icon-row">${icon ? `<img class="icon" src="${icon}" alt="">` : ""}</div>
    <div class="card-body">`
        : `<div class="no-banner-body">${icon ? `<div style="margin-bottom:16px"><img class="icon" src="${icon}" alt="" style="position:static;transform:none;border-color:var(--border)"></div>` : ""}`
    }
      <h1 class="relay-name">${name}</h1>
      ${description ? `<p class="description">${description}</p>` : ""}
      ${
        contactHtml
          ? `<div class="meta">
        <span>${contactHtml}</span>
      </div>`
          : ""
      }
    </div>
    <div class="relay-url-wrap">
      <div class="relay-url-group">
        <input class="relay-url-input" type="text" value="${relay}" readonly>
        <button class="copy-btn" type="button" onclick="copyUrl(this)" aria-label="Copy relay URL">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
          <span class="label">Copy</span>
        </button>
      </div>
    </div>
  </div>
  <div class="footer">${software ? `<a href="${software}">Ditto Relay</a>` : "Ditto Relay"}${version ? ` <span class="version">${version}</span>` : ""}</div>
  <script>
    function copyUrl(btn){
      var input=btn.parentNode.querySelector('.relay-url-input');
      navigator.clipboard.writeText(input.value).then(function(){
        var label=btn.querySelector('.label');
        label.textContent='Copied!';
        btn.style.color='var(--accent)';
        setTimeout(function(){label.textContent='Copy';btn.style.color='';},1500);
      });
    }
  </script>
</body>
</html>`;
}
