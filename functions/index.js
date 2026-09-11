'use strict';

/**
 * Fonderia Treviso — automazione email su nuova prenotazione.
 *
 * Trigger: creazione doc in bookings/{bookingId} (write anonimo dal sito).
 * Azione: email al locale + conferma al cliente (se ha lasciato l'email),
 *         poi marca il doc con emailed/emailedAt via Admin SDK.
 *
 * Config (tutta in Secret Manager, NIENTE in git e niente .env):
 *   - BREVO_SMTP_KEY    → secret — password SMTP Brevo (xsmtpsib-...)
 *   - BREVO_SMTP_USER   → secret — login SMTP Brevo (es. xxxx001@smtp-brevo.com)
 *   - VENUE_EMAIL       → secret — email del locale che riceve le prenotazioni
 *   - FROM_EMAIL        → secret — mittente visibile (deve essere sender verificato su Brevo)
 */

const { onDocumentCreated } = require('firebase-functions/v2/firestore');
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const { logger } = require('firebase-functions');
const admin = require('firebase-admin');
const nodemailer = require('nodemailer');
const { BetaAnalyticsDataClient } = require('@google-analytics/data');
const { GoogleAuth } = require('google-auth-library');

admin.initializeApp();

const brevoSmtpKey = defineSecret('BREVO_SMTP_KEY');
const brevoSmtpUser = defineSecret('BREVO_SMTP_USER');
const venueEmailParam = defineSecret('VENUE_EMAIL');
const fromEmailParam = defineSecret('FROM_EMAIL');

const SERVICE_LABELS = {
  cena: 'Cena',
  'after-cena': 'After-Cena',
  evento: 'Evento',
};

function esc(value) {
  return String(value === undefined || value === null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function row(label, value) {
  return '<tr>'
    + '<th style="text-align:left;padding:6px 12px 6px 0;color:#666;font-weight:600;vertical-align:top">'
    + esc(label) + '</th>'
    + '<td style="padding:6px 0">' + esc(value || '—') + '</td>'
    + '</tr>';
}

function bookingTableHtml(b) {
  return '<table style="border-collapse:collapse;font-family:Arial,Helvetica,sans-serif;font-size:14px">'
    + row('Nome', b.name)
    + row('Data', b.date)
    + row('Ora', b.time)
    + row('Ospiti', b.guests)
    + row('Servizio', SERVICE_LABELS[b.service] || b.service)
    + row('Tipo tavolo', b.tableType)
    + row('Evento', b.eventTitle)
    + row('Telefono', b.phone)
    + row('Email', b.email)
    + row('Origine', b.source)
    + row('Note', b.note)
    + '</table>';
}

exports.onBookingCreated = onDocumentCreated(
  {
    document: 'bookings/{bookingId}',
    region: 'europe-west1',
    maxInstances: 2,
    retry: true,
    secrets: [brevoSmtpKey, brevoSmtpUser, venueEmailParam, fromEmailParam],
  },
  async (event) => {
    const snap = event.data;
    if (!snap) {
      logger.error('onBookingCreated: evento senza data snapshot', {
        params: event.params,
      });
      return;
    }

    const booking = snap.data();
    const bookingId = event.params.bookingId;
    logger.info('Nuova prenotazione ricevuta', {
      bookingId,
      service: booking.service,
      date: booking.date,
      guests: booking.guests,
      source: booking.source,
    });

    const smtpUser = brevoSmtpUser.value() || process.env.BREVO_SMTP_USER;
    const smtpPass = brevoSmtpKey.value();
    const venueEmail = venueEmailParam.value() || process.env.VENUE_EMAIL;
    const fromEmail =
      fromEmailParam.value() || process.env.FROM_EMAIL || smtpUser;

    // Config mancante → log e skip pulito: la prenotazione resta in Firestore
    // e in admin; niente crash, niente retry loop infinito su un problema di setup.
    if (!smtpUser || !smtpPass || !venueEmail) {
      logger.error(
        'Config SMTP mancante, email NON inviata (prenotazione salvata comunque)',
        {
          bookingId,
          hasUser: !!smtpUser,
          hasPass: !!smtpPass,
          hasVenueEmail: !!venueEmail,
        }
      );
      return;
    }

    const transporter = nodemailer.createTransport({
      host: 'smtp-relay.brevo.com',
      port: 587,
      secure: false,
      requireTLS: true,
      auth: { user: smtpUser, pass: smtpPass },
    });

    const subjectBase =
      (SERVICE_LABELS[booking.service] || booking.service) +
      ' · ' + booking.date + ' ' + booking.time +
      ' · ' + booking.guests + ' ospiti';

    // 1) Email al locale (critica: se fallisce, rilanciamo per il retry)
    try {
      await transporter.sendMail({
        from: '"Sito Fonderia" <' + fromEmail + '>',
        to: venueEmail,
        replyTo: booking.email || booking.phone || undefined,
        subject: 'Nuova prenotazione — ' + subjectBase,
        html:
          '<h3 style="font-family:Arial,Helvetica,sans-serif">Nuova prenotazione dal sito</h3>'
          + bookingTableHtml(booking)
          + '<p style="color:#999;font-size:12px">ID: ' + esc(bookingId) + '</p>',
      });
      logger.info('Email al locale inviata', { bookingId });
    } catch (err) {
      logger.error('Invio email al locale FALLITO', {
        bookingId,
        error: err && err.message ? err.message : String(err),
      });
      throw err; // retry:true → riparte; la mail al cliente non e' ancora partita
    }

    // 2) Conferma al cliente (best-effort: un fallimento qui NON ritenta il trigger,
    //    altrimenti la mail al locale verrebbe rinviata a ogni retry)
    let clientSent = false;
    if (booking.email) {
      try {
        await transporter.sendMail({
          from: '"Fonderia Treviso" <' + fromEmail + '>',
          to: booking.email,
          subject: 'Richiesta di prenotazione ricevuta — Fonderia Treviso',
          html:
            '<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px">'
            + '<p>Ciao ' + esc(booking.name) + ',</p>'
            + '<p>abbiamo ricevuto la tua richiesta di prenotazione. '
            + 'Ti confermeremo la disponibilit&agrave; al pi&ugrave; presto.</p>'
            + bookingTableHtml(booking)
            + '<p style="color:#999;font-size:12px">Fonderia Treviso — '
            + 'per modifiche rispondi a questa email o chiama il locale.</p>'
            + '</div>',
        });
        clientSent = true;
        logger.info('Email di conferma al cliente inviata', { bookingId });
      } catch (err) {
        logger.error('Invio conferma al cliente FALLITO (mail al locale gia\' inviata)', {
          bookingId,
          error: err && err.message ? err.message : String(err),
        });
      }
    }

    // 3) Marca il doc: emailed:true + emailedAt (Admin SDK bypassa le rules)
    try {
      await snap.ref.update({
        emailed: true,
        emailedAt: admin.firestore.FieldValue.serverTimestamp(),
        clientEmailSent: clientSent,
      });
    } catch (err) {
      logger.error('Update emailed FALLITO', {
        bookingId,
        error: err && err.message ? err.message : String(err),
      });
      throw err; // meglio un retry con doppia email che uno stato non marcato
    }
  }
);

/* ------------------------------------------------------------------ *
 * getGaStats — statistiche GA4 per la scheda "Statistiche" dell'admin.
 *
 * Callable: richiede utente loggato la cui email sia nella whitelist
 * config/admin.allowedEmails (riletta a ogni chiamata, niente cache).
 *
 * Le credenziali NON sono nel codice: la function gira con il service
 * account ga-stats@fonderia-treviso.iam.gserviceaccount.com (ADC) che
 * deve essere aggiunto come LETTORE sulla proprietà GA4 4135131259
 * (GA → Amministrazione → Gestione accessi proprietà).
 * ------------------------------------------------------------------ */

const GA_PROPERTY = 'properties/4135131259';
const GA_SA = 'ga-stats@fonderia-treviso.iam.gserviceaccount.com';

async function assertAdmin(req) {
  const email = req.auth && req.auth.token && req.auth.token.email;
  if (!email) {
    throw new HttpsError('unauthenticated', 'Accesso richiesto.');
  }
  const cfg = await admin.firestore().doc('config/admin').get();
  const allowed = (cfg.exists && cfg.data().allowedEmails) || [];
  if (!allowed.includes(email)) {
    throw new HttpsError('permission-denied', 'Email non autorizzata.');
  }
}

exports.getGaStats = onCall(
  { region: 'europe-west1', maxInstances: 2, serviceAccount: GA_SA },
  async (req) => {
    await assertAdmin(req);

    const client = new BetaAnalyticsDataClient();
    const run = async (report) => {
      try {
        const [res] = await client.runReport({ property: GA_PROPERTY, ...report });
        return res;
      } catch (err) {
        // code 7 = PERMISSION_DENIED: quasi sempre il SA non e' ancora
        // lettore sulla proprieta' GA4 → messaggio azionabile per l'admin
        if (err && err.code === 7) {
          throw new HttpsError(
            'failed-precondition',
            'GA4 non ancora autorizzato: aggiungi ' + GA_SA +
              ' come Lettore nella proprieta  GA (Amministrazione → Gestione accessi proprietà).'
          );
        }
        logger.error('GA runReport fallito', { message: String(err && err.message || err) });
        throw new HttpsError('internal', 'Errore nel recupero delle statistiche.');
      }
    };

    const kpi = async (startDate) => {
      const res = await run({
        dateRanges: [{ startDate, endDate: 'today' }],
        metrics: [
          { name: 'sessions' },
          { name: 'totalUsers' },
          { name: 'screenPageViews' },
        ],
      });
      const row = res.rows && res.rows[0];
      const nums = row ? row.metricValues.map((m) => Number(m.value || 0)) : [0, 0, 0];
      return { sessions: nums[0], users: nums[1], pageviews: nums[2] };
    };

    const table = async (dimension, metric, limit) => {
      const res = await run({
        dateRanges: [{ startDate: '30daysAgo', endDate: 'today' }],
        dimensions: [{ name: dimension }],
        metrics: [{ name: metric }],
        orderBys: [{ metric: { metricName: metric }, desc: true }],
        limit,
      });
      return (res.rows || []).map((r) => ({
        label: r.dimensionValues[0].value,
        value: Number(r.metricValues[0].value || 0),
      }));
    };

    const trend = async () => {
      const res = await run({
        dateRanges: [{ startDate: '30daysAgo', endDate: 'today' }],
        dimensions: [{ name: 'date' }],
        metrics: [{ name: 'sessions' }],
        orderBys: [{ dimension: { dimensionName: 'date' } }],
      });
      return (res.rows || []).map((r) => ({
        date: r.dimensionValues[0].value, // YYYYMMDD
        sessions: Number(r.metricValues[0].value || 0),
      }));
    };

    const [last7, last30, topPages, topSources, daily] = await Promise.all([
      kpi('7daysAgo'),
      kpi('30daysAgo'),
      table('pagePath', 'screenPageViews', 8),
      table('sessionDefaultChannelGroup', 'sessions', 8),
      trend(),
    ]);

    return { last7, last30, topPages, topSources, daily, generatedAt: new Date().toISOString() };
  }
);

/* ------------------------------------------------------------------ *
 * suggestEventCopy — bozze di tagline/descrizione evento via Gemini.
 *
 * Callable: stessa protezione di getGaStats (assertAdmin + whitelist).
 * Modello: Gemini 2.5 Flash-Lite su Vertex AI del progetto (location
 * global, contratto verificato 2026-09-11 con chiamata reale).
 * Auth: ADC della Compute default SA (roles/aiplatform.user) — nessuna
 * chiave in codice, niente segreti nuovi. La function gira sul SA
 * Compute default (nessun serviceAccount esplicito impostato).
 * ------------------------------------------------------------------ */

const VERTEX_GEMINI_URL =
  'https://aiplatform.googleapis.com/v1/projects/fonderia-treviso' +
  '/locations/global/publishers/google/models/gemini-2.5-flash-lite:generateContent';

exports.suggestEventCopy = onCall(
  { region: 'europe-west1', maxInstances: 2 },
  async (req) => {
    await assertAdmin(req);

    const title = String((req.data && req.data.title) || '').trim().slice(0, 200);
    const date = String((req.data && req.data.date) || '').trim().slice(0, 20);
    const time = String((req.data && req.data.time) || '').trim().slice(0, 40);
    if (!title) {
      throw new HttpsError('invalid-argument', 'Serve almeno il titolo dell’evento.');
    }

    const prompt =
      'Sei il copywriter di Fonderia Treviso: birreria e cocktail bar con cucina,\n' +
      'musica live e DJ set, in Via Fonderia 113 a Treviso. Tono caldo, energico e\n' +
      'concreto, frasi brevi, niente frasi pubblicitarie stucchevoli. Lingua: italiano.\n\n' +
      'Evento da descrivere:\n' +
      '- Titolo: ' + title + '\n' +
      (date ? '- Data: ' + date + '\n' : '') +
      (time ? '- Ora: ' + time + '\n' : '') +
      '\nRispondi ESATTAMENTE in questo formato, senza altro testo:\n' +
      'TAGLINE: <una frase breve, max 90 caratteri, sottotitolo che incuriosisce>\n' +
      'DESCRIZIONE: <3 frasi, max 400 caratteri: cosa succede, atmosfera, invito a prenotare>';

    try {
      const auth = new GoogleAuth({ scopes: 'https://www.googleapis.com/auth/cloud-platform' });
      const client = await auth.getClient();
      const { token } = await client.getAccessToken();

      const resp = await fetch(VERTEX_GEMINI_URL, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + token,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.9, maxOutputTokens: 500 },
        }),
      });

      if (!resp.ok) {
        const body = await resp.text().catch(() => '');
        logger.error('Vertex generateContent non-OK', { status: resp.status, body: body.slice(0, 500) });
        throw new HttpsError('internal', 'Il modello non ha risposto (HTTP ' + resp.status + '). Riprova tra poco.');
      }

      const json = await resp.json();
      const text = (((json.candidates || [])[0] || {}).content || {}).parts
        ? json.candidates[0].content.parts.map((p) => p.text || '').join('')
        : '';

      const taglineMatch = text.match(/TAGLINE:\s*(.+)/);
      const descMatch = text.match(/DESCRIZIONE:\s*([\s\S]+)/);
      const tagline = taglineMatch ? taglineMatch[1].trim().replace(/^"|"$/g, '').slice(0, 140) : '';
      const description = descMatch
        ? descMatch[1].trim().slice(0, 600)
        : text.trim().slice(0, 600); // fallback: formato inatteso → tutto il testo come descrizione

      if (!description) {
        throw new HttpsError('internal', 'Il modello ha risposto vuoto. Riprova.');
      }

      logger.info('suggestEventCopy OK', { email: req.auth.token.email, title });
      return { tagline, description };
    } catch (err) {
      if (err instanceof HttpsError) throw err;
      logger.error('suggestEventCopy FALLITO', { error: String(err && err.message || err) });
      throw new HttpsError('internal', 'Generazione non riuscita. Riprova tra poco.');
    }
  }
);

/* ------------------------------------------------------------------ *
 * onNewsletterCreated — email di benvenuto al nuovo iscritto.
 *
 * Trigger: creazione doc in newsletter/{email} (write anonimo dal sito).
 * Contenuto: logo, messaggio di benvenuto, prossimi eventi attivi
 * (letti da Firestore), riepilogo servizi, CTA WhatsApp.
 * Gli iscritti sono già visibili in admin (tab Newsletter).
 * ------------------------------------------------------------------ */

const SITE_URL = 'https://fonderia-treviso.web.app';
const WA_URL = 'https://wa.me/393204137183';
const LOGO_URL = SITE_URL + '/images/logo-email.png';

function fmtEventDate(ts) {
  try {
    const d = ts && ts.toDate ? ts.toDate() : null;
    if (!d) return '';
    return new Intl.DateTimeFormat('it-IT', {
      weekday: 'short', day: 'numeric', month: 'long',
    }).format(d);
  } catch (e) {
    return '';
  }
}

function escapeHtml(s) {
  return String(s === undefined || s === null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

exports.onNewsletterCreated = onDocumentCreated(
  {
    document: 'newsletter/{subscriberId}',
    region: 'europe-west1',
    maxInstances: 2,
    retry: true,
    secrets: [brevoSmtpKey, brevoSmtpUser, venueEmailParam, fromEmailParam],
  },
  async (event) => {
    const snap = event.data;
    if (!snap) {
      logger.error('onNewsletterCreated: evento senza data snapshot');
      return;
    }
    const sub = snap.data();
    const toEmail = String(sub.email || event.params.subscriberId || '').toLowerCase();
    if (!toEmail) {
      logger.error('onNewsletterCreated: doc senza email', { id: event.params.subscriberId });
      return;
    }

    const smtpUser = brevoSmtpUser.value() || process.env.BREVO_SMTP_USER;
    const smtpPass = brevoSmtpKey.value();
    const fromEmail = fromEmailParam.value() || process.env.FROM_EMAIL || smtpUser;
    if (!smtpUser || !smtpPass) {
      logger.error('Config SMTP mancante, email di benvenuto NON inviata', { toEmail });
      return;
    }

    // Prossimi eventi attivi (best-effort: se la lettura fallisce l'email
    // parte comunque senza il blocco eventi)
    let eventsHtml = '';
    try {
      const evSnap = await admin.firestore().collection('events')
        .where('active', '==', true).orderBy('date', 'asc').limit(5).get();
      if (!evSnap.empty) {
        const rows = evSnap.docs.map((d) => {
          const ev = d.data();
          const when = [fmtEventDate(ev.date), ev.time].filter(Boolean).join(' · ');
          return '<tr><td style="padding:10px 0;border-bottom:1px solid #26211c">'
            + '<div style="font-weight:700;color:#ffffff;font-size:15px">' + escapeHtml(ev.title || '') + '</div>'
            + (ev.tagline ? '<div style="color:#a8a098;font-size:13px;margin-top:2px">' + escapeHtml(ev.tagline) + '</div>' : '')
            + (when ? '<div style="color:#e78c37;font-size:13px;margin-top:4px">' + escapeHtml(when) + '</div>' : '')
            + '</td></tr>';
        }).join('');
        eventsHtml =
          '<h2 style="font-size:18px;color:#ffffff;margin:32px 0 8px">Prossimi eventi</h2>'
          + '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse">' + rows + '</table>';
      }
    } catch (err) {
      logger.error('Lettura eventi per welcome email FALLITA (email parte senza blocco eventi)', {
        error: String(err && err.message || err),
      });
    }

    const html =
      '<div style="background:#060606;padding:32px 16px;font-family:Arial,Helvetica,sans-serif">'
      + '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;margin:0 auto;background:#141210;border-radius:16px;overflow:hidden;border:1px solid #26211c">'
      + '<tr><td style="padding:32px 32px 8px;text-align:center">'
      + '<img src="' + LOGO_URL + '" alt="Fonderia Treviso" width="260" style="max-width:80%;height:auto">'
      + '</td></tr>'
      + '<tr><td style="padding:16px 32px 32px">'
      + '<h1 style="font-size:24px;color:#ffffff;margin:16px 0 8px;text-align:center">Benvenuto alla Fonderia! 🍻</h1>'
      + '<p style="color:#cfc9c0;font-size:15px;line-height:1.6;text-align:center;margin:0 0 8px">'
      + 'Grazie per esserti iscritto alla nostra newsletter: sarai il primo a sapere '
      + 'di serate live, DJ set, menu speciali e serate a tema.'
      + '</p>'
      + eventsHtml
      + '<h2 style="font-size:18px;color:#ffffff;margin:32px 0 8px">Cosa trovi da noi</h2>'
      + '<ul style="color:#cfc9c0;font-size:14px;line-height:1.8;margin:0;padding-left:18px">'
      + '<li>Cena con menu del territorio e pizza</li>'
      + '<li>After-cena: cocktail e birre artigianali</li>'
      + '<li>Venerd&igrave; live e sabato DJ set</li>'
      + '<li>Sale private per feste, compleanni e cene aziendali</li>'
      + '</ul>'
      + '<div style="text-align:center;margin:28px 0 8px">'
      + '<a href="' + WA_URL + '" style="display:inline-block;background:#c45d26;color:#ffffff;text-decoration:none;font-weight:700;font-size:15px;padding:14px 32px;border-radius:999px">Prenota su WhatsApp</a>'
      + '</div>'
      + '<p style="text-align:center;margin:16px 0 0"><a href="' + SITE_URL + '" style="color:#e78c37;font-size:13px">fonderia-treviso.web.app</a></p>'
      + '</td></tr>'
      + '<tr><td style="padding:20px 32px 28px;border-top:1px solid #26211c">'
      + '<p style="color:#8a8278;font-size:12px;line-height:1.6;margin:0;text-align:center">'
      + 'Fonderia Treviso · Via Fonderia 113, 31100 Treviso (TV)<br>'
      + 'Ricevi questa email perch&eacute; ti sei iscritto alla newsletter su fonderia-treviso.web.app. '
      + 'Per cancellarti rispondi a questa email con oggetto &quot;Cancellami&quot;.'
      + '</p>'
      + '</td></tr></table></div>';

    const transporter = nodemailer.createTransport({
      host: 'smtp-relay.brevo.com',
      port: 587,
      secure: false,
      requireTLS: true,
      auth: { user: smtpUser, pass: smtpPass },
    });

    try {
      await transporter.sendMail({
        from: '"Fonderia Treviso" <' + fromEmail + '>',
        to: toEmail,
        subject: 'Benvenuto alla Fonderia! 🍻',
        html,
      });
      logger.info('Email di benvenuto newsletter inviata', { toEmail });
    } catch (err) {
      logger.error('Invio email di benvenuto FALLITO', {
        toEmail,
        error: String(err && err.message || err),
      });
      throw err; // retry:true
    }

    try {
      await snap.ref.update({
        welcomed: true,
        welcomedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    } catch (err) {
      logger.error('Update welcomed FALLITO', {
        toEmail,
        error: String(err && err.message || err),
      });
      throw err;
    }
  }
);

/* ------------------------------------------------------------------ *
 * GAMIFICATION — tessere, claim, QR premio, referral, badge.
 * Spec: docs/superpowers/specs/2026-09-11-gamification-design.md
 * ------------------------------------------------------------------ */

const crypto = require('crypto');
// FieldValue/FieldPath via subpath: in emulatore il runtime di firebase-tools
// stubba il modulo 'firebase-admin' e admin.firestore.FieldValue/FieldPath
// risultano undefined (admin.firestore() funziona comunque). Il subpath non
// viene intercettato.
const { FieldValue, FieldPath } = require('firebase-admin/firestore');

const TESSERA_BASE = SITE_URL + '/tessera.html?t=';
// Bucket custom del progetto (vedi firebase-config.js): senza nome esplicito
// admin.storage().bucket() risolve <project>.appspot.com, che NON è dove il
// client carica le prove — mismatch silenzioso (404) sia in emulatore che in prod.
const STORAGE_BUCKET = 'fonderia-treviso-storage-733715891717';
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
      badges: FieldValue.arrayUnion(...earned),
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
      refSuspicious, // refCode inesistente o auto-invito → true; il trigger (Task 6) lo consulta
      createdAt: FieldValue.serverTimestamp(),
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
        ? db.collection('badges').where(FieldPath.documentId(), 'in', data.badges.slice(0, 30)).get()
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

/* ------------------------------------------------------------------ *
 * submitClaim — caricamento screenshot a prova di azione promo.
 *
 * Callable: { token, promoId, imagePath } → { status, reason, tesseraUrl }.
 * Invarianti:
 *   - 1 claim per <promoId>_<memberId>: issued/pending_review bloccano,
 *     rejected (o assente) → nuovo tentativo fino a 5 upload per promo;
 *   - rate limit 10 claim/ora per membro (finestra YYYY-MM-DDTHH);
 *   - promo referral/scaduta/inattiva → errore, niente claim;
 *   - imagePath deve stare sotto claims-inbox/<memberId>/ (no traversal).
 * La prova è validata da Gemini 2.5 Flash-Lite vision (Vertex, stesso
 * pattern AUTH/fetch di suggestEventCopy sopra). IA indisponibile o
 * risposta non interpretabile → verdict null → pending_review con
 * approvazione manuale staff: MAI inventare un verdetto.
 * ------------------------------------------------------------------ */

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

    // Rate limit orario SUBITO dopo l'autenticazione: OGNI invocazione conta
    // (anche guards/promo/mime che falliscono), altrimenti loop su oggetti
    // non-immagine nel proprio claims-inbox sarebbero gratuiti e illimitati.
    const m = member.data;
    const hourKey = new Date().toISOString().slice(0, 13); // YYYY-MM-DDTHH
    const rate = m.claimsRate || {};
    if (rate.hour === hourKey && rate.count >= MAX_CLAIMS_PER_HOUR) {
      throw new HttpsError('resource-exhausted', 'Troppe richieste: riprova tra un\'ora.');
    }
    await member.ref.update({
      claimsRate: { hour: hourKey, count: rate.hour === hourKey ? (rate.count || 0) + 1 : 1 },
    });

    const promoId = String((req.data && req.data.promoId) || '').trim();
    const imagePath = String((req.data && req.data.imagePath) || '').trim();
    const db = admin.firestore();

    if (!promoId) throw new HttpsError('invalid-argument', 'Promozione mancante.');
    // '.' romperebbe il field-path uploadAttempts.<promoId> e il docId del claim
    if (promoId.includes('.')) {
      throw new HttpsError('invalid-argument', 'Identificativo promozione non valido.');
    }
    if (!imagePath.startsWith('claims-inbox/' + member.id + '/') || imagePath.includes('..')) {
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

    // Retry limit (tentativi immagine reali; il rate orario è già contato sopra)
    const attempts = (m.uploadAttempts || {})[promoId] || 0;
    if (attempts >= MAX_UPLOAD_ATTEMPTS) {
      throw new HttpsError('resource-exhausted',
        'Hai esaurito i tentativi per questa promozione: passa al banco.');
    }

    // Checklist vuota/mancante → fail-closed: niente validazione IA senza
    // vincoli (un modello senza checklist potrebbe approvare qualsiasi
    // immagine) → direttamente in revisione manuale staff.
    const checklist = String(promo.aiChecklist || '').trim();
    let verdict = null;
    let aiFallbackNote = 'Validazione automatica non disponibile';
    if (!checklist) {
      aiFallbackNote = 'Checklist IA mancante: revisione manuale';
    } else {
      // Scarica l'immagine da Storage e valida con Gemini vision
      try {
        // Bucket esplicito (STORAGE_BUCKET): il default `<project>.appspot.com`
        // non esiste in questo progetto — ogni download darebbe 404 (R1 Task 11).
        const bucket = admin.storage().bucket(STORAGE_BUCKET);
        const file = bucket.file(imagePath);
        const [meta] = await file.getMetadata();
        const mime = String(meta.contentType || 'image/jpeg');
        if (!mime.startsWith('image/')) {
          throw new HttpsError('invalid-argument', 'Il file caricato non è un\'immagine.');
        }
        const [buf] = await file.download();
        verdict = await geminiValidateImage(buf.toString('base64'), mime, checklist);
      } catch (err) {
        if (err instanceof HttpsError) throw err;
        logger.error('submitClaim: validazione impossibile', { error: String(err && err.message || err) });
        verdict = null;
      }
    }

    // Conta il tentativo immagine (sempre, prima dell'esito)
    await member.ref.update({
      ['uploadAttempts.' + promoId]: FieldValue.increment(1),
    });

    if (verdict === null) {
      // IA indisponibile / immagine illeggibile / checklist mancante → staff
      await claimRef.set({
        memberId: member.id, promoId,
        code: randomToken(), status: 'pending_review',
        screenshotPath: imagePath, aiModel: 'gemini-2.5-flash-lite',
        aiNote: aiFallbackNote,
        createdAt: FieldValue.serverTimestamp(),
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
      createdAt: FieldValue.serverTimestamp(),
      redeemedAt: null, redeemedVia: null, redeemedBy: null,
    });
    await member.ref.update({
      ['actionsCount.' + promo.actionType]: FieldValue.increment(1),
    });
    const updated = (await member.ref.get()).data();
    await evaluateBadges(member.ref, updated);
    logger.info('submitClaim issued', { memberId: member.id, promoId });
    return { status: 'issued', reason: 'Verifica superata! Mostra il QR al banco per il tuo premio.', tesseraUrl: TESSERA_BASE + String(req.data.token) };
  }
);

// Trigger referral: conteggio sul referente + claim automatico a soglia.
// Idempotenza anti-retry (retry:true): il doc del nuovo membro viene marcato
// referralCounted PRIMA di qualsiasi incremento; un riesame dello stesso
// evento trova il flag ed esce senza doppio conteggio.
exports.onMemberCreated = onDocumentCreated(
  { document: 'members/{memberId}', region: 'europe-west1', maxInstances: 2, retry: true },
  async (event) => {
    const snap = event.data;
    if (!snap) {
      logger.error('onMemberCreated: evento senza data snapshot', { params: event.params });
      return;
    }
    const member = snap.data();
    // referredBy null (registrazione senza refCode, refCode inesistente o
    // auto-invito) → niente da conteggiare.
    if (!member.referredBy) return;
    // Auto-riferimento diretto (possibile solo via scrittura admin): no-op.
    if (member.referredBy === snap.id) {
      logger.warn('onMemberCreated: referredBy self-reference, skip', { memberId: snap.id });
      return;
    }

    const db = admin.firestore();
    const memberRef = db.collection('members').doc(snap.id);
    const referrerRef = db.collection('members').doc(member.referredBy);

    // Gate anti-doppio-conteggio: marca atomica sul doc del nuovo membro.
    // Se la marcatura fallisce per conflitto la transazione viene ritentata
    // da Firestore; se il doc è già marcato (retry del trigger) → skip totale.
    const alreadyCounted = await db.runTransaction(async (tx) => {
      const mSnap = await tx.get(memberRef);
      if (!mSnap.exists) return true;
      if (mSnap.data().referralCounted === true) return true;
      tx.update(memberRef, { referralCounted: true });
      return false;
    });
    if (alreadyCounted) {
      logger.info('onMemberCreated: referral già conteggiato, skip', { memberId: snap.id });
      return;
    }

    const referrerSnap = await referrerRef.get();
    if (!referrerSnap.exists) {
      logger.error('onMemberCreated: referente mancante', { referredBy: member.referredBy });
      return;
    }

    if (member.refSuspicious) {
      // Referral sospetto (auto-invito): NON conteggiato, marcato sul
      // referente per approvazione manuale in admin.
      await referrerRef.update({ suspiciousReferral: true });
      logger.info('Referral sospetto marcato', { referrer: member.referredBy, nuovo: snap.id });
      return;
    }

    await referrerRef.update({ referralCount: FieldValue.increment(1) });
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
      if (!p.refTarget || (referrer.referralCount || 0) < p.refTarget) continue;
      const claimRef = db.collection('claims').doc(d.id + '_' + member.referredBy);
      // Claim + actionsCount dentro UNA transazione: due eventi members distinti
      // dello stesso referente possono correre in parallelo (maxInstances 2) —
      // senza transazione entrambi vedrebbero il claim inesistente e il secondo
      // set() sovrascriverebbe il code del primo (QR stale) con doppio
      // incremento di actionsCount. La transazione ri-legge il claim: se esiste
      // → no-op completo; altrimenti set claim + increment atomici.
      const issued = await db.runTransaction(async (tx) => {
        const existing = await tx.get(claimRef);
        if (existing.exists) return false; // 1 premio per promo per tessera
        tx.set(claimRef, {
          memberId: member.referredBy, promoId: d.id,
          code: randomToken(), status: 'issued',
          screenshotPath: null, aiModel: null,
          aiNote: 'Referral: soglia ' + p.refTarget + ' raggiunta',
          createdAt: FieldValue.serverTimestamp(),
          redeemedAt: null, redeemedVia: null, redeemedBy: null,
        });
        tx.update(referrerRef, {
          ['actionsCount.referral']: FieldValue.increment(1),
        });
        return true;
      });
      if (issued) {
        logger.info('Claim referral emesso', { promoId: d.id, memberId: member.referredBy });
      }
    }

    const refreshed = (await referrerRef.get()).data();
    await evaluateBadges(referrerRef, refreshed);
    logger.info('onMemberCreated: referral conteggiato', {
      nuovo: snap.id,
      referrer: member.referredBy,
      referralCount: refreshed.referralCount,
    });
  }
);

/* --- Riscatto QR al banco: peekClaim (pubblica) + redeemQr (bruciatura) --- */

// Il QR premio contiene SOLO il code (token opaco, 32 hex): niente PII nel
// payload QR. lookup per code perché il QR non conosce il docId del claim.
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

// Solo i dati visibili al banco: mai code, screenshotPath o note interne.
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

// Unica via di bruciatura. Admin loggato (app staff) salta il PIN; altrimenti
// PIN staff da config/gamification. Il valore del PIN non viene mai loggato:
// solo confronto. status già 'redeemed' NON è un errore anonimo: si
// restituiscono i dati del riscatto esistente (chi/quando/via) così lo staff
// capisce cosa è successo; la bruciatura resta protetta dalla transazione.
exports.redeemQr = onCall(
  { region: 'europe-west1', maxInstances: 2 },
  async (req) => {
    const email = req.auth && req.auth.token && req.auth.token.email;
    // Canale di autorizzazione reale (fix R1-M1): un socio loggato NON admin
    // che usa il PIN del banco NON deve risultare riscattato 'da lui' —
    // l'email entra nell'audit solo se assertAdmin passa.
    let authorizedVia = null; // 'admin' | 'pin'
    if (email) {
      try {
        await assertAdmin(req);
        authorizedVia = 'admin';
      } catch (err) {
        // Non admin → PIN sotto. Se l'errore non è il "non sei admin"
        // atteso (es. read Firestore transitoria su config/admin), lo
        // logghiamo: mai l'email, mai oggetti request (fix R1-M4).
        if (!(err instanceof HttpsError) ||
            (err.code !== 'unauthenticated' && err.code !== 'permission-denied')) {
          logger.warn('redeemQr: assertAdmin fallito, fallback PIN', {
            code: err && err.code ? String(err.code) : 'unknown',
            message: String(err && err.message || err).slice(0, 120),
          });
        }
      }
    }
    if (!authorizedVia) {
      const cfg = await admin.firestore().doc('config/gamification').get();
      const staffPin = cfg.exists ? String(cfg.data().staffPin || '') : '';
      const pin = String((req.data && req.data.pin) || '');
      if (!staffPin || pin !== staffPin) {
        throw new HttpsError('permission-denied', 'PIN staff errato.');
      }
      authorizedVia = 'pin';
    }

    const claimDoc = await findClaimByCode(req.data && req.data.code);
    const c = claimDoc.data();
    if (c.status === 'redeemed') {
      const payload = await claimPublicPayload(claimDoc);
      return {
        ok: false,
        alreadyRedeemed: true,
        prizeLabel: payload.prizeLabel,
        memberName: payload.memberName,
        redeemedAt: payload.redeemedAt,
        redeemedVia: c.redeemedVia || null,
        redeemedBy: c.redeemedBy || null,
      };
    }
    if (c.status !== 'issued') {
      throw new HttpsError('failed-precondition', 'Questo premio non è riscattabile (in verifica o rifiutato).');
    }

    // Transazione: bruciatura atomica, doppio tap sicuro. Se uno scan
    // concorrente ha già bruciato, la ri-lettura dentro la transazione lo
    // intercetta: nessuna seconda scrittura, nessun doppio premio.
    // L'esito della guardia esce dal callback tramite flag (niente errori
    // come control flow fuori dalla tx): così il doppio scan riceve lo
    // shape already-redeemed informativo invece di un HttpsError anonimo
    // (fix R1-M2). Guardia exists: se il doc sparisce tra lookup e tx
    // evitiamo il TypeError da fresh.data() su snapshot vuoto (fix R1-M3).
    // FieldValue dal subpath (ruling): admin.firestore.FieldValue in
    // emulatore risulta undefined.
    let txOutcome = 'ok'; // 'ok' | 'missing' | 'not-issued'
    await admin.firestore().runTransaction(async (tx) => {
      const fresh = await tx.get(claimDoc.ref);
      if (!fresh.exists) { txOutcome = 'missing'; return; }
      if (fresh.data().status !== 'issued') { txOutcome = 'not-issued'; return; }
      tx.update(claimDoc.ref, {
        status: 'redeemed',
        redeemedAt: FieldValue.serverTimestamp(),
        redeemedVia: authorizedVia === 'admin' ? 'admin' : 'pin',
        redeemedBy: authorizedVia === 'admin' ? email : null,
      });
    });

    if (txOutcome === 'missing') {
      throw new HttpsError('not-found', 'Codice QR non trovato.');
    }
    if (txOutcome === 'not-issued') {
      // Scan concorrente: ri-leggiamo per dire allo staff CHI ha riscattato,
      // quando e via quale canale (stesso shape del doppio scan sequenziale).
      const reread = await claimDoc.ref.get();
      if (reread.exists && reread.data().status === 'redeemed') {
        const rc = reread.data();
        const payload = await claimPublicPayload(reread);
        logger.info('redeemQr: bruciatura concorrente, claim già riscattato', { claimId: claimDoc.id });
        return {
          ok: false,
          alreadyRedeemed: true,
          prizeLabel: payload.prizeLabel,
          memberName: payload.memberName,
          redeemedAt: rc.redeemedAt && rc.redeemedAt.toDate ? rc.redeemedAt.toDate().toISOString() : null,
          redeemedVia: rc.redeemedVia || null,
          redeemedBy: rc.redeemedBy || null,
        };
      }
      throw new HttpsError('failed-precondition', 'Questo premio non è più riscattabile.');
    }

    logger.info('redeemQr OK', { claimId: claimDoc.id, via: authorizedVia });
    const payload = await claimPublicPayload(claimDoc);
    return { ok: true, prizeLabel: payload.prizeLabel, memberName: payload.memberName };
  }
);

// Storage rules: claims-inbox non è leggibile dal client (read:false) — le
// prove le vede lo staff SOLO via questo canale admin. Ritorna data URL base64
// (upload cap 5MB → risposta ~6.7MB, ok per consultazione puntuale).
exports.getClaimScreenshot = onCall(
  { region: 'europe-west1', maxInstances: 2 },
  async (req) => {
    await assertAdmin(req);
    const claimId = String((req.data && req.data.claimId) || '').trim();
    if (!claimId || claimId.includes('/')) {
      throw new HttpsError('invalid-argument', 'Claim non valido.');
    }
    const snap = await admin.firestore().collection('claims').doc(claimId).get();
    if (!snap.exists) throw new HttpsError('not-found', 'Claim non trovato.');
    const claim = snap.data();
    const path = String(claim.screenshotPath || '');
    // Il path DEVE stare nel folder del membro del claim: un claim non può
    // puntare alla prova di un altro membro (M1, R1 Task 11).
    if (!path.startsWith('claims-inbox/' + String(claim.memberId || '') + '/') || path.includes('..')) {
      throw new HttpsError('not-found', 'Nessuna prova allegata a questa richiesta.');
    }
    const file = admin.storage().bucket(STORAGE_BUCKET).file(path);
    const [meta] = await file.getMetadata().catch(() => [null]);
    if (!meta) throw new HttpsError('not-found', 'Immagine non più disponibile.');
    const mime = String(meta.contentType || 'image/jpeg');
    if (!mime.startsWith('image/')) {
      throw new HttpsError('failed-precondition', 'Il file allegato non è un\'immagine.');
    }
    const [buf] = await file.download();
    logger.info('getClaimScreenshot', { claimId, by: req.auth.token.email });
    return { dataUrl: 'data:' + mime + ';base64,' + buf.toString('base64') };
  }
);

/* --- Moderazione staff: reviewClaim (pending_review) + approveReferral --- */

// Approva/rifiuta un claim in pending_review. Approvazione: il code esiste già
// (generato alla sottomissione) → solo status='issued', poi actionsCount del
// membro +1 sulla metrica della promo e rivalutazione badge. FieldValue dal
// subpath (ruling): admin.firestore.FieldValue in emulatore è undefined.
exports.reviewClaim = onCall(
  { region: 'europe-west1', maxInstances: 2 },
  async (req) => {
    await assertAdmin(req);
    const claimId = String((req.data && req.data.claimId) || '').trim();
    const approve = Boolean(req.data && req.data.approve);
    if (!claimId || claimId.includes('/')) {
      throw new HttpsError('invalid-argument', 'Claim non valido.');
    }
    const db = admin.firestore();
    const ref = db.collection('claims').doc(claimId);
    // Guard + scritture DENTRO una transazione (standard redeemQr): due
    // reviewClaim concorrenti sullo stesso claim non possono entrambe vedere
    // pending_review e incrementare due volte actionsCount. Letture prima
    // delle scritture (vincolo tx Firestore); HttpsError nel callback esce
    // pulito (not-found / failed-precondition), mai internal.
    const memberRef = await db.runTransaction(async (tx) => {
      const fresh = await tx.get(ref);
      if (!fresh.exists) throw new HttpsError('not-found', 'Claim non trovato.');
      const claim = fresh.data();
      if (claim.status !== 'pending_review') {
        throw new HttpsError('failed-precondition', 'Claim già gestito.');
      }
      if (!approve) {
        tx.update(ref, { status: 'rejected' });
        return null;
      }
      const mRef = db.collection('members').doc(claim.memberId);
      const promoSnap = await tx.get(db.collection('promos').doc(claim.promoId));
      const promo = promoSnap.exists ? promoSnap.data() : {};
      tx.update(ref, { status: 'issued' });
      tx.update(mRef, {
        ['actionsCount.' + (promo.actionType || 'custom')]: FieldValue.increment(1),
      });
      return mRef;
    });
    // evaluateBadges FUORI dalla tx, su dati ri-letti: è idempotente.
    if (memberRef) {
      await evaluateBadges(memberRef, (await memberRef.get()).data());
    }
    logger.info('reviewClaim', { claimId, approve, by: req.auth.token.email });
    return { ok: true };
  }
);

// Approva un referral marcato sospetto (auto-invito / refCode inesistente):
// referralCount +1 sul referente e smarcatura. Scelta deliberata (ruling):
// NON viene emesso il claim da promo referral a soglia su approvazione
// manuale — solo conteggio + badge (ramo raro, popolazione vuota oggi).
exports.approveReferral = onCall(
  { region: 'europe-west1', maxInstances: 2 },
  async (req) => {
    await assertAdmin(req);
    const memberId = String((req.data && req.data.memberId) || '').trim();
    if (!memberId || memberId.includes('/')) {
      throw new HttpsError('invalid-argument', 'memberId non valido.');
    }
    const db = admin.firestore();
    const ref = db.collection('members').doc(memberId);
    // Guard + scritture nella stessa tx: doppia approvazione concorrente
    // conta UNA sola volta (la seconda ri-legge il flag già cancellato).
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) throw new HttpsError('not-found', 'Membro non trovato.');
      if (snap.data().suspiciousReferral !== true) {
        throw new HttpsError('failed-precondition', 'Referral già gestito o non sospetto.');
      }
      tx.update(ref, {
        referralCount: FieldValue.increment(1),
        suspiciousReferral: FieldValue.delete(),
      });
    });
    await evaluateBadges(ref, (await ref.get()).data());
    logger.info('approveReferral', { memberId, by: req.auth.token.email });
    return { ok: true };
  }
);
