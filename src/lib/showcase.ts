// Vitrin videoları — önceden işlenmiş, gözden geçirilmiş annotasyonlar.
//
// Kullanıcı bu videolarda anahtar girmeden tam ürünü görüyor. Veri PAKETTE:
// `scripts/build.mjs` `src/showcase/*.json` dosyalarını derleme zamanında
// background bundle'ına gömüyor; içerik betiği ve ayar sayfası veriyi
// background'dan MESAJLA istiyor. Uzaktan veri çekilmiyor.
//
// Bu dosya yalnız şemayı ve doğrulamayı tutuyor. Hiçbir `chrome.*` çağrısı ya
// da DOM erişimi yok: üç bağlamda da (background, içerik, ayar sayfası)
// güvenle içe aktarılabiliyor.

import type { Difficulty, Register, TeachType } from "./annotate";

export const SHOWCASE_SCHEMA_VERSION = 1;

export interface ShowcaseItem {
  term: string;
  senseHere: string;
  nuance?: string;
  type: TeachType;
  difficulty: Difficulty;
  register: Register;
  /** Saniye. */
  start: number;
  /** Saniye. */
  end: number;
}

export interface ShowcaseVideo {
  schemaVersion: 1;
  videoId: string;
  /** Panelde ve vitrin listesinde gösterilen başlık. */
  title: string;
  sourceKind: "manual" | "asr";
  /** İşlendiği model. */
  model: string;
  promptVersion: number;
  /** ISO tarih. */
  processedAt: string;
  items: ShowcaseItem[];
  /** Gözden geçirme kararı — karar 8: her madde için kayıt. */
  review: {
    kept: number;
    removed: { term: string; reason: string }[];
  };
}

/** Vitrin listesinde gösterilen kısa kayıt. */
export interface ShowcaseEntry {
  videoId: string;
  title: string;
}

// ── Enum kümeleri ────────────────────────────────────────────────────────────
//
// `Record<Tip, true>` biçimi bilinçli: TypeScript her enum değerinin burada
// OLMASINI ve fazlasının OLMAMASINI zorluyor. `annotate.ts`'teki listeler
// değişirse bu dosya derlenmez — iki liste sessizce ayrışamaz.

const TEACH_TYPE_SET: Record<TeachType, true> = {
  word: true,
  shifted_sense: true,
  idiom: true,
  phrasal_verb: true,
  abbreviation: true,
  slang: true,
  phrase: true,
};

const DIFFICULTY_SET: Record<Difficulty, true> = {
  a1: true,
  a2: true,
  b1: true,
  b2: true,
  c1: true,
  c2: true,
};

const REGISTER_SET: Record<Register, true> = {
  neutral: true,
  informal: true,
  slang: true,
  vulgar: true,
  technical: true,
  dated: true,
};

// ── unknown daraltma ─────────────────────────────────────────────────────────
//
// Vitrin dosyaları paketin parçası ama yine `unknown` giriyor: dosyaları bir
// betik üretiyor ve elle düzenlenebiliyorlar. Bozuk bir dosya eklentiyi
// ÇÖKERTMEZ — o video vitrin dışı sayılır ve sebebi söylenir.

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  return value as UnknownRecord;
}

class ShowcaseError extends Error {}

function readString(record: UnknownRecord, key: string, where: string): string {
  const value = record[key];
  if (typeof value !== "string" || value === "") {
    throw new ShowcaseError(`${where}.${key}: boş olmayan dize değil`);
  }
  return value;
}

function readNumber(record: UnknownRecord, key: string, where: string): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ShowcaseError(`${where}.${key}: sayı değil`);
  }
  return value;
}

function readMember<T extends string>(
  record: UnknownRecord,
  key: string,
  set: Record<T, true>,
  where: string,
): T {
  const value = record[key];
  if (typeof value !== "string" || !Object.prototype.hasOwnProperty.call(set, value)) {
    throw new ShowcaseError(`${where}.${key}: tanımsız değer ${JSON.stringify(value)}`);
  }
  return value as T;
}

/**
 * 🔴 `segmentText` (altyazı satırı) VİTRİN VERİSİNDE YASAK.
 *
 * Karar 8: telif yüzeyi küçük tutulur — üçüncü tarafın altyazı metni
 * eklentiyle dağıtılmaz. Alan bir maddede ya da kökte bulunursa dosyanın
 * TAMAMI reddediliyor: sessizce silmek, üretim betiğindeki bir hatayı
 * gizlerdi.
 */
function assertNoSegmentText(record: UnknownRecord, where: string): void {
  if (Object.prototype.hasOwnProperty.call(record, "segmentText")) {
    throw new ShowcaseError(`${where}: "segmentText" var — vitrin verisinde yasak (karar 8)`);
  }
}

function parseItem(value: unknown, where: string): ShowcaseItem {
  const record = asRecord(value);
  if (!record) throw new ShowcaseError(`${where}: nesne değil`);
  assertNoSegmentText(record, where);

  const start = readNumber(record, "start", where);
  const end = readNumber(record, "end", where);
  if (end < start) throw new ShowcaseError(`${where}: end < start`);

  const item: ShowcaseItem = {
    term: readString(record, "term", where),
    senseHere: readString(record, "senseHere", where),
    type: readMember(record, "type", TEACH_TYPE_SET, where),
    difficulty: readMember(record, "difficulty", DIFFICULTY_SET, where),
    register: readMember(record, "register", REGISTER_SET, where),
    start,
    end,
  };

  if (Object.prototype.hasOwnProperty.call(record, "nuance")) {
    const nuance = record.nuance;
    if (typeof nuance !== "string") throw new ShowcaseError(`${where}.nuance: dize değil`);
    item.nuance = nuance;
  }

  return item;
}

/**
 * Bir vitrin dosyasını doğrular.
 *
 * Dönüş: geçerli video ya da reddetme SEBEBİ. Çağıran sebebi konsola yazıyor;
 * burada `console` yok ki modül her bağlamda sessiz kalsın.
 */
export function parseShowcase(
  value: unknown,
  source: string,
): { ok: true; video: ShowcaseVideo } | { ok: false; reason: string } {
  try {
    const record = asRecord(value);
    if (!record) throw new ShowcaseError(`${source}: kök nesne değil`);
    assertNoSegmentText(record, source);

    if (record.schemaVersion !== SHOWCASE_SCHEMA_VERSION) {
      throw new ShowcaseError(
        `${source}.schemaVersion: ${JSON.stringify(record.schemaVersion)} (beklenen ${SHOWCASE_SCHEMA_VERSION})`,
      );
    }

    const sourceKind = record.sourceKind;
    if (sourceKind !== "manual" && sourceKind !== "asr") {
      throw new ShowcaseError(`${source}.sourceKind: "manual" ya da "asr" değil`);
    }

    const rawItems = record.items;
    if (!Array.isArray(rawItems)) throw new ShowcaseError(`${source}.items: dizi değil`);
    const items = rawItems.map((item, index) => parseItem(item, `${source}.items[${index}]`));

    const review = asRecord(record.review);
    if (!review) throw new ShowcaseError(`${source}.review: nesne değil`);
    const kept = readNumber(review, "kept", `${source}.review`);

    // Tutarlılık: "tutuldu" sayısı listedeki madde sayısıyla aynı olmalı.
    // Farklıysa üretim betiğinde bir şey kaybolmuş ya da eklenmiş demektir.
    if (kept !== items.length) {
      throw new ShowcaseError(
        `${source}.review.kept (${kept}) ≠ items.length (${items.length})`,
      );
    }

    const rawRemoved = review.removed;
    if (!Array.isArray(rawRemoved)) {
      throw new ShowcaseError(`${source}.review.removed: dizi değil`);
    }
    const removed = rawRemoved.map((entry, index) => {
      const where = `${source}.review.removed[${index}]`;
      const removedRecord = asRecord(entry);
      if (!removedRecord) throw new ShowcaseError(`${where}: nesne değil`);
      return {
        term: readString(removedRecord, "term", where),
        reason: readString(removedRecord, "reason", where),
      };
    });

    return {
      ok: true,
      video: {
        schemaVersion: 1,
        videoId: readString(record, "videoId", source),
        title: readString(record, "title", source),
        sourceKind,
        model: readString(record, "model", source),
        promptVersion: readNumber(record, "promptVersion", source),
        processedAt: readString(record, "processedAt", source),
        items,
        review: { kept, removed },
      },
    };
  } catch (error) {
    if (error instanceof ShowcaseError) return { ok: false, reason: error.message };
    return { ok: false, reason: `${source}: beklenmeyen hata` };
  }
}

/** Liste kaydı (ayar sayfası ve "işlenmemiş video" paneli için). */
export function readShowcaseEntries(value: unknown): ShowcaseEntry[] {
  if (!Array.isArray(value)) return [];
  const entries: ShowcaseEntry[] = [];
  for (const candidate of value) {
    const record = asRecord(candidate);
    const videoId = record?.videoId;
    const title = record?.title;
    if (typeof videoId === "string" && typeof title === "string") {
      entries.push({ videoId, title });
    }
  }
  return entries;
}

/**
 * Video genelinde tekrar karşılaştırmasının anahtarı: küçük harf + kırpılmış
 * + tek boşluklu YÜZEY biçimi.
 *
 * 🔴 TEK KURAL, İKİ KULLANICI. Canlı işlemede panel tekrarları bununla
 * gizliyor (content.ts), vitrin dönüştürücüsü de aynı fonksiyonu çağırıyor
 * (scripts/showcase-from-measure.mjs, scripts/lib/showcase-validator.mjs
 * üzerinden). İki ayrı kopya zamanla ayrışırdı: aynı video vitrinde ve canlı
 * işlemede farklı listeler gösterirdi.
 *
 * `termKey()` DEĞİL: o, taşınmış bir kapı kuralı (ek düşürme, artikel atma);
 * bu ise bir sunum kararı. "walked out" ile "walks out" burada ayrı sayılır.
 */
export function surfaceKey(term: string): string {
  return term.toLowerCase().trim().replace(/\s+/g, " ");
}

/** Vitrin videosunun YouTube adresi. */
export function showcaseUrl(videoId: string): string {
  return `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`;
}
