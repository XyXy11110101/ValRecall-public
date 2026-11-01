// @vitest-environment node
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { brotliDecompressSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import provenance from '../assets/fonts/lxgw/provenance.json';

const fontRoot = resolve('src/assets/fonts/lxgw');
const css = readFileSync(resolve(fontRoot, 'lxgw.css'), 'utf8');
const globalCss = readFileSync(resolve('src/styles/global.css'), 'utf8');
const reviewCss = readFileSync(resolve('src/dashboard/review.css'), 'utf8');

const FAMILY = 'LXGW WenKai Screen';
const FILE_COUNT = 97;

interface Face {
  family: string | undefined;
  style: string | undefined;
  weight: number;
  display: string | undefined;
  file: string | undefined;
  codePoints: Set<number>;
}

function parseFaces(source: string): Face[] {
  return [...source.matchAll(/@font-face\s*\{([^}]*)\}/gu)].map(([, rawBody]) => {
    const body = rawBody ?? '';
    const codePoints = new Set<number>();
    for (const token of body.match(/unicode-range:([^;]*);/u)?.[1]?.split(',') ?? []) {
      const [first = '', last = first] = token.trim().replace(/^U\+/u, '').split('-');
      for (let point = parseInt(first, 16); point <= parseInt(last, 16); point++) {
        codePoints.add(point);
      }
    }
    return {
      family: body.match(/font-family:\s*'([^']+)'/u)?.[1],
      style: body.match(/font-style:\s*(\w+)/u)?.[1],
      weight: Number(body.match(/font-weight:\s*(\d+)/u)?.[1]),
      display: body.match(/font-display:\s*(\w+)/u)?.[1],
      file: body.match(/src:\s*url\('\.\/([^']+)'\) format\('woff2'\)/u)?.[1],
      codePoints,
    };
  });
}

const KNOWN_TABLES = (
  'cmap,head,hhea,hmtx,maxp,name,OS/2,post,cvt ,fpgm,glyf,loca,prep,CFF ,VORG,EBDT,EBLC,gasp,hdmx,' +
  'kern,LTSH,PCLT,VDMX,vhea,vmtx,BASE,GDEF,GPOS,GSUB,EBSC,JSTF,MATH,CBDT,CBLC,COLR,CPAL,SVG ,sbix,' +
  'acnt,avar,bdat,bloc,bsln,cvar,fdsc,feat,fmtx,fvar,gvar,hsty,just,lcar,mort,morx,opbd,prop,trak,' +
  'Zapf,Silf,Glat,Gloc,Feat,Sill'
).split(',');

/** Reads untouched WOFF2 tables, so the font is checked as shipped without any font tooling. */
function fontTables(bytes: Buffer): Map<string, Buffer> {
  let offset = 48;
  const base128 = () => {
    let result = 0;
    for (let count = 0; count < 5; count++) {
      const byte = bytes[offset++]!;
      result = result * 128 + (byte & 0x7f);
      if (!(byte & 0x80)) return result;
    }
    throw new Error('Invalid WOFF2 table length');
  };
  const rows = Array.from({ length: bytes.readUInt16BE(12) }, () => {
    const flags = bytes[offset++]!;
    const known = flags & 0x3f;
    let tag = KNOWN_TABLES[known];
    if (known === 0x3f) {
      tag = bytes.toString('latin1', offset, offset + 4);
      offset += 4;
    }
    if (!tag) throw new Error('Invalid WOFF2 table tag');
    const originalLength = base128();
    const transformed = tag === 'glyf' || tag === 'loca' ? flags >> 6 !== 3 : flags >> 6 !== 0;
    return { tag, length: transformed ? base128() : originalLength };
  });
  const content = brotliDecompressSync(bytes.subarray(offset, offset + bytes.readUInt32BE(20)));
  let start = 0;
  return new Map(
    rows.map(({ tag, length }) => {
      const table = content.subarray(start, start + length);
      start += length;
      return [tag, table];
    }),
  );
}

function windowsName(name: Buffer, wantedId: number): string | undefined {
  const strings = name.readUInt16BE(4);
  for (let index = 0; index < name.readUInt16BE(2); index++) {
    const entry = 6 + index * 12;
    if (name.readUInt16BE(entry) !== 3 || name.readUInt16BE(entry + 6) !== wantedId) continue;
    const start = strings + name.readUInt16BE(entry + 10);
    const encoded = Buffer.from(name.subarray(start, start + name.readUInt16BE(entry + 8)));
    return encoded.swap16().toString('utf16le');
  }
  return undefined;
}

/** Looks a code point up in a format 4 cmap, the only format these subsets use. */
function glyphId(cmap: Buffer, codePoint: number): number {
  const subtable = cmap.readUInt32BE(8);
  expect(cmap.readUInt16BE(subtable)).toBe(4);
  const segments = cmap.readUInt16BE(subtable + 6) / 2;
  const ends = subtable + 14;
  const starts = ends + segments * 2 + 2;
  const deltas = starts + segments * 2;
  const offsets = deltas + segments * 2;
  for (let segment = 0; segment < segments; segment++) {
    if (codePoint > cmap.readUInt16BE(ends + segment * 2)) continue;
    const start = cmap.readUInt16BE(starts + segment * 2);
    if (codePoint < start) return 0;
    const delta = cmap.readUInt16BE(deltas + segment * 2);
    const offset = cmap.readUInt16BE(offsets + segment * 2);
    const glyph =
      offset === 0
        ? codePoint
        : cmap.readUInt16BE(offsets + segment * 2 + offset + (codePoint - start) * 2);
    return (glyph + delta) & 0xffff;
  }
  return 0;
}

describe('offline LXGW WenKai assets', () => {
  it('keeps the exact package bytes and no unlisted font files', () => {
    expect(provenance.files).toHaveLength(FILE_COUNT);
    for (const font of provenance.files) {
      const bytes = readFileSync(resolve(fontRoot, font.file));
      expect(bytes.subarray(0, 4).toString()).toBe('wOF2');
      expect(bytes.length).toBe(font.bytes);
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(font.sha256);
    }
    expect(readdirSync(fontRoot).sort()).toEqual(['lxgw.css', 'provenance.json', 'regular']);
    const onDisk = readdirSync(resolve(fontRoot, 'regular')).map((file) => `regular/${file}`);
    expect(onDisk.sort()).toEqual(provenance.files.map((font) => font.file).sort());
    expect(provenance.totals.files).toBe(provenance.files.length);
    expect(provenance.totals.bytes).toBe(provenance.files.reduce((sum, f) => sum + f.bytes, 0));
  });

  it('declares one local face for every file, with no remote or system source', () => {
    expect(css).not.toMatch(/https?:|local\(/u);
    const faces = parseFaces(css);
    expect(faces).toHaveLength(provenance.files.length);
    const weights = new Map(provenance.files.map((font) => [font.file, font.weight]));
    for (const face of faces) {
      expect(face.family).toBe(FAMILY);
      expect(face.style).toBe('normal');
      expect(face.display).toBe('swap');
      expect(face.codePoints.size).toBeGreaterThan(0);
      expect(weights.get(face.file ?? '')).toBe(face.weight);
    }
    expect(new Set(faces.map((face) => face.file)).size).toBe(faces.length);
    expect([...new Set(faces.map((face) => face.weight))]).toEqual([400]);
  });

  it('covers each character in exactly one file', () => {
    const faces = parseFaces(css);
    const union = new Set(faces.flatMap((face) => [...face.codePoints]));
    expect(union.size).toBe(faces.reduce((sum, face) => sum + face.codePoints.size, 0));
    expect(union.size).toBeGreaterThan(14000);
  });

  it('records the pinned package and ships its SIL OFL 1.1 license text', () => {
    expect(provenance.packages.map(({ name, version }) => `${name}@${version}`)).toEqual([
      'lxgw-wenkai-screen-webfont@1.7.0',
    ]);
    expect(provenance.license.id).toBe('OFL-1.1');
    const license = readFileSync(resolve('public/fonts/LXGW-OFL.txt'), 'utf8');
    expect(license).toContain('SIL OPEN FONT LICENSE Version 1.1');
    const unixLines = license.replace(/\r\n/gu, '\n');
    expect(createHash('sha256').update(unixLines).digest('hex')).toBe(provenance.license.sha256);
    for (const pack of provenance.packages) {
      expect(pack.fontLicense.id).toBe('OFL-1.1');
      expect(pack.fontLicense.sha256).toBe(provenance.license.sha256);
    }
  });

  it('identifies every file as the original font at its declared weight', () => {
    const families = new Map(provenance.packages.map((pack) => [pack.weight, pack.familyInFont]));
    for (const font of provenance.files) {
      const tables = fontTables(readFileSync(resolve(fontRoot, font.file)));
      expect(windowsName(tables.get('name')!, 1)).toBe(families.get(font.weight));
      expect(windowsName(tables.get('name')!, 0)).toContain('LXGW');
      expect(tables.get('OS/2')!.readUInt16BE(4)).toBe(font.weight);
    }
  });

  it('gives every digit the same width, so counts never jitter', () => {
    const digits = [...'0123456789'].map((digit) => digit.codePointAt(0)!);
    const face = parseFaces(css).find(({ codePoints }) =>
      digits.every((digit) => codePoints.has(digit)),
    );
    expect(face?.file).toBeDefined();
    const tables = fontTables(readFileSync(resolve(fontRoot, face?.file ?? '')));
    const metrics = tables.get('hhea')!.readUInt16BE(34);
    const advances = digits.map((digit) => {
      const glyph = glyphId(tables.get('cmap')!, digit);
      expect(glyph).toBeGreaterThan(0);
      return tables.get('hmtx')!.readUInt16BE(Math.min(glyph, metrics - 1) * 4);
    });
    expect(new Set(advances).size).toBe(1);
    expect(advances[0]! / tables.get('head')!.readUInt16BE(18)).toBeCloseTo(0.6, 3);
  });
});

describe('desktop font wiring', () => {
  it('makes LXGW WenKai the default desktop family, and names MiSans only where it is chosen', () => {
    expect(globalCss).toContain("@import '../assets/fonts/lxgw/lxgw.css'");
    expect(globalCss).toMatch(
      /--font-stack-wenkai:\s*'LXGW WenKai Screen',\s*'ValRecall Reading',/u,
    );
    expect(globalCss).toMatch(/:root\s*\{[^}]*--font-ui: var\(--font-stack-wenkai\);/u);
    expect(reviewCss).not.toMatch(/misans/iu);
    expect(reviewCss).not.toMatch(/--font-ui:/u);
    // A declared face is read only when text uses it, and only these two lines can make it so.
    const namesMisans = globalCss.split(/\r?\n/u).filter((line) => /misans/iu.test(line));
    expect(namesMisans).toEqual([
      expect.stringContaining('MiSans alone is about 15 MB'),
      "@import '../assets/fonts/misans.css';",
      '  --font-stack-misans:',
      "    'MiSans', 'ValRecall Reading', 'Noto Sans SC', 'Noto Sans CJK SC', 'PingFang SC',",
      "html[data-font='misans'] {",
      '  --font-ui: var(--font-stack-misans);',
      "html:is([data-font='misans'], [data-font='noto'], [data-font='yahei']) {",
    ]);
  });

  it('never fakes a bold, in any of the fonts', () => {
    expect(globalCss).toMatch(/:root\s*\{[^}]*font-synthesis:\s*none;/u);
  });

  it('keeps the phone on MiSans, without this font or its license', () => {
    const entry = readFileSync(resolve('src/mobile/main.tsx'), 'utf8');
    expect(entry).toContain("import '../assets/fonts/misans.css'");
    expect(entry).not.toMatch(/lxgw|global\.css/iu);
    expect(readFileSync(resolve('src/mobile/mobile.css'), 'utf8')).not.toMatch(/lxgw/iu);
    const mobileConfig = readFileSync(resolve('vite.mobile.config.ts'), 'utf8');
    expect(mobileConfig).toContain('publicDir: false');
    expect(mobileConfig).not.toMatch(/lxgw/iu);
  });
});
