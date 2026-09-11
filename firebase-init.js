// ========================================
// FONDERIA TREVISO - Firebase init (ES module)
// Lazy init memoized: l'SDK v10 viene caricato dal CDN gstatic
// solo alla prima chiamata. Su localhost i servizi si collegano
// automaticamente agli emulatori locali.
// ========================================

const CDN_BASE = 'https://www.gstatic.com/firebasejs/10.14.1';

const IS_LOCAL = ['localhost', '127.0.0.1'].includes(window.location.hostname);

const EMULATORS = {
    firestore: { host: 'localhost', port: 8080 },
    auth: { host: 'localhost', port: 9099 },
    storage: { host: 'localhost', port: 9199 }
};

let _appPromise = null;
let _dbPromise = null;
let _authPromise = null;
let _storagePromise = null;
let _functionsPromise = null;
let _fsMod = null;

// ----------------------------------------
// App (shared)
// ----------------------------------------
function getApp() {
    if (!_appPromise) {
        _appPromise = (async () => {
            if (!window.FB_CONFIG) throw new Error('[firebase] FB_CONFIG mancante: carica firebase-config.js prima dei moduli');
            const { initializeApp } = await import(`${CDN_BASE}/firebase-app.js`);
            return initializeApp(window.FB_CONFIG);
        })();
    }
    return _appPromise;
}

// ----------------------------------------
// Firestore
// ----------------------------------------
export async function getDb() {
    if (!_dbPromise) {
        _dbPromise = (async () => {
            const app = await getApp();
            _fsMod = await import(`${CDN_BASE}/firebase-firestore.js`);
            const db = _fsMod.getFirestore(app);
            if (IS_LOCAL) _fsMod.connectFirestoreEmulator(db, EMULATORS.firestore.host, EMULATORS.firestore.port);
            return db;
        })();
    }
    return _dbPromise;
}

// Modulo firestore gia' caricato (collection, addDoc, query, ...)
// Usato dai moduli che devono chiamare le API oltre a getDb().
export async function getFsMod() {
    await getDb();
    return _fsMod;
}

// ----------------------------------------
// Auth (usato dall'area admin)
// ----------------------------------------
export async function getAuth() {
    if (!_authPromise) {
        _authPromise = (async () => {
            const app = await getApp();
            const mod = await import(`${CDN_BASE}/firebase-auth.js`);
            const auth = mod.getAuth(app);
            if (IS_LOCAL) mod.connectAuthEmulator(auth, `http://${EMULATORS.auth.host}:${EMULATORS.auth.port}`);
            return auth;
        })();
    }
    return _authPromise;
}

// ----------------------------------------
// Storage (upload immagini da admin)
// ----------------------------------------
// Alias per admin.js (naming concordato cross-stream)
export { getAuth as getAuthInstance };

export async function getStorageInstance() {
    if (!_storagePromise) {
        _storagePromise = (async () => {
            const app = await getApp();
            const mod = await import(`${CDN_BASE}/firebase-storage.js`);
            const storage = mod.getStorage(app);
            if (IS_LOCAL) mod.connectStorageEmulator(storage, EMULATORS.storage.host, EMULATORS.storage.port);
            return storage;
        })();
    }
    return _storagePromise;
}

// ----------------------------------------
// Cloud Functions (callable admin: es. getGaStats)
// N.B. region esplicita: le function sono deployate in europe-west1,
// il default us-central1 fallirebbe con "not-found".
// ----------------------------------------
export async function getFunctionsInstance() {
    if (!_functionsPromise) {
        _functionsPromise = (async () => {
            const app = await getApp();
            const mod = await import(`${CDN_BASE}/firebase-functions.js`);
            const fns = mod.getFunctions(app, 'europe-west1');
            if (IS_LOCAL) mod.connectFunctionsEmulator(fns, 'localhost', 5001);
            return fns;
        })();
    }
    return _functionsPromise;
}
