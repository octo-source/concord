// Transcript ingestion: VTT (hour-format timestamps, <v Speaker> voice tags),
// SRT (comma decimals, "Speaker: text" prefixes), and Zoom/Otter-style JSON.
// Consecutive cues from the same speaker merge into a single turn.
import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { ConcordError } from "../core/errors.js";

// "01:02:03.500", "02:03.500", "00:00:01,000", "1.2", 1.2 -> seconds
export function toSeconds(v) {
  if (typeof v === "number") return v;
  if (v == null) return null;
  const s = String(v).trim().replace(",", ".");
  if (/^\d+(\.\d+)?$/.test(s)) return parseFloat(s);
  const m = /^(?:(\d{1,3}):)?(\d{1,2}):(\d{1,2}(?:\.\d+)?)$/.exec(s);
  if (!m) return null;
  const h = m[1] !== undefined ? parseInt(m[1], 10) : 0;
  return h * 3600 + parseInt(m[2], 10) * 60 + parseFloat(m[3]);
}

const SPEAKER_PREFIX = /^([A-Z][\w .'-]{0,40}?):\s+(.*)$/s;

function cueSpeakerText(rawText) {
  // <v Speaker>text</v> voice tag (VTT)
  const vm = /^<v(?:\.[^ >]*)?\s+([^>]+)>\s*([\s\S]*)$/.exec(rawText);
  if (vm) return { speaker: vm[1].trim(), text: vm[2].replace(/<\/v>\s*$/, "").trim() };
  // "Speaker: text" prefix (common in SRT and Zoom captions)
  const pm = SPEAKER_PREFIX.exec(rawText);
  if (pm) return { speaker: pm[1].trim(), text: pm[2].trim() };
  return { speaker: null, text: rawText.trim() };
}

function stripTags(s) {
  return s.replace(/<[^>]*>/g, "").trim();
}

// Merge consecutive same-speaker cues into turns — but only when the silence
// between them is short. A same-speaker cue that starts more than
// maxMergeGapSeconds after the previous one ends is a NEW turn (an hour-long
// gap is a different moment in the meeting, not one continuous utterance).
const DEFAULT_MAX_MERGE_GAP_SECONDS = 30;

function mergeCues(cues, maxMergeGapSeconds = DEFAULT_MAX_MERGE_GAP_SECONDS) {
  const turns = [];
  for (const cue of cues) {
    if (!cue.text) continue;
    const last = turns[turns.length - 1];
    // Unknown timestamps (null) cannot prove a gap, so they merge.
    const gap = last && cue.t0 != null && last.t1 != null ? cue.t0 - last.t1 : 0;
    // Consecutive cues WITHOUT speakers intentionally do NOT merge: stored
    // turns coerce a null speaker to "Speaker" while incoming cues keep null,
    // so this check fails for them. Anonymous captions are often arbitrary
    // mid-sentence breaks; merging them would fuse the whole file into one turn.
    if (last && last.speaker === cue.speaker && gap <= maxMergeGapSeconds) {
      last.text += (last.text ? " " : "") + cue.text;
      last.t1 = cue.t1 ?? last.t1;
    } else {
      turns.push({ speaker: cue.speaker ?? "Speaker", t0: cue.t0, t1: cue.t1, text: cue.text });
    }
  }
  return turns;
}

function splitBlocks(raw) {
  return raw.replace(/\r\n?/g, "\n").split(/\n{2,}/).map((b) => b.trim()).filter(Boolean);
}

const TIMING = /(\S+)\s+-->\s+(\S+)/;

export function parseVTT(raw, issues = []) {
  const cues = [];
  for (const block of splitBlocks(raw)) {
    if (/^WEBVTT/.test(block) || /^(NOTE|STYLE|REGION)\b/.test(block)) continue;
    const lines = block.split("\n");
    let ti = lines.findIndex((l) => TIMING.test(l));
    if (ti === -1) {
      issues.push({ kind: "bad_cue", detail: `no timing line in block: ${lines[0]?.slice(0, 40)}` });
      continue;
    }
    const [, a, b] = TIMING.exec(lines[ti]);
    const t0 = toSeconds(a);
    const t1 = toSeconds(b);
    if (t0 === null || t1 === null) {
      issues.push({ kind: "bad_timestamp", detail: lines[ti].slice(0, 60) });
      continue;
    }
    const body = lines.slice(ti + 1).join("\n").trim();
    const { speaker, text } = cueSpeakerText(body);
    cues.push({ speaker, t0, t1, text: stripTags(text) });
  }
  return cues;
}

export function parseSRT(raw, issues = []) {
  return parseVTT(raw, issues); // identical block structure; toSeconds handles commas
}

// Tolerant Zoom/Otter-style JSON: find the array of segments under common
// keys, then read speaker/time/text from common field aliases.
export function parseZoomJSON(raw, issues = []) {
  let data;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    throw new ConcordError("BAD_JSON", `transcript JSON does not parse: ${e.message}`);
  }
  let segs = null;
  if (Array.isArray(data)) segs = data;
  else if (data && typeof data === "object") {
    for (const key of ["transcripts", "transcript", "segments", "timeline", "results", "monologues", "utterances"]) {
      if (Array.isArray(data[key])) {
        segs = data[key];
        break;
      }
    }
  }
  if (!segs) throw new ConcordError("BAD_TRANSCRIPT", "no segment array found in transcript JSON", { keys: Object.keys(data || {}) });
  const cues = [];
  for (const seg of segs) {
    if (!seg || typeof seg !== "object") continue;
    const speaker = seg.speaker ?? seg.speaker_name ?? seg.username ?? seg.user_name ?? seg.name ?? null;
    let t0 = toSeconds(seg.start_time ?? seg.start ?? seg.ts ?? seg.t0 ?? seg.offset);
    let t1 = toSeconds(seg.end_time ?? seg.end ?? seg.end_ts ?? seg.t1);
    if (t1 === null && t0 !== null && seg.duration != null) {
      const d = toSeconds(seg.duration);
      if (d !== null) t1 = t0 + d;
    }
    const rawText = seg.text ?? seg.caption ?? seg.words ?? "";
    // Otter/Rev-style `words` arrays: [{text}, {word}, "literal", ...] — join
    // the word strings; String() on the array would yield "[object Object]".
    const text = Array.isArray(rawText)
      ? rawText
          .map((w) => w?.text ?? w?.word ?? (typeof w === "string" ? w : ""))
          .map((w) => String(w).trim())
          .filter(Boolean)
          .join(" ")
          .trim()
      : String(rawText).trim();
    if (!text) {
      issues.push({ kind: "empty_segment", detail: "segment without text skipped" });
      continue;
    }
    cues.push({ speaker: speaker ? String(speaker).trim() : null, t0, t1, text });
  }
  return cues;
}

// parse(filePath, {maxMergeGapSeconds}) — the option overrides the default
// 30s same-speaker merge window.
export async function parse(filePath, { maxMergeGapSeconds } = {}) {
  let raw;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (e) {
    throw new ConcordError("FILE_READ", `cannot read ${filePath}: ${e.message}`, { filePath });
  }
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
  const ext = extname(filePath).toLowerCase();
  const issues = [];
  let cues;
  if (ext === ".vtt" || /^﻿?WEBVTT/.test(raw)) cues = parseVTT(raw, issues);
  else if (ext === ".srt") cues = parseSRT(raw, issues);
  else if (ext === ".json" || raw.trimStart().startsWith("{") || raw.trimStart().startsWith("[")) cues = parseZoomJSON(raw, issues);
  else throw new ConcordError("BAD_TRANSCRIPT", `unrecognized transcript format: ${ext || "no extension"}`, { filePath });
  const turns = mergeCues(cues, maxMergeGapSeconds ?? DEFAULT_MAX_MERGE_GAP_SECONDS);
  if (turns.length === 0) issues.push({ kind: "empty", detail: "no turns extracted" });
  return { turns, issues };
}
