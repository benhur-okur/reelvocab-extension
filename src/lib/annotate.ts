// Sağlayıcıdan bağımsız olmayı hedefleyen annotasyon adaptörü — şimdilik tek
// sağlayıcı (Mistral).
//
// Bu adaptör tek chunk işler; kuyruk ve önbellek çağıran katmandadır.
//
// Akış: şema doğrulaması → KAPI LİSTESİ (gates.ts) → süzülmüş sonuç. Ham model
// çıktısı dışarıya HİÇ verilmiyor; dönen sonuç kapılardan geçmiş olanıdır ve
// yanında eleme kaydı gelir.
//
// ⚠️ Kapılardan geçmek "doğru" demek değil: kanıtlanmış kusur sınıfı tam olarak
// kapıların yakalayamadığı şeydir.
//
// 🔴 TEK KOŞU. Üç koşu + mutabakat eşiği eklentiye taşınmaz: eşik
// kararsızlığı filtreler, yanlışlığı değil.

import type { CaptionSegment } from "./captions";
import { applyGates } from "./gates";
import type { GateRejection } from "./gates";
import type { ModelId } from "./models";

// Prompt build sırasında gömülüyor: `scripts/build.mjs` dosyayı okuyup
// esbuild'in `define` mekanizmasıyla bu sabitin yerine JSON dizesi koyuyor.
// Böylece `prompts/annotate_v6.md` DEĞİŞTİRİLMEDEN, birebir kopya olarak
// kalıyor ve çalışma zamanında dosya okumaya gerek kalmıyor (service
// worker'da `fetch(chrome.runtime.getURL(...))` gerekirdi).
//
// 🔴 MALİYETİN NEREDE OLDUĞU — ölçüldü (18 Eyl 2026, ilk başarılı çağrı):
// 10 segment = **4457 prompt tokeni + 577 completion tokeni**. Prompt
// tokenlerinin neredeyse tamamı `annotate_v6`'nın KENDİSİ ve her çağrıda tam
// olarak gidiyor; `cached_tokens` **0**.
//
// Anlamı: maliyet segment sayısıyla değil, çağrı sayısıyla ölçekleniyor. Az
// sayıda büyük chunk, çok sayıda küçük chunk'tan belirgin biçimde ucuz. Bu,
// chunk boyutu ve maliyet tahmini kararlarının girdisi.
declare const __ANNOTATE_V6_PROMPT__: string;

/** Sağlayıcı ayrıntıları — tek yerde. */
const API_URL = "https://api.mistral.ai/v1/chat/completions";

// Model — artık PARAMETRE, izinli listeden (`models.ts`).
//
// ÖLÇÜLDÜ (18 Eyl 2026): `mistral-medium-2512` geçersiz bir model adıydı;
// Mistral 400 döndürdü —
// `{"message":"Invalid model: mistral-medium-2512","type":"invalid_model","code":"1500"}`.
//
// Varsayılan `mistral-large-2512`: `annotate_v6` bu modelle kalibre edildi.
// Başka bir model seçmek promptun davranışını
// ölçülmemiş hale getirir — seçim ölçüm içindir, varsayılanı değiştirmek için
// değil. Takma ad yasağının gerekçesi `models.ts` başlığında.

export type AnnotateError =
  | "NO_API_KEY"
  | "API_ERROR"
  | "RATE_LIMITED"
  | "INVALID_RESPONSE"
  // Seçilen model anahtarın planında yok (403 `tier_not_allowed`). Ayrı sınıf,
  // çünkü `API_ERROR`'a gömülürse kullanıcı sorunun anahtarında olduğunu sanır;
  // oysa anahtar geçerli, yalnız planı bu modeli kapsamıyor.
  | "MODEL_NOT_IN_TIER"
  // İzinli listede olmayan model istendi. Serbest dize kabul edilmiyor.
  | "UNKNOWN_MODEL";

// ── JSON çıktı şeması ───────────────────────────────────────────────────────

const TEACH_TYPES = [
  "word",
  "shifted_sense",
  "idiom",
  "phrasal_verb",
  "abbreviation",
  "slang",
  "phrase",
] as const;

const DIFFICULTIES = ["a1", "a2", "b1", "b2", "c1", "c2"] as const;

const REGISTERS = [
  "neutral",
  "informal",
  "slang",
  "vulgar",
  "technical",
  "dated",
] as const;

/** Şema sınırı: "Choose 1 to 3 from EXACTLY this list" (annotate_v6). */
const MAX_INTERESTS = 3;

const INTERESTS = [
  "tech",
  "business",
  "travel",
  "daily",
  "cinema",
  "science",
  "sports",
  "music",
  "food",
  "gaming",
] as const;

export type TeachType = (typeof TEACH_TYPES)[number];
export type Difficulty = (typeof DIFFICULTIES)[number];
export type Register = (typeof REGISTERS)[number];
export type Interest = (typeof INTERESTS)[number];

export interface TeachItem {
  term: string;
  senseHere: string;
  type: TeachType;
  difficulty: Difficulty;
  confidence: number;
  register: Register;
  note: string;
  /** `senseHere`'in ötesinde söylenecek bir şey yoksa atlanabilir; nadir olmalı. */
  nuance?: string;
  /** Alan anlamı tahmin ediliyorsa `true` (o zaman `confidence ≤ 0.4`). */
  uncertain?: boolean;
  /** Küfür / kaba argo — aşağı akışta filtrelenebilsin. */
  explicit?: boolean;
}

export interface AnnotatedSegment {
  index: number;
  /** Boş dizi GEÇERLİ ve beklenen bir cevap (kota yok kuralı). */
  teach: TeachItem[];
}

export interface AnnotationResult {
  interests: Interest[];
  segments: AnnotatedSegment[];
}

/**
 * Başarılı sonuç: kapılardan GEÇMİŞ maddeler + eleme kaydı.
 *
 * Eleme kaydı sonucun parçası, ek bir teşhis çıktısı değil: kaç madde
 * üretildiği ve hangi kapının ne elediği kusur sınıfı analizinin girdisidir.
 */
export interface AnnotateOk {
  ok: true;
  /** Süzülmüş sonuç. */
  data: AnnotationResult;
  /** Modelin ürettiği toplam madde sayısı (süzme öncesi). */
  totalItems: number;
  /** Elenen maddeler, kapılarıyla. */
  rejections: GateRejection[];
  /** Elenmeyen ama düzeltilen maddeler (yanlış segmente bağlanmış olanlar). */
  corrections: GateRejection[];
}

// ── unknown daraltma ────────────────────────────────────────────────────────
// Model çıktısı `unknown` girer. Şemaya uymayan alan SESSİZCE kabul edilmez —
// ama "kabul etmemek" ile "her şeyi çöpe atmak" aynı şey değil:
//
//  · YAPI bozuksa → `INVALID_RESPONSE`. Geriye güvenilecek bir şey kalmıyor.
//  · Tek MADDE bozuksa → madde atılır, sebebiyle kayda geçer, chunk'ın geri
//    kalanı geçer. Ölçümle böyle değişti (aşağıdaki `parseTeachItem` notu).
//
// Kayıt tutulduğu sürece hiçbir şey sessiz olmuyor; asıl kaçınılan şey,
// doğrulanmamış bir maddenin görünmeden içeri sızması.

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  return value as UnknownRecord;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

/** Değer sabit listede mi? Listede yoksa `undefined` — varsayılana düşülmez. */
function asMember<T extends string>(
  value: unknown,
  allowed: readonly T[],
): T | undefined {
  const text = asString(value);
  if (text === undefined) return undefined;
  return allowed.find((candidate) => candidate === text);
}

/**
 * TODO: teşhis sonrası kaldır
 *
 * Şema doğrulaması `INVALID_RESPONSE` dışında hiçbir bilgi bırakmıyor; hangi
 * kontrolün düştüğü kayboluyor. Bu yardımcı yalnız GÖZLEMLENEBİLİRLİK ekler —
 * karar vermez, her zaman `undefined` döner, yani doğrulama mantığı aynen
 * duruyor.
 */
function schemaFail(reason: string, detail?: unknown): undefined {
  // Yayın derlemesinde yalnız SEBEP basılıyor: `detail` modelin ürettiği ham
  // maddeyi taşıyor (kullanıcının izlediği videonun içeriği).
  if (detail === undefined || !__DEV__) {
    console.error(`[reelvocab:bg] şema düştü: ${reason}`);
  } else {
    console.error(`[reelvocab:bg] şema düştü: ${reason}`, detail);
  }
  return undefined;
}

/**
 * Tek bir `teach` maddesini doğrular.
 *
 * 🔴 BOZUK MADDE TÜM CHUNK'I DÜŞÜRMEZ — ölçümle değişti.
 *
 * ÖLÇÜLDÜ (19 Eyl 2026): model bir maddeye `register: "formal"` verdi
 * (`confidence` 0.95). Prompt bu değeri TANIMIYOR — enum tam olarak
 * `neutral · informal · slang · vulgar · technical · dated` ve prompt "exactly
 * one of" diyor. Şema doğrulaması ihlali yakaladı, ama eski davranış tüm
 * yanıtı `INVALID_RESPONSE` yapıyordu: aynı chunk'taki DÖRT geçerli madde
 * (`order of business`, `quorum call`, `calling the roll`, `speed it up`) tek
 * bir uydurma etiket yüzünden kayboldu; bir çağrı ($0.01, ~15 sn) ziyan oldu.
 *
 * İlke değişmedi: "şemaya uymayan alan sessizce kabul edilmez". Bozuk maddeyi
 * ATMAK onu kabul etmek değil — ve kaydı tutulduğu için sessiz de değil.
 *
 * ⚠️ `"formal"` enum'a EKLENMEDİ. Prompt onu tanımıyor; eklemek kodu promptla
 * ayrıştırır ve bir sonraki uydurma etiketi meşrulaştırır.
 *
 * Dönüş: geçerli madde, ya da maddeyi düşüren SEBEP (eleme kaydına girer).
 */
type TeachItemParse =
  | { ok: true; item: TeachItem }
  | { ok: false; reason: string };

function dropItem(reason: string, detail?: unknown): TeachItemParse {
  // TODO: teşhis sonrası kaldır — sebep artık kayda da giriyor, bu satır
  // yalnız ham değeri konsolda görmek için.
  schemaFail(reason, detail);
  return { ok: false, reason };
}

function parseTeachItem(value: unknown): TeachItemParse {
  const raw = asRecord(value);
  if (!raw) return dropItem("madde nesne değil", value);

  const term = asString(raw.term);
  const senseHere = asString(raw.senseHere);
  const type = asMember(raw.type, TEACH_TYPES);
  const difficulty = asMember(raw.difficulty, DIFFICULTIES);
  const register = asMember(raw.register, REGISTERS);
  const confidence = asNumber(raw.confidence);

  if (
    term === undefined ||
    term === "" ||
    senseHere === undefined ||
    type === undefined ||
    difficulty === undefined ||
    register === undefined ||
    confidence === undefined ||
    confidence < 0 ||
    confidence > 1
  ) {
    // Hangi alanın hangi DEĞERLE düştüğü sebebin içinde: enum ihlallerini
    // sonradan saymak için değerin kendisi gerekiyor (ör. "register: formal").
    const failed: string[] = [];
    if (term === undefined || term === "") failed.push("term");
    if (senseHere === undefined) failed.push("senseHere");
    if (type === undefined) failed.push(`type: ${String(raw.type)}`);
    if (difficulty === undefined) failed.push(`difficulty: ${String(raw.difficulty)}`);
    if (register === undefined) failed.push(`register: ${String(raw.register)}`);
    if (confidence === undefined) failed.push(`confidence: ${String(raw.confidence)}`);
    else if (confidence < 0 || confidence > 1) failed.push(`confidence aralık dışı: ${confidence}`);
    return dropItem(failed.join(", "), raw);
  }

  // 🔴 `note` ZORUNLU DEĞİL — promptla karşılaştırınca düzeltildi.
  //
  // Alan listesi `note`'u "kısa not, ya da \"\"" diye tanımlıyor, ama promptun
  // v3 değişiklik günlüğü çıktının sıkıştırılmasını şöyle anlatıyor: israf
  // "`note: \"\"` ve `uncertain: false` gibi VARSAYILAN ALANLARIN her maddede
  // tekrarlanması"ydı. Yani boş `note`'un atlanması promptun kendi beklediği
  // davranış. Zorunlu tutmak geçerli çıktıyı `INVALID_RESPONSE` yapardı.
  //
  // Yok sayılan alan varsayılana (`""`) düşer; YANLIŞ TİPTE gelen alan hâlâ
  // yanıtı geçersiz kılıyor — eksiklik ile bozukluk ayrı şeyler.
  let note = "";
  if ("note" in raw) {
    const parsedNote = asString(raw.note);
    if (parsedNote === undefined) return dropItem("note dize değil", raw.note);
    note = parsedNote;
  }

  const item: TeachItem = {
    term,
    senseHere,
    type,
    difficulty,
    confidence,
    register,
    note,
  };

  // İsteğe bağlı alanlar: VARSA tipi doğru olmalı. Yanlış tipte gelen bir
  // `uncertain` sessizce yok sayılmaz, yanıtı geçersiz kılar.
  if ("nuance" in raw) {
    const nuance = asString(raw.nuance);
    if (nuance === undefined) return dropItem("nuance dize değil", raw.nuance);
    item.nuance = nuance;
  }
  if ("uncertain" in raw) {
    const uncertain = asBoolean(raw.uncertain);
    if (uncertain === undefined) return dropItem("uncertain boolean değil", raw.uncertain);
    item.uncertain = uncertain;
  }
  if ("explicit" in raw) {
    const explicit = asBoolean(raw.explicit);
    if (explicit === undefined) return dropItem("explicit boolean değil", raw.explicit);
    item.explicit = explicit;
  }

  return { ok: true, item };
}

/**
 * Kök yanıtı doğrular.
 *
 * 🔴 YAPI ile MADDE ayrı: yapı bozuksa (JSON değil, kök nesne değil,
 * `interests` geçersiz, `segments` dizi değil) sonuç `INVALID_RESPONSE`,
 * çünkü geriye güvenilecek hiçbir şey kalmıyor. Tek bir madde bozuksa yanıt
 * geçerli sayılır, madde ATILIR ve sebebiyle kayda geçer.
 */
interface ParsedResponse {
  result: AnnotationResult;
  /** Şemada düşüp atılan maddeler — kapı raporuna "schema" olarak girer. */
  dropped: { segmentIndex: number; term: string; reason: string }[];
}

function parseAnnotationResult(value: unknown): ParsedResponse | undefined {
  const raw = asRecord(value);
  // TODO: teşhis sonrası kaldır
  if (!raw) return schemaFail("kök nesne değil", value);

  // `interests`: 1-3 kategori, sabit listeden.
  //
  // 🔴 FAZLALIK VE GEÇERSİZLİK TÜM CHUNK'I DÜŞÜRMEZ. `register: "formal"`
  // vakasının aynısı: kategori listesindeki bir kusur yüzünden dolu bir
  // chunk'ı çöpe atmak, maliyeti ve maddeleri boşa harcıyor. Fazlası
  // kırpılıyor, tanımsız olanı atılıyor, ikisi de kayda geçiyor.
  //
  // Dizi DEĞİLSE ya da geriye tek geçerli kategori kalmıyorsa yapı bozuktur
  // ve `INVALID_RESPONSE` dönülür — sahnenin konusu hakkında hiçbir bilgi yok.
  const rawInterests = raw.interests;
  // TODO: teşhis sonrası kaldır
  if (!Array.isArray(rawInterests)) {
    return schemaFail("interests dizi değil", rawInterests);
  }

  const interests: Interest[] = [];
  const droppedInterests: string[] = [];

  for (const candidate of rawInterests) {
    const interest = asMember(candidate, INTERESTS);
    if (interest === undefined) {
      droppedInterests.push(`geçersiz kategori: ${String(candidate)}`);
      continue;
    }
    interests.push(interest);
  }

  if (interests.length === 0) {
    // TODO: teşhis sonrası kaldır
    return schemaFail("interests içinde geçerli kategori yok", rawInterests);
  }

  if (interests.length > MAX_INTERESTS) {
    droppedInterests.push(
      `${rawInterests.length} kategori geldi, ilk ${MAX_INTERESTS} alındı`,
    );
    interests.length = MAX_INTERESTS;
  }

  const rawSegments = raw.segments;
  // TODO: teşhis sonrası kaldır
  if (!Array.isArray(rawSegments)) {
    return schemaFail("segments dizi değil", rawSegments);
  }

  const segments: AnnotatedSegment[] = [];

  // `segmentIndex: -1` = maddeye değil, yanıtın tamamına ait kayıt (kategori
  // listesi gibi). Kapı raporunda "schema" sayacına giriyor.
  const dropped: ParsedResponse["dropped"] = droppedInterests.map((reason) => ({
    segmentIndex: -1,
    term: "",
    reason: `interests → ${reason}`,
  }));

  for (let at = 0; at < rawSegments.length; at++) {
    const rawSegment = rawSegments[at];
    const segmentRecord = asRecord(rawSegment);
    // TODO: teşhis sonrası kaldır
    if (!segmentRecord) {
      return schemaFail(`segments[${at}] nesne değil`, rawSegment);
    }

    const index = asNumber(segmentRecord.index);
    if (index === undefined || !Number.isInteger(index) || index < 0) {
      // TODO: teşhis sonrası kaldır
      return schemaFail(
        `segments[${at}].index geçersiz`,
        segmentRecord.index,
      );
    }

    const rawTeach = segmentRecord.teach;
    // TODO: teşhis sonrası kaldır
    if (!Array.isArray(rawTeach)) {
      return schemaFail(`segments[${at}].teach dizi değil`, rawTeach);
    }

    const teach: TeachItem[] = [];
    for (const rawItem of rawTeach) {
      const parsed = parseTeachItem(rawItem);
      if (!parsed.ok) {
        // Madde atılıyor, chunk'ın geri kalanı geçiyor. Terim okunabiliyorsa
        // kayda yazılır: neyin kaybolduğu sebepten daha çok şey söylüyor.
        dropped.push({
          segmentIndex: index,
          term: asString(asRecord(rawItem)?.term) ?? "",
          reason: parsed.reason,
        });
        continue;
      }
      teach.push(parsed.item);
    }

    segments.push({ index, teach });
  }

  return { result: { interests, segments }, dropped };
}

/**
 * 403 gövdesi "model bu planda yok" mu diyor?
 *
 * ÖLÇÜLDÜ (21 Eyl 2026, kartsız hesap, `mistral-large-2512`): 403 +
 * `"This model is not available in your subscription tier"`,
 * `type: "tier_not_allowed"`, `code: 1910`. Birincil sinyal `type`; `code`
 * yedek — biri değişirse diğeri hâlâ tanıyor. İkisi de yoksa 403 genel
 * `API_ERROR` olarak kalır (başka bir 403 sebebi olabilir).
 */
function isTierNotAllowed(body: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return false;
  }

  const record = asRecord(parsed);
  if (!record) return false;

  if (record.type === "tier_not_allowed") return true;
  return String(record.code) === "1910";
}

/** Sağlayıcı yanıtından model metnini çıkarır (OpenAI uyumlu gövde). */
function readMessageContent(body: unknown): string | undefined {
  const choices = asRecord(body)?.choices;
  if (!Array.isArray(choices)) return undefined;

  const message = asRecord(asRecord(choices[0])?.message);
  return asString(message?.content);
}

// ── Dış arayüz ──────────────────────────────────────────────────────────────

/**
 * Bir chunk'ı annotate eder.
 *
 * Modele gönderilen girdi, segmentlerin `index` + `text` listesi: prompt
 * "verilen her segment index'i çıktıda TAM OLARAK BİR KEZ görünmeli" diyor ve
 * `term`in "o segmentte geçtiği gibi" olmasını istiyor, yani modelin index'i
 * ve metni birlikte görmesi gerekiyor. Index'ler bu yüzden burada üretilip
 * gönderiliyor.
 *
 * ⚠️ Prompt girdi JSON'unun BİÇİMİNİ hiçbir yerde tanımlamıyor — yalnız
 * çıktıyı tanımlıyor. Buradaki sarmalayıcı (`{segments:[{index,text}]}`)
 * bilinçli olarak ÇIKTI biçiminin aynası: aynı alan adları (`segments`,
 * `index`), aynı yapı. Promptla çelişen bir şey yok, ama "doğru biçim" diye
 * doğrulanmış bir şey de yok; ilk gerçek koşum bunu gösterecek.
 */
export async function annotateChunk(
  segments: CaptionSegment[],
  apiKey: string,
  model: ModelId,
): Promise<AnnotateOk | { ok: false; error: AnnotateError }> {
  if (apiKey.trim() === "") return { ok: false, error: "NO_API_KEY" };

  const userPayload = {
    segments: segments.map((segment, index) => ({
      index,
      text: segment.text,
    })),
  };

  let response: Response;
  try {
    response = await fetch(API_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        // Model YALNIZ JSON dönmeli — düz metin yok, markdown çiti yok.
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: __ANNOTATE_V6_PROMPT__ },
          { role: "user", content: JSON.stringify(userPayload) },
        ],
      }),
    });
  } catch {
    return { ok: false, error: "API_ERROR" };
  }

  // 🔴 KALICI LOG — geçici teşhis değil.
  //
  // `API_ERROR` sınıfı tek başına sebebi söylemiyor: ağ hatası, izin eksikliği,
  // kimlik doğrulama, geçersiz parametre — hepsi aynı sınıfa düşüyor. Sağlayıcı
  // sebebi gövdede yazıyor ve o gövde okunmadığında teşhis saatler alıyor:
  // geçersiz model adı (`mistral-medium-2512`) ancak gövde basıldığında
  // görüldü — `{"message":"Invalid model: …","type":"invalid_model"}`.
  //
  // Gövde yalnız HATA dalında okunuyor; `text()` akışı tükettiği için başarılı
  // yanıtta `response.json()`'ın çalışması gerekiyor.
  if (!response.ok) {
    let errorBody = "";
    try {
      errorBody = await response.text();
      console.error(
        `[reelvocab:bg] sağlayıcı hatası ${response.status} ${response.statusText}:`,
        errorBody,
      );
    } catch (error) {
      console.error(
        `[reelvocab:bg] sağlayıcı hatası ${response.status} ${response.statusText}; gövde okunamadı:`,
        error instanceof Error ? error.message : String(error),
      );
    }

    // 429 ayrı sınıf: bu KULLANICININ anahtarının sınırı. Karıştırılırsa
    // çağıran taraf yeniden deneyip kullanıcının kendi kotasını daha da yakar.
    if (response.status === 429) return { ok: false, error: "RATE_LIMITED" };

    if (response.status === 403 && isTierNotAllowed(errorBody)) {
      return { ok: false, error: "MODEL_NOT_IN_TIER" };
    }

    return { ok: false, error: "API_ERROR" };
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { ok: false, error: "INVALID_RESPONSE" };
  }

  const content = readMessageContent(body);
  if (content === undefined) {
    // Gövde yalnız geliştirme derlemesinde basılıyor: model çıktısı taşıyabilir.
    if (__DEV__) console.error("[reelvocab:bg] yanıtta content alanı yok:", body);
    else console.error("[reelvocab:bg] yanıtta content alanı yok");
    return { ok: false, error: "INVALID_RESPONSE" };
  }

  // Ham model metni, ayrıştırmadan ÖNCE — yalnız geliştirme derlemesinde.
  if (__DEV__) console.error("[reelvocab:bg] ham content:", content);

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    // TODO: teşhis sonrası kaldır
    console.error(
      "[reelvocab:bg] JSON.parse düştü:",
      error instanceof Error ? error.message : String(error),
    );
    return { ok: false, error: "INVALID_RESPONSE" };
  }

  const parsedResponse = parseAnnotationResult(parsed);
  if (!parsedResponse) return { ok: false, error: "INVALID_RESPONSE" };

  // Kapı listesi: şemayı geçen maddeler buradan geçmeden dışarı ÇIKMAZ.
  const gated = applyGates(parsedResponse.result, segments);

  // Şemada atılan maddeler eleme kaydının BAŞINA yazılıyor: kronolojik olarak
  // kapılardan önce düştüler. `gate: "schema"` sayacı, modelin enum dışına ne
  // sıklıkla çıktığını görünür kılıyor.
  const schemaRejections: GateRejection[] = parsedResponse.dropped.map((drop) => ({
    gate: "schema",
    segmentIndex: drop.segmentIndex,
    term: drop.term,
    detail: drop.reason,
  }));

  return {
    ok: true,
    data: gated.result,
    // Atılan maddeler de modelin ÜRETTİĞİ maddeler: toplam sayıya dahil,
    // yoksa "kaç madde üretildi" sorusu yanlış cevaplanır.
    totalItems: gated.totalItems + schemaRejections.length,
    rejections: [...schemaRejections, ...gated.rejections],
    // Düzeltmeler AYRI: bunlar elenmedi, taşındı. Eleme sayısına karışırsa
    // "kaç madde kaldı" hesabı bozulur.
    corrections: gated.corrections,
  };
}
