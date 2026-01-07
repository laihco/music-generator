// Lo-Fi Generator Website
// Implements your analog rules as a repeatable system:
// d20 = measures, 2d6 = key (weighted), d6 = tempo
// Deck draw = notes/rests (no immediate repeats)
// Tables are taken directly from your PDF. :contentReference[oaicite:4]{index=4}

/* ----------------------------- DOM ----------------------------- */

const el = {
  btnGenerate: document.getElementById("btnGenerate"),
  btnPlay: document.getElementById("btnPlay"),
  btnStop: document.getElementById("btnStop"),
  btnInstant: document.getElementById("btnRegenerateFast"),

  outMeasures: document.getElementById("outMeasures"),
  outKey: document.getElementById("outKey"),
  outTempo: document.getElementById("outTempo"),

  dieD20: document.getElementById("dieD20"),
  die2D6A: document.getElementById("die2D6A"),
  die2D6B: document.getElementById("die2D6B"),
  dieD6: document.getElementById("dieD6"),

  drawnCard: document.getElementById("drawnCard"),
  lastResult: document.getElementById("lastResult"),
  progress: document.getElementById("progress"),

  sheet: document.getElementById("sheet"),
};

/* ------------------------- Generator Tables ------------------------- */

// (1) 2d6 -> key (from PDF) :contentReference[oaicite:5]{index=5}
const KEY_BY_2D6 = {
  2: "A",
  3: "E",
  4: "F",
  5: "C",
  6: "G",
  7: "D",
  8: "Bb",
  9: "Eb",
  10: "Ab",
  11: "Db",
  12: "Gb",
};

// (2) d6 -> tempo (BPM) (from PDF) :contentReference[oaicite:6]{index=6}
const TEMPO_BY_D6 = {
  1: 60,
  2: 90,
  3: 108,
  4: 120,
  5: 156,
  6: 200,
};

// (3) rank -> pitch letter (from PDF) :contentReference[oaicite:7]{index=7}
const PITCH_BY_RANK = {
  "2": "E",
  "3": "F",
  "4": "G",
  "5": "A",
  "6": "B",
  "7": "C",   // "middle C" in PDF, we use C4 for audio
  "8": "D",
  "9": "E",
  "10": "F",
  "J": "G",
  "Q": "A",
  "K": "B",
};

// Suit -> duration (notes) (from PDF) :contentReference[oaicite:8]{index=8}
const DUR_BY_SUIT = {
  "H": { name: "whole", beats: 4, vf: "w" }, // ♥ 𝅝
  "S": { name: "half",  beats: 2, vf: "h" }, // ♠ 𝅗𝅥
  "C": { name: "quarter", beats: 1, vf: "q" }, // ♣ ♩
  "D": { name: "eighth", beats: 0.5, vf: "8" }, // ♦ ♪
};

const SUIT_GLYPH = { H: "♥", S: "♠", C: "♣", D: "♦" };

// Key signatures -> accidentals (for audio pitch adjustment)
const KEY_SIGNATURES = {
  // sharps
  "C":  [],
  "G":  ["F#"],
  "D":  ["F#","C#"],
  "A":  ["F#","C#","G#"],
  "E":  ["F#","C#","G#","D#"],
  // flats
  "F":  ["Bb"],
  "Bb": ["Bb","Eb"],
  "Eb": ["Bb","Eb","Ab"],
  "Ab": ["Bb","Eb","Ab","Db"],
  "Db": ["Bb","Eb","Ab","Db","Gb"],
  "Gb": ["Bb","Eb","Ab","Db","Gb","Cb"],
};

// Semitone mapping for audio
const SEMITONES = { C:0, D:2, E:4, F:5, G:7, A:9, B:11 };

function accidentalForLetterInKey(letter, key) {
  const acc = KEY_SIGNATURES[key] || [];
  // If key signature includes this letter with # or b, apply it.
  const sharp = acc.includes(letter + "#");
  const flat  = acc.includes(letter + "b");
  if (sharp) return "#";
  if (flat)  return "b";
  return ""; // natural
}

/* ------------------------- Random + Deck ------------------------- */

function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function rollD6() { return randInt(1,6); }
function rollD20() { return randInt(1,20); }

function roll2D6() {
  const a = rollD6();
  const b = rollD6();
  return { a, b, sum: a + b };
}

function newDeck() {
  const ranks = ["A","2","3","4","5","6","7","8","9","10","J","Q","K"];
  const suits = ["H","S","C","D"]; // hearts/spades/clubs/diamonds
  const deck = [];
  for (const s of suits) {
    for (const r of ranks) deck.push({ r, s });
  }
  return deck;
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/* ------------------------- Music Event Model ------------------------- */
/**
 * We fill measures in 4/4. Each measure = 4 beats.
 * If a drawn duration doesn't fit the remaining beats, we "fit" it down
 * (whole->half->quarter->eighth) until it fits.
 */

function fitDurationToRemainingBeats(durBeats, remaining) {
  const choices = [4, 2, 1, 0.5]; // whole, half, quarter, eighth
  // pick the largest <= min(durBeats, remaining)
  const cap = Math.min(durBeats, remaining);
  for (const c of choices) {
    if (c <= cap + 1e-9) return c;
  }
  return 0; // shouldn't happen
}

function beatsToVexflowDuration(beats) {
  if (beats === 4) return "w";
  if (beats === 2) return "h";
  if (beats === 1) return "q";
  if (beats === 0.5) return "8";
  // fallback
  return "q";
}

function beatsToHuman(beats) {
  if (beats === 4) return "whole";
  if (beats === 2) return "half";
  if (beats === 1) return "quarter";
  if (beats === 0.5) return "eighth";
  return `${beats} beats`;
}

function generateSongSpec({ measures, key, tempo }) {
  let deck = shuffle(newDeck());
  let i = 0;

  const measuresOut = [];
  const animationSteps = []; // for card-by-card animation

  for (let m = 0; m < measures; m++) {
    let beatsLeft = 4;
    const events = [];

    while (beatsLeft > 1e-9) {
      if (i >= deck.length) {
        deck = shuffle(newDeck());
        i = 0;
      }

      const card = deck[i++];
      const suitDur = DUR_BY_SUIT[card.s].beats;
      const fittedBeats = fitDurationToRemainingBeats(suitDur, beatsLeft);
      const vfDur = beatsToVexflowDuration(fittedBeats);

      if (card.r === "A") {
        // rest
        const ev = {
          type: "rest",
          beats: fittedBeats,
          vfDur,
          card,
        };
        events.push(ev);
        beatsLeft -= fittedBeats;

        animationSteps.push({
          card,
          produced: `Rest (${beatsToHuman(fittedBeats)})`,
          measureIndex: m,
        });
      } else {
        // note
        const letter = PITCH_BY_RANK[card.r];
        const acc = accidentalForLetterInKey(letter, key); // apply key signature
        // Choose a comfy octave: keep everything around octave 4.
        const octave = (letter === "C") ? 4 : 4;
        const ev = {
          type: "note",
          letter,
          acc,     // "#", "b", or ""
          octave,
          beats: fittedBeats,
          vfDur,
          card,
        };
        events.push(ev);
        beatsLeft -= fittedBeats;

        const shown = `${letter}${acc || ""}${octave} (${beatsToHuman(fittedBeats)})`;
        animationSteps.push({
          card,
          produced: shown,
          measureIndex: m,
        });
      }
    }

    measuresOut.push(events);
  }

  return { measuresOut, animationSteps, key, tempo, measures };
}

/* ------------------------- VexFlow Rendering ------------------------- */

let vfRenderer = null;
let vfContext = null;

function resetSheet() {
  el.sheet.innerHTML = "";
  vfRenderer = null;
  vfContext = null;
}

function renderSheet({ measuresOut, key, tempo }, { partialUpToStep = null } = {}) {
  // partialUpToStep: if provided, render only up to a certain animation step
  // by truncating events after that step.

  // Build a "partial" measures array if needed
  let partialMeasures = measuresOut;

  if (partialUpToStep !== null) {
    // Convert steps to a cut-off point: we keep everything up to that step index.
    // We rebuild measure events by counting across the flattened event list.
    const flattened = measuresOut.flat();
    const keepCount = Math.max(0, Math.min(flattened.length, partialUpToStep + 1));
    const kept = flattened.slice(0, keepCount);

    // Re-split into measures, preserving the original measure boundaries by beat totals
    partialMeasures = [];
    let cursor = 0;
    for (let m = 0; m < measuresOut.length; m++) {
      const targetLen = measuresOut[m].length;
      const slice = kept.slice(cursor, cursor + targetLen);
      partialMeasures.push(slice);
      cursor += targetLen;
    }
  }

  resetSheet();

  // VexFlow setup
  const VF = Vex.Flow;
  vfRenderer = new VF.Renderer(el.sheet, VF.Renderer.Backends.SVG);
  vfRenderer.resize(980, 220 + Math.ceil(partialMeasures.length / 4) * 220);

  vfContext = vfRenderer.getContext();
  vfContext.setFont("Arial", 10);

  // Layout: 4 measures per line
  const measuresPerLine = 4;
  const lineWidth = 940;
  const startX = 20;
  const startY = 20;
  const staffH = 140;
  const gapY = 70;

  let y = startY;

  for (let line = 0; line < Math.ceil(partialMeasures.length / measuresPerLine); line++) {
    const lineStart = line * measuresPerLine;
    const lineMeasures = partialMeasures.slice(lineStart, lineStart + measuresPerLine);

    const measureWidth = lineWidth / measuresPerLine;

    // Create voices per measure
    for (let j = 0; j < lineMeasures.length; j++) {
      const x = startX + j * measureWidth;
      const stave = new VF.Stave(x, y, measureWidth);

      // First measure in the whole piece: clef + time + key
      if (lineStart + j === 0) {
        stave.addClef("treble").addTimeSignature("4/4").addKeySignature(key);
      }

      stave.setContext(vfContext).draw();

      const notes = lineMeasures[j].map(ev => {
        if (ev.type === "rest") {
          // VexFlow: rest uses "b/4" etc with "r" in duration
          const restDur = ev.vfDur + "r";
          return new VF.StaveNote({ keys: ["b/4"], duration: restDur });
        } else {
          const keyStr = `${ev.letter.toLowerCase()}${ev.acc || ""}/${ev.octave}`;
          const n = new VF.StaveNote({ keys: [keyStr], duration: ev.vfDur });
          // Add accidental if needed (so it’s explicit when appropriate)
          // Even though we also set a key signature, explicit accidentals keep things readable
          // for partial renders and match the chosen pitch.
          if (ev.acc) n.addModifier(new VF.Accidental(ev.acc), 0);
          return n;
        }
      });

      const voice = new VF.Voice({ num_beats: 4, beat_value: 4 });
      voice.addTickables(notes);

      new VF.Formatter().joinVoices([voice]).format([voice], measureWidth - 30);
      voice.draw(vfContext, stave);
    }

    y += staffH + gapY;
  }

  // little title line
  // (kept minimal to avoid overlap with SVG staff)
}

/* ------------------------- Dice + Card Animations ------------------------- */

function setDie(elDie, val) {
  elDie.textContent = String(val);
}

async function animateRoll(elDie, sides, finalValue, ms = 700) {
  elDie.classList.add("rolling");
  const start = performance.now();

  return new Promise(resolve => {
    const tick = () => {
      const now = performance.now();
      if (now - start >= ms) {
        elDie.classList.remove("rolling");
        setDie(elDie, finalValue);
        resolve();
        return;
      }
      setDie(elDie, randInt(1, sides));
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

function showCard(card) {
  const rankEl = el.drawnCard.querySelectorAll(".rank");
  const suitEl = el.drawnCard.querySelectorAll(".suit");
  const pipEl = el.drawnCard.querySelector(".pip");

  const suitGlyph = SUIT_GLYPH[card.s];
  rankEl.forEach(n => (n.textContent = card.r));
  suitEl.forEach(n => (n.textContent = suitGlyph));
  pipEl.textContent = suitGlyph;

  // Color hearts/diamonds a little (still "placeholder")
  const isRed = card.s === "H" || card.s === "D";
  el.drawnCard.style.color = isRed ? "rgba(255,120,120,0.95)" : "rgba(233,233,239,0.95)";
}

async function animateCardDraw(card) {
  showCard(card);
  el.drawnCard.classList.remove("hidden");
  el.drawnCard.classList.remove("cardFlipIn");
  // force reflow
  void el.drawnCard.offsetWidth;
  el.drawnCard.classList.add("cardFlipIn");
  await sleep(180);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/* ------------------------- Audio Playback ------------------------- */

let audioCtx = null;
let masterGain = null;
let currentStopToken = { stop: false };

function ensureAudio() {
  if (audioCtx) return;
  audioCtx = new (window.AudioContext || window.webkitAudioContext)();

  masterGain = audioCtx.createGain();
  masterGain.gain.value = 0.18;

  // Simple “lo-fi-ish” lowpass
  const lowpass = audioCtx.createBiquadFilter();
  lowpass.type = "lowpass";
  lowpass.frequency.value = 1800;
  lowpass.Q.value = 0.6;

  masterGain.connect(lowpass);
  lowpass.connect(audioCtx.destination);
}

function midiFromLetter(letter, acc, octave) {
  // C4 = MIDI 60
  let semis = SEMITONES[letter];
  if (acc === "#") semis += 1;
  if (acc === "b") semis -= 1;
  const midi = 12 * (octave + 1) + semis;
  return midi;
}

function freqFromMidi(midi) {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

function scheduleTone({ t0, durSec, freq, stopToken }) {
  // A tiny synth voice with ADSR
  const osc = audioCtx.createOscillator();
  osc.type = "triangle";

  const g = audioCtx.createGain();
  const now = t0;

  const attack = Math.min(0.02, durSec * 0.2);
  const release = Math.min(0.08, durSec * 0.35);
  const sustain = 0.55;

  g.gain.setValueAtTime(0.0001, now);
  g.gain.exponentialRampToValueAtTime(1.0, now + attack);
  g.gain.exponentialRampToValueAtTime(sustain, now + attack + 0.04);
  g.gain.setValueAtTime(sustain, now + Math.max(attack + 0.04, durSec - release));
  g.gain.exponentialRampToValueAtTime(0.0001, now + durSec);

  osc.frequency.setValueAtTime(freq, now);

  osc.connect(g);
  g.connect(masterGain);

  osc.start(now);
  osc.stop(now + durSec + 0.02);

  // If user stops, kill quickly
  if (stopToken.stop) {
    try { osc.stop(audioCtx.currentTime + 0.01); } catch {}
  }
}

async function playSong(song) {
  ensureAudio();
  if (audioCtx.state === "suspended") await audioCtx.resume();

  // stop any existing playback
  currentStopToken.stop = true;
  currentStopToken = { stop: false };

  el.btnStop.disabled = false;
  el.btnPlay.disabled = true;

  const bpm = song.tempo;
  const beatSec = 60 / bpm;

  let t = audioCtx.currentTime + 0.05;

  // Flatten events in order
  const events = song.measuresOut.flat();

  for (const ev of events) {
    if (currentStopToken.stop) break;

    const durSec = ev.beats * beatSec;

    if (ev.type === "note") {
      const midi = midiFromLetter(ev.letter, ev.acc, ev.octave);
      const freq = freqFromMidi(midi);
      scheduleTone({ t0: t, durSec, freq, stopToken: currentStopToken });
    }
    // rest = do nothing

    t += durSec;
  }

  // re-enable play after estimated end (unless stopped)
  const totalSec = events.reduce((s, ev) => s + ev.beats * beatSec, 0);
  setTimeout(() => {
    if (!currentStopToken.stop) {
      el.btnPlay.disabled = false;
      el.btnStop.disabled = true;
    }
  }, Math.max(200, totalSec * 1000));
}

function stopSong() {
  currentStopToken.stop = true;
  el.btnPlay.disabled = false;
  el.btnStop.disabled = true;
}

/* ------------------------- App Orchestration ------------------------- */

let currentSong = null;
let isGenerating = false;

function setRunOutputs({ measures, key, tempo }) {
  el.outMeasures.textContent = String(measures);
  el.outKey.textContent = key;
  el.outTempo.textContent = String(tempo);
}

function setProgressText(stepIndex, totalSteps, measureIndex) {
  el.progress.textContent = `card ${stepIndex + 1}/${totalSteps} • measure ${measureIndex + 1}/${currentSong.measures}`;
}

function disableControls(disabled) {
  el.btnGenerate.disabled = disabled;
  el.btnInstant.disabled = disabled;
  if (disabled) {
    el.btnPlay.disabled = true;
    el.btnStop.disabled = true;
  }
}

async function generateAnimated() {
  if (isGenerating) return;
  isGenerating = true;
  disableControls(true);
  stopSong();

  // Roll dice
  const measures = rollD20();
  const d2 = roll2D6();
  const key = KEY_BY_2D6[d2.sum] ?? "C";
  const d6 = rollD6();
  const tempo = TEMPO_BY_D6[d6] ?? 120;

  // Animate dice in the requested order: d20, 2d6, 1d6
  await animateRoll(el.dieD20, 20, measures, 850);
  await Promise.all([
    animateRoll(el.die2D6A, 6, d2.a, 650),
    animateRoll(el.die2D6B, 6, d2.b, 650),
  ]);
  await animateRoll(el.dieD6, 6, d6, 650);

  setRunOutputs({ measures, key, tempo });

  // Generate song from deck
  currentSong = generateSongSpec({ measures, key, tempo });

  // Render blank/partial initially
  renderSheet(currentSong, { partialUpToStep: -1 });
  el.lastResult.textContent = "—";
  el.progress.textContent = "starting…";

  // Animate card draws and progressively fill the sheet
  const steps = currentSong.animationSteps;
  for (let s = 0; s < steps.length; s++) {
    const step = steps[s];
    await animateCardDraw(step.card);

    el.lastResult.textContent = step.produced;
    setProgressText(s, steps.length, step.measureIndex);

    // re-render partially up to this event
    renderSheet(currentSong, { partialUpToStep: s });

    // pace: faster for long pieces
    const delay = steps.length > 140 ? 65 : (steps.length > 80 ? 95 : 130);
    await sleep(delay);
  }

  // Finished
  el.progress.textContent = `done • ${currentSong.measures} measures`;
  el.btnPlay.disabled = false;
  el.btnStop.disabled = true;

  disableControls(false);
  isGenerating = false;
}

function generateInstant() {
  if (isGenerating) return;
  isGenerating = true;
  disableControls(true);
  stopSong();

  const measures = rollD20();
  const d2 = roll2D6();
  const key = KEY_BY_2D6[d2.sum] ?? "C";
  const d6 = rollD6();
  const tempo = TEMPO_BY_D6[d6] ?? 120;

  setDie(el.dieD20, measures);
  setDie(el.die2D6A, d2.a);
  setDie(el.die2D6B, d2.b);
  setDie(el.dieD6, d6);
  setRunOutputs({ measures, key, tempo });

  currentSong = generateSongSpec({ measures, key, tempo });
  renderSheet(currentSong);
  el.drawnCard.classList.add("hidden");
  el.lastResult.textContent = "generated instantly";
  el.progress.textContent = `done • ${currentSong.measures} measures`;

  el.btnPlay.disabled = false;
  el.btnStop.disabled = true;

  disableControls(false);
  isGenerating = false;
}

/* ------------------------- Wire UI ------------------------- */

el.btnGenerate.addEventListener("click", generateAnimated);
el.btnInstant.addEventListener("click", generateInstant);

el.btnPlay.addEventListener("click", async () => {
  if (!currentSong) return;
  await playSong(currentSong);
});
el.btnStop.addEventListener("click", () => stopSong());

// First render (empty)
resetSheet();
el.progress.textContent = "press Generate";
