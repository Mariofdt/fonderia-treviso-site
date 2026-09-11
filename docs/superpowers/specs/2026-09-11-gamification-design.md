# Gamification Fonderia Treviso — Design Spec

Data: 2026-09-11 · Stato: approvata nelle sezioni (data model, flussi, IA/antifrode, componenti) · Approccio: **A — pagine dinamiche lette da Firestore**

## 1. Obiettivo

Trasformare i clienti in canale di marketing: azioni social (condivisione evento/post, tag nelle
storie, referral tra amici) → prova via screenshot → **validazione con IA (Gemini vision)** →
**QR univoco monouso** riscattabile al banco (drink / fritto / ingresso omaggio) → **badge
fedeltà** configurabili dall'admin. Fondamenta pronte per la futura **app staff** che legge e
brucia gli stessi QR chiamando lo stesso backend.

### Decisioni approvate (da brainstorming)

| Tema | Decisione |
|---|---|
| Verifica azione | Screenshot caricato dal cliente + validazione Gemini vision; fallback approvazione manuale staff in admin |
| Identità cliente | Tessera leggera: nome + telefono, niente password; accesso via link segreto salvabile in home |
| Limiti premio | **1 premio per promo per tessera** (garantito da docId composto) |
| Riscatto | Oggi pagina web con PIN staff; domani app baristi con login — stessa `redeemQr` |
| Badge | Configurabili da admin (nome, emoji, soglia su contatore) |
| Referral | Nuovo `actionType`: il server conta gli inviti, niente screenshot/IA |
| Promo referral sospette | Marcate `suspicious`, non conteggiate finché lo staff non approva |
| Architettura pagine | Dinamiche da Firestore (zero deploy per promo nuova, link condivisibile subito) |

## 2. Data model Firestore

```
members/{memberId}
  name: string (2-50 char)
  phone: string (formato IT, validato)
  token: string 128-bit          // segreto del link tessera — mai leggibile da client
  refCode: string                // pubblico, es. "MARCO7" (nome + cifre, univoco)
  referredBy: memberId | null
  referralCount: number          // incrementato solo da function
  actionsCount: { [actionType]: number }   // scritto solo da function
  claimsUsed: { [promoId]: true }          // per contatore anti-riprova upload
  uploadAttempts: { [promoId]: number }    // max 5 prove per promo
  badges: string[]               // badgeId assegnati, scritti solo da function
  createdAt: Timestamp

promos/{promoId}                 // create da admin; lette pubblicamente solo se active
  title, description, prizeLabel ("Drink omaggio")
  actionType: condividi_evento | condividi_post | tag_story | referral | custom
  aiChecklist: string            // cosa Gemini deve vedere nello screenshot (non per referral)
  refTarget: number | null       // solo referral: quanti amici per il premio
  eventRef: events/{id} | null
  imageUrl: string | null        // gallery o Storage, come pattern esistente popup/eventi
  active: boolean
  startsAt, endsAt: Timestamp | null
  createdAt: Timestamp

claims/{promoId_memberId}        // 1 doc = 1 QR univoco = 1 premio per promo per tessera
  memberId, promoId
  code: string 128-bit           // contenuto del QR — mai leggibile da client anonimo
  status: issued | redeemed | pending_review | rejected
  screenshotPath: string | null  // null per referral
  aiModel: string | null         // es. "gemini-2.5-flash-lite"
  aiNote: string | null          // reason del verdetto — visibile in admin
  createdAt, redeemedAt: Timestamp
  redeemedVia: pin | staff_app | null
  redeemedBy: string | null      // futuro: uid/email barista

badges/{badgeId}                 // configurabili da admin
  name, icon (emoji), description
  rule: { metric: "totalClaims" | "actionsCount.<actionType>" | "referralCount",
          threshold: number }
  active: boolean

config/gamification {
  staffPin: string,              // lettura/scrittura client SOLO da email whitelist admin;
                                 // redeemQr la confronta lato server
  prizeOptions: string[]         // es. ["Drink omaggio","Fritto omaggio","Ingresso omaggio"]
}
```

### Invarianti garantite a livello database

- `claims` docId = `<promoId>_<memberId>` → un solo claim per coppia promo/tessera
  (riuscito o meno: i claim `rejected`/`pending_review` occupano comunque il docId solo dopo
  validazione positiva — vedi §5 per il dettaglio del flusso di retry);
- contatori (`referralCount`, `actionsCount`, `badges`) scrivibili **solo** da Cloud Functions;
- `token` e `code` mai esposti dalle rules: tessera e QR si leggono solo via callable dedicate.

## 3. Flussi

### 3.1 Cliente — registrazione e partecipazione

1. Popup home o link (`promo.html?p=<promoId>`) → pagina promo dinamica.
2. Tap "Partecipa" → micro-form nome + telefono + consenso privacy → callable `registerMember`
   → risposta `{ memberId, token, tesseraUrl }`; il link tessera viene salvato in localStorage
   della pagina e proposto subito con "Aggiungi alla schermata Home".
3. Sulla promo: tap "Carica la prova" → upload immagine su Storage
   (`claims-inbox/<memberId>/<timestamp>.jpg`) → callable `submitClaim`.
4. Esito in ~5s:
   - **valid** → claim `issued`, QR mostrato subito (e per sempre in tessera finché non riscattato);
   - **invalid** → messaggio con `aiNote` ("non si vede il tag…"), nuovo tentativo consentito
     (max 5 per promo);
   - **IA indisponibile/errore** → claim `pending_review`, badge giallo in admin, approvazione
     manuale staff → diventa `issued`.
5. Tessera (`tessera.html?t=<token>`): QR premi attivi, badge, contatore referral, tasto
   "Invita amici" → condivide il link `promo.html?p=<promoId>&ref=<refCode>` (o home con
   `?ref=` se nessuna promo referral attiva): chi lo apre e si registra viene attribuito
   al referente.

### 3.2 Referral

- Registrazione con `?ref=<refCode>` valido → `referredBy` impostato.
- Trigger `onMemberCreated` → `referralCount` del referente +1, **se non sospetto**
  (telefono già registrato, refCode inesistente, o stesso dispositivo/telefono del referente →
  claim referral marcato `suspicious`, approvazione manuale in admin).
- Al raggiungimento di `refTarget` di una promo referral attiva → claim `issued` automatico,
  QR compare in tessera. Nessuna IA coinvolta.

### 3.3 Staff — riscatto

**Oggi (web)**: fotocamera sul QR → `riscatta.html?c=<code>` → mostra premio, nome cliente,
promo → PIN staff → callable `redeemQr({code, pin})` → `redeemed`, irreversibile.
Chi riapre un QR bruciato vede "Già riscattato il <data>".

**Domani (app)**: la app baristi (login Firebase, email in whitelist staff) chiama la stessa
`redeemQr({code})` autenticata (`redeemedVia: staff_app`, `redeemedBy: email`). QR, dati e
funzione restano identici; la pagina PIN resta come fallback.

### 3.4 Admin

Nuova tab **Promozioni** + tab **Badge** in `/admin.html` (stesso look: tooltip, anteprima live,
stessi CSS admin):

- Crea/modifica promo: titolo, premio (da `prizeOptions` + custom), tipo azione, eventRef,
  checklist IA in italiano, date, immagine → link pagina promo pronto da copiare.
- Interruttore attiva/disattiva. Il popup home mostra la promo attiva più recente.
- Tabella claim: cliente, promo, stato, `aiNote`, filtro "sospetti/pending".
- Approva/rifiuta `pending_review` e `suspicious` referral con un tap.
- Badge: CRUD con regola su contatore.
- Impostazioni: PIN staff, `prizeOptions`.

## 4. Validazione IA — contratto

- Callable `submitClaim({ token, promoId, imagePath })`, europe-west1, `assertMember(token)`.
- Function scarica l'immagine da Storage e chiama
  `POST aiplatform.googleapis.com/v1/projects/fonderia-treviso/locations/global/publishers/google/models/gemini-2.5-flash-lite:generateContent`
  (stesso ADC/Compute SA di `suggestEventCopy`, roles/aiplatform.user già attivo).
- Payload: system instruction "verificatore promo Fonderia, rispondi SOLO JSON" + immagine
  (inlineData base64) + `aiChecklist` della promo + schema risposta:
  `{"valid": bool, "reason": "<frase breve italiana>"}`.
- `generationConfig: { temperature: 0, maxOutputTokens: 150, responseMimeType: "application/json" }`.
- Parse JSON con fallback: risposta non-JSON → `pending_review` (mai inventare un verdetto).
- **Valutazione badge**: dopo ogni claim `issued` e dopo ogni incremento referral, la function
  rilegge le regole di `badges/` (active) e aggiunge a `member.badges` le soglie raggiunte
  (idempotente: solo badge non già presenti).
- **Il contratto va verificato con chiamata reale** (screenshot IG vero + uno falso) prima di
  costruire il resto del flusso, come fatto per `suggestEventCopy`.
- Costo atteso ~0,001€/screenshot → trascurabile ai volumi del locale.

## 5. Antifrode (a strati)

1. docId composto claims → 1 premio per promo per tessera, garantito anche contro race/doppi tap.
2. Retry solo dopo rifiuto: claim `issued` occupa il docId; tentativi falliti contano in
   `uploadAttempts[promoId]` (max 5, poi serve lo staff).
   NOTA di coerenza col modello: il claim documento viene **creato solo a validazione positiva**
   (o `pending_review`); i rifiuti vivono solo come contatore in `members` + log.
3. Rate limit: `submitClaim` max 10/ora per tessera (contatore in member con finestra oraria).
4. Storage rules: solo `image/*`, max 5MB, solo nel path del proprio memberId (memberId nel path
   validato contro il token nel callable — il client può caricare ovunque in `claims-inbox/` ma
   `submitClaim` accetta solo path col proprio memberId).
   Limite accettato: upload anonimi randagi possibili ma inerti (nessun claim senza token).
5. Referral: telefono duplicato → rifiuto registrazione; referral sospetti (stesso telefono del
   referente, refCode invalido) → `suspicious`, conteggio solo dopo ok staff.
6. `redeemQr` è l'unico modo di bruciare un claim; `redeemed` irreversibile; code 128-bit non indovinabile.
7. Transparenza admin: tabella claim completa con `aiNote` — pattern strani visibili a occhio.

Rischio residuo accettato: screenshot costruito ad arte può fregare la vision; posta in gioco
bassa (premio 6-8€) + staff vede il telefono al banco. Upgrade futuro possibile ("story ancora
live al riscatto") senza rifare il sistema.

## 6. Componenti

| File | Ruolo |
|---|---|
| `promo.html` / `promo.js` / `promo.css` | pagina promo dinamica da `?p=` |
| `tessera.html` / `tessera.js` / `tessera.css` | tessera (QR, badge, referral) |
| `riscatta.html` / `riscatta.js` | riscatto con PIN |
| `gamification.js` | condiviso: register/tessera fetch, QR lib (qrcodejs ~5KB, self-hosted) |
| `admin.html` / `admin.js` / `admin.css` | tab Promozioni, Badge, claims, impostazioni |
| `index.html` + `popup.js` | popup promo attiva più recente (dismissal per promoId, stesso meccanismo esistente) |
| `functions/index.js` | `registerMember`, `getTessera`, `submitClaim`, `redeemQr`, `onMemberCreated` |
| `firestore.rules` / `storage.rules` | regole nuove collezioni + `claims-inbox/` |

Pagine standalone leggere (stesso brand: font/colori/noise; niente navbar pesante): pensate per
apertura da storia IG. QR generato in pagina, nessun servizio esterno.

### Callable pubbliche (riepilogo contratti)

- `registerMember({ name, phone, refCode? })` → `{ tesseraUrl }` — validazioni forma; telefono duplicato → errore friendly.
- `getTessera({ token })` → `{ name, refCode, referralCount, badges:[…], claims:[{promo,prize,status,qrUrl}], promos:[attive] }`.
- `submitClaim({ token, promoId, imagePath })` → `{ status: "issued"|"rejected"|"pending_review", reason }`.
- `redeemQr({ code, pin? })` (o auth staff) → `{ ok, prizeLabel, memberName }` | errore "già riscattato/codice invalido/PIN errato".

QR content: `https://fonderia-treviso.web.app/riscatta.html?c=<code>`.

## 7. Security rules

- `promos`, `badges`: read pubblico solo `active == true` (e finestra date se presente);
  write solo email whitelist `config/admin` (pattern esistente).
- `members`: create anonimo **negato** (la creazione passa da `registerMember`); read/update/delete
  client **negati** (lettura via `getTessera`).
- `claims`: client **nessun accesso**; function fanno tutto.
- `config/gamification`: client **nessun accesso**; admin write via callable dedicata o console.
- Storage `claims-inbox/`: write anonimo solo `image/*` ≤5MB, depth fissata; read negato a client.

## 8. Test plan

1. **Rules unit tests** (suite `test/` esistente, JDK 21): matrice anon/admin/token su tutte le
   nuove collezioni; docId composto; write contatori negata.
2. **Contratto Gemini vision reale** prima del resto: screenshot IG story con tag valido /
   screenshot falso → verdetto corretto; risposta non-JSON → pending_review.
3. **Emulatori**: registrazione → claim issued → redeemQr pin giusto/sbagliato → doppio riscatto
   bloccato → referral +1 → soglia promo → badge assegnato → pending_review → approvazione admin.
4. **E2E headless prod**: promo render da link, form registrazione, tessera con QR, popup home.
5. **Mobile 390px** su tutte le nuove pagine (shrink-to-fit già coperto dal fix `overflow-x: clip`
   in styles.css condiviso — le nuove pagine lo includono).
6. Admin resta in testabile solo via browser loggato (Mario) — come per suggestEventCopy.

## 9. Fuori scope (volutamente)

Classifiche pubbliche, notifiche push, punti convertibili, premio legato al badge,
multi-premio per claim, app nativa (questa spec ne prepara i contratti), autenticazione
forte del cliente. I contatori nel data model permettono di aggiungerli dopo senza migrazioni.

## 10. Compatibilità app futura

- QR = URL con `code`; l'app legge il code e chiama `redeemQr` autenticata.
- `config/admin` verrà estesa con `staffEmails` (ruolo staff ≠ admin gestionale).
- Nessun cambio a QR, claims, tessere: la migrazione app = solo una nuova front-end.
