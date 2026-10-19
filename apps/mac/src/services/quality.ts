// Recording quality: turns microphone facts (the device, live statistics from the native recorder, and the
// engine's measurements of a finished take) into issues the Record screen shows, with what to do about each.
import type { MicDevice, MicStats } from "../../modules/zunos-native";
import type { AudioMeasure, MicDeviceInfo, MicIssue, MicIssueCode, RoomCheck, TakeQuality } from "../shared/types";

/** Seconds at the start of every take the user is asked to stay quiet: the room tone. */
export const ROOM_SECONDS = 1.5;

// Thresholds (dBFS unless noted).
const NOISY_ROOM_DB = -50; // noise floor above this: a noisy room
const VERY_NOISY_ROOM_DB = -38;
const LOW_SNR_DB = 25; // speech this far above the background or less: noisy for training
const BAD_SNR_DB = 12;
const QUIET_SPEECH_DB = -40; // active speech level below this: too quiet
const VERY_QUIET_SPEECH_DB = -50;
const LONG_SILENCE_S = 8;
const POPS = 3;
const GATED_PCT = 2;
const LOW_INPUT_VOLUME = 0.3;
const NARROWBAND_HZ = 7000; // a mic path that stops below this is phone quality (8/16 kHz Bluetooth)
const MIDBAND_HZ = 13000; // 24 kHz Bluetooth (AirPods): usable, not full band
const ECHO_S = 0.6;

const issue = (code: MicIssueCode, severity: MicIssue["severity"], title: string, detail: string): MicIssue => ({ code, severity, title, detail });

const PICK_MIC = "Pick the MacBook microphone or a wired/USB mic in System Settings → Sound → Input.";

export function deviceInfo(d: MicDevice | null | undefined): MicDeviceInfo | null {
  if (!d) return null;
  return {
    name: d.name ?? null, transport: d.transport ?? "unknown", sampleRate: d.sampleRate ?? null,
    inputVolume: d.inputVolume ?? null, micMode: d.micMode ?? null,
  };
}

/** Issues that follow from the device alone (shown before and during recording). */
export function deviceIssues(d: MicDeviceInfo | null): MicIssue[] {
  if (!d) return [issue("noInput", "bad", "No microphone", "macOS reports no input device. Connect a microphone or check System Settings → Sound → Input.")];
  const out: MicIssue[] = [];
  const name = d.name ? `“${d.name}”` : "This microphone";
  if (d.transport === "bluetooth" || d.transport === "bluetoothLE") {
    out.push(issue("bluetooth", "warn", "Bluetooth microphone",
      `${name} is a Bluetooth mic. AirPods and other headsets send the microphone at phone-call quality and often process it, so your recordings lose the detail the voice model learns from. ${PICK_MIC}`));
  } else if (d.sampleRate && d.sampleRate < 32000) {
    out.push(issue("narrowband", "warn", "Low-quality input",
      `${name} records at ${Math.round(d.sampleRate / 1000)} kHz, which cuts off part of your voice. ${PICK_MIC}`));
  }
  if (d.transport === "continuity") {
    out.push(issue("continuity", "info", "iPhone microphone",
      "You're recording through your iPhone (Continuity). It works, but keep the phone still and at the same distance for every take."));
  }
  if (d.transport === "virtual" || d.transport === "aggregate") {
    out.push(issue("virtualDevice", "info", "Virtual input",
      `${name} is a virtual or combined device, which may filter or resample your voice. A real microphone gives cleaner training data.`));
  }
  if (d.micMode === "voiceIsolation" || d.micMode === "wideSpectrum") {
    out.push(issue("micMode", "info", d.micMode === "voiceIsolation" ? "Voice Isolation is on" : "Wide Spectrum is on",
      "macOS's Mic Mode is set in Control Center. zunos records the raw microphone, but switch Mic Mode back to Standard so dictation and recordings sound the same."));
  }
  if (d.inputVolume != null && d.inputVolume < LOW_INPUT_VOLUME) {
    out.push(issue("lowInputVolume", "warn", "Input volume is low",
      `The input volume for ${name} is at ${Math.round(d.inputVolume * 100)}%. Raise it to about 75% in System Settings → Sound → Input.`));
  }
  return out;
}

/** Issues from the live statistics while the user speaks (or stays quiet for the room tone). */
export function liveIssues(s: MicStats, phase: "room" | "recording", roomSeconds: number): MicIssue[] {
  const out: MicIssue[] = [];
  const inRoom = phase === "room" || s.elapsed < roomSeconds;
  if (s.clippingNow || s.clipEvents > 0) {
    out.push(issue("clipping", "bad", "Too loud: clipping",
      "Your voice is hitting the microphone's limit, which distorts it. Move back a little or lower the input volume in System Settings → Sound → Input."));
  } else if (s.loudPct > 5 || s.peakDb > -1) {
    out.push(issue("tooLoud", "warn", "Very loud", "Your voice is close to the microphone's limit. Back off a few centimetres."));
  }
  if (s.roomSpoken && phase === "recording" && s.elapsed < roomSeconds + 2) {
    out.push(issue("roomSpoken", "info", "Wait a moment before reading",
      "zunos listens to the quiet room for the first second and a half of each take. Start reading when it says so."));
  }
  if (s.noiseDb > VERY_NOISY_ROOM_DB) {
    out.push(issue("noisyRoom", "bad", "Very noisy room",
      "There's a lot of background sound (fan, traffic, voices, music). Move somewhere quieter, close windows, or switch off fans before recording."));
  } else if (s.noiseDb > NOISY_ROOM_DB && (s.snrDb == null || s.snrDb < LOW_SNR_DB)) {
    out.push(issue("noisyRoom", "warn", "Noisy room",
      "zunos can hear background sound. It cleans what it can, but a quieter room or a mic closer to you records better."));
  }
  if (!inRoom && s.speechDb != null && s.speechSec > 2) {
    if (s.snrDb != null && s.snrDb < BAD_SNR_DB) {
      out.push(issue("lowSnr", "bad", "Your voice is buried in noise",
        `Your voice is only ${Math.round(s.snrDb)} dB above the background. Get closer to the mic (about a hand's width to 30 cm) or find a quieter room.`));
    } else if (s.speechDb < VERY_QUIET_SPEECH_DB) {
      out.push(issue("tooQuiet", "bad", "Too quiet", "zunos can barely hear you. Speak up, move closer to the microphone, or raise the input volume."));
    } else if (s.speechDb < QUIET_SPEECH_DB) {
      out.push(issue("tooQuiet", "warn", "A bit quiet", "Speak a little louder or move closer to the microphone (about a hand's width to 30 cm)."));
    }
  }
  if (s.pops >= POPS) {
    out.push(issue("pops", "info", "Popping sounds",
      "Breath is hitting the microphone on p and b sounds. Turn the mic slightly to the side of your mouth, or move back a little."));
  }
  if (s.gatedPct > GATED_PCT) {
    out.push(issue("processedMic", "warn", "The microphone mutes itself",
      `This microphone cuts to silence between words, which means it is processing your voice (common on Bluetooth headsets). ${PICK_MIC}`));
  }
  if (phase === "recording" && s.speechSec > 1 && s.silenceSec > LONG_SILENCE_S) {
    out.push(issue("longSilence", "info", "Still there?",
      `Nothing for ${Math.round(s.silenceSec)} seconds. Keep reading, or stop the take; long silences add nothing to training.`));
  }
  return out;
}

const DEVICE_CHANGED = issue("deviceChanged", "bad", "The microphone changed",
  "The input device changed during the take, so the recording stopped receiving audio. Record this take again.");
export const deviceChangedIssue = () => DEVICE_CHANGED;

/** Room check: listen a few seconds with the user quiet, then judge the room and the device. */
export function roomVerdict(stats: MicStats | undefined, m: AudioMeasure | null, device: MicDeviceInfo | null): RoomCheck {
  const issues = deviceIssues(device);
  const noiseDb = m?.noiseDb ?? stats?.noiseDb ?? null;
  if (stats?.roomSpoken) {
    issues.push(issue("roomSpoken", "info", "Sounded like talking",
      "The room check heard speech or a loud sound. Stay quiet for the few seconds it listens, then check again."));
  }
  if (noiseDb != null && noiseDb > VERY_NOISY_ROOM_DB) {
    issues.push(issue("noisyRoom", "bad", "Very noisy room", "There's a lot of background sound. Move somewhere quieter, close windows, or switch off fans."));
  } else if (noiseDb != null && noiseDb > NOISY_ROOM_DB) {
    issues.push(issue("noisyRoom", "warn", "Some background noise",
      "zunos can hear the room. It cleans what it can, but keep the mic close (about a hand's width to 30 cm) so your voice stays well above it."));
  }
  if (m?.humHz) {
    issues.push(issue("hum", "info", `Electrical hum (${m.humHz} Hz)`,
      "There's a mains hum, often from a charger, a desk lamp or a cable near the mic. zunos removes it, but unplugging the source is better."));
  }
  if ((m?.lowShare ?? 0) > 0.3) {
    issues.push(issue("rumble", "info", "Low rumble", "There's a low rumble (air conditioning, traffic, or the desk being bumped). zunos filters it."));
  }
  if ((m?.gatedPct ?? stats?.gatedPct ?? 0) > 20) {
    issues.push(issue("processedMic", "warn", "The microphone mutes itself",
      `This microphone sends pure silence when nobody talks, which means it processes your voice. ${PICK_MIC}`));
  }
  const verdict = issues.some((i) => i.severity === "bad") ? "noisy" : issues.some((i) => i.severity === "warn") ? "ok" : "good";
  return { noiseDb, humHz: m?.humHz ?? null, device, issues, verdict };
}

/** Issues and verdict of a finished take, from the engine's measurements of the raw take. */
export function takeVerdict(
  m: AudioMeasure | null,
  live: MicStats | undefined,
  device: MicDeviceInfo | null,
): { verdict: TakeQuality["verdict"]; issues: MicIssue[] } {
  const issues: MicIssue[] = [];
  const add = (i: MicIssue) => !issues.some((x) => x.code === i.code) && issues.push(i);
  deviceIssues(device).filter((i) => i.code !== "continuity" && i.code !== "micMode").forEach(add);
  if (m) {
    if (m.clippedPct > 0.05 || m.clipEvents >= 3) {
      add(issue("clipping", m.clippedPct > 0.5 ? "bad" : "warn", "Clipped",
        "Parts of this take hit the microphone's limit and are distorted. Move back a little or lower the input volume, and record it again."));
    }
    if (m.snrDb != null && m.snrDb < BAD_SNR_DB) {
      add(issue("lowSnr", "bad", "Too much background noise",
        `Your voice was only ${Math.round(m.snrDb)} dB above the background. zunos cleaned it for voice cloning, but record again closer to the mic or in a quieter room for better training data.`));
    } else if (m.snrDb != null && m.snrDb < LOW_SNR_DB) {
      add(issue("noisyRoom", "warn", "Some background noise",
        `Your voice was ${Math.round(m.snrDb)} dB above the background. zunos cleaned the copy used for voice cloning; a quieter room would still help.`));
    }
    if (m.speechDb != null && m.speechDb < VERY_QUIET_SPEECH_DB) {
      add(issue("tooQuiet", "bad", "Very quiet", "This take is very quiet. Speak up or move closer to the microphone, and record it again."));
    } else if (m.speechDb != null && m.speechDb < QUIET_SPEECH_DB) {
      add(issue("tooQuiet", "warn", "Quiet", "This take is quiet. zunos evened out the level; next time move a little closer."));
    }
    if (m.bandwidthHz != null && m.bandwidthHz < NARROWBAND_HZ) {
      add(issue("narrowband", "bad", "Phone-quality audio",
        `This take carries nothing above ${(m.bandwidthHz / 1000).toFixed(1)} kHz, typical of a Bluetooth headset mic. ${PICK_MIC}`));
    } else if (m.bandwidthHz != null && m.bandwidthHz < MIDBAND_HZ) {
      add(issue("narrowband", "warn", "Reduced audio quality",
        `This take stops at ${(m.bandwidthHz / 1000).toFixed(1)} kHz, typical of AirPods and other Bluetooth mics. ${PICK_MIC}`));
    }
    if ((m.gatedPct ?? 0) > GATED_PCT) {
      add(issue("processedMic", "warn", "Processed microphone",
        `The microphone cut to silence between words, so it is processing your voice. ${PICK_MIC}`));
    }
    if (m.reverbSec != null && m.reverbSec >= ECHO_S) {
      add(issue("echo", "warn", "Echoey room",
        "The room adds a noticeable echo. Record somewhere with soft furnishings (curtains, a sofa, a closet of clothes), or sit closer to the mic."));
    }
    if (m.pops >= POPS) add(issue("pops", "info", "Popping sounds", "Breath hit the microphone on p and b sounds. Turn the mic slightly to the side of your mouth."));
    if (m.humHz) add(issue("hum", "info", `Electrical hum (${m.humHz} Hz)`, "zunos removed a mains hum from the cleaned copy. A charger or lamp cable near the mic is the usual source."));
  } else if (live) {
    liveIssues(live, "recording", ROOM_SECONDS).filter((i) => i.code !== "longSilence" && i.code !== "roomSpoken").forEach(add);
  }
  const verdict = issues.some((i) => i.severity === "bad") ? "redo" : issues.some((i) => i.severity === "warn") ? "ok" : "good";
  return { verdict, issues };
}
