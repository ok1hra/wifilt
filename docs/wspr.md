# WSPR — the protocol WIFILT implements

The description of WSPR that `data/wspr-core.js` was written from. It covers
the Type 1 message only, which is what the encoder produces: a callsign, a
four-character Maidenhead locator and a power level.

WSPR itself was defined by Joe Taylor (K1JT) and the WSJT-X development team;
the constants below are theirs. The encoder in this repository is original
code, and the golden vectors it is tested against (`tools/fixtures/wspr-*.txt`)
come from WSJT-X's own `wsprcode`.

---

## 1. Message parameters

A standard WSPR message is:

```text
<CALLSIGN> <LOCATOR> <POWER_DBM>
```

For example:

```text
OK1ABC JN79 30
```

Its data content is 50 bits:

- 28 bits for the callsign,
- 15 bits for the four-character Maidenhead locator,
- 7 bits for the power and the message type.

After convolutional coding, interleaving and merging with the synchronisation
vector, 162 symbols with values `0–3` remain. WSPR uses continuous 4-FSK at a
symbol rate of `12000 / 8192`, which is exactly `1.46484375 Bd`. The same value
is the spacing between adjacent tones. A complete message lasts about
`110.592 s`.

```text
Symbol count:     162
Symbol length:    8192 / 12000 s
                  ≈ 0.6826666667 s

Symbol rate:      12000 / 8192 Bd
                  = 1.46484375 Bd

Tone spacing:     1.46484375 Hz

Total length:     162 × 8192 / 12000
                  = 110.592 s

Approx. bandwidth: 6 Hz
```

On the air a WSPR transmission nominally starts one second after the top of an
even UTC minute. Slot timing is not part of the encoder; a separate scheduler
owns it (see [section 6](#6-slot-timing)).

---

## 2. Input validation

### 2.1 Callsign

Only the standard WSPR Type 1 message is supported. The validator:

- upper-cases the callsign,
- strips leading and trailing whitespace,
- rejects unsupported characters,
- checks the format against the six-position WSPR field,
- inserts the internal padding the encoder expects,
- rejects compound callsigns carrying a prefix or a suffix.

Accepted:

```text
K1ABC
OK1ABC
G4JNT
```

Rejected:

```text
OK1ABC/P
EA/OK1ABC
OK1ABC/7
```

Compound callsigns and six-character locators need other message types or a
multi-transmission sequence, so they are a separate extension rather than part
of this path.

### 2.2 Locator

A four-character Maidenhead locator:

```text
[A-R][A-R][0-9][0-9]
```

For example `JN79`. Normalisation is `locator.trim().toUpperCase()`.

### 2.3 Power

Power is given in dBm. The standard values are:

```js
const WSPR_POWER_LEVELS = [
  0, 3, 7, 10, 13, 17, 20, 23, 27, 30,
  33, 37, 40, 43, 47, 50, 53, 57, 60,
];
```

The validator must not silently round the input. It may offer the nearest
legal value instead:

```text
32 dBm is not a supported power level.
The nearest standard value is 33 dBm.
```

---

## 3. Encoding

The encoder always produces exactly 162 symbols, each an integer `0`, `1`, `2`
or `3`.

```text
normalise the input
        ↓
pack the callsign          (28 bits)
        ↓
pack the locator and power (15 + 7 bits)
        ↓
assemble the 50-bit message
        ↓
convolutional coding, r=1/2, K=32
        ↓
bit interleaving
        ↓
merge the data with the synchronisation vector
        ↓
162 symbols, 0–3
```

### 3.1 Convolutional coding

```text
Constraint length K = 32
Code rate           r = 1/2
```

The 50 message bits are followed by a 31-bit zero tail, so
`(50 + 31) × 2 = 162` bits come out. The generator polynomials are:

```js
const POLY_0 = 0xf2d05351 >>> 0;
const POLY_1 = 0xe4613c47 >>> 0;
```

Every shift has to stay unsigned, because JavaScript's `<<` yields a signed
32-bit result:

```js
registerValue = ((registerValue << 1) | inputBit) >>> 0;
```

The parity function:

```js
function parity32(value) {
  value >>>= 0;
  value ^= value >>> 16;
  value ^= value >>> 8;
  value ^= value >>> 4;
  value &= 0x0f;

  return (0x6996 >>> value) & 1;
}
```

### 3.2 Interleaving

The destination index is the bit-reversal of the source counter; indices at or
above 162 are skipped.

```js
const output = new Uint8Array(162);
let sourceIndex = 0;

for (let i = 0; i < 256 && sourceIndex < 162; i++) {
  const destinationIndex = reverse8Bits(i);

  if (destinationIndex < 162) {
    output[destinationIndex] = encodedBits[sourceIndex];
    sourceIndex++;
  }
}
```

### 3.3 Synchronisation vector

Each symbol combines one data bit with one sync bit:

```js
symbol = syncBit + 2 * dataBit;
```

```text
data sync  symbol
  0    0      0
  0    1      1
  1    0      2
  1    1      3
```

The 162-entry sync vector is a fixed constant of the protocol. In
`data/wspr-core.js` it is stored packed MSB-first into 21 bytes rather than as
162 array entries, purely to save filesystem space.

---

## 4. Audio generation

### 4.1 Sample rate

```text
48 000 Hz
```

That rate makes the samples per symbol an exact integer, which keeps the
symbol boundaries free of accumulated rounding error:

```text
48000 × 8192 / 12000 = 32768 samples per symbol
162 × 32768          = 5 308 416 samples total
                     = 110.592 s
```

### 4.2 Tone frequencies

```js
const WSPR_TONE_SPACING = 12000 / 8192;

frequency = baseFrequencyHz + symbol * WSPR_TONE_SPACING;
```

With a 1500 Hz base frequency:

```text
symbol 0: 1500.00000000 Hz
symbol 1: 1501.46484375 Hz
symbol 2: 1502.92968750 Hz
symbol 3: 1504.39453125 Hz
```

### 4.3 Phase continuity

WSPR is continuous-phase 4-FSK: the oscillator phase carries across the symbol
boundary rather than restarting, because a phase jump spreads the signal well
beyond its 6 Hz occupied bandwidth.

```js
const TWO_PI = 2 * Math.PI;

let phase = 0;
let writeIndex = 0;

for (const symbol of symbols) {
  const frequency = baseFrequencyHz + symbol * WSPR_TONE_SPACING;
  const phaseIncrement = TWO_PI * frequency / sampleRate;

  for (let i = 0; i < SAMPLES_PER_SYMBOL; i++) {
    samples[writeIndex++] = amplitude * Math.sin(phase);

    phase += phaseIncrement;

    if (phase >= TWO_PI) {
      phase -= TWO_PI;
    }
  }
}
```

### 4.4 Edge ramp

A 5 ms raised-cosine ramp on the first and last samples removes the key click
that a hard start and stop would otherwise produce:

```js
function applyEdgeRamp(samples, sampleRate, rampMs = 5) {
  const count = Math.round(sampleRate * rampMs / 1000);

  for (let i = 0; i < count; i++) {
    const gain = 0.5 - 0.5 * Math.cos(Math.PI * i / count);

    samples[i] *= gain;
    samples[samples.length - 1 - i] *= gain;
  }
}
```

---

## 5. Constants as implemented

`data/wspr-core.js` uses exactly these values:

```js
const SYMBOL_COUNT       = 162;
const SAMPLE_RATE        = 48000;
const SAMPLES_PER_SYMBOL = 32768;                            // exact
const SIGNAL_SAMPLES     = SYMBOL_COUNT * SAMPLES_PER_SYMBOL; // 5 308 416
const TONE_SPACING_HZ    = 12000 / 8192;                     // 1.46484375
const DURATION_S         = SIGNAL_SAMPLES / SAMPLE_RATE;     // 110.592
```

---

## 6. Slot timing

WSPR transmissions are aligned to even UTC minutes:

1. work in UTC,
2. find the next even minute,
3. set the second to `01`,
4. leave headroom for the audio pipeline to start.

```text
Now:        12:03:20 UTC
Next slot:  12:04:01 UTC
```

---

## 7. Verification

The encoder is checked against golden vectors produced by WSJT-X's `wsprcode`,
committed in `tools/fixtures/`:

```bash
node tools/wspr-encoder-smoke.js
```

All four intermediate stages are compared, not only the final symbols, so a
break in (say) the interleaver names the interleaver rather than reporting a
generic mismatch. Regenerate a fixture with:

```bash
wsprcode "OK1HRA JN79 37" > tools/fixtures/wspr-OK1HRA_JN79_37.txt
```

Related checks:

```bash
node tools/wspr-schedule-smoke.js   # slot prediction and the band timetable
node tools/wspr-audio-smoke.js      # survival through the firmware's TX audio chain
```
