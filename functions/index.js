'use strict';

/**
 * Fonderia Treviso — automazione email su nuova prenotazione.
 *
 * Trigger: creazione doc in bookings/{bookingId} (write anonimo dal sito).
 * Azione: email al locale + conferma al cliente (se ha lasciato l'email),
 *         poi marca il doc con emailed/emailedAt via Admin SDK.
 *
 * Config (tutta fuori dal codice, NIENTE in git):
 *   - BREVO_SMTP_KEY    → Secret Manager (defineSecret) — password SMTP Brevo
 *   - BREVO_SMTP_USER   → functions/.env — login SMTP Brevo
 *   - VENUE_EMAIL       → functions/.env — email del locale
 *   - FROM_EMAIL        → functions/.env — mittente (fallback: EMAIL_FROM, poi BREVO_SMTP_USER)
 * functions/.env e' caricato automaticamente dal runtime v2 (e dall'emulatore).
 */

const { onDocumentCreated } = require('firebase-functions/v2/firestore');
const { defineSecret } = require('firebase-functions/params');
const { logger } = require('firebase-functions');
const admin = require('firebase-admin');
const nodemailer = require('nodemailer');

admin.initializeApp();

const brevoSmtpKey = defineSecret('BREVO_SMTP_KEY');

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
    secrets: [brevoSmtpKey],
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

    const smtpUser = process.env.BREVO_SMTP_USER;
    const smtpPass = brevoSmtpKey.value();
    const venueEmail = process.env.VENUE_EMAIL;
    const fromEmail =
      process.env.FROM_EMAIL || process.env.EMAIL_FROM || smtpUser;

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
