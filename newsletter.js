// ========================================
// FONDERIA TREVISO - Newsletter (footer)
// Iscrizione su Firestore `newsletter/{email}` con dedup via docId.
// Consenso GDPR obbligatorio (checkbox required in markup).
// ========================================

import { getDb, getFsMod } from './firebase-init.js';

document.addEventListener('DOMContentLoaded', () => {
    initNewsletter();
});

function initNewsletter() {
    const form = document.getElementById('nlForm');
    if (!form) return;

    const emailInput = document.getElementById('nlEmail');
    const phoneInput = document.getElementById('nlPhone');
    const consentInput = document.getElementById('nlConsent');
    const msg = document.getElementById('nlMsg');

    form.addEventListener('submit', async (e) => {
        e.preventDefault();

        const email = emailInput.value.trim().toLowerCase();
        const phone = phoneInput ? phoneInput.value.trim() : '';

        if (!email || !consentInput.checked) return;

        setMsg('', '');
        const submitBtn = form.querySelector('button[type="submit"]');
        if (submitBtn) submitBtn.disabled = true;

        try {
            const db = await getDb();
            const fs = await getFsMod();
            await fs.setDoc(fs.doc(db, 'newsletter', email), {
                email,
                ...(phone ? { phone } : {}),
                consent: true,
                consentAt: fs.serverTimestamp()
            });
            form.reset();
            setMsg('Iscrizione confermata. Benvenuto nella famiglia Fonderia!', 'ok');
        } catch (err) {
            // Le rules sono append-only: docId esistente = permission-denied
            if (err && err.code === 'permission-denied') {
                setMsg('Questa email risulta già iscritta.', 'warn');
            } else {
                console.warn('[newsletter] iscrizione fallita:', err);
                setMsg('Errore di connessione. Riprova tra poco.', 'err');
            }
        } finally {
            if (submitBtn) submitBtn.disabled = false;
        }
    });

    function setMsg(text, type) {
        if (!msg) return;
        msg.textContent = text;
        msg.className = 'nl-msg' + (type ? ` nl-msg-${type}` : '');
    }
}
