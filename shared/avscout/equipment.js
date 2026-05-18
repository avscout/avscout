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
    excelMatch: ['audio processor', 'audio processors'] },
  { value: 'av_via_usb',         label: 'AV via USB',         emoji: '🔌', preselected: true,
    excelMatch: ['av via usb'] },
  { value: 'avracks',            label: 'AVRacks',            emoji: '🗄️', preselected: true,
    excelMatch: ['avrack', 'avracks', 'av rack', 'av racks'] },
  { value: 'cameras',            label: 'Cameras',            emoji: '📷', preselected: true,
    excelMatch: ['camera', 'cameras'] },
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
    excelMatch: ['interactive board', 'interactive boards', 'ia board', 'ia boards'] },
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
  { value: 'screens',            label: 'Screens',            emoji: '🪟', preselected: true,
    excelMatch: ['screen', 'screens'] },
  { value: 'switchers',          label: 'Switchers',          emoji: '🔀', preselected: false,
    excelMatch: ['switcher', 'switchers'] },
  { value: 'video_processor',    label: 'Video Processor',    emoji: '🎞️', preselected: false,
    excelMatch: ['video processor', 'video processors'] },
  { value: 'visualizers',        label: 'Visualizers',        emoji: '🔍', preselected: true,
    excelMatch: ['visualizer', 'visualizers', 'visualiser', 'visualisers'] },
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
// Map an Excel "Equipment Type" string to our internal value key.
// Exact match against any alias in excelMatch (after normalisation on
// both sides). Returns null if no type matches — caller can then route
// the row into the "Unmatched" bucket of the pre-import modal.
function excelTypeToValue(str) {
  const norm = normaliseExcelType(str);
  if (!norm) return null;
  for (const t of EQUIP_TYPES) {
    if (t.excelMatch.some(m => norm === m)) return t.value;
  }
  return null;
}

export { EQUIP_TYPES, equipEmoji, equipLabel, normaliseExcelType, excelTypeToValue };
