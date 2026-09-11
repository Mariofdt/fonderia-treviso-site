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
