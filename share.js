/**
 * share.js — Bottoni "Condividi" sotto immagini gallery e card evento.
 *
 * Script classico (non modulo): monta le righe su tutto il document al
 * DOMContentLoaded ed espone window.FonderiaShare.mount(root) per i
 * contenuti dinamici (events.js chiama mount(grid) dopo il render).
 *
 * Reti supportate:
 *  - Facebook → sharer.php reale (apre il dialog di condivisione)
 *  - Instagram / TikTok → NON esiste uno share-URL web pubblico:
 *    il bottone copia il link e avvisa di incollarlo nel post/storia
 *  - Copia link → navigator.clipboard (fallback: campo nascosto)
 */
(function () {
    'use strict';

    var SITE = 'https://fonderia-treviso.web.app';

    var ICONS = {
        fb: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M13.5 21v-7h2.4l.4-3h-2.8V9.1c0-.9.3-1.5 1.6-1.5h1.3V4.9c-.3 0-1.1-.1-2-.1-2 0-3.4 1.2-3.4 3.5V11H8.5v3H11v7h2.5z"/></svg>',
        ig: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="5"/><circle cx="12" cy="12" r="4"/><circle cx="17.2" cy="6.8" r="0.9" fill="currentColor" stroke="none"/></svg>',
        tt: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M16.6 3c.4 2 1.8 3.5 3.9 3.7v3.1c-1.5 0-2.9-.5-4-1.3v6.3c0 3.5-2.6 5.7-5.7 5.7A5.3 5.3 0 0 1 5.2 15c0-3.2 2.7-5.6 6-5.3v3.2a2.3 2.3 0 0 0-2.8 2.2 2.3 2.3 0 0 0 2.4 2.3c1.5 0 2.6-1.1 2.6-2.7V3h3.2z"/></svg>',
        link: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/></svg>'
    };

    function toast(msg) {
        var t = document.querySelector('.share-toast');
        if (!t) {
            t = document.createElement('div');
            t.className = 'share-toast';
            document.body.appendChild(t);
        }
        t.textContent = msg;
        t.classList.add('visible');
        clearTimeout(t._timer);
        t._timer = setTimeout(function () { t.classList.remove('visible'); }, 3200);
    }

    function copyLink(url, msg) {
        var done = function () { toast(msg || 'Link copiato! Incollalo dove vuoi.'); };
        if (navigator.clipboard && window.isSecureContext) {
            navigator.clipboard.writeText(url).then(done, function () { fallbackCopy(url); done(); });
        } else { fallbackCopy(url); done(); }
    }

    function fallbackCopy(url) {
        var ta = document.createElement('textarea');
        ta.value = url;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        try { document.execCommand('copy'); } catch (e) { /* noop */ }
        document.body.removeChild(ta);
    }

    function rowHTML(url) {
        var encUrl = encodeURIComponent(url);
        var fb = 'https://www.facebook.com/sharer/sharer.php?u=' + encUrl;
        return '<div class="share-row" role="group" aria-label="Condividi">'
            + '<span class="share-label">Condividi</span>'
            + '<button type="button" class="share-btn" data-share-net="fb" data-share-href="' + fb + '" title="Condividi su Facebook" aria-label="Condividi su Facebook">' + ICONS.fb + '</button>'
            + '<button type="button" class="share-btn" data-share-net="ig" data-share-url="' + url + '" title="Copia il link per Instagram">' + ICONS.ig + '</button>'
            + '<button type="button" class="share-btn" data-share-net="tt" data-share-url="' + url + '" title="Copia il link per TikTok">' + ICONS.tt + '</button>'
            + '<button type="button" class="share-btn" data-share-net="link" data-share-url="' + url + '" title="Copia link" aria-label="Copia link">' + ICONS.link + '</button>'
            + '</div>';
    }

    function mount(root) {
        root = root || document;

        // Gallery: avvolgi l'immagine e metti la riga SOTTO
        root.querySelectorAll('.gallery-grid .gallery-item').forEach(function (item) {
            if (item.closest('.gallery-cell')) return; // già montato
            var cell = document.createElement('div');
            cell.className = 'gallery-cell';
            item.parentNode.insertBefore(cell, item);
            cell.appendChild(item);
            var frag = document.createElement('div');
            frag.innerHTML = rowHTML(SITE + '#gallery');
            cell.appendChild(frag.firstChild);
        });

        // Eventi: riga in fondo alla card body
        root.querySelectorAll('.event-card-body').forEach(function (body) {
            if (body.querySelector('.share-row')) return;
            var url = SITE + '#events';
            var frag = document.createElement('div');
            frag.innerHTML = rowHTML(url);
            body.appendChild(frag.firstChild);
        });
    }

    // Un solo click handler per tutto il document (bottoni presenti e futuri)
    document.addEventListener('click', function (e) {
        var btn = e.target.closest ? e.target.closest('.share-btn') : null;
        if (!btn) return;
        var net = btn.dataset.shareNet;
        var url = btn.dataset.shareUrl;
        var label = btn.closest('.event-card-body')
            ? (btn.closest('.event-card-body').querySelector('h3') || {}).textContent || ''
            : '';
        var pretty = label ? '«' + label.trim() + '»\n' : '';

        if (net === 'fb') {
            window.open(btn.dataset.shareHref, 'fb-share', 'width=640,height=520,menubar=no,toolbar=no');
        } else if (net === 'ig') {
            copyLink(url, 'Link copiato — incollalo nel tuo post o storia Instagram');
        } else if (net === 'tt') {
            copyLink(url, 'Link copiato — incollalo nella descrizione su TikTok');
        } else if (net === 'link') {
            copyLink(url, pretty + 'Link copiato negli appunti!');
        }
    });

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', function () { mount(document); });
    } else {
        mount(document);
    }

    window.FonderiaShare = { mount: mount };
})();
