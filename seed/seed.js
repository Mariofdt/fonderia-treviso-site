'use strict';

/**
 * Fonderia Treviso — seed una-tantum (idempotente, setDoc + merge).
 *
 * Crea/aggiorna:
 *   - config/admin            → whitelist email admin (INTERIM: da editare in console)
 *   - events/apertura-stagione-2026
 *   - popups/popup-apertura-2026
 *
 * Uso:
 *   cd seed
 *   GOOGLE_APPLICATION_CREDENTIALS=/path/to/serviceAccountKey.json npm run seed
 *   # oppure metti serviceAccountKey.json accanto a questo file
 *
 * La serviceAccountKey.json NON va MAI in git (vedi .gitignore root).
 */

const path = require('path');
const fs = require('fs');
const admin = require('firebase-admin');

const keyPath =
  process.env.GOOGLE_APPLICATION_CREDENTIALS ||
  path.join(__dirname, 'serviceAccountKey.json');

if (!fs.existsSync(keyPath)) {
  console.error('Service account non trovato: ' + keyPath);
  console.error('Scaricalo da Firebase Console → Impostazioni progetto → Account di servizio,');
  console.error('oppure passa il path con GOOGLE_APPLICATION_CREDENTIALS.');
  process.exit(1);
}

admin.initializeApp({
  credential: admin.credential.cert(require(keyPath)),
});

const db = admin.firestore();
const Timestamp = admin.firestore.Timestamp;

async function main() {
  // 1) Whitelist admin (interim — editabile da console o rieseguendo dopo edit qui)
  await db.doc('config/admin').set(
    { allowedEmails: ['cardanocodelab@gmail.com'] },
    { merge: true }
  );
  console.log('OK config/admin → allowedEmails: cardanocodelab@gmail.com (interim)');

  // 2) Evento apertura stagione: 3 ottobre 2026, ore 21:00 (CEST = +02:00)
  await db.doc('events/apertura-stagione-2026').set(
    {
      title: 'Apertura Stagione',
      tagline: 'Si riparte — cena & DJ set',
      date: Timestamp.fromDate(new Date('2026-10-03T21:00:00+02:00')),
      time: '21:00',
      description:
        'La Fonderia riapre le porte per la nuova stagione. ' +
        'Una serata speciale per ricominciare insieme: cena con il menu ' +
        'dello chef e DJ set fino a tarda notte. I posti sono limitati — ' +
        'prenota il tuo tavolo e vieni a brindare con noi al nuovo inizio.',
      image: 'images/hero-bg.jpg',
      active: true,
      order: 1,
    },
    { merge: true }
  );
  console.log('OK events/apertura-stagione-2026');

  // 3) Popup apertura (visibile 11 set → 4 ott 2026, CTA → prenotazione cena)
  await db.doc('popups/popup-apertura-2026').set(
    {
      title: 'Apertura Stagione — 3 Ottobre',
      body:
        'Si riparte! Venerdì 3 ottobre riapriamo con una serata speciale: ' +
        'cena e DJ set. Prenota ora il tuo tavolo per la cena o un tavolo ' +
        'per l’after-cena — i posti sono limitati.',
      imageUrl: 'images/gallery5.jpg',
      imageSource: 'local',
      startDate: Timestamp.fromDate(new Date('2026-09-11T00:00:00+02:00')),
      endDate: Timestamp.fromDate(new Date('2026-10-04T23:59:59+02:00')),
      ctaType: 'booking',
      ctaBookingType: 'cena',
      ctaLabel: 'Prenota il tuo tavolo',
      version: 1,
      active: true,
    },
    { merge: true }
  );
  console.log('OK popups/popup-apertura-2026');

  console.log('Seed completato (idempotente: rieseguibile senza duplicati).');
}

main().catch((err) => {
  console.error('Seed FALLITO:', err);
  process.exit(1);
});
