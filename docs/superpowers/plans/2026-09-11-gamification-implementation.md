# Gamification Fonderia Treviso — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Clienti compiono azioni social (condivisione, tag, referral) → screenshot validato da Gemini vision → QR premio univoco monouso riscattabile al banco → badge fedeltà configurabili, tutto gestito da tab admin.

**Architecture:** Sito statico Firebase Hosting + Firestore + Cloud Functions (europe-west1) già esistenti. Pagine standalone leggere (`promo.html`, `tessera.html`, `riscatta.html`) che leggono da Firestore via SDK v10 CDN, callable per tutto ciò che è privilegiato. QR generato client-side con qrcodejs self-hosted. Nessun build step, stesso pattern del codice esistente.

**Tech Stack:** Firebase SDK v10.14.1 (CDN), Cloud Functions v2 Node, Firestore + Storage rules, mocha + @firebase/rules-unit-testing (suite esistente in `test/`), Gemini 2.5 Flash-Lite su Vertex AI (contratto già verificato con chiamata reale 2026-09-11).

**Spec:** `docs/superpowers/specs/2026-09-11-gamification-design.md`

## Global Constraints

- Region Functions: `europe-west1`, `maxInstances: 2` (pattern esistente in `functions/index.js`)
- Client SDK: `firebase-init.js` già espone `getDb()`, `getFsMod()`, `getStorageInstance()`, `getFunctionsInstance()` — MAI re-inizializzare Firebase nelle nuove pagine
- Gemini: `POST https://aiplatform.googleapis.com/v1/projects/fonderia-treviso/locations/global/publishers/google/models/gemini-2.5-flash-lite:generateContent`, auth via `new GoogleAuth({scopes: 'https://www.googleapis.com/auth/cloud-platform'})` (ADC Compute SA, `roles/aiplatform.user` già attivo) — stesso pattern di `suggestEventCopy`
- `generationConfig: { temperature: 0, maxOutputTokens: 150, responseMimeType: "application/json" }` per la validazione (deterministico)
- Rules: whitelist admin via `config/admin.allowedEmails` con `exists()` prima di `get()` (pattern esistente)
- Niente segreti in codice/git; QR code = `https://fonderia-treviso.web.app/riscatta.html?c=<code 128-bit>; token tessera 128-bit; mai esposti via rules
- Hosting cache: html no-cache, js/css max-age=600 → **bumpare `?v=N` su ogni asset toccato**
- Mobile: tutte le pagine nuove includono `<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">`, `styles.css` (contiene il fix `overflow-x: clip` anti shrink-to-fit) e `input {font-size: 16px}` implicito da styles.css
- Brand: stessi font/colori/noise del sito (Space Grotesk + Inter, dark bg `#060606`-family, accent `#e78c37`/`#c45d26`); niente navbar pesante sulle pagine standalone
- Commit ad ogni task, messaggi in italiano, footer `Co-Authored-By: Claude Code <noreply@anthropic.com>`; push come utente `Mariofdt`, poi ripristinare `cardanocodelab-alt`

---

### Task 1: Firestore rules — nuove collezioni gamification (TDD)

**Files:**
- Modify: `firestore.rules` (inserire PRIMA del default deny finale)
- Test: `test/rules.test.js`

**Interfaces:**
- Produces: rules per `promos/`, `badges/`, `members/`, `claims/`, `config/gamification` che i task successivi danno per scontate (promos/badges read pubblico solo active; members/claims zero accesso client)

- [ ] **Step 1: Test fallimentari in `test/rules.test.js`**

Aggiungere al seed di `beforeEach` (dopo il setDoc di config/admin):

```js
    await setDoc(doc(db, 'promos', 'active-promo'), {
      title: 'Condividi la serata', prizeLabel: 'Drink omaggio',
      actionType: 'tag_story', active: true,
    });
    await setDoc(doc(db, 'promos', 'inactive-promo'), {
      title: 'Promo spenta', prizeLabel: 'Fritto omaggio',
      actionType: 'custom', active: false,
    });
    await setDoc(doc(db, 'badges', 'badge-1'), {
      name: 'Fedele', icon: '⭐',
      rule: { metric: 'totalClaims', threshold: 3 }, active: true,
    });
    await setDoc(doc(db, 'config', 'gamification'), {
      staffPin: '1234', prizeOptions: ['Drink omaggio'],
    });
    await setDoc(doc(db, 'members', 'm1'), {
      name: 'Test', phone: '+393331234567', token: 'segreto',
    });
    await setDoc(doc(db, 'claims', 'p1_m1'), {
      memberId: 'm1', promoId: 'p1', code: 'codice-segreto', status: 'issued',
    });
```

Nuovi describe alla fine del file:

```js
describe('gamification — promos e badges', () => {
  it('anon PUO\' leggere una promo attiva', async () => {
    const db = testEnv.unauthenticatedContext().firestore();
    await assertSucceeds(getDoc(doc(db, 'promos', 'active-promo')));
  });

  it('anon NON puo\' leggere una promo inattiva', async () => {
    const db = testEnv.unauthenticatedContext().firestore();
    await assertFails(getDoc(doc(db, 'promos', 'inactive-promo')));
  });

  it('anon PUO\' leggere un badge attivo', async () => {
    const db = testEnv.unauthenticatedContext().firestore();
    await assertSucceeds(getDoc(doc(db, 'badges', 'badge-1')));
  });

  it('anon NON puo\' scrivere promos', async () => {
    const db = testEnv.unauthenticatedContext().firestore();
    await assertFails(setDoc(doc(db, 'promos', 'x'), { title: 'x', active: true }));
  });

  it('admin PUO\' scrivere promos', async () => {
    const db = testEnv.authenticatedContext('admin-uid', { email: ADMIN_EMAIL }).firestore();
    await assertSucceeds(setDoc(doc(db, 'promos', 'x'), {
      title: 'Nuova', prizeLabel: 'Drink omaggio', actionType: 'custom', active: true,
    }));
  });
});

describe('gamification — members, claims, config', () => {
  it('anon NON puo\' leggere members', async () => {
    const db = testEnv.unauthenticatedContext().firestore();
    await assertFails(getDoc(doc(db, 'members', 'm1')));
  });

  it('anon NON puo\' creare members (solo via callable)', async () => {
    const db = testEnv.unauthenticatedContext().firestore();
    await assertFails(setDoc(doc(db, 'members', 'm2'), { name: 'X', phone: '+393339999999' }));
  });

  it('admin NON puo\' scrivere members dal client (contatori solo via function)', async () => {
    const db = testEnv.authenticatedContext('admin-uid', { email: ADMIN_EMAIL }).firestore();
    await assertFails(setDoc(doc(db, 'members', 'm2'), { name: 'X', phone: '+393339999999' }));
  });

  it('anon NON puo\' leggere claims', async () => {
    const db = testEnv.unauthenticatedContext().firestore();
    await assertFails(getDoc(doc(db, 'claims', 'p1_m1')));
  });

  it('admin PUO\' leggere claims (tabella admin)', async () => {
    const db = testEnv.authenticatedContext('admin-uid', { email: ADMIN_EMAIL }).firestore();
    await assertSucceeds(getDoc(doc(db, 'claims', 'p1_m1')));
  });

  it('config/gamification NON leggibile da utente loggato non-admin (staffPin)', async () => {
    const db = testEnv.authenticatedContext('random-uid', { email: 'estraneo@example.com' }).firestore();
    await assertFails(getDoc(doc(db, 'config', 'gamification')));
  });

  it('config/admin resta leggibile da utente loggato (check whitelist admin.js)', async () => {
    const db = testEnv.authenticatedContext('random-uid', { email: 'estraneo@example.com' }).firestore();
    await assertSucceeds(getDoc(doc(db, 'config', 'admin')));
  });
});
```

- [ ] **Step 2: Eseguire i test e verificare che falliscono**

Run: `cd test && npx firebase emulators:exec --only firestore --project demo-fonderia 'npx mocha rules.test.js'`
Expected: i nuovi test `assertSucceeds` su promos/badges falliscono (default deny), quelli admin su claims falliscono, config/gamification loggato-non-admin PASSA già male (leak: rules attuali `config/{docId}` permettono read a `isSignedIn()`), admin-write-members fallisce già (passa).

- [ ] **Step 3: Aggiungere le rules in `firestore.rules`**

Inserire dopo il blocco newsletter, prima del default deny:

```
    // ---------- gamification ----------

    // Promo e badge: lettura anonima solo dei doc attivi; scrittura solo admin.
    match /promos/{promoId} {
      allow read: if isAdmin() || resource.data.active == true;
      allow create, update, delete: if isAdmin();
    }
    match /badges/{badgeId} {
      allow read: if isAdmin() || resource.data.active == true;
      allow create, update, delete: if isAdmin();
    }

    // members: NESSUN accesso client (né anon né admin): creazione e lettura
    // solo via callable (registerMember / getTessera). Il token tessera non
    // deve mai essere leggibile dal client.
    match /members/{memberId} {
      allow read, write: if false;
    }

    // claims: lettura solo admin (tabella claim); scrittura solo via callable
    // (docId composto <promoId>_<memberId> gestito dalle function).
    match /claims/{claimId} {
      allow read: if isAdmin();
      allow write: if false;
    }
```

E modificare il blocco config esistente — sostituire `match /config/{docId}` con:

```
    // config/admin: lettura da utenti autenticati (check whitelist in admin.js).
    match /config/admin {
      allow read: if isSignedIn();
      allow write: if false;
    }

    // config/gamification: staffPin e prizeOptions — SOLO admin.
    match /config/gamification {
      allow read, write: if isAdmin();
    }
```

- [ ] **Step 4: Eseguire i test e verificare che passano TUTTI (vecchi + nuovi)**

Run: `cd test && npx firebase emulators:exec --only firestore --project demo-fonderia 'npx mocha rules.test.js'`
Expected: PASS (tutti i test, inclusi quelli preesistenti su events/popups/bookings/newsletter)

- [ ] **Step 5: Commit**

```bash
git add firestore.rules test/rules.test.js
git commit -m "Gamification: rules Firestore per promos/badges/members/claims + test

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 2: Storage rules `claims-inbox/` + indice Firestore + seed config

**Files:**
- Modify: `storage.rules` (prima del default deny)
- Modify: `firestore.indexes.json`
- Modify: `seed/seed.js` (appendere seed idempotente di `config/gamification`)

**Interfaces:**
- Produces: path Storage `claims-inbox/<memberId>/<file>` scrivibile anon (image/*, ≤5MB), read negato — usato da Task 5 e Task 8; indice `promos(active, createdAt desc)` usato dal popup home (Task 12); doc `config/gamification { staffPin, prizeOptions }` letto da Task 7

- [ ] **Step 1: Storage rules**

In `storage.rules`, prima del default deny:

```
    // Screenshot delle prove promo (gamification). Upload anonimo consentito
    // ma inerte: submitClaim accetta solo path col memberId del token chiamante.
    match /claims-inbox/{memberId}/{fileName} {
      allow read: if false; // le prove le vede solo lo staff (function/admin SDK)
      allow create: if request.resource != null
        && request.resource.size <= 5 * 1024 * 1024
        && request.resource.contentType.matches('image/.*');
      allow update, delete: if false;
    }
```

- [ ] **Step 2: Verificare le storage rules nell'emulatore**

Non esiste suite storage-rules nel repo: verifica manuale via emulator suite (Task 13) con probe script: upload `image/png` anon in `claims-inbox/m1/x.png` → successo atteso; upload `text/plain` → fallimento atteso; read anon → fallimento atteso.

- [ ] **Step 3: Indice composto promos**

In `firestore.indexes.json`, aggiungere all'array `indexes` (mantenendo quelli esistenti):

```json
    {
      "collectionGroup": "promos",
      "queryScope": "COLLECTION",
      "fields": [
        { "fieldPath": "active", "order": "ASCENDING" },
        { "fieldPath": "createdAt", "order": "DESCENDING" }
      ]
    }
```

- [ ] **Step 4: Seed config/gamification**

In `seed/seed.js`, in fondo allo script (pattern Admin SDK già presente), idempotente:

```js
// Gamification: config iniziale (idempotente). staffPin: placeholder,
// da cambiare subito dall'admin (tab Promozioni → Impostazioni).
const gamRef = db.collection('config').doc('gamification');
const gamSnap = await gamRef.get();
if (!gamSnap.exists) {
  await gamRef.set({
    staffPin: '0000',
    prizeOptions: ['Drink omaggio', 'Fritto omaggio', 'Ingresso omaggio'],
  });
  console.log('config/gamification creato (cambia il PIN in admin!)');
}
```

- [ ] **Step 5: Commit**

```bash
git add storage.rules firestore.indexes.json seed/seed.js
git commit -m "Gamification: storage rules claims-inbox, indice promos, seed config

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 3: Functions — helpers + `registerMember`

**Files:**
- Modify: `functions/index.js` (appendere in fondo)

**Interfaces:**
- Consumes: pattern `onCall`/`HttpsError`/`logger`/`admin` già importati in cima a `functions/index.js`
- Produces (usati dai task 4-7):
  - `async function assertMember(token) → { id, data, ref }` — valida token tessera, HttpsError `unauthenticated` se invalido
  - `randomToken() → string` — 128-bit hex via `crypto.randomBytes(16).toString('hex')`
  - `makeRefCode(name) → Promise<string>` — `NOME` + 1 cifra, retry con +cifre finché univoco in `members`
  - callable `registerMember({ name, phone, refCode? }) → { memberId, token, tesseraUrl, refCode }`

- [ ] **Step 1: Implementare**

```js
/* ------------------------------------------------------------------ *
 * GAMIFICATION — tessere, claim, QR premio, referral, badge.
 * Spec: docs/superpowers/specs/2026-09-11-gamification-design.md
 * ------------------------------------------------------------------ */

const crypto = require('crypto');

const TESSERA_BASE = SITE_URL + '/tessera.html?t=';
const PHONE_RE = /^[+0-9][0-9 .()-]{5,24}$/;

function randomToken() {
  return crypto.randomBytes(16).toString('hex'); // 128 bit
}

async function assertMember(token) {
  const t = String(token || '').trim();
  if (!/^[a-f0-9]{32}$/.test(t)) {
    throw new HttpsError('unauthenticated', 'Tessera non valida.');
  }
  const snap = await admin.firestore().collection('members')
    .where('token', '==', t).limit(1).get();
  if (snap.empty) {
    throw new HttpsError('unauthenticated', 'Tessera non trovata.');
  }
  const docSnap = snap.docs[0];
  return { id: docSnap.id, data: docSnap.data(), ref: docSnap.ref };
}

async function makeRefCode(name) {
  const base = name.replace(/[^A-Za-z]/g, '').toUpperCase().slice(0, 8) || 'FRIEND';
  const members = admin.firestore().collection('members');
  for (let i = 0; i < 20; i++) {
    const code = base + crypto.randomInt(0, 10) + (i > 9 ? crypto.randomInt(0, 10) : '');
    const dup = await members.where('refCode', '==', code).limit(1).get();
    if (dup.empty) return code;
  }
  throw new HttpsError('internal', 'Impossibile generare il codice invito. Riprova.');
}

// Valutazione badge: idempotente, aggiunge solo soglie raggiunte non presenti.
async function evaluateBadges(memberRef, memberData) {
  const snap = await admin.firestore().collection('badges')
    .where('active', '==', true).get();
  if (snap.empty) return [];
  const owned = new Set(memberData.badges || []);
  const totalClaims = Object.values(memberData.actionsCount || {})
    .reduce((a, b) => a + b, 0);
  const earned = [];
  for (const d of snap.docs) {
    const b = d.data();
    if (owned.has(d.id) || !b.rule || !b.rule.metric) continue;
    let value = 0;
    if (b.rule.metric === 'totalClaims') value = totalClaims;
    else if (b.rule.metric === 'referralCount') value = memberData.referralCount || 0;
    else if (b.rule.metric.startsWith('actionsCount.')) {
      value = (memberData.actionsCount || {})[b.rule.metric.slice(13)] || 0;
    }
    if (value >= (b.rule.threshold || 0)) earned.push(d.id);
  }
  if (earned.length) {
    await memberRef.update({
      badges: admin.firestore.FieldValue.arrayUnion(...earned),
    });
  }
  return earned;
}

exports.registerMember = onCall(
  { region: 'europe-west1', maxInstances: 2 },
  async (req) => {
    const name = String((req.data && req.data.name) || '').trim();
    const phone = String((req.data && req.data.phone) || '').trim();
    const refCodeIn = String((req.data && req.data.refCode) || '').trim().toUpperCase();

    if (name.length < 2 || name.length > 50) {
      throw new HttpsError('invalid-argument', 'Inserisci un nome valido (2-50 caratteri).');
    }
    if (!PHONE_RE.test(phone)) {
      throw new HttpsError('invalid-argument', 'Numero di telefono non valido.');
    }
    const phoneNorm = phone.replace(/[ .()-]/g, '');

    const db = admin.firestore();

    // Telefono duplicato → la tessera esiste già (anti multi-account)
    const dup = await db.collection('members').where('phoneNorm', '==', phoneNorm).limit(1).get();
    if (!dup.empty) {
      throw new HttpsError('already-exists',
        'Questo numero è già registrato: riapri il link della tua tessera.');
    }

    let referredBy = null;
    let refSuspicious = false;
    if (refCodeIn) {
      const ref = await db.collection('members').where('refCode', '==', refCodeIn).limit(1).get();
      if (ref.empty) {
        refSuspicious = true; // refCode inesistente: registra comunque, marca il referral
      } else if (ref.docs[0].data().phoneNorm === phoneNorm) {
        refSuspicious = true; // auto-invito
      } else {
        referredBy = ref.docs[0].id;
      }
    }

    const token = randomToken();
    const refCode = await makeRefCode(name);
    const ref = await db.collection('members').add({
      name,
      phone,
      phoneNorm,
      token,
      refCode,
      referredBy,
      referralCount: 0,
      actionsCount: {},
      uploadAttempts: {},
      badges: [],
      refSuspicious: referredBy ? refSuspicious : false,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    logger.info('registerMember OK', { memberId: ref.id, referredBy: referredBy || 'nessuno' });
    return {
      memberId: ref.id,
      token,
      refCode,
      tesseraUrl: TESSERA_BASE + token,
    };
  }
);
```

Nota: `refSuspicious` è sul nuovo membro; il trigger del Task 6 lo consulta prima di conteggiare.

- [ ] **Step 2: Syntax check**

Run: `cd functions && node --check index.js`
Expected: nessun output (exit 0)

- [ ] **Step 3: Verifica su emulatori**

Run: `firebase emulators:start --only firestore,functions` e probe con `curl "http://localhost:5001/fonderia-treviso/europe-west1/registerMember" -H 'Content-Type: application/json' -d '{"data":{"name":"Test User","phone":"+39 333 0001112"}}'`
Expected: `result.tesseraUrl` presente; seconda chiamata identica → errore `already-exists`; chiamata con `refCode` inesistente → successo con `refSuspicious:true` sul doc (verifica da Firestore emulator UI)

- [ ] **Step 4: Commit**

```bash
git add functions/index.js
git commit -m "Gamification: callable registerMember + helpers (token, refCode, badge eval)

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 4: Functions — `getTessera`

**Files:**
- Modify: `functions/index.js`

**Interfaces:**
- Consumes: `assertMember`, `evaluateBadges` (Task 3)
- Produces: callable `getTessera({ token }) → { memberId, name, refCode, referralCount, badges: [{id,name,icon,description}], claims: [{promoId, promoTitle, prizeLabel, status, qrUrl|null, redeemedAt|null}], activePromos: [{id,title,prizeLabel,actionType}] }` — MAI il campo `token` nel payload; `qrUrl` presente solo per status `issued`

- [ ] **Step 1: Implementare**

```js
exports.getTessera = onCall(
  { region: 'europe-west1', maxInstances: 2 },
  async (req) => {
    const member = await assertMember(req.data && req.data.token);
    const db = admin.firestore();

    // Rinfresca i badge (idempotente) e rileggi
    const newBadges = await evaluateBadges(member.ref, member.data);
    const data = newBadges.length
      ? { ...member.data, badges: [...(member.data.badges || []), ...newBadges] }
      : member.data;

    const [claimsSnap, promosSnap, badgesSnap] = await Promise.all([
      db.collection('claims').where('memberId', '==', member.id).get(),
      db.collection('promos').where('active', '==', true).get(),
      (data.badges || []).length
        ? db.collection('badges').where(admin.firestore.FieldPath.documentId(), 'in', data.badges.slice(0, 30)).get()
        : Promise.resolve(null),
    ]);

    const promoById = {};
    promosSnap.forEach((d) => {
      promoById[d.id] = d.data();
    });
    // Promo di claim non più attive: leggi puntualmente
    const claims = [];
    for (const d of claimsSnap.docs) {
      const c = d.data();
      let promo = promoById[c.promoId];
      if (!promo) {
        const pDoc = await db.collection('promos').doc(c.promoId).get();
        promo = pDoc.exists ? pDoc.data() : {};
      }
      claims.push({
        promoId: c.promoId,
        promoTitle: promo.title || '',
        prizeLabel: promo.prizeLabel || '',
        status: c.status,
        qrUrl: c.status === 'issued'
          ? SITE_URL + '/riscatta.html?c=' + c.code
          : null,
        redeemedAt: c.redeemedAt && c.redeemedAt.toDate ? c.redeemedAt.toDate().toISOString() : null,
      });
    }

    const badges = [];
    if (badgesSnap) {
      badgesSnap.forEach((d) => {
        const b = d.data();
        badges.push({ id: d.id, name: b.name, icon: b.icon, description: b.description || '' });
      });
    }

    const activePromos = [];
    promosSnap.forEach((d) => {
      const p = d.data();
      activePromos.push({ id: d.id, title: p.title, prizeLabel: p.prizeLabel, actionType: p.actionType });
    });

    return {
      memberId: member.id,
      name: data.name,
      refCode: data.refCode,
      referralCount: data.referralCount || 0,
      badges,
      claims,
      activePromos,
    };
  }
);
```

- [ ] **Step 2: Syntax check + probe emulatore** (come Task 3 step 2-3; member seminato a mano in emulator UI con token `a`×32)
Expected: payload completo; token assente; claim `pending_review` senza `qrUrl`

- [ ] **Step 3: Commit**

```bash
git add functions/index.js
git commit -m "Gamification: callable getTessera (badge refresh idempotente incluso)

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 5: Functions — `submitClaim` con validazione Gemini vision

**Files:**
- Modify: `functions/index.js`

**Interfaces:**
- Consumes: `assertMember`, `randomToken`, `evaluateBadges` (Task 3), `VERTEX_GEMINI_URL` + pattern GoogleAuth/fetch di `suggestEventCopy` (stesso file)
- Produces: callable `submitClaim({ token, promoId, imagePath }) → { status: "issued"|"rejected"|"pending_review", reason, tesseraUrl }`. Invarianti: 1 claim per `<promoId>_<memberId>`; claim inesistente o `rejected` → nuovo tentativo consentito finché `uploadAttempts[promoId] < 5`; `issued`/`pending_review` bloccano; promos referral → errore (niente screenshot); promo scaduta/inattiva → errore

- [ ] **Step 1: Implementare**

```js
const MAX_UPLOAD_ATTEMPTS = 5;
const MAX_CLAIMS_PER_HOUR = 10;

function geminiVisionPrompt(checklist) {
  return {
    systemInstruction: {
      parts: [{ text:
        'Sei il verificatore delle promozioni di Fonderia Treviso (birreria e cocktail bar, ' +
        'Instagram @fonderiatreviso). Ti arriva uno screenshot che un cliente ha caricato per ' +
        'dimostrare di aver compiuto un\'azione social. Valuta SOLO ciò che vedi; se un elemento ' +
        'richiesto non è chiaramente visibile, la prova non è valida. Rispondi SOLO con un oggetto ' +
        'JSON: {"valid": boolean, "reason": "una frase breve in italiano, comprensibile al cliente"}',
      }],
    },
    text:
      'Checklist della promozione (tutti gli elementi devono essere chiaramente visibili):\n' +
      checklist + '\n\nLo screenshot soddisfa la checklist?',
  };
}

async function geminiValidateImage(imageB64, mimeType, checklist) {
  const p = geminiVisionPrompt(checklist);
  const auth = new GoogleAuth({ scopes: 'https://www.googleapis.com/auth/cloud-platform' });
  const client = await auth.getClient();
  const { token } = await client.getAccessToken();
  const resp = await fetch(VERTEX_GEMINI_URL, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: p.systemInstruction,
      contents: [{
        role: 'user',
        parts: [
          { text: p.text },
          { inlineData: { mimeType, data: imageB64 } },
        ],
      }],
      generationConfig: {
        temperature: 0,
        maxOutputTokens: 150,
        responseMimeType: 'application/json',
      },
    }),
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    logger.error('Gemini vision non-OK', { status: resp.status, body: body.slice(0, 300) });
    return null; // null = IA indisponibile → pending_review (mai inventare un verdetto)
  }
  const json = await resp.json();
  const raw = (((json.candidates || [])[0] || {}).content || {}).parts
    ? json.candidates[0].content.parts.map((x) => x.text || '').join('')
    : '';
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed.valid !== 'boolean') return null;
    return { valid: parsed.valid, reason: String(parsed.reason || '').slice(0, 200) };
  } catch {
    logger.error('Gemini vision: risposta non-JSON', { raw: raw.slice(0, 300) });
    return null;
  }
}

exports.submitClaim = onCall(
  { region: 'europe-west1', maxInstances: 2, timeoutSeconds: 60 },
  async (req) => {
    const member = await assertMember(req.data && req.data.token);
    const promoId = String((req.data && req.data.promoId) || '').trim();
    const imagePath = String((req.data && req.data.imagePath) || '').trim();
    const db = admin.firestore();

    if (!promoId) throw new HttpsError('invalid-argument', 'Promozione mancante.');
    if (!imagePath.startsWith('claims-inbox/' + member.id + '/')) {
      throw new HttpsError('permission-denied', 'Percorso immagine non valido.');
    }

    const promoDoc = await db.collection('promos').doc(promoId).get();
    if (!promoDoc.exists || !promoDoc.data().active) {
      throw new HttpsError('failed-precondition', 'Questa promozione non è più attiva.');
    }
    const promo = promoDoc.data();
    const now = new Date();
    if (promo.startsAt && promo.startsAt.toDate() > now) {
      throw new HttpsError('failed-precondition', 'La promozione non è ancora iniziata.');
    }
    if (promo.endsAt && promo.endsAt.toDate() < now) {
      throw new HttpsError('failed-precondition', 'Questa promozione è terminata.');
    }
    if (promo.actionType === 'referral') {
      throw new HttpsError('invalid-argument',
        'Questa promozione si completa invitando amici, non con uno screenshot.');
    }

    const claimRef = db.collection('claims').doc(promoId + '_' + member.id);
    const claimSnap = await claimRef.get();
    if (claimSnap.exists && claimSnap.data().status !== 'rejected') {
      throw new HttpsError('already-exists',
        'Hai già una richiesta per questa promozione. Controlla la tua tessera.');
    }

    // Rate limit orario + retry limit
    const m = member.data;
    const hourKey = new Date().toISOString().slice(0, 13); // YYYY-MM-DDTHH
    const attempts = (m.uploadAttempts || {})[promoId] || 0;
    if (attempts >= MAX_UPLOAD_ATTEMPTS) {
      throw new HttpsError('resource-exhausted',
        'Hai esaurito i tentativi per questa promozione: passa al banco.');
    }
    const rate = m.claimsRate || {};
    if (rate.hour === hourKey && rate.count >= MAX_CLAIMS_PER_HOUR) {
      throw new HttpsError('resource-exhausted', 'Troppe richieste: riprova tra un\'ora.');
    }

    // Scarica l'immagine da Storage e valida con Gemini vision
    let verdict = null;
    try {
      const bucket = admin.storage().bucket();
      const file = bucket.file(imagePath);
      const [meta] = await file.getMetadata();
      const mime = String(meta.contentType || 'image/jpeg');
      if (!mime.startsWith('image/')) {
        throw new HttpsError('invalid-argument', 'Il file caricato non è un\'immagine.');
      }
      const [buf] = await file.download();
      verdict = await geminiValidateImage(buf.toString('base64'), mime, promo.aiChecklist || '');
    } catch (err) {
      if (err instanceof HttpsError) throw err;
      logger.error('submitClaim: validazione impossibile', { error: String(err && err.message || err) });
      verdict = null;
    }

    // Aggiorna contatori anti-abuso (sempre, prima dell'esito)
    await member.ref.update({
      ['uploadAttempts.' + promoId]: admin.firestore.FieldValue.increment(1),
      claimsRate: { hour: hourKey, count: rate.hour === hourKey ? (rate.count || 0) + 1 : 1 },
    });

    if (verdict === null) {
      // IA indisponibile / immagine illeggibile → approvazione manuale staff
      await claimRef.set({
        memberId: member.id, promoId,
        code: randomToken(), status: 'pending_review',
        screenshotPath: imagePath, aiModel: 'gemini-2.5-flash-lite',
        aiNote: 'Validazione automatica non disponibile',
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        redeemedAt: null, redeemedVia: null, redeemedBy: null,
      });
      return { status: 'pending_review', reason: 'Verifica in corso da parte dello staff: trovi l\'esito sulla tua tessera.', tesseraUrl: TESSERA_BASE + String(req.data.token) };
    }

    if (!verdict.valid) {
      // Rifiuto: niente doc claim (retry consentito fino al limite tentativi)
      return { status: 'rejected', reason: verdict.reason || 'La prova non soddisfa la checklist.', tesseraUrl: TESSERA_BASE + String(req.data.token) };
    }

    // Valido → claim issued con QR univoco
    await claimRef.set({
      memberId: member.id, promoId,
      code: randomToken(), status: 'issued',
      screenshotPath: imagePath, aiModel: 'gemini-2.5-flash-lite',
      aiNote: verdict.reason || '',
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      redeemedAt: null, redeemedVia: null, redeemedBy: null,
    });
    await member.ref.update({
      ['actionsCount.' + promo.actionType]: admin.firestore.FieldValue.increment(1),
    });
    const updated = (await member.ref.get()).data();
    await evaluateBadges(member.ref, updated);
    logger.info('submitClaim issued', { memberId: member.id, promoId });
    return { status: 'issued', reason: 'Verifica superata! Mostra il QR al banco per il tuo premio.', tesseraUrl: TESSERA_BASE + String(req.data.token) };
  }
);
```

- [ ] **Step 2: Syntax check** — `node --check index.js`

- [ ] **Step 3: Probe emulatore**

Con emulatori avviati: seminare promo attiva con `aiChecklist`, member con token noto, upload immagine su Storage emulator `claims-inbox/<id>/test.jpg`. La chiamata Gemini reale NON va dall'emulatore-only: accettato che `verdict === null` → atteso `pending_review`. Il path `valid`/`rejected` reale va verificato in prod (Task 13, contratto Gemini già verificato separatamente il 2026-09-11 con `/tmp/dbg-admin/call-vision.py`).

- [ ] **Step 4: Commit**

```bash
git add functions/index.js
git commit -m "Gamification: submitClaim con validazione Gemini vision (fallback pending_review)

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 6: Functions — trigger referral `onMemberCreated` + auto-claim soglia

**Files:**
- Modify: `functions/index.js`

**Interfaces:**
- Consumes: `randomToken`, `evaluateBadges` (Task 3); campo `refSuspicious`/`referredBy` scritti da `registerMember`
- Produces: trigger `onMemberCreated` su `members/{id}`: se `referredBy` e non `refSuspicious` → `referralCount++` sul referente + valutazione promo referral attive (claim `issued` automatico a soglia `refTarget`) + `evaluateBadges`; se sospetto → solo log + campo `suspiciousReferral: true` sul referente (visibile in admin, approvazione manuale)

- [ ] **Step 1: Implementare**

```js
exports.onMemberCreated = onDocumentCreated(
  { document: 'members/{memberId}', region: 'europe-west1', maxInstances: 2, retry: true },
  async (event) => {
    const snap = event.data;
    if (!snap) return;
    const member = snap.data();
    if (!member.referredBy) return;

    const db = admin.firestore();
    const referrerRef = db.collection('members').doc(member.referredBy);
    const referrerSnap = await referrerRef.get();
    if (!referrerSnap.exists) {
      logger.error('onMemberCreated: referente mancante', { referredBy: member.referredBy });
      return;
    }

    if (member.refSuspicious) {
      // Referral sospetto: NON conteggiato. Approvazione manuale in admin.
      await referrerRef.update({ suspiciousReferral: true });
      logger.info('Referral sospetto marcato', { referrer: member.referredBy, nuovo: snap.id });
      return;
    }

    await referrerRef.update({
      referralCount: admin.firestore.FieldValue.increment(1),
    });
    const referrer = (await referrerRef.get()).data();

    // Promo referral attive: soglia raggiunta → claim issued automatico
    const promos = await db.collection('promos')
      .where('active', '==', true)
      .where('actionType', '==', 'referral').get();
    for (const d of promos.docs) {
      const p = d.data();
      const now = new Date();
      if (p.startsAt && p.startsAt.toDate() > now) continue;
      if (p.endsAt && p.endsAt.toDate() < now) continue;
      if (!p.refTarget || referrer.referralCount < p.refTarget) continue;
      const claimRef = db.collection('claims').doc(d.id + '_' + member.referredBy);
      const existing = await claimRef.get();
      if (existing.exists) continue; // 1 premio per promo per tessera
      await claimRef.set({
        memberId: member.referredBy, promoId: d.id,
        code: randomToken(), status: 'issued',
        screenshotPath: null, aiModel: null,
        aiNote: 'Referral: soglia ' + p.refTarget + ' raggiunta',
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        redeemedAt: null, redeemedVia: null, redeemedBy: null,
      });
      await referrerRef.update({
        ['actionsCount.referral']: admin.firestore.FieldValue.increment(1),
      });
      logger.info('Claim referral emesso', { promoId: d.id, memberId: member.referredBy });
    }

    const refreshed = (await referrerRef.get()).data();
    await evaluateBadges(referrerRef, refreshed);
  }
);
```

Nota import: `onDocumentCreated` è già importato in cima a `functions/index.js`.

- [ ] **Step 2: Syntax check + probe emulatore**

Crea due member (A con refCode, B con referredBy=A) → verifica `referralCount` di A = 1. Crea promo referral `refTarget: 1` attiva, registra C con refCode di A → claim `issued` su A per quella promo. Registra D con refCode inesistente → nessun incremento.

- [ ] **Step 3: Commit**

```bash
git add functions/index.js
git commit -m "Gamification: trigger referral onMemberCreated + claim automatico a soglia

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 7: Functions — `peekClaim` + `redeemQr` (riscatto, irreversibile)

**Files:**
- Modify: `functions/index.js`

**Interfaces:**
- Consumes: `assertAdmin` (esistente), `config/gamification.staffPin` (da Task 2)
- Produces:
  - callable `peekClaim({ code }) → { prizeLabel, memberName, promoTitle, status, redeemedAt|null }` — pubblica, nessun dato oltre quelli visibili al banco
  - callable `redeemQr({ code, pin? }) → { ok: true, prizeLabel, memberName }` — unica via di bruciatura; admin loggato salta il PIN; altrimenti PIN obbligatorio; errori: `not-found` (codice invalido), `failed-precondition` (già riscattato / non riscattabile), `permission-denied` (PIN errato)

- [ ] **Step 1: Implementare**

```js
async function findClaimByCode(code) {
  const c = String(code || '').trim();
  if (!/^[a-f0-9]{32}$/.test(c)) {
    throw new HttpsError('not-found', 'Codice QR non valido.');
  }
  const snap = await admin.firestore().collection('claims')
    .where('code', '==', c).limit(1).get();
  if (snap.empty) {
    throw new HttpsError('not-found', 'Codice QR non trovato.');
  }
  return snap.docs[0];
}

async function claimPublicPayload(claimDoc) {
  const c = claimDoc.data();
  const db = admin.firestore();
  const [promo, member] = await Promise.all([
    db.collection('promos').doc(c.promoId).get(),
    db.collection('members').doc(c.memberId).get(),
  ]);
  return {
    prizeLabel: (promo.exists && promo.data().prizeLabel) || 'Premio',
    promoTitle: (promo.exists && promo.data().title) || '',
    memberName: (member.exists && member.data().name) || '',
    status: c.status,
    redeemedAt: c.redeemedAt && c.redeemedAt.toDate ? c.redeemedAt.toDate().toISOString() : null,
  };
}

exports.peekClaim = onCall(
  { region: 'europe-west1', maxInstances: 2 },
  async (req) => claimPublicPayload(await findClaimByCode(req.data && req.data.code))
);

exports.redeemQr = onCall(
  { region: 'europe-west1', maxInstances: 2 },
  async (req) => {
    // Admin loggato (futura app staff) salta il PIN; altrimenti PIN obbligatorio
    const email = req.auth && req.auth.token && req.auth.token.email;
    let authorized = false;
    if (email) {
      try { await assertAdmin(req); authorized = true; } catch { /* non admin: PIN sotto */ }
    }
    if (!authorized) {
      const cfg = await admin.firestore().doc('config/gamification').get();
      const staffPin = cfg.exists ? String(cfg.data().staffPin || '') : '';
      const pin = String((req.data && req.data.pin) || '');
      if (!staffPin || pin !== staffPin) {
        throw new HttpsError('permission-denied', 'PIN staff errato.');
      }
    }

    const claimDoc = await findClaimByCode(req.data && req.data.code);
    const c = claimDoc.data();
    if (c.status === 'redeemed') {
      const when = c.redeemedAt && c.redeemedAt.toDate ? c.redeemedAt.toDate().toLocaleDateString('it-IT') : '';
      throw new HttpsError('failed-precondition', 'Premio già riscattato il ' + when + '.');
    }
    if (c.status !== 'issued') {
      throw new HttpsError('failed-precondition', 'Questo premio non è riscattabile (in verifica o rifiutato).');
    }

    // Transazione: bruciatura atomica, doppio tap sicuro
    await admin.firestore().runTransaction(async (tx) => {
      const fresh = await tx.get(claimDoc.ref);
      if (fresh.data().status !== 'issued') {
        throw new HttpsError('failed-precondition', 'Premio già riscattato da un altro accesso.');
      }
      tx.update(claimDoc.ref, {
        status: 'redeemed',
        redeemedAt: admin.firestore.FieldValue.serverTimestamp(),
        redeemedVia: email ? 'staff_app' : 'pin',
        redeemedBy: email || null,
      });
    });

    logger.info('redeemQr OK', { claimId: claimDoc.id, via: email ? 'staff' : 'pin' });
    const payload = await claimPublicPayload(claimDoc);
    return { ok: true, prizeLabel: payload.prizeLabel, memberName: payload.memberName };
  }
);
```

- [ ] **Step 2: Syntax check + probe emulatore**

Seminare `config/gamification {staffPin:'1234'}` e claim `issued` con code `b`×32: peek → payload; redeem pin errato → `permission-denied`; redeem pin giusto → `ok:true`; redeem di nuovo → `failed-precondition`; redeem claim `pending_review` → `failed-precondition`.

- [ ] **Step 3: Commit**

```bash
git add functions/index.js
git commit -m "Gamification: peekClaim + redeemQr (bruciatura atomica con PIN)

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 8: Pagina `promo.html` — landing promo + registrazione + upload prova

**Files:**
- Create: `promo.html`, `promo.js`, `promo.css`
- Create: `vendor/qrcode.min.js` — scaricare qrcodejs (davidshimjs, ~5KB, MIT) in vendor e referenziarlo con script classico (espone `new QRCode(el, {...})`)

**Interfaces:**
- Consumes: callable `registerMember` (Task 3), `getTessera` (Task 4), `submitClaim` (Task 5); rules pubbliche promos (Task 1); Storage claims-inbox (Task 2)
- Produces: localStorage `fond.tessera.<token>` = JSON `{ token, memberId }` (chiave = token stesso così ogni device ricorda la sua); URL handling: `?p=<promoId>`, `?p=<promoId>&ref=<refCode>`, `?ref=<refCode>` (standalone referral → home delle promo)

- [ ] **Step 1: `promo.html` scheletro completo**

```html
<!DOCTYPE html>
<html lang="it">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
    <meta name="robots" content="noindex">
    <title>Fonderia — Promozioni</title>
    <link rel="icon" type="image/svg+xml" href="images/logo.svg">
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;700&family=Inter:wght@400;500;600&display=swap" rel="stylesheet">
    <link rel="stylesheet" href="styles.css">
    <link rel="stylesheet" href="promo.css?v=1">
    <script src="firebase-config.js?v=2"></script>
    <script src="vendor/qrcode.min.js" defer></script>
    <script type="module" src="promo.js?v=1"></script>
</head>
<body class="promo-body">
    <main class="promo-main">
        <header class="promo-header">
            <img src="images/logo.svg" alt="Fonderia Treviso" class="promo-logo">
        </header>
        <div id="promoApp" class="promo-app">
            <p class="promo-loading">Caricamento…</p>
        </div>
    </main>
</body>
</html>
```

- [ ] **Step 2: `promo.js` — stati della pagina**

Struttura: `init()` legge i query param → carica promo attiva da Firestore (read pubblico, `where('active','==',true)` + filtro date client) → se localStorage ha già la tessera → stato PARTECIPA (bottone upload) altrimenti → stato REGISTRA (form nome+telefono+consenso). Dopo submitClaim con `issued` → stato PREMIO (QR generato da `tesseraUrl` claims, via `getTessera` refresh). Funzioni chiave con implementazione completa:

```js
import { getDb, getFsMod, getStorageInstance, getFunctionsInstance } from './firebase-init.js';
import { httpsCallable } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-functions.js';
import { ref as storageRef, uploadBytes }
  from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-storage.js';

const app = document.getElementById('promoApp');
const LS_KEY = () => { // una tessera per device
  try { return Object.keys(localStorage).find(k => k.startsWith('fond.tessera.')) || null; }
  catch { return null; }
};

function savedTessera() {
  const k = LS_KEY();
  if (!k) return null;
  try { return JSON.parse(localStorage.getItem(k)); } catch { return null; }
}

async function callable(name) {
  const fns = await getFunctionsInstance();
  return httpsCallable(fns, name);
}

function esc(v) {
  return String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
```

Render states come funzioni `renderRegister(promo, refCode)`, `renderParticipate(promo, tessera)`, `renderPrize(claim)`, `renderStatus(status, reason)` — tutto innerHTML con `esc()` su ogni dato Firestore/utente. Upload: `<input type="file" accept="image/*" capture="environment">` → check `file.type.startsWith('image/')` e `file.size <= 5MB` → `uploadBytes(storageRef(storage, 'claims-inbox/' + tessera.memberId + '/' + Date.now() + '.jpg'), file)` → `submitClaim`.

Per referral (promo `actionType === 'referral'` o assenza di `?p=`): stato INVITA con testo "Invita X amici" (da `refTarget`), bottone Condividi con `navigator.share({ url: location.origin + '/promo.html?p=' + promo.id + '&ref=' + tessera.refCode })` e fallback copy-to-clipboard.

- [ ] **Step 3: `promo.css`** — mobile-first 390px, card dark su bg del sito, bottoni full-width stile `btn btn-primary`, QR centrato 220×220, input font-size 16px ereditato da styles.css.

- [ ] **Step 4: Test manuale emulatore** + mobile probe 390px (script pattern `/tmp/dbg-admin/probe-verify-mobile.js`: `viewport 390 isMobile`, assert `innerWidth === 390`).

- [ ] **Step 5: Commit**

```bash
git add promo.html promo.js promo.css vendor/qrcode.min.js
git commit -m "Gamification: pagina promo (registrazione, upload prova, QR premio, referral)

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 9: Pagina `tessera.html` — QR attivi, badge, referral

**Files:**
- Create: `tessera.html`, `tessera.js`, `tessera.css`

**Interfaces:**
- Consumes: callable `getTessera` (Task 4), `vendor/qrcode.min.js` (Task 8)
- Produces: URL `?t=<token>`; se token assente/invalido → schermata "Tessera non trovata" + link a promo.html

- [ ] **Step 1: `tessera.html` + `tessera.js`**

Stesso scheletro head di promo.html (viewport, fonts, styles.css, firebase-config, qrcode). JS: legge `?t=` → `getTessera({token})` → render: header nome+refCode, lista claim (stati: issued → QR 220px con `new QRCode(el, { text: claim.qrUrl, width: 220, height: 220 })` + label premio; pending_review → chip gialla "in verifica"; redeemed → chip grigia "riscattato il <data>"), sezione badge con emoji, contatore referral + bottone "Invita amici" (`navigator.share` con link `promo.html?ref=<refCode>`), lista promo attive con link. Anche salva `{token, memberId}` in localStorage (`fond.tessera.<token>`) per riallacciare promo.html su questo device.

- [ ] **Step 2: `tessera.css`** — come promo.css (cards, chips di stato, QR con cornice bianca per la scansione: fondo QR SEMPRE `#fff` in un contenitore padding 12px anche su tema scuro).

- [ ] **Step 3: Probe mobile 390px + emulatore** (pattern Task 8 step 4)

- [ ] **Step 4: Commit**

```bash
git add tessera.html tessera.js tessera.css
git commit -m "Gamification: pagina tessera (QR premi, badge, contatore referral)

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 10: Pagina `riscatta.html` — riscatto al banco con PIN

**Files:**
- Create: `riscatta.html`, `riscatta.js`

**Interfaces:**
- Consumes: callable `peekClaim` + `redeemQr` (Task 7)
- Produces: URL `?c=<code>`; flusso: peek → mostra premio/nome/stato → se `issued` form PIN (tastiera numerica, `inputmode="numeric"`) → redeem; stati finali "Riscattato ✅ / Già riscattato il <data> / Non valido"

- [ ] **Step 1: `riscatta.html` + `riscatta.js`**

Stesso scheletro head. JS:

```js
import { getFunctionsInstance } from './firebase-init.js';
import { httpsCallable } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-functions.js';

const code = new URLSearchParams(location.search).get('c') || '';
// init: peekClaim({code}) → render stato
// form PIN → redeemQr({code, pin}) → success: schermata verde premio+nome (grande, leggibile al banco)
// errori HttpsError mapping: not-found → "QR non valido", failed-precondition → messaggio server,
// permission-denied → "PIN errato, riprova" (PIN field reset)
```

Schermata successo volutamente gigante (premio 32px bold, nome sotto) per essere letta a distanza dal barista.

- [ ] **Step 2: Probe emulatore**: peek + redeem flusso completo verso Functions emulator (seed claim, pin config).

- [ ] **Step 3: Probe mobile 390px.**

- [ ] **Step 4: Commit**

```bash
git add riscatta.html riscatta.js
git commit -m "Gamification: pagina riscatto QR con PIN staff

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 11: Admin — tab Promozioni + Badge + tabella claim

**Files:**
- Modify: `admin.html` (2 bottoni tab + 2 section; bump `admin.js?v=7`, `admin.css?v=7`)
- Modify: `admin.js` (els.panels, unsubscribe map, case nel tab switcher, nuovi moduli di render)
- Modify: `admin.css` (stili chips stato claim, toggle attivo — riusando classi esistenti)

**Interfaces:**
- Consumes: rules admin-write su promos/badges/config.gamification (Task 1), read claims (Task 1); callable `submitClaim`/`redeemQr` NON usate qui; approvazione pending_review = update diretto `claims/<id> { status: 'issued' }`? NO — le rules negano write claims al client, admin incluso → serve callable `reviewClaim({claimId, approve})` (aggiungere in questo task a functions/index.js, protetta da `assertAdmin`, approve → status issued (code già presente), reject → status rejected)
- Produces: tab `promos` (lista + form create/edit con campo aiChecklist, actionType select [condividi_evento, condividi_post, tag_story, referral, custom], refTarget visibile solo per referral, eventRef select dagli events, date, attiva toggle + bottone "copia link promo.html?p=<id>"), tab `badges` (CRUD con metric select [totalClaims, referralCount, actionsCount.<tipo>] + threshold), tabella claim con filtri (tutti/pending/sospetti) + bottoni Approva/Rifiuta, impostazioni (staffPin, prizeOptions) in fondo al tab Promozioni

- [ ] **Step 1: callable `reviewClaim` in functions/index.js**

```js
exports.reviewClaim = onCall(
  { region: 'europe-west1', maxInstances: 2 },
  async (req) => {
    await assertAdmin(req);
    const claimId = String((req.data && req.data.claimId) || '').trim();
    const approve = Boolean(req.data && req.data.approve);
    const ref = admin.firestore().collection('claims').doc(claimId);
    const snap = await ref.get();
    if (!snap.exists) throw new HttpsError('not-found', 'Claim non trovato.');
    if (snap.data().status !== 'pending_review') {
      throw new HttpsError('failed-precondition', 'Claim già gestito.');
    }
    await ref.update({ status: approve ? 'issued' : 'rejected' });
    if (approve) {
      const claim = snap.data();
      const mRef = admin.firestore().collection('members').doc(claim.memberId);
      const promo = (await admin.firestore().collection('promos').doc(claim.promoId).get()).data();
      await mRef.update({ ['actionsCount.' + (promo.actionType || 'custom')]: admin.firestore.FieldValue.increment(1) });
      await evaluateBadges(mRef, (await mRef.get()).data());
    }
    logger.info('reviewClaim', { claimId, approve, by: req.auth.token.email });
    return { ok: true };
  }
);
```

Anche referral sospetti: approvazione = cancellare `suspiciousReferral` dal member + `referralCount++` manuale? Tenere semplice: i referral sospetti compaiono nella tabella claim SOLO come membri marcati — fuori scope CRUD; lo staff li vede nel tab Promozioni sezione "Referral sospetti" (query members where suspiciousReferral==true + bottone "Approva" → callable `approveReferral({memberId})` che incrementa e smarca). Implementarla analoga a reviewClaim (assertAdmin, update + evaluateBadges).

- [ ] **Step 2: admin.html** — aggiungere 2 bottoni in `#admTabs` (`data-tab="promos"` label "Promozioni", `data-tab="badges"` label "Badge") e 2 `<section id="tab-promos" class="adm-panel" hidden>` / `tab-badges` in `adm-main`. Bump `admin.js?v=7` e `admin.css?v=7`.

- [ ] **Step 3: admin.js** — pattern identico alle tab esistenti: `els.panels.promos/badges`, `unsubscribe.promos/badges/claims`, `onSnapshot(query(collection(db,'promos'), orderBy('createdAt','desc')), …)`, form con submit→`addDoc`/`updateDoc`, toggle `active`→`updateDoc`. Campo data con `toDatetimeLocalValue` (esiste). Link promo: `location.origin + '/promo.html?p=' + id` con bottone copia (`navigator.clipboard`). Claims: `onSnapshot(collection(db,'claims'), …)` con join leggero su members/promos via `getDoc` puntuale per nome/titolo (cache in map, i volumi sono bassi).

- [ ] **Step 4: Syntax check** `node --check admin.js` (admin.js è un ES module browser: `node --check` accetta la sintassi import solo con estensione .mjs o flag — usare `cp admin.js /tmp/admin.mjs && node --check /tmp/admin.mjs`).

- [ ] **Step 5: Verifica E2E admin via browser loggato (Mario) dopo deploy** — non testabile headless senza credenziali admin.

- [ ] **Step 6: Commit**

```bash
git add admin.html admin.js admin.css functions/index.js
git commit -m "Gamification: tab admin Promozioni/Badge/claims + reviewClaim/approveReferral

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 12: Popup home per la promo attiva + sezione promo in index

**Files:**
- Modify: `popup.js` (dopo la logica popup esistente: se nessun popup mostrato, query promos attive → popup "🎁 <titolo>: <premio>" CTA link interno a promo.html?p=<id> — dismissal `fond.popup.dismissed.promo-<id>`)
- Modify: `index.html` (bump `popup.js?v=N`)

**Interfaces:**
- Consumes: rules pubbliche promos (Task 1), `fond-popup-*` CSS esistente, indice `promos(active,createdAt desc)` (Task 2)

- [ ] **Step 1: Estendere popup.js**

In `initPopup`, nel ramo `if (!popup) return;` sostituire con: se nessun popup Firestore valido → `await initPromoPopup(fs, db)`:

```js
async function initPromoPopup(fs, db) {
    const q = fs.query(
        fs.collection(db, 'promos'),
        fs.where('active', '==', true),
        fs.orderBy('createdAt', 'desc'),
        fs.limit(1)
    );
    const snap = await fs.getDocs(q);
    if (snap.empty) return;
    const p = { id: snap.docs[0].id, ...snap.docs[0].data() };
    const now = new Date();
    if (p.startsAt && p.startsAt.toDate() > now) return;
    if (p.endsAt && p.endsAt.toDate() < now) return;
    const dismissKey = DISMISS_PREFIX + 'promo-' + p.id;
    try { if (localStorage.getItem(dismissKey)) return; } catch { /* mostra comunque */ }
    setTimeout(() => showPromoPopup(p, dismissKey), SHOW_DELAY_MS);
}
```

`showPromoPopup` riusa la stessa struttura DOM di `showPopup` (classi `fond-popup-*`): title `🎁 ` + p.title, body p.description o p.prizeLabel, CTA `<a class="btn btn-primary fond-popup-cta" href="/promo.html?p=<id>">Partecipa</a>` (link interno, no target blank), close marca `localStorage[dismissKey]='1'`.

- [ ] **Step 2: Bump versione in index.html** (`popup.js?v=2` o successivo coerente con lo stato attuale).

- [ ] **Step 3: Probe headless 390px** su home con promo seminata nell'emulatore? L'home punta a prod: verifica post-deploy (Task 13) con localStorage pulito → popup promo visibile → dismiss → reload → assente.

- [ ] **Step 4: Commit**

```bash
git add popup.js index.html
git commit -m "Gamification: popup home per la promo attiva (dismissal per promo)

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 13: Deploy + verifica E2E in produzione

**Files:** nessuno (operativo)

- [ ] **Step 1: Deploy rules + indici + functions**

```bash
firebase deploy --only firestore:rules,storage:rules,firestore:indexes,functions
```

- [ ] **Step 2: Seed config/gamification in prod**

`cd seed && node seed.js` (già include il blocco idempotente del Task 2) — poi **cambiare staffPin da console/admin a un valore non di default** (segnarlo a Mario, NON nei log/git).

- [ ] **Step 3: Deploy hosting**

```bash
firebase deploy --only hosting
```

- [ ] **Step 4: E2E reale, flusso felice completo**

1. Mario crea una promo di test in admin (tag_story, checklist "si vede una storia Instagram con il tag @fonderiatreviso") attiva
2. Apro `/promo.html?p=<id>` headless (pattern `/tmp/dbg-admin/`): render promo ✓
3. Registro member di test via callable probe (curl) → tesseraUrl; apro tessera → render vuoto ok
4. Upload screenshot story VERO (da `/tmp/dbg-admin/gen-shots.js`, già validato con Gemini) su `claims-inbox/<id>/e2e.jpg` → `submitClaim` → atteso `issued` (validazione Gemini reale in prod)
5. Apro `tessera.html?t=<token>` → claim issued senza QR (il QR appare in promo/tessera via qrUrl) ✓
6. `/riscatta.html?c=<code>` → peek ok → redeem con PIN → `ok:true` → riapro → "già riscattato" ✓
7. Retry submitClaim stessa promo → `already-exists` ✓
8. Screenshot falso (gen-shots invalid) → secondo member → `rejected` con reason italiano ✓
9. Popup home: localStorage pulito headless → promo popup compare → dismiss → scompare ✓
10. Mobile 390px su promo/tessera/riscatta/home: `innerWidth === 390`, niente shrink-to-fit ✓

- [ ] **Step 5: Pulizia dati di test** (cancellare member/claim/promo di test da console o admin), aggiornare `~/CONTESTO-FONDERIA-2026-09-11.md`, commit finale se serve.

```bash
git push  # identità Mariofdt, poi ripristino cardanocodelab-alt
```

---

## Self-Review (eseguita)

- **Spec coverage**: rules (§7→Task 1-2), callable §6 (register/getTessera/submitClaim/redeemQr → Task 3-7; onMemberCreated → Task 6; reviewClaim/approveReferral/peekClaim aggiunte come callable mancanti ma implicate dai flussi §3.3/§3.4), pagine (§6→Task 8-10), admin (§3.4→Task 11), popup (§3.1→Task 12), antifrode §5 (docId composto, retry max5, rate limit, storage rules, suspicious referral — tutti nei task 1-2-5-6-7), test plan §8 (rules test Task 1, Gemini reale già verificato + probe prod Task 13, emulatori per task, E2E+mobile Task 13).
- **Deltas documentati vs spec**: (1) `peekClaim` aggiunta — necessaria per mostrare il premio in riscatta.html senza accesso client a claims; (2) claim `rejected` consente retry (docId riutilizzabile) — coerente con §5 nota 2 (rifiuti non occupano il premio), uploadAttempts max5 resta il guardrail; (3) `pending_review` occupa il docId (§5 nota 2: "creato a validazione positiva o pending_review").
- **Type consistency**: `assertMember` ritorna `{id, data, ref}` ovunque; claim fields identici tra submitClaim/onMemberCreated/redeemQr (`memberId, promoId, code, status, screenshotPath, aiModel, aiNote, createdAt, redeemedAt, redeemedVia, redeemedBy`); `qrUrl` solo in getTessera; actionType enum identico in spec/admin/submitClaim.
