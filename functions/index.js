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
