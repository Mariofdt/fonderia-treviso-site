// ========================================
// FONDERIA MUSIC - Procedural Deep House / Lounge
// ========================================

class FonderiaMusic {
    constructor() {
        this.ctx = null;
        this.playing = false;
        this.nextNoteTime = 0;
        this.beat = 0;
        this.step = 0;
        this.bpm = 110;
        this.lookahead = 25.0;
        this.scheduleAheadTime = 0.1;
        this.timerID = null;
        this.masterGain = null;
    }

    start() {
        const AudioContext = window.AudioContext || window.webkitAudioContext;
        this.ctx = new AudioContext();
        this.masterGain = this.ctx.createGain();
        this.masterGain.gain.value = 0.25;

        // Compressor for punch
        const compressor = this.ctx.createDynamicsCompressor();
        compressor.threshold.value = -18;
        compressor.knee.value = 6;
        compressor.ratio.value = 4;
        compressor.attack.value = 0.005;
        compressor.release.value = 0.1;

        // Master filter
        const filter = this.ctx.createBiquadFilter();
        filter.type = 'lowpass';
        filter.frequency.value = 3000;
        filter.Q.value = 0.5;

        this.masterGain.connect(filter);
        filter.connect(compressor);
        compressor.connect(this.ctx.destination);

        this.nextNoteTime = this.ctx.currentTime + 0.1;
        this.beat = 0;
        this.step = 0;
        this.playing = true;
        this.scheduler();
    }

    stop() {
        this.playing = false;
        clearTimeout(this.timerID);
        if (this.ctx) {
            this.ctx.close();
            this.ctx = null;
        }
    }

    scheduler() {
        while (this.nextNoteTime < this.ctx.currentTime + this.scheduleAheadTime) {
            this.scheduleStep(this.step, this.nextNoteTime);
            this.advanceStep();
        }
        if (this.playing) {
            this.timerID = setTimeout(() => this.scheduler(), this.lookahead);
        }
    }

    advanceStep() {
        const secondsPerBeat = 60.0 / this.bpm;
        const secondsPerStep = secondsPerBeat / 4; // 16th notes
        this.nextNoteTime += secondsPerStep;
        this.step++;
        if (this.step % 4 === 0) this.beat++;
    }

    scheduleStep(step, time) {
        const beat = Math.floor(step / 4);
        const sixteenth = step % 4;

        // KICK: every beat (1,2,3,4)
        if (sixteenth === 0) {
            this.kick(time);
        }

        // SNARE/CLAP: beat 2 and 4
        if (sixteenth === 0 && (beat % 2 === 1)) {
            this.snare(time);
        }

        // HI-HAT: every 8th note
        if (sixteenth % 2 === 0) {
            this.hihat(time, false);
        } else {
            this.hihat(time, true); // open
        }

        // BASS: pattern on beats
        if (sixteenth === 0) {
            if ([0,2,3,6,8,10,12,14].includes(beat % 16)) {
                this.bass(time, 55, 0.25); // A1
            } else if ([1,4,5,7,9,11,13,15].includes(beat % 16)) {
                this.bass(time, 41.2, 0.2); // E1
            }
        }

        // SYNTH CHORD STABS: every 4 beats
        if (sixteenth === 0 && beat % 4 === 0) {
            this.chordStab(time);
        }

        // ATMOSPHERIC PAD: every 8 beats
        if (sixteenth === 0 && beat % 8 === 0) {
            this.pad(time);
        }

        // PERC: off-beat 16ths for groove
        if (sixteenth === 2 && beat % 2 === 0) {
            this.perc(time);
        }
    }

    kick(time) {
        const osc = this.ctx.createOscillator();
        const gain = this.ctx.createGain();
        osc.connect(gain);
        gain.connect(this.masterGain);

        osc.frequency.setValueAtTime(150, time);
        osc.frequency.exponentialRampToValueAtTime(40, time + 0.15);
        gain.gain.setValueAtTime(0.9, time);
        gain.gain.exponentialRampToValueAtTime(0.01, time + 0.3);

        osc.start(time);
        osc.stop(time + 0.3);
    }

    snare(time) {
        // Noise burst
        const bufferSize = this.ctx.sampleRate * 0.2;
        const buffer = this.ctx.createBuffer(1, bufferSize, this.ctx.sampleRate);
        const data = buffer.getChannelData(0);
        for (let i = 0; i < bufferSize; i++) {
            data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / bufferSize, 3);
        }
        const noise = this.ctx.createBufferSource();
        noise.buffer = buffer;

        const noiseFilter = this.ctx.createBiquadFilter();
        noiseFilter.type = 'highpass';
        noiseFilter.frequency.value = 800;

        const noiseGain = this.ctx.createGain();
        noiseGain.gain.setValueAtTime(0.5, time);
        noiseGain.gain.exponentialRampToValueAtTime(0.01, time + 0.2);

        noise.connect(noiseFilter);
        noiseFilter.connect(noiseGain);
        noiseGain.connect(this.masterGain);

        noise.start(time);
        noise.stop(time + 0.2);

        // Snap layer
        const snapOsc = this.ctx.createOscillator();
        const snapGain = this.ctx.createGain();
        snapOsc.type = 'triangle';
        snapOsc.frequency.setValueAtTime(250, time);
        snapGain.gain.setValueAtTime(0.15, time);
        snapGain.gain.exponentialRampToValueAtTime(0.01, time + 0.08);
        snapOsc.connect(snapGain);
        snapGain.connect(this.masterGain);
        snapOsc.start(time);
        snapOsc.stop(time + 0.08);
    }

    hihat(time, open) {
        const bufferSize = this.ctx.sampleRate * 0.05;
        const buffer = this.ctx.createBuffer(1, bufferSize, this.ctx.sampleRate);
        const data = buffer.getChannelData(0);
        for (let i = 0; i < bufferSize; i++) {
            data[i] = (Math.random() * 2 - 1);
        }
        const noise = this.ctx.createBufferSource();
        noise.buffer = buffer;

        const filter = this.ctx.createBiquadFilter();
        filter.type = 'highpass';
        filter.frequency.value = 7000;

        const gain = this.ctx.createGain();
        const decay = open ? 0.15 : 0.04;
        gain.gain.setValueAtTime(0.35, time);
        gain.gain.exponentialRampToValueAtTime(0.01, time + decay);

        noise.connect(filter);
        filter.connect(gain);
        gain.connect(this.masterGain);

        noise.start(time);
        noise.stop(time + decay);
    }

    bass(time, freq, vol) {
        const osc = this.ctx.createOscillator();
        const gain = this.ctx.createGain();
        const filter = this.ctx.createBiquadFilter();

        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(freq, time);

        filter.type = 'lowpass';
        filter.frequency.setValueAtTime(400, time);
        filter.frequency.exponentialRampToValueAtTime(120, time + 0.15);
        filter.Q.value = 2;

        gain.gain.setValueAtTime(vol, time);
        gain.gain.exponentialRampToValueAtTime(0.01, time + 0.25);

        osc.connect(filter);
        filter.connect(gain);
        gain.connect(this.masterGain);

        osc.start(time);
        osc.stop(time + 0.25);
    }

    chordStab(time) {
        // Minor 7th chord: A - C - E - G
        const freqs = [220, 261.63, 329.63, 392];
        freqs.forEach((f, i) => {
            const osc = this.ctx.createOscillator();
            const gain = this.ctx.createGain();
            const filter = this.ctx.createBiquadFilter();

            osc.type = 'sine';
            osc.frequency.value = f;

            filter.type = 'lowpass';
            filter.frequency.value = 1200;

            gain.gain.setValueAtTime(0.04, time);
            gain.gain.exponentialRampToValueAtTime(0.001, time + 0.8);

            osc.connect(filter);
            filter.connect(gain);
            gain.connect(this.masterGain);

            osc.start(time + i * 0.01); // slight detune per voice
            osc.stop(time + 0.8);
        });
    }

    pad(time) {
        const freqs = [110, 164.81, 220, 261.63]; // Am7 pad
        freqs.forEach((f, i) => {
            const osc = this.ctx.createOscillator();
            const gain = this.ctx.createGain();
            const lfo = this.ctx.createOscillator();
            const lfoGain = this.ctx.createGain();

            osc.type = 'sine';
            osc.frequency.value = f;

            // Tremolo
            lfo.frequency.value = 0.2 + i * 0.1;
            lfoGain.gain.value = 0.3;
            lfo.connect(lfoGain);
            lfoGain.connect(gain.gain);

            gain.gain.setValueAtTime(0, time);
            gain.gain.linearRampToValueAtTime(0.04, time + 0.5);
            gain.gain.linearRampToValueAtTime(0.01, time + 4.0);

            osc.connect(gain);
            gain.connect(this.masterGain);

            osc.start(time);
            lfo.start(time);
            osc.stop(time + 4.0);
            lfo.stop(time + 4.0);
        });
    }

    perc(time) {
        const osc = this.ctx.createOscillator();
        const gain = this.ctx.createGain();
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(600, time);
        osc.frequency.exponentialRampToValueAtTime(200, time + 0.05);
        gain.gain.setValueAtTime(0.12, time);
        gain.gain.exponentialRampToValueAtTime(0.01, time + 0.08);
        osc.connect(gain);
        gain.connect(this.masterGain);
        osc.start(time);
        osc.stop(time + 0.08);
    }
}

// Global instance
let fonderiaMusic = new FonderiaMusic();

// Override the sound toggle in wow.js to use this
function initMusicToggle() {
    const btn = document.getElementById('soundToggle');
    if (!btn) return;
    
    btn.addEventListener('click', () => {
        const isPlaying = btn.classList.contains('active');
        if (!isPlaying) {
            fonderiaMusic.start();
            btn.classList.add('active');
            document.getElementById('soundIconOff').style.display = 'none';
            document.getElementById('soundIconOn').style.display = 'block';
        } else {
            fonderiaMusic.stop();
            btn.classList.remove('active');
            document.getElementById('soundIconOff').style.display = 'block';
            document.getElementById('soundIconOn').style.display = 'none';
        }
    });
}

document.addEventListener('DOMContentLoaded', initMusicToggle);
