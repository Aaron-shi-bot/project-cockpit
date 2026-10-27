import { Buffer } from 'node:buffer';
const MIME = {
  pdf: 'application/pdf', png: 'image/png', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', tiff: 'image/tiff',
  zip: 'application/zip', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  doc: 'application/msword', xls: 'application/vnd.ms-excel', ppt: 'application/vnd.ms-powerpoint', ole: 'application/x-ole-storage',
  text: 'text/plain', json: 'application/json', html: 'text/html', svg: 'image/svg+xml', xml: 'application/xml',
};
const aliases = new Map([['image/jpg', MIME.jpeg], ['application/x-pdf', MIME.pdf], ['application/x-zip-compressed', MIME.zip], ['text/json', MIME.json], ['text/xml', MIME.xml]]);
const canonical = mime => aliases.get(mime.toLowerCase()) ?? mime.toLowerCase();
const knownMimes = new Set(Object.values(MIME));
const starts = (bytes, hex) => bytes.subarray(0, hex.length / 2).equals(Buffer.from(hex, 'hex'));

function zipNames(bytes) {
  // Read only bounded central-directory metadata; never inflate untrusted data.
  for (let offset = bytes.length - 22; offset >= Math.max(0, bytes.length - 65557); offset--) {
    if (bytes.readUInt32LE(offset) !== 0x06054b50) continue;
    const comment = bytes.readUInt16LE(offset + 20);
    if (offset + 22 + comment !== bytes.length) continue;
    if (bytes.readUInt16LE(offset + 4) !== 0 || bytes.readUInt16LE(offset + 6) !== 0) return [];
    const count = bytes.readUInt16LE(offset + 10), size = bytes.readUInt32LE(offset + 12), start = bytes.readUInt32LE(offset + 16);
    if (count > 10000 || start + size > offset) return [];
    let cursor = start;
    const names = [];
    for (let n = 0; n < count; n++) {
      if (cursor + 46 > start + size || bytes.readUInt32LE(cursor) !== 0x02014b50) return [];
      const nameLength = bytes.readUInt16LE(cursor + 28), extra = bytes.readUInt16LE(cursor + 30), fileComment = bytes.readUInt16LE(cursor + 32);
      const next = cursor + 46 + nameLength + extra + fileComment;
      if (next > start + size) return [];
      names.push(bytes.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8'));
      cursor = next;
    }
    return cursor === start + size ? names : [];
  }
  return [];
}
function decodedText(bytes) {
  try {
    const encoding = starts(bytes, 'fffe') ? 'utf-16le' : starts(bytes, 'feff') ? 'utf-16be' : 'utf-8';
    const value = new TextDecoder(encoding, { fatal: true }).decode(bytes);
    return /[\x00-\x08\x0b\x0e-\x1f]/.test(value) ? null : value;
  } catch { return null; }
}
function xmlRoot(value) {
  let cursor = 0;
  while (cursor < value.length) {
    while (/\s/.test(value[cursor] ?? '') && cursor < value.length) cursor++;
    if (value.startsWith('<!--', cursor)) { const end = value.indexOf('-->', cursor + 4); if (end < 0) break; cursor = end + 3; continue; }
    if (value.startsWith('<?xml', cursor)) { const end = value.indexOf('?>', cursor + 5); if (end < 0) break; cursor = end + 2; continue; }
    if (value.slice(cursor, cursor + 9).toLowerCase() === '<!doctype') {
      let quote = '', brackets = 0, end = cursor + 9;
      for (; end < value.length; end++) {
        const char = value[end];
        if (quote) { if (char === quote) quote = ''; continue; }
        if (char === '"' || char === "'") { quote = char; continue; }
        if (char === '[') brackets++;
        else if (char === ']') brackets = Math.max(0, brackets - 1);
        else if (char === '>' && brackets === 0) break;
      }
      if (end >= value.length) break;
      cursor = end + 1; continue;
    }
    break;
  }
  return value.slice(cursor);
}
function identify(bytes) {
  if (bytes.subarray(0, 5).toString() === '%PDF-') return 'pdf';
  if (starts(bytes, '89504e470d0a1a0a')) return 'png';
  if (starts(bytes, 'ffd8ff')) return 'jpeg';
  if (['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString())) return 'gif';
  if (bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP') return 'webp';
  if (bytes.length >= 14 && bytes.subarray(0, 2).toString() === 'BM' && bytes.readUInt32LE(2) === bytes.length) return 'bmp';
  if (starts(bytes, '49492a00') || starts(bytes, '4d4d002a')) return 'tiff';
  if (starts(bytes, '504b0304') || starts(bytes, '504b0506')) {
    const names = new Set(zipNames(bytes));
    if (names.has('[Content_Types].xml')) {
      if (names.has('word/document.xml')) return 'docx';
      if (names.has('xl/workbook.xml')) return 'xlsx';
      if (names.has('ppt/presentation.xml')) return 'pptx';
    }
    return 'zip';
  }
  if (starts(bytes, 'd0cf11e0a1b11ae1')) {
    if (bytes.includes(Buffer.from('WordDocument', 'utf16le'))) return 'doc';
    if (bytes.includes(Buffer.from('Workbook', 'utf16le')) || bytes.includes(Buffer.from('Book', 'utf16le'))) return 'xls';
    if (bytes.includes(Buffer.from('PowerPoint Document', 'utf16le'))) return 'ppt';
    return 'ole';
  }
  const value = decodedText(bytes);
  if (value !== null) {
    const trimmed = value.trimStart();
    // Scan metadata linearly without parsing it, expanding entities or loading
    // external DTDs. Also accept XML that legitimately omits its declaration.
    const root = xmlRoot(trimmed);
    if (/^<svg(?=[\s/>])/i.test(root)) return 'svg';
    if (/^<html(?=[\s/>])/i.test(root)) return 'html';
    if (/^<[A-Za-z_][\w.:-]*(?:\s|\/?>)/.test(root) || /^<\?xml\b/.test(trimmed)) return 'xml';
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) { try { JSON.parse(value); return 'json'; } catch {} }
    return 'text';
  }
  return 'unknown';
}

export function inspectFileType(bytes, declaredMime) {
  const detectedType = identify(bytes), detectedMime = MIME[detectedType] ?? null;
  const declared = canonical(declaredMime);
  const generic = declared === 'application/octet-stream';
  let compatible = generic || declared === detectedMime;
  if (['docx', 'xlsx', 'pptx'].includes(detectedType) && declared === MIME.zip) compatible = true;
  if (['text', 'json', 'html', 'xml'].includes(detectedType) && declared.startsWith('text/')) compatible = true;
  if (detectedType === 'text' && ['application/javascript', 'application/x-javascript', 'application/sql'].includes(declared)) compatible = true;
  // Unknown binaries may retain an unrecognised vendor type but must not claim
  // a supported identified format such as PDF, PNG or text.
  if (detectedType === 'unknown' && !knownMimes.has(declared) && !declared.startsWith('text/')) compatible = true;
  return { detectedType, detectedMime, typeVerified: !['unknown', 'ole'].includes(detectedType), compatible };
}
