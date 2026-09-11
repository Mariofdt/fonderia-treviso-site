// ========================================
// FONDERIA TREVISO - Riscatto premio al banco (staff)
// Ingresso: riscatta.html?c=<code> (link dentro il QR della tessera)
// oppure inserimento manuale del code (32 hex) senza ?c=.
// Contratto (Task 7):
//   peekClaim({code}) ->
//     {prizeLabel, promoTitle, memberName, status, redeemedAt|null}
//   redeemQr({code, pin}) ->
//     {ok:true, prizeLabel, memberName}
//     {ok:false, alreadyRedeemed:true, prizeLabel, memberName,
//      redeemedAt, redeemedVia('pin'|'admin'), redeemedBy|null}
//     HttpsError: not-found (code invalido/inesistente),
//      permission-denied (PIN errato), failed-precondition
//      (pending_review/rejected)
// Invarianti:
//  - alreadyRedeemed e' un caso UI DEDICATO (warning), non un errore:
//    al banco deve saltare all'occhio che il QR e' gia' stato usato;
//  - nessun retry automatico sul PIN: ogni tentativo errato consuma
//    un contatore/rate-limit lato server, lo staff ridigita a mano;
//  - PIN mai hardcoded, mai loggato: digitato dallo staff e tenuto
//    in sessionStorage (vive solo per la sessione/tab del banco);
//  - ogni dato dal server passa da esc(): mai innerHTML non escaped.
// ========================================

import { getFunctionsInstance } from './firebase-init.js';
import { httpsCallable }
  from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-functions.js';

const app = document.getElementById('riscattaApp');

// PIN del banco per la sessione corrente (tab). Salvato SOLO dopo un
// redeem andato a buon fine (o un alreadyRedeemed: in entrambi i casi
// il server ha validato il PIN prima di rispondere) e cancellato al
// primo permission-denied: non si conserva mai un PIN errato.
const PIN_KEY = 'fond.staffPin';
const CODE_RE = /^[a-f0-9]{32}$/;

function savedPin() {
  try { return sessionStorage.getItem(PIN_KEY) || ''; } catch { return ''; }
}

function storePin(pin) {
  try { sessionStorage.setItem(PIN_KEY, pin); } catch { /* storage privato: PIN ridigitato ogni volta */ }
}

function clearPin() {
  try { sessionStorage.removeItem(PIN_KEY); } catch { /* noop */ }
}

async function callable(name) {
  const fns = await getFunctionsInstance();
  return httpsCallable(fns, name);
}

function esc(v) {
  return String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Data+ora: al banco serve sapere QUANDO e' stato bruciato il QR,
// la sola data non basta per due riscatti nello stesso giorno.
function formatDateTime(iso) {
  const d = iso ? new Date(iso) : null;
  if (!d || isNaN(d.getTime())) return '';
  const data = d.toLocaleDateString('it-IT', { day: 'numeric', month: 'long', year: 'numeric' });
  const ora = d.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
  return data + ' alle ' + ora;
}

function isCodeErr(err, code) {
  return ((err && err.code) || '').includes(code);
}

// ----------------------------------------
// Schermate di servizio
// ----------------------------------------
function renderLoading() {
  app.innerHTML = `<p class="riscatta-loading">Verifica del premio…</p>`;
}

function renderManual(errorMsg) {
  app.innerHTML = `
    <p class="riscatta-badge">Riscatto premio</p>
    <h1 class="riscatta-title">Cerca un premio</h1>
    <p class="riscatta-desc">Inquadra il QR della tessera col telefono e apri il link, oppure digita qui il codice del premio (32 caratteri).</p>
    <form id="codeForm" novalidate>
      <label class="riscatta-label" for="codeInput">Codice premio</label>
      <input id="codeInput" class="riscatta-input riscatta-input-code" type="text"
             inputmode="text" autocomplete="off" autocapitalize="none"
             spellcheck="false" maxlength="32" placeholder="es. 4f2a…c91b" required>
      <p class="riscatta-error" id="codeError" role="alert"${errorMsg ? '' : ' hidden'}>${esc(errorMsg || '')}</p>
      <button type="submit" class="btn btn-primary riscatta-btn">Cerca premio</button>
    </form>`;

  document.getElementById('codeForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const code = document.getElementById('codeInput').value.trim().toLowerCase();
    if (!CODE_RE.test(code)) {
      const errEl = document.getElementById('codeError');
      errEl.textContent = 'Codice non valido: servono esattamente 32 caratteri esadecimali (0-9, a-f).';
      errEl.hidden = false;
      return;
    }
    loadCode(code);
  });
}

function renderInvalidCode() {
  app.innerHTML = `
    <p class="riscatta-badge">Riscatto premio</p>
    <h1 class="riscatta-title">QR non valido</h1>
    <p class="riscatta-desc">Questo codice non corrisponde a nessun premio. Verifica che il QR sia quello della tessera Fonderia e non sia stato ritagliato.</p>
    <button type="button" class="btn btn-primary riscatta-btn" id="againBtn">Cerca un altro codice</button>`;
  document.getElementById('againBtn').addEventListener('click', renderManual.bind(null, ''));
}

function renderLoadError() {
  app.innerHTML = `
    <p class="riscatta-badge">Riscatto premio</p>
    <h1 class="riscatta-title">Servizio non disponibile</h1>
    <p class="riscatta-desc">Non riusciamo a verificare il premio in questo momento. Controlla la connessione e riprova.</p>
    <button type="button" class="btn btn-primary riscatta-btn" id="retryBtn">Riprova</button>`;
  document.getElementById('retryBtn').addEventListener('click', () => window.location.reload());
}

// ----------------------------------------
// Peek: dati premio prima del riscatto
// ----------------------------------------
function claimHeader(data) {
  return `
    <h2 class="riscatta-prize">${esc(data.prizeLabel || 'Premio')}</h2>
    ${data.memberName ? `<p class="riscatta-member">di ${esc(data.memberName)}</p>` : ''}
    ${data.promoTitle ? `<p class="riscatta-promo">${esc(data.promoTitle)}</p>` : ''}`;
}

// Premio riscattabile: mostra i dati e chiede il PIN staff.
function renderPinForm(code, data) {
  app.innerHTML = `
    <p class="riscatta-badge">Riscatto premio</p>
    ${claimHeader(data)}
    <form id="pinForm" novalidate>
      <label class="riscatta-label" for="pinInput">PIN staff</label>
      <input id="pinInput" class="riscatta-input" type="password"
             inputmode="numeric" autocomplete="off" required>
      <p class="riscatta-error" id="pinError" role="alert" hidden></p>
      <button type="submit" class="btn btn-primary riscatta-btn" id="redeemBtn">Riscatta il premio</button>
    </form>
    <button type="button" class="riscatta-link" id="backBtn">← Cerca un altro codice</button>`;

  // PIN gia' validato in questa sessione: precompilato, basta un tap.
  const prefilled = savedPin();
  if (prefilled) document.getElementById('pinInput').value = prefilled;

  document.getElementById('backBtn').addEventListener('click', renderManual.bind(null, ''));
  document.getElementById('pinForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const pin = document.getElementById('pinInput').value.trim();
    if (!pin) {
      const errEl = document.getElementById('pinError');
      errEl.textContent = 'Inserisci il PIN staff.';
      errEl.hidden = false;
      return;
    }
    redeem(code, pin, data);
  });
}

// Premio gia' riscattato. due varianti dati:
//  - dal peek (status redeemed): solo quando;
//  - dal redeem (alreadyRedeemed): anche chi (via/redeemedBy).
// Stile WARNING distinto: non e' un errore di rete, e' il caso reale
// del QR ri-presentato.
function renderAlreadyRedeemed(data) {
  const when = formatDateTime(data.redeemedAt);
  let how = '';
  if (data.redeemedVia === 'pin') {
    how = 'al banco con il PIN staff';
  } else if (data.redeemedVia === 'admin') {
    how = 'dall’area admin' + (data.redeemedBy ? ` (${esc(data.redeemedBy)})` : '');
  }
  app.innerHTML = `
    <p class="riscatta-badge riscatta-badge-warn">Attenzione</p>
    <div class="riscatta-result riscatta-result-warn">
      <div class="riscatta-result-icon" aria-hidden="true">⚠️</div>
      <h1 class="riscatta-result-title">Premio già riscattato</h1>
      <p class="riscatta-result-prize">${esc(data.prizeLabel || 'Premio')}</p>
      ${data.memberName ? `<p class="riscatta-result-member">${esc(data.memberName)}</p>` : ''}
    </div>
    <div class="riscatta-warn-panel">
      ${when ? `<p>Questo QR è già stato usato <strong>${esc(when)}</strong>${how ? ' ' + how : ''}.</p>` : '<p>Questo QR è già stato usato.</p>'}
      <p class="riscatta-no-handout">NON consegnare di nuovo il premio.</p>
    </div>
    <button type="button" class="btn btn-primary riscatta-btn" id="nextBtn">Nuovo riscatto</button>`;
  document.getElementById('nextBtn').addEventListener('click', renderManual.bind(null, ''));
}

// Premio non riscattabile (in verifica / rifiutato / messaggio server).
function renderNotRedeemable(data, serverMsg) {
  let reason = serverMsg || '';
  if (!reason) {
    if (data && data.status === 'pending_review') {
      reason = 'La partecipazione è ancora in verifica: il premio non è ancora riscattabile.';
    } else if (data && data.status === 'rejected') {
      reason = 'La partecipazione non è stata approvata: il premio non è riscattabile.';
    } else {
      reason = 'Questo premio non è riscattabile in questo momento.';
    }
  }
  app.innerHTML = `
    <p class="riscatta-badge">Riscatto premio</p>
    <h1 class="riscatta-title">Non riscattabile</h1>
    ${data ? claimHeader(data) : ''}
    <p class="riscatta-desc">${esc(reason)}</p>
    <button type="button" class="btn btn-primary riscatta-btn" id="nextBtn">Cerca un altro codice</button>`;
  document.getElementById('nextBtn').addEventListener('click', renderManual.bind(null, ''));
}

// Successo: volutamente gigante, leggibile a distanza dal banco.
function renderSuccess(data) {
  app.innerHTML = `
    <p class="riscatta-badge riscatta-badge-ok">Fatto</p>
    <div class="riscatta-result riscatta-result-ok">
      <div class="riscatta-result-icon" aria-hidden="true">✅</div>
      <h1 class="riscatta-result-title">Riscattato</h1>
      <p class="riscatta-result-prize">${esc(data.prizeLabel || 'Premio')}</p>
      ${data.memberName ? `<p class="riscatta-result-member">${esc(data.memberName)}</p>` : ''}
      <p class="riscatta-result-detail">Consegna il premio al cliente.</p>
    </div>
    <button type="button" class="btn btn-primary riscatta-btn" id="nextBtn">Nuovo riscatto</button>`;
  document.getElementById('nextBtn').addEventListener('click', renderManual.bind(null, ''));
}

// ----------------------------------------
// Riscatto (redeemQr): nessun retry automatico, l'errore torna
// allo staff che decide cosa fare (ogni PIN errato e' contato lato
// server — fix R1 / ruling controller).
// ----------------------------------------
let redeeming = false;

async function redeem(code, pin, peekData) {
  if (redeeming) return;
  redeeming = true;
  const btn = document.getElementById('redeemBtn');
  const errEl = document.getElementById('pinError');
  if (btn) { btn.disabled = true; btn.textContent = 'Riscatto in corso…'; }
  if (errEl) errEl.hidden = true;

  try {
    const res = await (await callable('redeemQr'))({ code, pin });
    const data = res.data || {};
    if (data.ok) {
      storePin(pin);
      renderSuccess(data);
      return;
    }
    if (data.alreadyRedeemed) {
      // Il PIN era corretto (il server lo valida prima del lookup):
      // tenerlo in sessione evita di ridigitarlo allo scan successivo.
      storePin(pin);
      renderAlreadyRedeemed(data);
      return;
    }
    // Shape inatteso: non fingere un successo.
    throw new Error('risposta redeemQr inattesa');
  } catch (err) {
    if (isCodeErr(err, 'permission-denied') || isCodeErr(err, 'unauthenticated')) {
      clearPin();
      if (errEl) {
        errEl.textContent = 'PIN errato, riprova.';
        errEl.hidden = false;
      }
      const pinInput = document.getElementById('pinInput');
      if (pinInput) { pinInput.value = ''; pinInput.focus(); }
    } else if (isCodeErr(err, 'not-found')) {
      renderInvalidCode();
      return;
    } else if (isCodeErr(err, 'failed-precondition')) {
      // Lo status e' cambiato tra peek e redeem (es. rifiutato dall'admin).
      renderNotRedeemable(peekData, (err && err.message) || '');
      return;
    } else {
      // Rete/server: nessuna azione dal server garantita, ma la tx e'
      // atomica — riprovare a mano e' sicuro (una eventuale bruciatura
      // gia' avvenuta tornerebbe come "gia' riscattato").
      if (errEl) {
        errEl.textContent = 'Errore di comunicazione. Riprova quando la connessione è stabile.';
        errEl.hidden = false;
      }
    }
    if (btn) { btn.disabled = false; btn.textContent = 'Riscatta il premio'; }
  } finally {
    redeeming = false;
  }
}

// ----------------------------------------
// Peek iniziale / da inserimento manuale
// ----------------------------------------
async function loadCode(code) {
  renderLoading();
  try {
    const res = await (await callable('peekClaim'))({ code });
    const data = res.data || {};
    if (data.status === 'issued') {
      renderPinForm(code, data);
    } else if (data.status === 'redeemed') {
      renderAlreadyRedeemed(data);
    } else if (data.status === 'pending_review' || data.status === 'rejected') {
      renderNotRedeemable(data, '');
    } else {
      renderInvalidCode();
    }
  } catch (err) {
    if (isCodeErr(err, 'not-found')) {
      renderInvalidCode();
    } else {
      renderLoadError();
    }
  }
}

// ----------------------------------------
// init
// ----------------------------------------
function init() {
  const code = (new URLSearchParams(location.search).get('c') || '').trim().toLowerCase();
  if (!code) {
    renderManual('');
    return;
  }
  // Sintassi controllata lato client prima di chiamare: un ?c= malformato
  // non deve neppure partire verso il server.
  if (!CODE_RE.test(code)) {
    renderManual('Il codice nel link non è valido. Verifica il QR o digitalo a mano.');
    const input = document.getElementById('codeInput');
    if (input) input.value = code;
    return;
  }
  loadCode(code);
}

init();
