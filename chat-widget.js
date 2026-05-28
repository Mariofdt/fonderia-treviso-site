// ========================================
// FONDERIA TREVISO — AI Chat Assistant
// ========================================

document.addEventListener('DOMContentLoaded', () => {
    initChatWidget();
});

function initChatWidget() {
    const toggle = document.getElementById('chatToggle');
    const windowEl = document.getElementById('chatWindow');
    const closeBtn = document.getElementById('chatClose');
    const input = document.getElementById('chatInput');
    const sendBtn = document.getElementById('chatSend');
    const messages = document.getElementById('chatMessages');
    const suggestions = document.getElementById('chatSuggestions');

    if (!toggle || !windowEl) return;

    // Open / close
    toggle.addEventListener('click', () => {
        const isOpen = windowEl.classList.toggle('active');
        toggle.classList.toggle('active', isOpen);
        if (isOpen && messages.children.length === 0) {
            addBotMessage(welcomeMsg());
            renderSuggestions(['🍽️ Menu', '📅 Prenota tavolo', '📍 Dove siamo', '🎵 Eventi']);
        }
        if (isOpen) setTimeout(() => input.focus(), 300);
    });

    closeBtn?.addEventListener('click', () => {
        windowEl.classList.remove('active');
        toggle.classList.remove('active');
    });

    // Send message
    function sendUser(text) {
        if (!text.trim()) return;
        addUserMessage(text);
        input.value = '';
        handleUserMessage(text);
    }

    sendBtn?.addEventListener('click', () => sendUser(input.value));
    input?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') sendUser(input.value);
    });

    // Suggestion chips
    suggestions?.addEventListener('click', (e) => {
        const chip = e.target.closest('.chat-chip');
        if (!chip) return;
        const text = chip.dataset.value || chip.textContent;
        sendUser(text);
    });

    function addUserMessage(text) {
        const div = document.createElement('div');
        div.className = 'chat-msg user';
        div.innerHTML = `<div class="chat-bubble">${escapeHtml(text)}</div><div class="chat-time">${nowTime()}</div>`;
        messages.appendChild(div);
        scrollToBottom();
    }

    function addBotMessage(html, opts = []) {
        const div = document.createElement('div');
        div.className = 'chat-msg bot';
        div.innerHTML = `<div class="chat-avatar">F</div><div class="chat-bubble">${html}</div><div class="chat-time">${nowTime()}</div>`;
        messages.appendChild(div);
        scrollToBottom();
        if (opts.length) renderSuggestions(opts);
    }

    function renderSuggestions(opts) {
        suggestions.innerHTML = opts.map(o =>
            `<button class="chat-chip" data-value="${escapeHtml(o)}">${escapeHtml(o)}</button>`
        ).join('');
        scrollToBottom();
    }

    function scrollToBottom() {
        messages.scrollTop = messages.scrollHeight;
    }

    function escapeHtml(t) {
        const d = document.createElement('div');
        d.textContent = t;
        return d.innerHTML;
    }

    function nowTime() {
        const d = new Date();
        return d.getHours().toString().padStart(2, '0') + ':' + d.getMinutes().toString().padStart(2, '0');
    }

    // ========== RESPONSE ENGINE ==========
    function welcomeMsg() {
        return `Ciao! Sono l'assistente di <strong>Fonderia Treviso</strong>. 🔥<br>Come posso aiutarti stasera?`;
    }

    function handleUserMessage(raw) {
        const t = raw.toLowerCase();
        const typing = addTyping();

        setTimeout(() => {
            typing.remove();

            // Keywords matching
            if (match(t, ['prenota', 'tavolo', 'vip', 'sala privata', 'festa', 'compleanno', 'cena aziendale'])) {
                addBotMessage(`Perfetto! Ti apro il modulo prenotazione. Compila i dati e ti invieremo la conferma via WhatsApp.`, ['📅 Vai alla prenotazione', '📞 Chiama ora']);
                setTimeout(() => {
                    document.getElementById('bookingOverlay')?.classList.add('active');
                    document.body.style.overflow = 'hidden';
                }, 800);
                return;
            }

            if (match(t, ['menu', 'cibo', 'mangiare', 'bere', 'birra', 'cocktail', 'pizza', 'pinsa', 'tagliere', 'mangi'])) {
                addBotMessage(`Il nostro menu include birre artigianali alla spina, cocktail signature, taglieri di salumi e formaggi locali, pinsa romana e snack. Puoi consultare il menu completo qui sotto.`, ['📖 Apri il Menu']);
                return;
            }

            if (match(t, ['orari', 'aperto', 'quando', 'ora', 'chiuso', 'apertura', 'sera'])) {
                addBotMessage(`Siamo aperti il <strong>venerdì e il sabato dalle 21:00 fino a tarda notte</strong> (circa 04:00). 🌙<br>Il locale è aperto solo in orario serale/notturno.`, ['📅 Prenota un tavolo']);
                return;
            }

            if (match(t, ['dove', 'indirizzo', 'parcheggio', 'arrivare', 'posizione', 'ztl', 'macchina', 'navigare'])) {
                addBotMessage(`Ci troviamo in <strong>Via Fonderia, 113 a Treviso</strong>. 📍<br>Siamo <strong>vicino al centro ma non in centro</strong>, con <strong>ampio parcheggio gratuito</strong> davanti all'ingresso. Nessuna ZTL.`, ['📍 Apri Mappa', '📅 Prenota']);
                return;
            }

            if (match(t, ['eventi', 'venerdì', 'sabato', 'dj', 'live', 'musica', 'serata', 'ballo', 'pista'])) {
                addBotMessage(`🎵 <strong>Venerdì Live</strong> — musica dal vivo, band e jam session.<br>🎧 <strong>Sabato Notte</strong> — DJ set, pista da ballo, luci e laser fino all'alba.<br>Area VIP disponibile su prenotazione.`, ['📅 Prenota ora', '📞 Info WhatsApp']);
                return;
            }

            if (match(t, ['prezzi', 'costo', 'quanto', 'euro', 'spesa', 'conto'])) {
                addBotMessage(`💶 Birre artigianali da €5, cocktail signature €10, taglieri €18, pinsa romana vari prezzi.<br>L'Area VIP richiede un minimo di spesa (prenotazione obbligatoria). Sale private su preventivo personalizzato.`, ['📖 Vedi il Menu', '📅 Prenota']);
                return;
            }

            if (match(t, ['telefono', 'contatto', 'whatsapp', 'email', 'chiama', 'scrivi', 'numero'])) {
                addBotMessage(`📞 <strong>+39 320 413 7183</strong><br>💬 <a href="https://wa.me/393204137183" target="_blank" style="color:#25d366;">Scrivi su WhatsApp</a><br>📧 info@fonderiatreviso.it`, ['💬 Apri WhatsApp', '📅 Prenota']);
                return;
            }

            if (match(t, ['ciao', 'salve', 'buongiorno', 'buonasera', 'hey', 'hi'])) {
                addBotMessage(`Ciao! Benvenuto in Fonderia Treviso. 🍻<br>Cosa ti serve?`, ['🍽️ Menu', '📅 Prenota tavolo', '📍 Dove siamo', '🎵 Eventi']);
                return;
            }

            if (match(t, ['grazie', 'perfetto', 'ok', 'bene', 'grazie mille'])) {
                addBotMessage(`Piacere mio! 🔥 A presto in Fonderia! Se hai altre domande, sono qui.`, ['📅 Prenota', '📞 Chiama']);
                return;
            }

            if (match(t, ['recensioni', 'google', 'opinioni', 'stelle', 'voto'])) {
                addBotMessage(`⭐ Valutazione media <strong>4.7 su 5</strong> con oltre 150 recensioni Google. I clienti apprezzano l'atmosfera, i cocktail e la musica dal vivo.`, ['⭐ Leggi Recensioni', '📅 Prenota']);
                return;
            }

            if (match(t, ['eta', 'minima', 'anni', '18', 'maggiorenne', 'documento', 'id'])) {
                addBotMessage(`L'ingresso è consentito dai <strong>18 anni</strong>. Per serate con DJ set potrebbe essere richiesto un documento all'ingresso.`, ['🎵 Eventi', '📅 Prenota']);
                return;
            }

            // Fallback
            addBotMessage(`Scusa, non ho capito bene. Posso aiutarti su:<br>• Orari e apertura<br>• Prenotazioni tavolo / VIP / sale private<br>• Menu e prezzi<br>• Dove siamo e parcheggio<br>• Eventi (venerdì live / sabato DJ set)<br>• Contatti e WhatsApp`, ['🍽️ Menu', '📅 Prenota tavolo', '📍 Dove siamo', '🎵 Eventi']);
        }, 600 + Math.random() * 400);
    }

    function match(text, keywords) {
        return keywords.some(k => text.includes(k));
    }

    function addTyping() {
        const div = document.createElement('div');
        div.className = 'chat-msg bot typing-indicator';
        div.innerHTML = `<div class="chat-avatar">F</div><div class="chat-bubble"><span class="dot"></span><span class="dot"></span><span class="dot"></span></div>`;
        messages.appendChild(div);
        scrollToBottom();
        return div;
    }
}
