// ========================================
// FONDERIA TREVISO - Pagina promo pubblica (gamification)
// Stati: HOME (lista promo) → REGISTRA (nome+telefono+consenso)
// → PARTECIPA (upload prova) / INVITA (referral) → esito claim.
// Contratti:
//  - registerMember({name, phone, refCode?}) → {memberId, token, refCode, tesseraUrl}
//  - getTessera({token}) → {refCode, claims[], activePromos[], ...}
//  - submitClaim({token, promoId, imagePath}) → {status, reason, tesseraUrl}
//  - promos: lettura anonima SOLO con where('active','==',true) + filtro date client
//  - Storage: claims-inbox/<memberId>/<file> (image/* ≤5MB, create-only)
//  - localStorage: fond.tessera.<token> = { token, memberId }
// Vincoli UX: submitClaim SOLO su click esplicito (ogni invocazione
// consuma 1 credito orario lato server): nessun retry automatico.
// Il QR del premio NON si renderizza qui: vive sulla tessera.
// ========================================

import { getDb, getFsMod, getStorageInstance, getFunctionsInstance } from './firebase-init.js';
import { httpsCallable } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-functions.js';
import { ref as storageRef, uploadBytes }
  from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-storage.js';

const app = document.getElementById('promoApp');
const MAX_FILE_SIZE = 5 * 1024 * 1024;

// ----------------------------------------
// Tessera salvata sul device: una sola, chiave = token stesso
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

// Una sola tessera per device: salvandone una nuova si evincono le altre.
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

// Errori che provano che il token salvato non esiste piu' lato server
// (assertMember lancia 'unauthenticated'). Se li riceviamo da una callable
// che usa il token, la tessera e' spazzatura: va cancellata, non riletta.
// N.B. permission-denied in submitClaim e' il guard del path immagine, NON
// token invalido → non invalideremmo mai la tessera per quello.
// Errori di rete/offline (unavailable, internal, deadline-exceeded) NON
// entrano qui: la tessera resta e l'utente riprova.
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

// ----------------------------------------
// Firestore: promo attive (lettura anonima; la rule richiede
// where('active','==',true), altrimenti la query viene rifiutata in blocco)
// ----------------------------------------
async function loadActivePromos() {
  const fsm = await getFsMod();
  const db = await getDb();
  // getDocsFromServer: con backend irraggiungibile getDocs risolverebbe dalla
  // cache vuota, indistinguibile da "nessuna promo" — forziamo il server così
  // l'errore è esplicito e mostriamo lo stato "servizio non disponibile".
  const snap = await fsm.getDocsFromServer(fsm.query(
    fsm.collection(db, 'promos'),
    fsm.where('active', '==', true)
  ));
  const now = new Date();
  const toDate = (v) => v && typeof v.toDate === 'function' ? v.toDate() : (v ? new Date(v) : null);
  const promos = [];
  snap.forEach((d) => {
    const p = d.data();
    const startsAt = toDate(p.startsAt);
    const endsAt = toDate(p.endsAt);
    if (startsAt && startsAt > now) return;   // non ancora iniziata
    if (endsAt && endsAt < now) return;       // scaduta
    promos.push({
      id: d.id,
      title: p.title || 'Promozione',
      description: p.description || '',
      prizeLabel: p.prizeLabel || '',
      actionType: p.actionType || 'social_share',
      refTarget: p.refTarget || 0,
    });
  });
  return promos;
}

// ----------------------------------------
// Componenti
// ----------------------------------------
function badgeHtml(text) {
  return `<p class="promo-badge">${esc(text)}</p>`;
}

function prizeHtml(promo) {
  if (!promo || !promo.prizeLabel) return '';
  return `<p class="promo-prize">In palio: <strong>${esc(promo.prizeLabel)}</strong></p>`;
}

function descHtml(promo) {
  if (!promo || !promo.description) return '';
  return `<p class="promo-desc">${esc(promo.description)}</p>`;
}

function formError(id) {
  return `<p class="promo-error" id="${id}" role="alert" hidden></p>`;
}

function setError(id, msg) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = msg || '';
  el.hidden = !msg;
}

function errorMessage(err, fallback) {
  // Le callable rilanciano HttpsError: err.code = 'functions/<code>'.
  const code = (err && err.code) || '';
  const msg = (err && err.message) || '';
  if (code.includes('already-exists')) return msg || 'Hai già una richiesta attiva per questa promozione.';
  if (code.includes('resource-exhausted')) return msg || 'Troppe richieste: riprova più tardi.';
  if (code.includes('invalid-argument')) return msg || 'Controlla i dati inseriti e riprova.';
  if (code.includes('failed-precondition')) return msg || 'Questa promozione non è più attiva.';
  if (code.includes('permission-denied')) {
    return msg || 'Operazione non consentita: riprova.';
  }
  return fallback;
}

// ----------------------------------------
// Stato HOME: nessuna promo specifica in URL → lista delle attive
// ----------------------------------------
function renderHome(promos, refCode) {
  if (!promos.length) {
    app.innerHTML = `
      ${badgeHtml('Promozioni')}
      <h1 class="promo-title">Nessuna promozione attiva</h1>
      <p class="promo-desc">Al momento non ci sono promozioni in corso. Torna a trovarci presto — oppure passa al banco e chiedi del tesseramento.</p>
      <a class="btn btn-outline promo-btn" href="/">Torna al sito</a>`;
    return;
  }
  const cards = promos.map(p => {
    const href = '/promo.html?p=' + encodeURIComponent(p.id) + (refCode ? '&ref=' + encodeURIComponent(refCode) : '');
    const tag = p.actionType === 'referral' ? 'Invita gli amici' : 'Prova con foto';
    return `
      <a class="promo-card" href="${href}">
        <span class="promo-card-tag">${esc(tag)}</span>
        <span class="promo-card-title">${esc(p.title)}</span>
        ${p.prizeLabel ? `<span class="promo-card-prize">${esc(p.prizeLabel)}</span>` : ''}
      </a>`;
  }).join('');
  app.innerHTML = `
    ${badgeHtml('Promozioni attive')}
    <h1 class="promo-title">Scegli la tua mossa</h1>
    <div class="promo-list">${cards}</div>
    <a class="promo-link" href="/">← Torna al sito</a>`;
}

// ----------------------------------------
// Stato REGISTRA: nome + telefono + consenso
// ----------------------------------------
function renderRegister(promo, refCode, headingOverride, notice) {
  const heading = headingOverride
    || (promo ? promo.title : 'Diventa socio della Fonderia');
  app.innerHTML = `
    ${badgeHtml('Tesseramento')}
    <h1 class="promo-title">${esc(heading)}</h1>
    ${notice ? `<p class="promo-notice" role="alert">${esc(notice)}</p>` : ''}
    ${prizeHtml(promo)}
    ${descHtml(promo)}
    <form id="registerForm" class="promo-form" novalidate>
      <label class="promo-label" for="regName">Nome e cognome</label>
      <input class="promo-input" id="regName" name="name" type="text" autocomplete="name"
             minlength="2" maxlength="50" required placeholder="Come ti chiami?">
      <label class="promo-label" for="regPhone">Cellulare</label>
      <input class="promo-input" id="regPhone" name="phone" type="tel" autocomplete="tel"
             inputmode="tel" required placeholder="+39 333 1234567">
      <label class="promo-consent" for="regConsent">
        <input id="regConsent" type="checkbox" required>
        <span>Acconsento al trattamento dei miei dati per partecipare alle promozioni della Fonderia.</span>
      </label>
      ${formError('regError')}
      <button type="submit" class="btn btn-primary promo-btn" id="regSubmit">Registrati</button>
    </form>`;
  if (refCode) {
    app.insertAdjacentHTML('beforeend',
      `<p class="promo-ref">Sei stato invitato da un amico: il suo codice verrà registrato.</p>`);
  }
}

function bindRegister(promo, refCode, onDone) {
  const form = document.getElementById('registerForm');
  const btn = document.getElementById('regSubmit');
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    setError('regError', '');
    const name = document.getElementById('regName').value.trim();
    const phone = document.getElementById('regPhone').value.trim();
    const consent = document.getElementById('regConsent').checked;
    if (name.length < 2 || name.length > 50) {
      setError('regError', 'Inserisci un nome valido (2-50 caratteri).');
      return;
    }
    if (!/^[+0-9][0-9 .()-]{5,24}$/.test(phone)) {
      setError('regError', 'Numero di telefono non valido.');
      return;
    }
    if (!consent) {
      setError('regError', 'Serve il consenso per partecipare.');
      return;
    }
    btn.disabled = true;
    btn.textContent = 'Registrazione…';
    try {
      const res = await (await callable('registerMember'))({
        name, phone, ...(refCode ? { refCode } : {}),
      });
      const data = res.data || {};
      saveTessera(data.token, data.memberId);
      onDone({ token: data.token, memberId: data.memberId, tesseraUrl: data.tesseraUrl });
    } catch (err) {
      setError('regError', errorMessage(err, 'Registrazione non riuscita: riprova tra poco.'));
      btn.disabled = false;
      btn.textContent = 'Registrati';
    }
  });
}

// ----------------------------------------
// Stato PARTECIPA: upload della prova (social_share / visit / photo…)
// ----------------------------------------
function startRegister(promo, refCode, notice) {
  renderRegister(promo, refCode, undefined, notice);
  bindRegister(promo, refCode, (saved) => routeWithTessera(promo, refCode, saved));
}

// Dopo registrazione o con tessera valida: referral → INVITA, altrimenti PARTECIPA.
function routeWithTessera(promo, refCode, tessera) {
  if (!promo || promo.actionType === 'referral') renderInvite(promo, tessera, refCode);
  else renderParticipateThenBind(promo, tessera, refCode);
}

// Tessera invalida lato server: cancella tutte le chiavi e torna a REGISTRA
// con spiegazione (mai loop: la chiave guasta non viene piu' riletta).
function invalidTokenRecovery(promo, refCode) {
  clearTesseraKeys();
  startRegister(promo, refCode,
    'La tessera salvata su questo dispositivo non è più valida: registrati di nuovo.');
}

function renderParticipate(promo) {
  app.innerHTML = `
    ${badgeHtml('Partecipa')}
    <h1 class="promo-title">${esc(promo.title)}</h1>
    ${prizeHtml(promo)}
    ${descHtml(promo)}
    <div class="promo-upload">
      <label class="promo-drop" for="proofInput">
        <span class="promo-drop-cta">Carica lo screenshot della prova</span>
        <span class="promo-drop-hint">Screenshot o foto dalla galleria, max 5 MB</span>
      </label>
      <input id="proofInput" type="file" accept="image/*" hidden>
      <p class="promo-file" id="proofName" hidden></p>
      ${formError('claimError')}
      <button type="button" class="btn btn-primary promo-btn" id="claimSubmit" disabled>Invia la prova</button>
    </div>
    <p class="promo-note">La foto viene verificata automaticamente: se è valida ricevi subito il premio sulla tua tessera.</p>`;
}

// Un solo tentativo per click: bottone disabilitato subito, errori mostrati
// senza retry automatico (ogni chiamata submitClaim consuma credito orario).
function bindParticipate(promo, tessera, refCode) {
  const input = document.getElementById('proofInput');
  const nameEl = document.getElementById('proofName');
  const btn = document.getElementById('claimSubmit');
  let picked = null;
  // Path del file correntemente selezionato: UN solo UUID per file.
  // Se il submit fallisce (es. rete) il retry riusa lo stesso path e, se
  // l'upload e' gia' riuscito, non carica un secondo oggetto: niente orfani
  // eterni in claims-inbox.
  let pending = null; // { file, path, uploaded }

  function pathFor(file) {
    if (!pending || pending.file !== file) {
      const ext = ({ 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/heic': 'heic' })[file.type] || 'jpg';
      pending = { file, path: 'claims-inbox/' + tessera.memberId + '/' + crypto.randomUUID() + '.' + ext, uploaded: false };
    }
    return pending;
  }

  input.addEventListener('change', () => {
    setError('claimError', '');
    picked = input.files && input.files[0] ? input.files[0] : null;
    pending = null;
    if (!picked) {
      nameEl.hidden = true;
      btn.disabled = true;
      return;
    }
    if (!picked.type.startsWith('image/')) {
      setError('claimError', 'Il file deve essere un’immagine.');
      picked = null;
      btn.disabled = true;
      return;
    }
    if (picked.size > MAX_FILE_SIZE) {
      setError('claimError', 'Immagine troppo grande: max 5 MB.');
      picked = null;
      btn.disabled = true;
      return;
    }
    nameEl.textContent = picked.name;
    nameEl.hidden = false;
    btn.disabled = false;
  });

  btn.addEventListener('click', async () => {
    if (!picked || btn.disabled) return;
    btn.disabled = true;
    input.disabled = true;
    btn.textContent = 'Caricamento…';
    try {
      const entry = pathFor(picked);
      const storage = await getStorageInstance();
      if (!entry.uploaded) {
        await uploadBytes(storageRef(storage, entry.path), picked);
        entry.uploaded = true;
      }
      btn.textContent = 'Verifica in corso…';
      const res = await (await callable('submitClaim'))({
        token: tessera.token, promoId: promo.id, imagePath: entry.path,
      });
      renderStatus(res.data || {});
    } catch (err) {
      // Token non piu' valido lato server: pulisci e torna a REGISTRA.
      // Errori di rete/server: la tessera RESTA e si puo' riprovare.
      if (isInvalidTokenError(err)) {
        invalidTokenRecovery(promo, refCode);
        return;
      }
      // Tentativi esauriti → percorso obbligato: banco (uploadAttempts non si resetta)
      if ((err && err.code || '').includes('resource-exhausted') && /tentativi/i.test(err && err.message || '')) {
        renderForcedDesk(promo);
        return;
      }
      setError('claimError', errorMessage(err,
        'Invio non riuscito: controlla la connessione e riprova (i tentativi di verifica per questa promozione sono limitati).'));
      btn.textContent = 'Invia la prova';
      input.disabled = false;
      btn.disabled = !picked;
    }
  });
}

// ----------------------------------------
// Stato esito claim (issued / pending_review / rejected)
// ----------------------------------------
function renderStatus(data) {
  const status = data.status;
  const tesseraUrl = data.tesseraUrl || '';
  const reason = typeof data.reason === 'string' ? data.reason : '';
  if (status === 'issued') {
    // Niente QR qui: il premio si mostra dalla tessera (quella sì che ha il QR).
    app.innerHTML = `
      ${badgeHtml('Premio sbloccato')}
      <h1 class="promo-title promo-title-win">Verifica superata!</h1>
      <p class="promo-desc">${esc(reason || 'Mostra il QR sulla tua tessera al banco per ritirare il premio.')}</p>
      ${tesseraUrl ? `<a class="btn btn-primary promo-btn" href="${esc(tesseraUrl)}">Apri la tua tessera</a>` : ''}
      <a class="promo-link" href="/">← Torna al sito</a>`;
    return;
  }
  if (status === 'pending_review') {
    app.innerHTML = `
      ${badgeHtml('In verifica')}
      <h1 class="promo-title">Prova ricevuta</h1>
      <p class="promo-desc">${esc(reason || 'Lo staff sta verificando la tua prova: trovi l’esito sulla tessera.')}</p>
      ${tesseraUrl ? `<a class="btn btn-primary promo-btn" href="${esc(tesseraUrl)}">Guarda la tua tessera</a>` : ''}
      <a class="promo-link" href="/">← Torna al sito</a>`;
    return;
  }
  // rejected (o sconosciuto): comunicare chiaramente il percorso "vieni al banco"
  app.innerHTML = `
    ${badgeHtml('Prova non valida')}
    <h1 class="promo-title">Non ci siamo</h1>
    <p class="promo-desc">${esc(reason || 'La prova non soddisfa i requisiti della promozione.')}</p>
    <p class="promo-desc">Puoi riprovare con una foto più chiara — occhio, i tentativi di verifica automatica per questa promozione sono limitati — oppure passa al banco: lo staff ti aiuta a ritirare il premio.</p>
    <button type="button" class="btn btn-primary promo-btn" id="retryBtn">Riprova</button>
    ${tesseraUrl ? `<a class="promo-link" href="${esc(tesseraUrl)}">La mia tessera</a>` : ''}`;
  const retry = document.getElementById('retryBtn');
  if (retry) retry.addEventListener('click', () => window.location.reload());
}

// Tentativi esauriti lato server: da qui in poi solo banco.
function renderForcedDesk(promo) {
  app.innerHTML = `
    ${badgeHtml('Passa al banco')}
    <h1 class="promo-title">${esc(promo.title)}</h1>
    <p class="promo-desc">Hai esaurito i tentativi di verifica automatica per questa promozione. Nessun problema: <strong>vieni al banco</strong> e lo staff verifica la prova con te.</p>
    <a class="btn btn-primary promo-btn" href="/#contatti">Come trovarci</a>
    <a class="promo-link" href="/">← Torna al sito</a>`;
}

// ----------------------------------------
// Stato INVITA (referral): condividi il proprio link
// ----------------------------------------
function renderInviteShell() {
  app.innerHTML = `
    ${badgeHtml('Invita gli amici')}
    <h1 class="promo-title">Invita, vinci, ripeti</h1>
    <p class="promo-desc">Caricamento del tuo link personale…</p>`;
}

async function renderInvite(promo, tessera, refCode) {
  renderInviteShell();
  let data;
  try {
    const res = await (await callable('getTessera'))({ token: tessera.token });
    data = res.data || {};
  } catch (err) {
    // Token invalido → pulisci e REGISTRA; rete/server → messaggio + reload manuale
    if (isInvalidTokenError(err)) {
      invalidTokenRecovery(promo, refCode);
      return;
    }
    app.innerHTML = `
      ${badgeHtml('Invita gli amici')}
      <h1 class="promo-title">Ops</h1>
      <p class="promo-desc">${esc(errorMessage(err, 'Non riesco a recuperare la tua tessera: controlla la connessione e riprova.'))}</p>
      <button type="button" class="btn btn-primary promo-btn" id="reloadBtn">Riprova</button>`;
    document.getElementById('reloadBtn').addEventListener('click', () => window.location.reload());
    return;
  }
  const myRefCode = data.refCode || '';
  const count = data.referralCount || 0;
  const target = promo && promo.refTarget ? promo.refTarget : 0;
  const shareUrl = location.origin + '/promo.html'
    + (promo ? '?p=' + encodeURIComponent(promo.id) + '&' : '?')
    + 'ref=' + encodeURIComponent(myRefCode);
  const progress = target ? `<p class="promo-progress">Inviti registrati: <strong>${count}</strong> su ${target}</p>` : '';
  app.innerHTML = `
    ${badgeHtml('Invita gli amici')}
    <h1 class="promo-title">${esc(promo ? promo.title : 'Invita gli amici')}</h1>
    ${prizeHtml(promo)}
    <p class="promo-desc">${target
      ? `Fai iscrivere ${target} amici col tuo link personale: al traguardo il premio è tuo.`
      : 'Condividi il tuo link personale: chi si iscrive da lì conta per te.'}</p>
    ${progress}
    <div class="promo-share">
      <input class="promo-input promo-share-url" id="shareUrl" type="text" readonly value="${esc(shareUrl)}">
      <button type="button" class="btn btn-primary promo-btn" id="shareBtn">Condividi il tuo link</button>
    </div>
    <p class="promo-toast" id="shareToast" hidden>Link copiato!</p>`;
  const btn = document.getElementById('shareBtn');
  btn.addEventListener('click', async () => {
    const payload = {
      title: 'Fonderia Treviso — Promozioni',
      text: 'Iscriviti alla tessera della Fonderia col mio link:',
      url: shareUrl,
    };
    if (navigator.share) {
      try { await navigator.share(payload); return; }
      catch (e) { if (e && e.name === 'AbortError') return; /* utente ha annullato */ }
    }
    // Fallback: copia negli appunti
    try {
      await navigator.clipboard.writeText(shareUrl);
    } catch {
      const inp = document.getElementById('shareUrl');
      inp.focus();
      inp.select();
      document.execCommand('copy');
    }
    const toast = document.getElementById('shareToast');
    toast.hidden = false;
    setTimeout(() => { toast.hidden = true; }, 2500);
  });
}

// ----------------------------------------
// Stato ERRORE caricamento (es. emulator offline / rete giù)
// ----------------------------------------
function renderLoadError() {
  app.innerHTML = `
    ${badgeHtml('Promozioni')}
    <h1 class="promo-title">Servizio non disponibile</h1>
    <p class="promo-desc">Non riusciamo a caricare le promozioni in questo momento. Controlla la connessione e riprova — oppure passa al banco per il tesseramento.</p>
    <button type="button" class="btn btn-primary promo-btn" id="reloadBtn">Riprova</button>
    <a class="promo-link" href="/">← Torna al sito</a>`;
  document.getElementById('reloadBtn').addEventListener('click', () => window.location.reload());
}

// ----------------------------------------
// init: query param → promo → stato iniziale
// ----------------------------------------
async function init() {
  const params = new URLSearchParams(location.search);
  const promoId = (params.get('p') || '').trim();
  const refCode = (params.get('ref') || '').trim().toUpperCase() || null;

  let promos;
  try {
    promos = await loadActivePromos();
  } catch {
    renderLoadError();
    return;
  }

  const promo = promoId ? promos.find(p => p.id === promoId) : null;
  if (promoId && !promo) {
    app.innerHTML = `
      ${badgeHtml('Promozioni')}
      <h1 class="promo-title">Promozione non disponibile</h1>
      <p class="promo-desc">Questa promozione è terminata o non esiste più: ecco quelle attive adesso.</p>
      <div class="promo-list-holder"></div>`;
    renderHomeInto(app.querySelector('.promo-list-holder'), promos, refCode);
    return;
  }

  const tessera = savedTessera();

  if (!tessera) {
    // Registrazione (con eventuale refCode dell'invitante). Per la home senza
    // promo mostriamo prima la lista: la registrazione avviene su una promo.
    if (!promo && !refCode) {
      renderHome(promos, refCode);
      return;
    }
    startRegister(promo, refCode);
    return;
  }

  routeWithTessera(promo, refCode, tessera);
}

function renderParticipateThenBind(promo, tessera, refCode) {
  renderParticipate(promo);
  bindParticipate(promo, tessera, refCode);
}

function renderHomeInto(holder, promos, refCode) {
  const cards = promos.map(p => {
    const href = '/promo.html?p=' + encodeURIComponent(p.id) + (refCode ? '&ref=' + encodeURIComponent(refCode) : '');
    return `<a class="promo-card" href="${href}">
      <span class="promo-card-title">${esc(p.title)}</span>
      ${p.prizeLabel ? `<span class="promo-card-prize">${esc(p.prizeLabel)}</span>` : ''}
    </a>`;
  }).join('');
  holder.innerHTML = `<div class="promo-list">${cards || '<p class="promo-desc">Nessuna promozione attiva al momento.</p>'}</div>
    <a class="promo-link" href="/">← Torna al sito</a>`;
}

init();
