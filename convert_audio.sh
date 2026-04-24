#!/bin/bash
# Converts every source audio file under public/audio/ into the two-format
# pair the game actually loads (OGG primary, MP3 fallback), applying any
# per-file trims, fades, or effects discussed during audio wiring.
#
# Safe to re-run: each conversion is guarded by a `[ -f "$src" ]` check,
# so missing source files just print a skip line instead of aborting.
# Source is deleted ONLY if BOTH the OGG and MP3 writes exit cleanly —
# a failed ffmpeg leaves the source in place so you can re-run after
# fixing whatever was wrong.
#
# Run from the repo root:
#     bash convert_audio.sh

set -u

cd "$(dirname "$0")/public/audio" || {
  echo "public/audio/ not found — run this script from the repo root."
  exit 1
}

echo "[convert] working in $(pwd)"
echo

# ---------- shared filter chains ----------
SFX_AF="silenceremove=start_periods=1:start_threshold=-50dB,loudnorm=I=-16:TP=-1.5:LRA=11"
OGG_OPTS="-c:a libvorbis -b:a 96k -ar 44100 -ac 1"
MP3_OPTS="-c:a libmp3lame -b:a 96k -ar 44100 -ac 1"

# ---------- helpers ----------

# bc emits ".496…" (no leading zero) on fractional results. ffmpeg's
# -ss/-t parsers reject that. Normalize to "0.496…" so the args parse.
fix_num() {
  case "$1" in .*) echo "0$1" ;; -.*) echo "-0${1#-}" ;; *) echo "$1" ;; esac
}

pair() {
  # pair <src> <out-base> [<ffmpeg-pre-args>] [<extra-af-suffix>]
  local src="$1" base="$2" pre="${3:-}" af_extra="${4:-}"
  if [ ! -f "$src" ]; then
    echo "  skip $base — '$src' not found"
    return
  fi
  local af="$SFX_AF${af_extra:+,$af_extra}"
  if ffmpeg -loglevel error -y $pre -i "$src" -af "$af" $OGG_OPTS "${base}.ogg" \
   && ffmpeg -loglevel error -y $pre -i "$src" -af "$af" $MP3_OPTS "${base}.mp3"; then
    rm -- "$src"
    echo "  ok   $base"
  else
    echo "  FAIL $base — source kept for retry"
  fi
}

pair_custom_af() {
  # pair_custom_af <src> <out-base> <full-af> [<ffmpeg-pre-args>]
  local src="$1" base="$2" af="$3" pre="${4:-}"
  if [ ! -f "$src" ]; then
    echo "  skip $base — '$src' not found"
    return
  fi
  if ffmpeg -loglevel error -y $pre -i "$src" -af "$af" $OGG_OPTS "${base}.ogg" \
   && ffmpeg -loglevel error -y $pre -i "$src" -af "$af" $MP3_OPTS "${base}.mp3"; then
    rm -- "$src"
    echo "  ok   $base"
  else
    echo "  FAIL $base — source kept for retry"
  fi
}

# ---------- music layers (m4a → ogg/mp3, trimmed to whole 110 BPM cycles) ----------
# Matches both `layer_*.m4a` and `Layer_*.m4a` (capital L). Output files
# are always lowercase `layer_N.ogg` / `.mp3` so PreloadScene's loader
# finds them. LAYER_COUNT in MusicEngine is 3 — layers 1..3 form the bed.
CYCLE=1.0909091
echo "[music layers]"
for f in [Ll]ayer_*.m4a; do
  [ -f "$f" ] || continue
  num="${f#*_}"; num="${num%.m4a}"
  base="layer_${num}"
  DUR=$(ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "$f")
  CYCLES=$(echo "$DUR / $CYCLE" | bc)
  TRIM=$(fix_num "$(echo "$CYCLES * $CYCLE" | bc -l)")
  echo "  ${base}: ${DUR}s → ${CYCLES} cycles (${TRIM}s)"
  if ffmpeg -loglevel error -y -i "$f" -t "$TRIM" -c:a libvorbis -b:a 160k -ar 44100 -ac 1 "${base}.ogg" \
   && ffmpeg -loglevel error -y -i "$f" -t "$TRIM" -c:a libmp3lame -b:a 160k -ar 44100 -ac 1 "${base}.mp3"; then
    rm -- "$f"
  else
    echo "  FAIL ${base} — source kept for retry"
  fi
done

# LAYER_COUNT was lowered from 4 to 3 — the old middle layer (layer_3)
# was too clashing, so if we still have a layer_4 sitting around we drop
# the current layer_3 and promote layer_4 down into its slot. Idempotent:
# second run finds no layer_4 and leaves things alone.
if [ -f "layer_4.ogg" ] || [ -f "layer_4.mp3" ]; then
  rm -f layer_3.ogg layer_3.mp3
  [ -f "layer_4.ogg" ] && mv layer_4.ogg layer_3.ogg
  [ -f "layer_4.mp3" ] && mv layer_4.mp3 layer_3.mp3
  echo "  dropped old layer_3, promoted layer_4 → layer_3"
fi
echo

# ---------- shape_exit (wizardoz swoosh) ----------
echo "[shape_exit]"
pair "419341__wizardoz__swoosh.ogg" "shape_exit"
echo

# ---------- shape_pop (factory shape exit) ----------
echo "[shape_pop]"
pair "Factory_Shape_Exit_001.mp3" "shape_pop"
echo

# ---------- ui_click ----------
echo "[ui_click]"
pair "342200__christopherderp__videogame-menu-button-click (1).wav" "ui_click"
echo

# ---------- funnel_wrong (trim first 0.8s) ----------
echo "[funnel_wrong]"
pair "648462__andreas__wrong-answer.mp3" "funnel_wrong" "-t 0.8"
echo

# ---------- funnel_right (full clip) ----------
echo "[funnel_right]"
pair "243701__ertfelda__correct.wav" "funnel_right"
echo

# ---------- zap (trim first 0.4s) ----------
echo "[zap]"
pair "536741__egomassive__zap.ogg" "zap" "-t 0.4"
echo

# ---------- laser_charge (first 1.1s of cannon charge) ----------
echo "[laser_charge]"
pair "440147__dpren__scifi-gun-mega-charge-cannon.wav" "laser_charge" "-t 1.1"
echo

# ---------- laser_fire (last 2/3 of the explosion) ----------
echo "[laser_fire]"
EXP="47252__deleted_user_364925__bad-explosion.wav"
if [ -f "$EXP" ]; then
  EXP_DUR=$(ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "$EXP")
  EXP_START=$(fix_num "$(echo "$EXP_DUR / 3" | bc -l)")
  pair "$EXP" "laser_fire" "-ss $EXP_START"
else
  echo "  skip laser_fire — '$EXP' not found"
fi
echo

# ---------- laser_beam (half-beat slice starting 1 beat in @ 110 BPM,
#            concatenated with its own time-reversed copy. The final
#            loop is 0.5454s long: forward then reversed. Looped by
#            Phaser, this produces a "→ ← → ← …" alternation where
#            each half-beat iteration flips playback direction.
#            Fades are applied to each half separately so the three
#            seams — fwd→rev, rev→loop-start, and the outer fade-in —
#            all cross zero and don't click.) ----------
echo "[laser_beam]"
SRC_LASER_BEAM="449013__parabolix__jacobs-ladder-from-side.wav"
if [ -f "$SRC_LASER_BEAM" ]; then
  # Pitch-shift down ~3.5 semitones (asetrate=0.82×) and compensate
  # tempo so duration stays at 0.2727s. volume=0.7 pulls the clip
  # down a tad before loudnorm — together the loop reads "deeper
  # and softer" without losing the electric-arc character.
  FC_LASER_BEAM="[0:a]asetrate=44100*0.82,aresample=44100,atempo=1/0.82,volume=0.7,afade=t=in:d=0.004:curve=hsin,afade=t=out:st=0.2687:d=0.004:curve=hsin,asplit=2[fwd][revSrc];[revSrc]areverse[rev];[fwd][rev]concat=n=2:v=0:a=1[out]"
  if ffmpeg -loglevel error -y -ss 0.5455 -t 0.2727 -i "$SRC_LASER_BEAM" -filter_complex "$FC_LASER_BEAM" -map "[out]" $OGG_OPTS laser_beam.ogg \
   && ffmpeg -loglevel error -y -ss 0.5455 -t 0.2727 -i "$SRC_LASER_BEAM" -filter_complex "$FC_LASER_BEAM" -map "[out]" $MP3_OPTS laser_beam.mp3; then
    rm -- "$SRC_LASER_BEAM"
    echo "  ok   laser_beam (fwd + reversed)"
  else
    echo "  FAIL laser_beam — source kept for retry"
  fi
else
  echo "  skip laser_beam — '$SRC_LASER_BEAM' not found"
fi
echo

# ---------- acid_bubble (first 1s, with gentle fade-in and fade-out so
#            shapes skim across pits without a hard "pop" on entry/exit) ----------
echo "[acid_bubble]"
pair "202094__spookymodem__acid-bubbling.wav" "acid_bubble" "-t 1.0" \
  "afade=t=in:d=0.18:curve=hsin,afade=t=out:st=0.82:d=0.18:curve=hsin"
echo

# ---------- firework (level-complete burst) ----------
echo "[firework]"
pair "422079__johnnyguitar01__single-firework.wav" "firework"
echo

# ---------- factory_rotate (first 0.22s of projector — matches the
#            220ms rotation tween in PlayerScene) ----------
echo "[factory_rotate]"
pair "241886__videofueralle__8mm-projector-sound.wav" "factory_rotate" "-t 0.22"
echo

# ---------- click_empty (bush hit, for clicking on nothing) ----------
echo "[click_empty]"
pair "106113__j1987__bushhit.wav" "click_empty"
echo

# ---------- factory_pass (whoosh, plays when a shape enters a factory
#            input funnel) ----------
echo "[factory_pass]"
pair "60013__qubodup__whoosh (1).flac" "factory_pass"
echo

# ---------- victory_fanfare (trumpet flourish at the start of the
#            level-complete banner) ----------
echo "[victory_fanfare]"
pair "456966__funwithsound__success-fanfare-trumpets (1).mp3" "victory_fanfare"
echo

# ---------- acid_pit_tap (first 1s of splooshes — plays on clicking
#            an acid pit in the game, dropping a label on one in the
#            editor, or starting to move one) ----------
echo "[acid_pit_tap]"
pair "693542__dannyraye__splooshes-2.mp3" "acid_pit_tap" "-t 1.0"
echo

# ---------- border_item_tap (cartoon metal hit — plays on clicking a
#            border funnel in the game, dropping a label on one in the
#            editor, or starting to move one) ----------
echo "[border_item_tap]"
pair "209771__johnnyfarmer__metal-hit-cartoon.aiff" "border_item_tap"
echo

# ---------- funnel_suck (windbreaker pop — plays each time a shape is
#            consumed by a red border output funnel, so a steady stream
#            of delivered shapes gets a steady pop cadence) ----------
echo "[funnel_suck]"
pair "607123__vanwinkle3__windbreaker-pop.wav" "funnel_suck"
echo

# ---------- mono downmix pass (idempotent) ----------
# Walks every .ogg / .mp3 in public/audio/ and re-encodes it as
# single-channel in place. Safe to run without the original source
# files — each output is re-encoded from its own stereo self via a
# temp file, then atomic-mv'd back. Files already flagged as mono by
# ffprobe are skipped so repeated runs don't compound artifacts.
# Music layers (layer_*) keep their 160k bitrate; everything else
# drops to the 96k sfx bitrate.
echo "[mono downmix]"
for f in *.ogg *.mp3; do
  [ -f "$f" ] || continue
  channels=$(ffprobe -v error -select_streams a:0 -show_entries stream=channels -of default=noprint_wrappers=1:nokey=1 "$f" 2>/dev/null)
  if [ "$channels" = "1" ]; then
    echo "  skip $f (already mono)"
    continue
  fi
  case "$f" in
    layer_*.ogg)  enc="-c:a libvorbis  -b:a 160k";;
    layer_*.mp3)  enc="-c:a libmp3lame -b:a 160k";;
    *.ogg)        enc="-c:a libvorbis  -b:a 96k";;
    *.mp3)        enc="-c:a libmp3lame -b:a 96k";;
    *) continue;;
  esac
  tmp="_mono_$$_$f"
  if ffmpeg -loglevel error -y -i "$f" -ac 1 -ar 44100 $enc "$tmp"; then
    mv -- "$tmp" "$f"
    echo "  ok   $f → mono"
  else
    rm -f -- "$tmp"
    echo "  FAIL $f"
  fi
done
echo

echo "[done] public/audio/ contents:"
ls -1
