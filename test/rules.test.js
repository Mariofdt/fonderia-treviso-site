'use strict';

/**
 * Fonderia Treviso — unit test delle Firestore security rules.
 *
 * Esecuzione:  cd test && npm install && npm test
 * (npm test lancia gli emulatori Firestore via `firebase emulators:exec`)
 */

const fs = require('fs');
const path = require('path');
const {
  initializeTestEnvironment,
  assertSucceeds,
  assertFails,
} = require('@firebase/rules-unit-testing');
const {
  doc,
  setDoc,
  getDoc,
  collection,
  getDocs,
  serverTimestamp,
} = require('firebase/firestore');

const PROJECT_ID = 'demo-fonderia';
const ADMIN_EMAIL = 'admin@fonderia.it';

const rules = fs.readFileSync(
  path.join(__dirname, '..', 'firestore.rules'),
  'utf8'
);

const validBooking = {
  name: 'Mario Rossi',
  date: '2026-10-03',
  time: '21:00',
  guests: 4,
  service: 'cena',
  tableType: 'standard',
  eventTitle: 'Apertura Stagione',
  phone: '+39 333 1234567',
  note: '',
  source: 'site',
  status: 'new',
  // createdAt aggiunto nei test con serverTimestamp() (→ request.time in emulator)
};

function validBookingPayload() {
  return { ...validBooking, createdAt: serverTimestamp() };
}

let testEnv;

before(async () => {
  testEnv = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: { rules },
  });
});

beforeEach(async () => {
  await testEnv.clearFirestore();
  // seed con rules disabilitate: whitelist admin + contenuti di test
  await testEnv.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore();
    await setDoc(doc(db, 'config', 'admin'), {
      allowedEmails: [ADMIN_EMAIL],
    });
    await setDoc(doc(db, 'events', 'active-event'), {
      title: 'Evento attivo',
      active: true,
    });
    await setDoc(doc(db, 'events', 'inactive-event'), {
      title: 'Evento inattivo',
      active: false,
    });
    await setDoc(doc(db, 'popups', 'active-popup'), {
      title: 'Popup attivo',
      active: true,
    });
  });
});

after(async () => {
  if (testEnv) await testEnv.cleanup();
});

describe('lettura pubblica contenuti', () => {
  it('anon PUO\' leggere un evento attivo', async () => {
    const db = testEnv.unauthenticatedContext().firestore();
    await assertSucceeds(getDoc(doc(db, 'events', 'active-event')));
  });

  it('anon NON puo\' leggere un evento inattivo', async () => {
    const db = testEnv.unauthenticatedContext().firestore();
    await assertFails(getDoc(doc(db, 'events', 'inactive-event')));
  });

  it('anon PUO\' leggere un popup attivo', async () => {
    const db = testEnv.unauthenticatedContext().firestore();
    await assertSucceeds(getDoc(doc(db, 'popups', 'active-popup')));
  });
});

describe('bookings (create-only anonimo)', () => {
  it('una prenotazione VALIDA e\' accettata', async () => {
    const db = testEnv.unauthenticatedContext().firestore();
    await assertSucceeds(
      setDoc(doc(db, 'bookings', 'b1'), validBookingPayload())
    );
  });

  it('una prenotazione con campo EXTRA (emailed) e\' rifiutata', async () => {
    const db = testEnv.unauthenticatedContext().firestore();
    await assertFails(
      setDoc(doc(db, 'bookings', 'b2'), {
        ...validBookingPayload(),
        emailed: true,
      })
    );
  });

  it('una prenotazione con status FORGED e\' rifiutata', async () => {
    const db = testEnv.unauthenticatedContext().firestore();
    await assertFails(
      setDoc(doc(db, 'bookings', 'b3'), {
        ...validBookingPayload(),
        status: 'confirmed',
      })
    );
  });

  it('campo email opzionale con formato valido e\' accettato', async () => {
    const db = testEnv.unauthenticatedContext().firestore();
    await assertSucceeds(
      setDoc(doc(db, 'bookings', 'b4'), {
        ...validBookingPayload(),
        email: 'cliente@example.com',
      })
    );
  });

  it('anon NON puo\' leggere la lista prenotazioni', async () => {
    const db = testEnv.unauthenticatedContext().firestore();
    await assertFails(getDocs(collection(db, 'bookings')));
  });

  it('admin (email in whitelist) PUO\' leggere le prenotazioni', async () => {
    const db = testEnv
      .authenticatedContext('admin-uid', { email: ADMIN_EMAIL })
      .firestore();
    await assertSucceeds(getDocs(collection(db, 'bookings')));
  });
});

describe('newsletter (append-only, consenso GDPR)', () => {
  it('iscrizione SENZA consenso e\' rifiutata', async () => {
    const db = testEnv.unauthenticatedContext().firestore();
    await assertFails(
      setDoc(doc(db, 'newsletter', 'user@example.com'), {
        email: 'user@example.com',
        consent: false,
        consentAt: serverTimestamp(),
      })
    );
  });

  it('iscrizione con telefono VALIDO e\' accettata', async () => {
    const db = testEnv.unauthenticatedContext().firestore();
    await assertSucceeds(
      setDoc(doc(db, 'newsletter', 'user@example.com'), {
        email: 'user@example.com',
        phone: '+39 333 1234567',
        consent: true,
        consentAt: serverTimestamp(),
      })
    );
  });
});

describe('scritture contenuti', () => {
  it('autenticato NON admin NON puo\' scrivere eventi', async () => {
    const db = testEnv
      .authenticatedContext('user-uid', { email: 'qualcuno@example.com' })
      .firestore();
    await assertFails(
      setDoc(doc(db, 'events', 'hack'), { title: 'x', active: true })
    );
  });

  it('admin PUO\' scrivere eventi', async () => {
    const db = testEnv
      .authenticatedContext('admin-uid', { email: ADMIN_EMAIL })
      .firestore();
    await assertSucceeds(
      setDoc(doc(db, 'events', 'nuovo'), { title: 'x', active: true })
    );
  });
});
