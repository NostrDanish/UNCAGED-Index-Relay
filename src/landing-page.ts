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
  const software = info.software ? String(info.software) : "";
  const version = info.version ? esc(String(info.version)) : "";
  const contact = info.contact ? esc(String(info.contact)) : "";
  const nips: number[] = (info.supported_nips as number[]) ?? [];
  const lim = (info.limitation as Record<string, unknown>) ?? {};

  const nipBadges = nips
    .map((n) => {
      const padded = String(n).padStart(2, "0");
      return `<a href="https://github.com/nostr-protocol/nips/blob/master/${esc(padded)}.md" target="_blank" rel="noopener" class="nip-badge">NIP-${esc(padded)}</a>`;
    })
    .join("\n            ");

  const limRows = Object.entries(lim)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => {
      const label = esc(k.replace(/_/g, " "));
      const val =
        typeof v === "boolean"
          ? `<span class="bool ${v ? "yes" : "no"}">${v ? "yes" : "no"}</span>`
          : esc(String(v));
      return `<tr><td>${label}</td><td>${val}</td></tr>`;
    })
    .join("\n              ");

  const softwareHtml = software
    ? `<a href="${esc(software)}" target="_blank" rel="noopener">${esc(software.replace(/^https?:\/\//, ""))}</a>${version ? ` <span class="version">${version}</span>` : ""}`
    : version
      ? `<span class="version">${version}</span>`
      : "";

  const contactHtml = contact
    ? contact.includes("@")
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
  <link rel="icon" href="/favicon.ico">
  <style>
    *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
    :root{
      --bg:#0a0a0c;
      --surface:#12121a;
      --border:#1e1e2e;
      --text:#e0e0e8;
      --text-dim:#7a7a8e;
      --accent:#7c5cfc;
      --accent-glow:#7c5cfc33;
      --radius:12px;
    }
    html{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
      background:var(--bg);color:var(--text);line-height:1.6;-webkit-font-smoothing:antialiased}
    body{min-height:100vh;display:flex;flex-direction:column;align-items:center}

    /* Banner */
    .banner{width:100%;max-height:280px;object-fit:cover;display:block;mask-image:linear-gradient(to bottom,#000 60%,transparent);-webkit-mask-image:linear-gradient(to bottom,#000 60%,transparent)}

    /* Main container */
    .container{width:100%;max-width:640px;padding:0 24px 64px}

    /* Header */
    .header{display:flex;align-items:center;gap:16px;margin-top:-36px;position:relative;z-index:1}
    .icon{width:72px;height:72px;border-radius:16px;border:3px solid var(--bg);box-shadow:0 4px 24px #0006;object-fit:cover;background:var(--surface)}
    .relay-name{font-size:1.5rem;font-weight:700;letter-spacing:-0.02em}
    .no-banner .header{margin-top:48px}

    /* Description */
    .description{margin-top:20px;color:var(--text-dim);font-size:0.95rem;max-width:520px}

    /* Meta row */
    .meta{margin-top:16px;display:flex;flex-wrap:wrap;gap:8px 20px;font-size:0.82rem;color:var(--text-dim)}
    .meta a{color:var(--accent);text-decoration:none}
    .meta a:hover{text-decoration:underline}
    .version{opacity:0.55}

    /* Section */
    .section{margin-top:32px}
    .section-title{font-size:0.7rem;font-weight:600;text-transform:uppercase;letter-spacing:0.08em;color:var(--text-dim);margin-bottom:12px}

    /* NIP badges */
    .nips{display:flex;flex-wrap:wrap;gap:6px}
    .nip-badge{display:inline-block;padding:4px 10px;background:var(--surface);border:1px solid var(--border);
      border-radius:6px;font-size:0.78rem;font-weight:500;color:var(--text);text-decoration:none;transition:border-color .15s,box-shadow .15s}
    .nip-badge:hover{border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-glow)}

    /* Limitations table */
    .limits-table{width:100%;border-collapse:collapse;font-size:0.85rem}
    .limits-table td{padding:8px 0;border-bottom:1px solid var(--border)}
    .limits-table tr:last-child td{border-bottom:none}
    .limits-table td:first-child{color:var(--text-dim);text-transform:capitalize;padding-right:24px}
    .limits-table td:last-child{text-align:right;font-variant-numeric:tabular-nums;font-weight:500}
    .bool{font-weight:600;text-transform:uppercase;font-size:0.75rem;letter-spacing:0.04em}
    .bool.yes{color:#5ce09f}
    .bool.no{color:var(--text-dim)}

    /* WebSocket hint */
    .ws-hint{margin-top:48px;text-align:center;padding:20px;border:1px dashed var(--border);border-radius:var(--radius);color:var(--text-dim);font-size:0.82rem}
    .ws-hint code{color:var(--accent);font-family:"SF Mono",Menlo,Consolas,monospace;font-size:0.8rem}

    /* Footer */
    .footer{margin-top:40px;text-align:center;color:var(--text-dim);font-size:0.72rem;opacity:0.5}
    .footer a{color:inherit;text-decoration:none}
    .footer a:hover{text-decoration:underline}
  </style>
</head>
<body>
  ${banner ? `<img class="banner" src="${banner}" alt="" loading="eager">` : ""}
  <div class="container${banner ? "" : " no-banner"}">
    <div class="header">
      ${icon ? `<img class="icon" src="${icon}" alt="">` : ""}
      <h1 class="relay-name">${name}</h1>
    </div>
    ${description ? `<p class="description">${description}</p>` : ""}
    <div class="meta">
      ${softwareHtml ? `<span>${softwareHtml}</span>` : ""}
      ${contactHtml ? `<span>${contactHtml}</span>` : ""}
    </div>
    ${
      nips.length > 0
        ? `
    <div class="section">
      <div class="section-title">Supported NIPs</div>
      <div class="nips">
        ${nipBadges}
      </div>
    </div>`
        : ""
    }
    ${
      limRows
        ? `
    <div class="section">
      <div class="section-title">Limitations</div>
      <table class="limits-table">
        <tbody>
          ${limRows}
        </tbody>
      </table>
    </div>`
        : ""
    }
    <div class="ws-hint">
      Connect with a Nostr client via WebSocket, or fetch relay info with<br>
      <code>curl -H "Accept: application/nostr+json" ${esc(relayUrl.replace(/^ws/, "http"))}</code>
    </div>
    <div class="footer"><a href="https://gitlab.com/soapbox-pub/ditto-relay">Ditto Relay</a></div>
  </div>
</body>
</html>`;
}
