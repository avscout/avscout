// shared/avscout/equipment.js
//
// Single source of truth for AV equipment types. Used by both
// Floorplan-extension's Excel-import filter modal and the AVScout
// surveying app.

// 21 equipment types — alphabetical by label.
// `preselected: true` types are checked by default in the pre-import modal
// on the very first import; thereafter the last user selection wins.
// `excelMatch` is an exact-match alias list (after lowercase + whitespace
// normalisation). NO substring/includes matching — collisions are too easy
// once we have 21 types (e.g. "Audio Processor" includes "Processor"
// which would also match "Video Processor").
const EQUIP_TYPES = [
  { value: 'amplifiers',         label: 'Amplifiers',         emoji: '🎚️', preselected: false,
    excelMatch: ['amplifier', 'amplifiers'] },
  { value: 'audio_processors',   label: 'Audio Processors',   emoji: '🎛️', preselected: false,
    excelMatch: ['audio processor', 'audio processors', 'processor'] },
  { value: 'av_via_usb',         label: 'AV via USB',         emoji: '🔌', preselected: true,
    excelMatch: ['av via usb', 'avviausb'] },
  { value: 'avracks',            label: 'AVRacks',            emoji: '🗄️', preselected: true,
    excelMatch: ['avrack', 'avracks', 'av rack', 'av racks'] },
  { value: 'cameras',            label: 'Cameras',            emoji: '📷', preselected: true,
    excelMatch: ['camera', 'cameras'] },
  { value: 'computers',          label: 'Computers',          emoji: '💻', preselected: false,
    excelMatch: ['computer', 'computers'] },
  { value: 'controllers',        label: 'Controllers',        emoji: '🕹️', preselected: false,
    excelMatch: ['controller', 'controllers'] },
  { value: 'convertors',         label: 'Convertors',         emoji: '🔄', preselected: false,
    excelMatch: ['convertor', 'convertors', 'converter', 'converters'] },
  { value: 'displays',           label: 'Displays',           emoji: '📺', preselected: true,
    excelMatch: ['display', 'displays'] },
  { value: 'endecoders',         label: 'EnDecoders',         emoji: '🔣', preselected: false,
    excelMatch: ['endecoder', 'endecoders', 'encoder', 'encoders', 'decoder', 'decoders', 'en/decoder', 'en/decoders'] },
  { value: 'extenders',          label: 'Extenders',          emoji: '↔️', preselected: false,
    excelMatch: ['extender', 'extenders'] },
  { value: 'interactive_boards', label: 'Interactive Boards', emoji: '📋', preselected: true,
    excelMatch: ['interactive board', 'interactive boards', 'ia board', 'ia boards', 'interactiveboard'] },
  { value: 'led_displays',       label: 'LED Displays',       emoji: '🔆', preselected: true,
    excelMatch: ['led', 'leds', 'led display', 'led displays'] },
  { value: 'loudspeakers',       label: 'LoudSpeakers',       emoji: '📢', preselected: true,
    excelMatch: ['loudspeaker', 'loudspeakers', 'loud speaker', 'loud speakers'] },
  { value: 'microphones',        label: 'Microphones',        emoji: '🎙️', preselected: true,
    excelMatch: ['microphone', 'microphones'] },
  { value: 'monitors',           label: 'Monitors',           emoji: '🖥️', preselected: true,
    excelMatch: ['monitor', 'monitors'] },
  { value: 'operation_panels',   label: 'Operation Panels',   emoji: '📟', preselected: true,
    excelMatch: ['operation panel', 'operation panels'] },
  { value: 'projectors',         label: 'Projectors',         emoji: '📽️', preselected: true,
    excelMatch: ['projector', 'projectors'] },
  { value: 'recorders',          label: 'Recorders',          emoji: '⏺️', preselected: false,
    excelMatch: ['recorder', 'recorders'] },
  { value: 'room_signs',         label: 'Room Signs',         emoji: '🪧', preselected: false,
    excelMatch: ['room sign', 'room signs', 'roomsign', 'roomsigns'] },
  { value: 'screens',            label: 'Screens',            emoji: '🪟', preselected: true,
    excelMatch: ['screen', 'screens'] },
  { value: 'switchers',          label: 'Switchers',          emoji: '🔀', preselected: false,
    excelMatch: ['switcher', 'switchers'] },
  { value: 'video_cards',        label: 'Video Cards',        emoji: '🃏', preselected: false,
    excelMatch: ['video card', 'video cards', 'videocard', 'videocards'] },
  { value: 'video_processor',    label: 'Video Processor',    emoji: '🎞️', preselected: false,
    excelMatch: ['video processor', 'video processors'] },
  { value: 'visualizers',        label: 'Visualizers',        emoji: '🔍', preselected: true,
    excelMatch: ['visualizer', 'visualizers', 'visualiser', 'visualisers'] },
  { value: 'wireless_presentation', label: 'Wireless Presentation', emoji: '📡', preselected: false,
    excelMatch: ['wireless presentation', 'wirelesspresentation'] },
];

function equipEmoji(value) {
  const t = EQUIP_TYPES.find(t => t.value === value);
  return t ? t.emoji : '📍';
}
function equipLabel(value) {
  const t = EQUIP_TYPES.find(t => t.value === value);
  return t ? t.label : value;
}
// Normalise an Excel cell value for matching: lowercase, collapse all
// whitespace runs (incl. NBSP) to single spaces, trim. Returns '' for
// nullish input.
function normaliseExcelType(str) {
  if (str == null) return '';
  return String(str).replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
}

// Stipl's newer export format puts an admin URL in the Equipment Type
// column (e.g. "/admin/data/avrack/106/change/") rather than a
// human-readable label. Extract the slug between /data/ and the numeric
// id so we can match against the same alias table.
//   "/admin/data/avrack/106/change/"        -> "avrack"
//   "/admin/data/wirelesspresentation/3/"   -> "wirelesspresentation"
// Returns null if the input doesn't look like an admin URL.
function extractStiplTypeSlug(str) {
  if (!str) return null;
  const m = /\/admin\/data\/([a-z0-9_]+)\/\d+/i.exec(String(str));
  return m ? m[1].toLowerCase() : null;
}

// Likewise, pull the numeric ID out of the URL. Returns null if absent.
//   "/admin/data/avrack/106/change/" -> "106"
function extractStiplTypeId(str) {
  if (!str) return null;
  const m = /\/admin\/data\/[a-z0-9_]+\/(\d+)/i.exec(String(str));
  return m ? m[1] : null;
}

// Map an Excel "Equipment Type" cell to our internal value key. Handles
// both the legacy human-readable form ("Camera", "AV via USB") and the
// newer admin-URL form ("/admin/data/camera/3/change/"). Returns null if
// neither form matches — caller routes that row into the "Unmatched"
// bucket of the pre-import modal.
function excelTypeToValue(str) {
  const slug = extractStiplTypeSlug(str);
  const norm = slug || normaliseExcelType(str);
  if (!norm) return null;
  for (const t of EQUIP_TYPES) {
    if (t.excelMatch.some(m => norm === m)) return t.value;
  }
  return null;
}

export { EQUIP_TYPES, equipEmoji, equipLabel, normaliseExcelType, excelTypeToValue, extractStiplTypeSlug, extractStiplTypeId };
