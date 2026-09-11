// ========================================
// FONDERIA TREVISO - Tessera socio (gamification)
// Ingresso: tessera.html?t=<token> (link ricevuto all'iscrizione).
// Senza ?t= si prova la tessera salvata sul device (localStorage
// fond.tessera.<token>). Dopo un caricamento riuscito il token viene
// rimosso dall'URL (replaceState): resta solo in localStorage.
// Contratto: getTessera({token}) → { memberId, name, refCode,
//   referralCount, badges[{id,name,icon,description}],
//   claims[{promoId,promoTitle,prizeLabel,status,qrUrl(solo issued),redeemedAt}],
//   activePromos[{id,title,prizeLabel,actionType}] }
// Invarianti:
//  - il QR del premio esiste SOLO se il server manda qrUrl (status issued):
//    mai inferire l'idoneita' client-side;
//  - token invalido (unauthenticated/not-found) → pulizia localStorage e
//    percorso di ri-registrazione esplicito (qui la tessera e' l'unica
//    identita' del socio, il messaggio deve dire come procedere);
//  - errori di rete/unavailable NON cancellano la tessera;
//  - ogni dato dal server passa da esc(): la pagina e' pubblica al socio,
//    staffPin e token non si mostrano MAI.
// ========================================

import { getFunctionsInstance } from './firebase-init.js';
import { httpsCallable }
  from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-functions.js';

const app = document.getElementById('tesseraApp');

// ----------------------------------------
// Tessera salvata sul device (stesso schema di promo.js)
// ----------------------------------------
const LS_PREFIX = 'fond.tessera.';

function savedTessera() {
  try {
    const k = Object.keys(localStorage).find(key => key.startsWith(LS_PREFIX));
    if (!k) return null;
    const v = JSON.parse(localStorage.getItem(k));
    return (v && typeof v.token === 'string' && typeof v.memberId === 'string') ? v : null;
  } catch {
    return null;
  }
}

function saveTessera(token, memberId) {
  clearTesseraKeys();
  try {
    localStorage.setItem(LS_PREFIX + token, JSON.stringify({ token, memberId }));
  } catch { /* storage pieno/privato: la tessera resta raggiungibile via link */ }
}

function clearTesseraKeys() {
  try {
    Object.keys(localStorage)
      .filter(k => k.startsWith(LS_PREFIX))
      .forEach(k => localStorage.removeItem(k));
  } catch { /* noop */ }
}

// Solo questi errori provano che il token non esiste piu' lato server.
// Rete/server (unavailable, internal, deadline-exceeded) → la tessera resta.
function isInvalidTokenError(err) {
  const code = (err && err.code) || '';
  return code.includes('unauthenticated') || code.includes('not-found');
}

async function callable(name) {
  const fns = await getFunctionsInstance();
  return httpsCallable(fns, name);
}

function esc(v) {
  return String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function formatDate(iso) {
  const d = iso ? new Date(iso) : null;
  if (!d || isNaN(d.getTime())) return '';
  return d.toLocaleDateString('it-IT', { day: 'numeric', month: 'long', year: 'numeric' });
}

// ----------------------------------------
// Schermate di servizio
// ----------------------------------------
function renderNotFound(withSaved) {
  app.innerHTML = `
    <p class="tessera-badge">Tessera</p>
    <h1 class="tessera-title">Tessera non trovata</h1>
    ${withSaved ? `<p class="tessera-notice" role="alert">La tessera salvata su questo dispositivo non è più valida (probabilmente è stata rimossa o sostituita). Per rientrare: registrati di nuovo da una promozione attiva, oppure riapri il link della tessera che hai ricevuto al momento dell’iscrizione.</p>`
    : `<p class="tessera-desc">Questo link non corrisponde a nessuna tessera attiva. Se ti sei appena iscritto, controlla di aver copiato l’intero link; altrimenti registrati da una promozione attiva.</p>`}
    <a class="btn btn-primary tessera-btn" href="/promo.html">Vai alle promozioni</a>
    <a class="tessera-link" href="/">← Torna al sito</a>`;
}

function renderLoadError() {
  app.innerHTML = `
    <p class="tessera-badge">Tessera</p>
    <h1 class="tessera-title">Servizio non disponibile</h1>
    <p class="tessera-desc">Non riusciamo a caricare la tua tessera in questo momento. Controlla la connessione e riprova — la tessera salvata sul dispositivo non viene toccata.</p>
    <button type="button" class="btn btn-primary tessera-btn" id="reloadBtn">Riprova</button>
    <a class="tessera-link" href="/">← Torna al sito</a>`;
  document.getElementById('reloadBtn').addEventListener('click', () => window.location.reload());
}

// ----------------------------------------
// Render tessera
// ----------------------------------------

// Issued in cima (il socio mostra il QR al banco), poi in verifica, poi gli altri.
const STATUS_ORDER = { issued: 0, pending_review: 1, redeemed: 2 };

function claimChip(claim) {
  if (claim.status === 'pending_review') {
    return `<span class="tessera-chip tessera-chip-pending">In verifica</span>`;
  }
  if (claim.status === 'redeemed') {
    const when = formatDate(claim.redeemedAt);
    return `<span class="tessera-chip tessera-chip-redeemed">Riscattato${when ? ` il ${esc(when)}` : ''}</span>`;
  }
  if (claim.status === 'rejected') {
    return `<span class="tessera-chip tessera-chip-rejected">Non approvata</span>`;
  }
  return '';
}

// NB: `claims` DEVE arrivare gia' ordinato da renderTessera — l'indice i
// di id="qr-i" e la stessa posizione nell'array usato dal loop QR li
// sotto. Ordinare qui una seconda copia ricreerebbe il mismatch F1.
function claimsHtml(claims) {
  if (!claims.length) {
    return `<p class="tessera-empty">Nessun premio ancora: partecipa a una promozione qui sotto per sbloccarne uno.</p>`;
  }
  return claims
    .map((c, i) => {
      // QR solo se il server ha mandato qrUrl (invariante: solo issued).
      const hasQr = c.status === 'issued' && typeof c.qrUrl === 'string' && c.qrUrl.length > 0;
      return `
      <section class="tessera-claim">
        <div class="tessera-claim-head">
          <span class="tessera-claim-prize">${esc(c.prizeLabel || 'Premio')}</span>
          ${claimChip(c)}
        </div>
        <p class="tessera-claim-promo">${esc(c.promoTitle || 'Promozione')}</p>
        ${hasQr ? `
        <div class="tessera-qr-frame"><div class="tessera-qr" id="qr-${i}" role="img"
             aria-label="Codice QR per il premio ${esc(c.prizeLabel || 'premio')}"></div></div>
        <p class="tessera-qr-hint">Mostra questo QR al banco per ritirare il premio.</p>` : ''}
      </section>`;
    }).join('');
}

function badgesHtml(badges) {
  if (!badges.length) {
    return `<p class="tessera-empty">Nessun badge ancora: continua a partecipare per collezionarli.</p>`;
  }
  return badges.map(b => `
    <div class="tessera-badge-card">
      <span class="tessera-badge-icon" aria-hidden="true">${esc(b.icon || '🏅')}</span>
      <span class="tessera-badge-name">${esc(b.name)}</span>
      ${b.description ? `<span class="tessera-badge-desc">${esc(b.description)}</span>` : ''}
    </div>`).join('');
}

function promosHtml(promos) {
  if (!promos.length) return '';
  const cards = promos.map(p => `
    <a class="tessera-promo-card" href="/promo.html?p=${encodeURIComponent(p.id)}">
      <span class="tessera-promo-title">${esc(p.title)}</span>
      ${p.prizeLabel ? `<span class="tessera-promo-prize">${esc(p.prizeLabel)}</span>` : ''}
    </a>`).join('');
  return `
    <h2 class="tessera-h2">Promozioni attive</h2>
    <div class="tessera-promo-list">${cards}</div>`;
}

function renderTessera(token, data) {
  // UN solo array ordinato per HTML e loop QR: gli id "qr-<i>" combaciano
  // perche' puntano allo stesso ordine (fix F1).
  const claims = (Array.isArray(data.claims) ? data.claims : [])
    .slice()
    .sort((a, b) => (STATUS_ORDER[a.status] ?? 3) - (STATUS_ORDER[b.status] ?? 3));
  const badges = Array.isArray(data.badges) ? data.badges : [];
  const promos = Array.isArray(data.activePromos) ? data.activePromos : [];
  const refCode = data.refCode || '';
  const refCount = data.referralCount || 0;
  // refCode vuoto (non dovrebbe, ma il contratto non lo garantisce):
  // link alla promo nuda, mai "?ref=".
  const shareUrl = refCode
    ? location.origin + '/promo.html?ref=' + encodeURIComponent(refCode)
    : location.origin + '/promo.html';

  app.innerHTML = `
    <p class="tessera-badge">La mia tessera</p>
    <h1 class="tessera-title">${esc(data.name || 'Socio Fonderia')}</h1>
    <p class="tessera-refcode">Codice invito: <strong>${esc(refCode)}</strong>
      <button type="button" class="tessera-refresh" id="refreshBtn">↻ Aggiorna</button></p>

    <h2 class="tessera-h2">I miei premi</h2>
    <div class="tessera-claims">${claimsHtml(claims)}</div>

    <h2 class="tessera-h2">I miei badge</h2>
    <div class="tessera-badges">${badgesHtml(badges)}</div>

    <h2 class="tessera-h2">Invita gli amici</h2>
    <p class="tessera-desc">Inviti registrati col tuo codice: <strong class="tessera-accent">${refCount}</strong></p>
    <button type="button" class="btn btn-primary tessera-btn" id="shareBtn">Invita amici</button>
    <p class="tessera-toast" id="shareToast" hidden></p>

    ${promosHtml(promos)}
    <a class="tessera-link" href="/">← Torna al sito</a>`;

  // QR dopo che i contenitori sono nel DOM (davidshimjs disegna dentro l'elemento).
  // Indici dell'array ORDINATO: stesso array passato a claimsHtml (fix F1).
  claims.forEach((c, i) => {
    if (c.status !== 'issued' || typeof c.qrUrl !== 'string' || !c.qrUrl.length) return;
    const el = document.getElementById('qr-' + i);
    if (!el) return;
    if (!window.QRCode) {
      // libreria non caricata: niente cornice bianca muta + hint ingannevole
      el.classList.add('tessera-qr-fallback');
      el.textContent = 'QR non disponibile — ricarica la pagina';
      const hint = el.closest('.tessera-claim')?.querySelector('.tessera-qr-hint');
      if (hint) hint.hidden = true;
      return;
    }
    new QRCode(el, {
      text: c.qrUrl,
      width: 220,
      height: 220,
      colorDark: '#000000',
      colorLight: '#ffffff',
      correctLevel: QRCode.CorrectLevel.M,
    });
  });

  // F3: refresh manuale (lo stesso getTessera gira anche su visibilitychange)
  const refreshBtn = document.getElementById('refreshBtn');
  refreshBtn.addEventListener('click', async () => {
    refreshBtn.disabled = true;
    refreshBtn.textContent = 'Aggiorno…';
    await refreshTessera(token);
    const stillThere = document.getElementById('refreshBtn');
    // Se il refresh ha ridisegnato la pagina il bottone e' gia' nuovo;
    // su errore di rete la UI resta e va riabilitato.
    if (stillThere === refreshBtn) {
      refreshBtn.disabled = false;
      refreshBtn.textContent = '↻ Aggiorna';
    }
  });

  const shareBtn = document.getElementById('shareBtn');
  shareBtn.addEventListener('click', async () => {
    const payload = {
      title: 'Fonderia Treviso — Promozioni',
      text: 'Iscriviti alla tessera della Fonderia col mio link:',
      url: shareUrl,
    };
    if (navigator.share) {
      try { await navigator.share(payload); return; }
      catch (e) { if (e && e.name === 'AbortError') return; /* utente ha annullato */ }
    }
    const toast = document.getElementById('shareToast');
    try {
      await navigator.clipboard.writeText(shareUrl);
      toast.textContent = 'Link copiato!';
    } catch {
      // clipboard negata: mostra l'URL intero da copiare a mano (F5)
      toast.textContent = 'Copia questo link: ' + shareUrl;
    }
    toast.hidden = false;
    setTimeout(() => { toast.hidden = true; }, 4000);
  });
}

// ----------------------------------------
// Refresh (F3): dopo un riscatto al banco il socio torna alla pagina —
// visibilitychange + bottone "Aggiorna" rileggono getTessera. Se un claim
// e' passato issued→redeemed, il QR sparisce e resta il chip: voluto.
// ----------------------------------------
let refreshing = false;

async function refreshTessera(token) {
  if (refreshing) return;
  refreshing = true;
  try {
    const res = await (await callable('getTessera'))({ token });
    const data = res.data || {};
    if (typeof data.memberId === 'string') saveTessera(token, data.memberId);
    renderTessera(token, data);
  } catch (err) {
    if (isInvalidTokenError(err)) {
      clearTesseraKeys();
      renderNotFound(true);
      return;
    }
    // rete/server: la pagina esistente resta com'e', nessuna distruzione UI
  } finally {
    refreshing = false;
  }
}

function bindAutoRefresh(token) {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') refreshTessera(token);
  });
}

// ----------------------------------------
// init
// ----------------------------------------
async function init() {
  const params = new URLSearchParams(location.search);
  let token = (params.get('t') || '').trim();

  if (!token) {
    const saved = savedTessera();
    if (!saved) {
      renderNotFound(false);
      return;
    }
    token = saved.token;
  }

  try {
    const res = await (await callable('getTessera'))({ token });
    const data = res.data || {};
    // Riallaccia il device (evince eventuali altre tessere, una sola per device)
    if (typeof data.memberId === 'string') saveTessera(token, data.memberId);
    renderTessera(token, data);
    bindAutoRefresh(token);
    // F2: token MAI nell'URL dopo un caricamento riuscito. La tessera e'
    // gia' in localStorage, quindi lo scrub e' safe sia se ?t= arrivava
    // dal link sia se mancava (localStorage).
    if (window.history && history.replaceState) {
      history.replaceState(null, '', location.pathname);
    }
  } catch (err) {
    if (isInvalidTokenError(err)) {
      clearTesseraKeys();
      renderNotFound(true);
      return;
    }
    renderLoadError();
  }
}

init();
