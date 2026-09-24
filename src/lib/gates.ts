// Üretim sonrası kapılar — model çıktısına uygulanan altı doğrulama kuralı.
//
// Model çıktısı DOĞRUDAN KULLANILMAZ. Burada altı kapı uygulanır ve süzülmüş
// sonuç aşağı akışa verilir.
//
// 🔴 Kapılar kusur sınıfını ÇÖZMÜYOR. Kanıtlanmış kusur sınıfı (model bozuk
// kaynak metne güvenle anlam uyduruyor) tam olarak kapıların yakalayamadığı
// şey: terim metinde gerçekten geçiyor, model emin, itiraf da etmiyor. Kapılar
// başka şeyleri eliyor — uydurulmuş yüzey biçimi, cümle parçası, özel isim,
// yasaklı örnek. Bu ayrımı unutmak, kapı listesini geçen her maddeyi doğru
// sanmaya yol açar.
//
// 🔴 ELEME SEBEBİ KAYBEDİLMEZ. Her elenen madde, hangi kapıda elendiğiyle
// birlikte kayda geçer: kusur sınıfı analizi ve eval repo'su bu veriyi girdi
// olarak kullanacak.

import type { AnnotationResult, TeachItem } from "./annotate";
import type { CaptionSegment } from "./captions";
import { containsCensoredMarker } from "./captionArtifacts";
import { normText, termKey } from "./termKey";

// Prompt derleme sırasında gömülüyor (bkz. scripts/build.mjs → DEFINE).
// Yasaklı liste bu dizeden TÜRETİLİYOR, elle kopyalanmıyor.
declare const __ANNOTATE_V6_PROMPT__: string;

export type GateName =
  | "proper_noun"
  | "not_in_text"
  | "forbidden_example"
  | "self_confession"
  | "not_a_unit"
  | "duplicate_in_scene"
  // 🔴 "schema" BİR KAPI DEĞİL — kapılardan ÖNCE, şema doğrulamasında atılan
  // maddeler. Aynı kayıtta seyahat ediyor ki eleme raporu tek yerden okunsun
  // ve enum ihlalleri ayrı sayılabilsin.
  // Kaydı `annotate.ts` üretiyor, bu dosya değil.
  | "schema"
  // 🔴 "index_corrected" de bir eleme DEĞİL: madde tutuldu, yalnız yanlış
  // segmente bağlanmıştı ve doğru segmente taşındı. Eleme kayıtlarıyla
  // KARIŞMASIN diye ayrı bir listede taşınıyor (`GateOutcome.corrections`),
  // yoksa "kaç madde elendi" sayısı yanlış olur.
  | "index_corrected";

export interface GateRejection {
  gate: GateName;
  /** Maddenin geldiği segment index'i (chunk içindeki konum). */
  segmentIndex: number;
  term: string;
  /** Kısa, makine okunabilir ayrıntı — hangi kalıp/eşik tetikledi. */
  detail: string;
}

export interface GateOutcome {
  /** Süzülmüş sonuç. Aşağı akış YALNIZ bunu görür. */
  result: AnnotationResult;
  /** Modelin ürettiği toplam madde sayısı (süzme öncesi). */
  totalItems: number;
  /** Elenen her madde, kapısıyla birlikte. */
  rejections: GateRejection[];
  /** Elenmeyen ama DÜZELTİLEN maddeler (şimdilik yalnız index taşıma). */
  corrections: GateRejection[];
}

// ── 3. kapı: yasaklı liste PROMPTTAN türetilir ──────────────────────────────
//
// Elle kopyalanan bir liste, prompt güncellendiğinde eskisiyle kalır ve kapı
// SESSİZCE işlevsizleşir. Bu yüzden liste her çalışmada promptun kendisinden
// okunuyor.
//
// Kaynak iki başlık: promptta `Not units` (birim olmayan cümle parçaları) ve
// `Observed violations` (geçmiş koşularda kurala rağmen üretilmiş ifadeler).
// Başlığı izleyen satırlardaki backtick içi ifadeler, İLK BOŞ SATIRA kadar
// toplanıyor; her biri `termKey()` ile kanonikleştiriliyor.
//
// ⚠️ Promptun `Good units` başlığı altındaki örnekler BİLEREK dışarıda: onlar
// istenen maddeler. Tarama yalnız yukarıdaki iki başlıktan başlıyor.
const FORBIDDEN_HEADINGS = ["Not units", "Observed violations"] as const;

const BACKTICKED = /`([^`\n]+)`/g;

let forbiddenKeysCache: Set<string> | undefined;

/** Prompttan türetilmiş yasaklı anahtar kümesi (bir kez hesaplanır). */
export function forbiddenKeys(): Set<string> {
  if (forbiddenKeysCache) return forbiddenKeysCache;

  const keys = new Set<string>();
  const lines = __ANNOTATE_V6_PROMPT__.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const heading = lines[i];
    if (heading === undefined) continue;
    if (!FORBIDDEN_HEADINGS.some((needle) => heading.includes(needle))) continue;

    // Başlık satırının kendisinden başla (bazı başlıklar iki satıra sarıyor),
    // ilk boş satırda dur.
    for (let j = i; j < lines.length; j++) {
      const line = lines[j];
      if (line === undefined) break;
      if (j > i && line.trim() === "") break;

      for (const match of line.matchAll(BACKTICKED)) {
        const expression = match[1];
        if (expression === undefined) continue;
        const key = termKey(expression);
        if (key !== "") keys.add(key);
      }
    }
  }

  forbiddenKeysCache = keys;
  return keys;
}

// ── 4. kapı: kendi itirafı ──────────────────────────────────────────────────
//
// Model kuralı bilir ve ihlal eder: maddeyi "fragment" ya da "outdated" diye
// etiketleyip YİNE DE sunar (promptun v5 günlüğündeki "booby hatch"
// patolojisi). Açıklama alanlarında mazeret varsa madde çıkar.
//
// 🔴 `senseHere` DE TARANIYOR ve transkripsiyon kalıpları eklendi — ölçümle.
// ÖLÇÜLDÜ (vitrin işlemesi, 21 Eyl 2026, `l2NxH4hke_I`, `large-2512`): model
// `day me` maddesinin `senseHere`'ine "possibly a transcription error",
// `nuance`'ına "may be a misheard … version" yazdı ve yine de sundu. Kapı
// geçirdi: `senseHere` taranmıyordu, listede "transcription" ve "misheard"
// yoktu. Vitrinde insan kapısı yakaladı; BYOK yolunda insan kapısı YOK — bu
// kapı o yoldaki tek koruma.
//
// ⚠️ YANLIŞ POZİTİF RİSKİ: öğretilen ifade gerçekten bu kelimelerle ilgiliyse
// (ör. terim "transcription" kelimesini kapsıyor ve açıklama onu anlatıyor)
// geçerli madde elenebilir. Kalıplar yalnız AÇIKLAMA alanlarında aranıyor,
// `term`'de değil — bu riski azaltıyor, sıfırlamıyor. Elemeler `detail`'de
// alan + kalıpla kayıtlı; eval'de izlenebilir.
const CONFESSION_PATTERNS = [
  "fragment",
  "not standalone",
  "outdated",
  "derogatory",
  "offensive",
  "mispronunciation",
  "misspelling",
  "probably a typo",
  // 21 Eyl 2026 — `day me` vakası (yukarıda).
  "transcription",
  "transcribed",
  "misheard",
  "mishear",
  "mis-hear",
  "likely a typo",
  "could be a typo",
  "caption error",
  "subtitle error",
] as const;

// ── 5. kapı: birim değil ────────────────────────────────────────────────────
//
// 🔴 KELİME SINIRI TÜRE GÖRE (ölçümle değişti, 21 Eyl 2026).
//
// Sınırın gerekçesi ölçülmüş: cümle parçalarını yakalamak. Promptun kendi
// başlığındaki bulgu ("`phrase` HÂLÂ ÇÖP KUTUSU") parçaların ağırlıklı olarak
// `type: "phrase"` ile geldiğini söylüyor.
//
// Ama tek sınır iki geçerli ifadeyi eledi — `too good to be true` ve
// `the motion is agreed to` — ve atasözleri/deyimler sistematik olarak 4
// kelimeyi aşıyor (`the straw that broke the camel's back`, 7 kelime). Sınır
// "birim mi değil mi" çizgisiyle örtüşmüyordu.
//
// Karşılık: `idiom` → 8 kelime; DİĞER tüm türler → 4 (değişmedi). Parçaların
// geldiği `phrase` türü dar sınırda kalıyor.
//
// ⚠️ RİSK: ölçüt modelin `type` BEYANI. Model bir cümle parçasını `idiom`
// diye etiketleyerek bu kapıyı atlatabilir. Elemeler ve geçişler kayıtlı
// olduğu için izlenebilir; kapı raporunda `idiom` türlü uzun maddeler bu
// yüzden ayrıca bakılması gereken yer.
const MAX_TERM_WORDS = 4;
const MAX_IDIOM_WORDS = 8;

function maxWordsFor(type: TeachItem["type"]): number {
  return type === "idiom" ? MAX_IDIOM_WORDS : MAX_TERM_WORDS;
}

function wordCount(term: string): number {
  const normalized = normText(term);
  if (normalized === "") return 0;
  return normalized.split(" ").filter((word) => word !== "").length;
}

/**
 * 1. kapı — özel isim.
 *
 * Kural: "segmentte cümle ortasında büyük harfle geçen ve sözlük birimi
 * olmayan terimler".
 *
 * ⚠️ Kapının İKİNCİ YARISI UYGULANAMADI: "sözlük birimi olmayan" ölçütü bir
 * sözlük gerektiriyor, elimizde yok ve uydurulmadı. Burada yalnız ölçülebilir
 * yarısı var: terim segmentte cümle ORTASINDA ve BÜYÜK HARFLE geçiyorsa elenir.
 *
 * Sonuçları:
 *  · Cümle başındaki büyük harf elenmez (orada büyük harf bilgi taşımıyor).
 *  · Terim segmentte birebir bulunamazsa kapı karar VERMEZ (2. kapı zaten
 *    ilgilenecek).
 *  · Büyük harfle yazılan gerçek sözlük birimleri (kısaltmalar: ASAP, DIY)
 *    bu kapıya takılır — bilinen ve raporlanan bir yanlış pozitif.
 *  · Tamamı küçük harf olan ASR metninde kapı etkisiz kalır; kusur sınıfının
 *    `aaron boys` vakası tam olarak böyleydi.
 */
function isMidSentenceCapitalized(term: string, segmentText: string): boolean {
  let searchFrom = 0;

  for (;;) {
    const at = segmentText.indexOf(term, searchFrom);
    if (at === -1) return false;

    const first = term[0];
    const capitalized = first !== undefined && first === first.toUpperCase() && first !== first.toLowerCase();

    if (capitalized) {
      // Önceki boşluk olmayan karakter: cümle sonu işareti ya da metnin başı
      // ise burası cümle BAŞI, kapı tetiklenmez.
      let previous = "";
      for (let i = at - 1; i >= 0; i--) {
        const char = segmentText[i];
        if (char === undefined) break;
        if (char.trim() === "") continue;
        previous = char;
        break;
      }
      if (previous !== "" && !".!?".includes(previous)) return true;
    }

    searchFrom = at + 1;
  }
}

/**
 * 1-5. kapıları tek maddeye uygular. Geçerse `undefined`, elenirse sebep.
 *
 * Sıra bu beş kapı arasında önemsiz (hepsi eleyici); 6. kapı ayrı ve sonra.
 */
function rejectItem(
  item: TeachItem,
  segmentText: string,
): { gate: GateName; detail: string } | undefined {
  // 1 — özel isim.
  //
  // 🔴 KISALTMALAR MUAF. Bu bir "iyileştirme" değil, iç çelişkinin
  // düzeltilmesi: prompt kısaltmaları AÇIKÇA öğretilecek kapsama alıyor
  // (annotate_v6 → "What counts": "**abbreviations and contractions** a learner
  // meets in real speech (ASAP, DIY, IMO, gonna, wanna, gotta…)"), ama
  // kısaltmalar doğaları gereği cümle ortasında BÜYÜK HARFLE geçiyor. Muafiyet
  // olmadan kapı, promptun istediği maddeleri eliyordu.
  //
  // Muafiyet `type` alanına dayanıyor, yani modelin beyanına: `abbreviation`
  // diyerek bir özel ismi bu kapıdan geçirebilir. Kabul edilen takas — bir
  // kapının yanlış elemesi, promptun ana kapsamından bir sınıfı tamamen
  // kaybetmekten iyidir.
  if (
    item.type !== "abbreviation" &&
    isMidSentenceCapitalized(item.term, segmentText)
  ) {
    return { gate: "proper_noun", detail: "cümle ortasında büyük harf" };
  }

  // 2 — metinde geçmiyor: bu kapı artık ÖNCE, `resolveSegment` içinde
  // çalışıyor (aşağıdaki halüsinasyon/index ayrımı). Buraya gelen madde
  // metinde zaten bulunmuş demektir.

  // 3 — yasaklı örnek (prompttan türetilmiş küme)
  const key = termKey(item.term);
  if (forbiddenKeys().has(key)) {
    return { gate: "forbidden_example", detail: `termKey: ${key}` };
  }

  // 4 — kendi itirafı. Açıklama alanları AYRI AYRI taranıyor ki `detail`
  // hangi alanda hangi kalıbın eşleştiğini söyleyebilsin. `term` taranmıyor
  // (yanlış pozitif notu yukarıda).
  const confessionFields = [
    ["senseHere", item.senseHere],
    ["note", item.note],
    ["nuance", item.nuance ?? ""],
  ] as const;
  for (const [field, text] of confessionFields) {
    const lower = text.toLowerCase();
    const pattern = CONFESSION_PATTERNS.find((needle) => lower.includes(needle));
    if (pattern !== undefined) {
      return { gate: "self_confession", detail: `alan: ${field}, kalıp: ${pattern}` };
    }
  }

  // 5 — birim değil: türe göre kelime sınırı ve sansür yer tutucusu.
  // `detail` uygulanan sınırı da yazıyor: hangi türün hangi sınıra takıldığı
  // eval'de ayrıştırılabilsin.
  const words = wordCount(item.term);
  const limit = maxWordsFor(item.type);
  if (words > limit) {
    return {
      gate: "not_a_unit",
      detail: `${words} kelime, ${item.type} sınırı ${limit}`,
    };
  }
  if (containsCensoredMarker(item.term)) {
    return { gate: "not_a_unit", detail: "sansür yer tutucusu taşıyor" };
  }

  return undefined;
}

interface ResolvedSegment {
  /** Maddenin bağlanacağı segment index'i (düzeltilmiş olabilir). */
  index: number;
  text: string;
  /** Düzeltme yapıldıysa modelin verdiği eski index. */
  correctedFrom?: number;
  /** Terimin chunk'ta kaç segmentte bulunduğu. */
  matchCount: number;
}

/**
 * 2. kapı — metinde geçmiyor. 🔴 İKİ FARKLI ŞEY AYRILIYOR.
 *
 * ÖLÇÜLDÜ (19 Eyl 2026), dört vaka: `calling the roll` (segment 4'e atandı,
 * orada yok), `the chair recognizes`, `nay`, `the ayes have it`,
 * `compel the attendance`. Hepsi parlamenter jargon; hepsi chunk'ta VAR ama
 * modelin verdiği index'te değil.
 *
 * Eski kapı ikisini aynı sınıfa çöküyordu:
 *  · **halüsinasyon** — terim chunk'ın hiçbir yerinde yok. Modelin uydurduğu
 *    ya da "düzelttiği" yüzey biçimi. Elenir.
 *  · **index hatası** — terim BAŞKA bir segmentte var. Madde geçerli, yalnız
 *    konumu yanlış. Taşınır.
 *
 * Taşımak ürünün iddiasını zedelemiyor: madde "bu sahnede ne demek" sorusuna
 * cevap veriyor ve GERÇEKTEN geçtiği segmente bağlanıyor — yanlış segmentte
 * bırakmak ya da atmak, iddiayı zedeleyen şey olurdu.
 *
 * Birden fazla segmentte bulunursa ilki alınır; kaç segmentte bulunduğu kayda
 * yazılır (tekrar eden ifade 6. kapının işi).
 */
function resolveSegment(
  term: string,
  givenIndex: number,
  segments: CaptionSegment[],
): ResolvedSegment | undefined {
  const needle = normText(term);
  // Boş terim hiçbir şeye bağlanamaz: her metin boş dizeyi "içerir", bu da
  // her maddeyi geçirirdi.
  if (needle === "") return undefined;

  const given = segments[givenIndex];
  if (given && normText(given.text).includes(needle)) {
    return { index: givenIndex, text: given.text, matchCount: 1 };
  }

  const matches: number[] = [];
  for (let at = 0; at < segments.length; at++) {
    const candidate = segments[at];
    if (!candidate) continue;
    if (normText(candidate.text).includes(needle)) matches.push(at);
  }

  const first = matches[0];
  if (first === undefined) return undefined;

  const target = segments[first];
  if (!target) return undefined;

  return {
    index: first,
    text: target.text,
    correctedFrom: givenIndex,
    matchCount: matches.length,
  };
}

/**
 * Kapıları uygular.
 *
 * 🔴 SIRA BAĞLAYICI. İlk beş kapı eleyicidir, ancak 6. kapı eleme değil
 * TEKİLLEŞTİRME yapıyor. Önce
 * çalışırsa en yüksek `confidence`'lı kopya tutulur, sonra o kopya başka bir
 * kapıda (ör. "metinde geçmiyor") elenir ve geçerli olan DAHA DÜŞÜK kopya da
 * kaybolmuş olur — ifade hiç öğretilmez. Bu yüzden 1-5 önce, 6 EN SON.
 *
 * `segments` chunk'ın kendisidir; model çıktısındaki `index` bu dizideki
 * konuma karşılık gelir (annotate.ts index'leri oradan üretiyor).
 */
export function applyGates(
  result: AnnotationResult,
  segments: CaptionSegment[],
): GateOutcome {
  const rejections: GateRejection[] = [];
  const corrections: GateRejection[] = [];
  let totalItems = 0;

  // ── 2. kapı (çözümleme) + 1, 3-5 ──
  interface Surviving {
    segmentIndex: number;
    item: TeachItem;
  }
  const surviving: Surviving[] = [];

  for (const segment of result.segments) {
    for (const item of segment.teach) {
      totalItems++;

      // 2 — terim hangi segmentte GERÇEKTEN geçiyor? Verilen index yanlışsa
      // madde taşınır; hiçbir yerde yoksa elenir (halüsinasyon).
      const resolved = resolveSegment(item.term, segment.index, segments);
      if (!resolved) {
        rejections.push({
          gate: "not_in_text",
          segmentIndex: segment.index,
          term: item.term,
          detail: "chunk'ın hiçbir segmentinde geçmiyor",
        });
        continue;
      }

      if (resolved.correctedFrom !== undefined) {
        corrections.push({
          gate: "index_corrected",
          segmentIndex: resolved.index,
          term: item.term,
          detail:
            `index ${resolved.correctedFrom} → ${resolved.index}` +
            (resolved.matchCount > 1
              ? `, ${resolved.matchCount} segmentte bulundu (ilki alındı)`
              : ""),
        });
      }

      // 1, 3, 4, 5 — düzeltilmiş segmentin METNİ üzerinden. Özel isim kapısı
      // terimin geçtiği yere bakıyor, dolayısıyla doğru metin şart.
      const rejection = rejectItem(item, resolved.text);
      if (rejection) {
        rejections.push({
          gate: rejection.gate,
          segmentIndex: resolved.index,
          term: item.term,
          detail: rejection.detail,
        });
        continue;
      }

      surviving.push({ segmentIndex: resolved.index, item });
    }
  }

  // ── 6. kapı: sahne içinde tekrar ──
  // Aynı ifade chunk içinde birden çok segmentte geçebiliyor; `termKey` ile
  // tekilleştirilir ve en yüksek `confidence` taşıyan kopya tutulur.
  const best = new Map<string, Surviving>();
  const duplicates: Surviving[] = [];

  for (const candidate of surviving) {
    const key = termKey(candidate.item.term);
    const current = best.get(key);

    if (!current) {
      best.set(key, candidate);
      continue;
    }

    if (candidate.item.confidence > current.item.confidence) {
      best.set(key, candidate);
      duplicates.push(current);
    } else {
      duplicates.push(candidate);
    }
  }

  for (const dropped of duplicates) {
    rejections.push({
      gate: "duplicate_in_scene",
      segmentIndex: dropped.segmentIndex,
      term: dropped.item.term,
      detail: `termKey: ${termKey(dropped.item.term)}`,
    });
  }

  // Kalanlar segment index'lerine göre yeniden toplanır. Boş `teach` taşıyan
  // segment KORUNUR: boş dizi geçerli ve beklenen bir cevap (kota yok kuralı).
  const keptBySegment = new Map<number, TeachItem[]>();
  for (const segment of result.segments) {
    keptBySegment.set(segment.index, []);
  }
  // Taşınan bir madde, modelin çıktısında hiç bulunmayan bir segmente gitmiş
  // olabilir; o segment listeye eklenir, yoksa madde sessizce kaybolur.
  for (const kept of best.values()) {
    const bucket = keptBySegment.get(kept.segmentIndex);
    if (bucket) {
      bucket.push(kept.item);
    } else {
      keptBySegment.set(kept.segmentIndex, [kept.item]);
    }
  }

  const orderedIndexes = [...keptBySegment.keys()].sort((a, b) => a - b);

  return {
    result: {
      interests: result.interests,
      segments: orderedIndexes.map((index) => ({
        index,
        teach: keptBySegment.get(index) ?? [],
      })),
    },
    totalItems,
    rejections,
    corrections,
  };
}
