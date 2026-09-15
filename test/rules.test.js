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
const ADMIN_EMAIL = 'admin@fonderia.it'; // owner
const OWNER2_EMAIL = 'owner2@fonderia.it';
const EDITOR_EMAIL = 'editor@fonderia.it';
const SUSPENDED_EMAIL = 'sospeso@fonderia.it';

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
  // seed con rules disabilitate: registro adminUsers + contenuti di test
  await testEnv.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore();
    await setDoc(doc(db, 'adminUsers', ADMIN_EMAIL), {
      name: 'Admin Test', role: 'owner', status: 'active',
    });
    await setDoc(doc(db, 'adminUsers', OWNER2_EMAIL), {
      name: 'Owner Due', role: 'owner', status: 'active',
    });
    await setDoc(doc(db, 'adminUsers', EDITOR_EMAIL), {
      name: 'Editor Test', role: 'editor', status: 'active',
    });
    await setDoc(doc(db, 'adminUsers', SUSPENDED_EMAIL), {
      name: 'Sospeso Test', role: 'editor', status: 'suspended',
    });
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

  it('admin PUO\' leggere members (Task 11: join claim + referral sospetti)', async () => {
    const db = testEnv.authenticatedContext('admin-uid', { email: ADMIN_EMAIL }).firestore();
    await assertSucceeds(getDoc(doc(db, 'members', 'm1')));
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

  it('config/admin resta leggibile da utente loggato (retro-compat admin.js)', async () => {
    const db = testEnv.authenticatedContext('random-uid', { email: 'estraneo@example.com' }).firestore();
    await assertSucceeds(getDoc(doc(db, 'config', 'admin')));
  });

  it('utente SOSPESO non e\' admin: NON puo\' leggere bookings', async () => {
    const db = testEnv.authenticatedContext('susp-uid', { email: SUSPENDED_EMAIL }).firestore();
    await assertFails(getDocs(collection(db, 'bookings')));
  });

  it('editor ATTIVO e\' admin: PUO\' leggere bookings e scrivere eventi', async () => {
    const db = testEnv.authenticatedContext('ed-uid', { email: EDITOR_EMAIL }).firestore();
    await assertSucceeds(getDocs(collection(db, 'bookings')));
    await assertSucceeds(setDoc(doc(db, 'events', 'ed-event'), { title: 'x', active: true }));
  });
});

describe('adminUsers — gestione utenti admin', () => {
  it('anon NON puo\' leggere adminUsers', async () => {
    const db = testEnv.unauthenticatedContext().firestore();
    await assertFails(getDoc(doc(db, 'adminUsers', ADMIN_EMAIL)));
  });

  it('editor attivo PUO\' leggere adminUsers (isAdmin)', async () => {
    const db = testEnv.authenticatedContext('ed-uid', { email: EDITOR_EMAIL }).firestore();
    await assertSucceeds(getDocs(collection(db, 'adminUsers')));
  });

  it('editor NON puo\' creare adminUsers (serve owner)', async () => {
    const db = testEnv.authenticatedContext('ed-uid', { email: EDITOR_EMAIL }).firestore();
    await assertFails(setDoc(doc(db, 'adminUsers', 'nuovo@fonderia.it'), {
      name: 'Nuovo', role: 'editor', status: 'active',
    }));
  });

  it('owner PUO\' creare un editor', async () => {
    const db = testEnv.authenticatedContext('admin-uid', { email: ADMIN_EMAIL }).firestore();
    await assertSucceeds(setDoc(doc(db, 'adminUsers', 'nuovo@fonderia.it'), {
      name: 'Nuovo', role: 'editor', status: 'active',
    }));
  });

  it('owner NON puo\' creare un doc con role owner (owners solo via Admin SDK)', async () => {
    const db = testEnv.authenticatedContext('admin-uid', { email: ADMIN_EMAIL }).firestore();
    await assertFails(setDoc(doc(db, 'adminUsers', 'fake-owner@fonderia.it'), {
      name: 'Fake', role: 'owner', status: 'active',
    }));
  });

  it('owner PUO\' sospendere un editor (update status)', async () => {
    const db = testEnv.authenticatedContext('admin-uid', { email: ADMIN_EMAIL }).firestore();
    await assertSucceeds(setDoc(doc(db, 'adminUsers', EDITOR_EMAIL), {
      name: 'Editor Test', role: 'editor', status: 'suspended',
    }));
  });

  it('owner immutabile: NON modificabile nemmeno da un altro owner', async () => {
    const db = testEnv.authenticatedContext('admin-uid', { email: ADMIN_EMAIL }).firestore();
    await assertFails(setDoc(doc(db, 'adminUsers', OWNER2_EMAIL), {
      name: 'Owner Due', role: 'owner', status: 'suspended',
    }));
  });

  it('owner immutabile: NON eliminabile nemmeno da un owner (se stesso)', async () => {
    const { deleteDoc } = require('firebase/firestore');
    const db = testEnv.authenticatedContext('admin-uid', { email: ADMIN_EMAIL }).firestore();
    await assertFails(deleteDoc(doc(db, 'adminUsers', ADMIN_EMAIL)));
  });

  it('owner PUO\' eliminare un editor', async () => {
    const { deleteDoc } = require('firebase/firestore');
    const db = testEnv.authenticatedContext('admin-uid', { email: ADMIN_EMAIL }).firestore();
    await assertSucceeds(deleteDoc(doc(db, 'adminUsers', EDITOR_EMAIL)));
  });
});

describe('social — campaigns e socialPosts (solo admin)', () => {
  it('anon NON puo\' leggere campaigns', async () => {
    const db = testEnv.unauthenticatedContext().firestore();
    await assertFails(getDocs(collection(db, 'campaigns')));
  });

  it('anon NON puo\' scrivere socialPosts', async () => {
    const db = testEnv.unauthenticatedContext().firestore();
    await assertFails(setDoc(doc(db, 'socialPosts', 'p1'), { title: 'x', status: 'draft' }));
  });

  it('utente loggato NON admin NON puo\' leggere campaigns', async () => {
    const db = testEnv.authenticatedContext('rnd-uid', { email: 'estraneo@example.com' }).firestore();
    await assertFails(getDocs(collection(db, 'campaigns')));
  });

  it('editor attivo PUO\' creare e leggere campaigns e socialPosts', async () => {
    const db = testEnv.authenticatedContext('ed-uid', { email: EDITOR_EMAIL }).firestore();
    await assertSucceeds(setDoc(doc(db, 'campaigns', 'c1'), {
      name: 'Apertura', status: 'active', createdBy: EDITOR_EMAIL,
    }));
    await assertSucceeds(setDoc(doc(db, 'socialPosts', 'p1'), {
      campaignId: 'c1', title: 'Post apertura', status: 'draft', createdBy: EDITOR_EMAIL,
    }));
    await assertSucceeds(getDocs(collection(db, 'campaigns')));
    await assertSucceeds(getDocs(collection(db, 'socialPosts')));
  });

  it('utente SOSPESO NON puo\' scrivere socialPosts', async () => {
    const db = testEnv.authenticatedContext('susp-uid', { email: SUSPENDED_EMAIL }).firestore();
    await assertFails(setDoc(doc(db, 'socialPosts', 'p2'), { title: 'x', status: 'draft' }));
  });
});
