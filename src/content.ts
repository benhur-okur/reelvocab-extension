// İzole ortam (ISOLATED) giriş noktası — köprünün eklenti tarafı.
//
// Bu betik `chrome.*` API'lerine erişir ama sayfanın JS global'lerini GÖRMEZ.
// Altyazıyı çeken kod bu yüzden MAIN ortamında duruyor ve sonucu buraya
// `window.postMessage` ile geçiyor.
//
// Betik manifest'ten değil, ikon tıklamasında `chrome.scripting` ile enjekte
// ediliyor (background.ts) ve SPA gezinmesinde sayfada kalıyor.
//
// Buradaki işler: köprü mesajını doğrulamak, segmentleri chunk'lamak, sırayla
// background'a göndermek ve sonucu PANELDE göstermek. Konsol
// çıktısı da duruyor — panel ona ek, yerine değil.
//
// 🔴 Panelde görünen maddeler kapılardan geçmiş olanlar, ama "doğru" demek
// değil: kanıtlanmış kusur sınıfı kapıların yakalayamadığı şey. Arayüz bunları
// "bu sahnede muhtemelen şu anlama geliyor" çerçevesiyle sunmalı; o metin henüz
// yazılmadı.
//
// TODO: altyazı katmanı ve renklendirme, oynatma kafasıyla senkron,
// `yt-navigate-finish` ile SPA gezinmesi, depolama.

import { mountPanel } from "./overlay/overlay";
import type { Panel, PanelItem, PanelPosition } from "./overlay/overlay";
import { cacheKey, STORAGE_KEY_MISTRAL, STORAGE_KEY_REPORTS } from "./lib/storageKeys";
import { ALLOWED_MODELS, DEFAULT_MODEL, asModelId } from "./lib/models";
import type { ModelId } from "./lib/models";
import { parseShowcase, readShowcaseEntries, surfaceKey } from "./lib/showcase";
import type { ShowcaseEntry, ShowcaseVideo } from "./lib/showcase";
import { ISOLATED_READY_FLAG } from "./lib/injection";
import { msg } from "./lib/i18n";

const MESSAGE_SOURCE = "reelvocab";
const MESSAGE_TYPE = "captions-result";

/** İzole taraftan MAIN'e "koşumu başlat" mesajı (ikon tetiği için). */
const START_TYPE = "start-run";

/** Koşum özetinin MAIN tarafına döndüğü mesaj tipi. */
const SUMMARY_TYPE = "annotation-summary";

const LOG_PREFIX = "[reelvocab:isolated]";

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  return value as UnknownRecord;
}

/**
 * 🔴 KÖPRÜDEN GELEN VERİ GÜVENİLMEZ.
 *
 * `window.postMessage` sayfadaki HER koda açık: YouTube'un kendi JS'i, başka
 * eklentiler, enjekte edilmiş her şey aynı kanala yazabilir. Bizim MAIN
 * betiğimizden geldiğinin garantisi yok — bu yüzden mesaj kimliği kontrol
 * edilmeden kullanılmaz.
 *
 * Kontroller:
 *  · `event.source === window` — mesaj BU pencereden gelmiş olmalı, iframe ya
 *    da başka bir pencereden değil.
 *  · `event.origin` sayfanın origin'i olmalı.
 *  · `source` + `type` alanları beklenen ikiliyi taşımalı.
 *
 * ⚠️ Bunlar mesajın SAHİCİLİĞİNİ kanıtlamaz, yalnız kaba gürültüyü eler:
 * sayfa ortamındaki kötü niyetli kod aynı alanlarla mesaj üretebilir. Asıl
 * koruma, `payload` içeriğinin aşağı akışta doğrulanması — bu tur yalnız
 * konsola bastığı için o doğrulama henüz yazılmadı.
 */
interface BridgeMessage {
  payload: unknown;
  requestId: string | undefined;
  chunkSize: number;
  maxChunks: number | undefined;
  /** Konsol yolu: onay beklemeden koş. İkon yolu önizlemede durur. */
  autoStart: boolean;
  /**
   * İzinli model; `undefined` = mesaj izinli OLMAYAN bir model taşıyordu.
   * Alan hiç yoksa varsayılan (kalibre edilmiş) model.
   */
  model: ModelId | undefined;
  /** Altyazının çekildiği video (MAIN, çekme başladığında adresten okudu). */
  videoId: string | undefined;
}

function readBridgeMessage(
  event: MessageEvent<unknown>,
): BridgeMessage | undefined {
  if (event.source !== window) return undefined;
  if (event.origin !== window.location.origin) return undefined;

  const data = asRecord(event.data);
  if (!data) return undefined;
  if (data.source !== MESSAGE_SOURCE || data.type !== MESSAGE_TYPE) {
    return undefined;
  }

  // Parametreler de güvenilmez kanaldan geliyor: sayı olmayan ya da anlamsız
  // değerler varsayılana düşer, koşumu bozmaz.
  const options = asRecord(data.options);
  const rawChunkSize = asNumber(options?.chunkSize);
  const rawMaxChunks = asNumber(options?.maxChunks);

  return {
    payload: data.payload,
    requestId: asString(data.requestId),
    chunkSize:
      rawChunkSize !== undefined && rawChunkSize >= 1
        ? Math.floor(rawChunkSize)
        : DEFAULT_CHUNK_SIZE,
    maxChunks:
      rawMaxChunks !== undefined && rawMaxChunks >= 1
        ? Math.floor(rawMaxChunks)
        : undefined,
    autoStart: data.autoStart === true,
    // Serbest dize kabul edilmiyor: kanal güvenilmez ve varsayılana sessizce
    // düşmek, başka modeli ölçtüğünü sanan kişiye yanlış sonuç gösterirdi.
    model: options?.model === undefined ? DEFAULT_MODEL : asModelId(options?.model),
    videoId: asString(data.videoId),
  };
}

// ── Chunk'lama ──────────────────────────────────────────────────────────────
//
// 🔴 ÖLÇÜT ZAMAN DEĞİL, SEGMENT SAYISI.
//
// Gerekçe — maliyet çağrı sayısıyla ölçekleniyor, segment sayısıyla değil:
// ölçüldü (18 Eyl 2026), 10 segmentlik bir çağrıda 4457 prompt tokeninin
// neredeyse tamamı `annotate_v6`'nın KENDİSİ ve her çağrıda tam olarak
// gidiyor (`cached_tokens` 0). Yani az sayıda büyük chunk, çok sayıda küçük
// chunk'tan belirgin biçimde ucuz.
//
// İkinci gerekçe kalite tarafında: ölçüm çok chunk'lı
// sahnelerde çöpün arttığını gösteriyor (dwight sahnesi: 66 madde —
// stopwatch, duffel bag, measles gibi düz sözlük anlamları). Chunk'lama örtük
// kota yaratıyor: her chunk "bir şey bulmalıyım" baskısı üretiyor.
//
// 🔴 20 SAYISI ÖLÇÜLMÜŞ BİR OPTİMUM DEĞİL, GEREKÇELİ BİR VARSAYILAN
// (karar, 19 Eyl 2026).
//
// Karşılaştırmalı ölçüm eklentide YAPILAMAZ: ölçülecek sinyal modelin kendi
// varyansının altında kalıyor. Aynı video ve aynı promptla yapılan koşumlarda
// madde sayısı (3/5/6), hangi maddelerin üretildiği, aynı maddenin enum
// değerleri (`register`: formal → technical), boş segment döndürülüp
// döndürülmediği ve hatta alan adları (`confidence` → `conficulty`) değişti.
// Bu gürültünün içinden chunk boyutunun etkisini ayırmak boyut başına çok
// sayıda koşu ister ve sonuç yine tek videoda geçerli olur. Doğru yeri eval
// repo'su: sabit set, tekrarlanabilir koşu, kayıtlı sonuç.
//
// Kararı taşıyan iki ÖLÇÜLMÜŞ girdi yukarıda: (1) maliyet çağrı sayısıyla
// ölçekleniyor, (2) çok chunk'lı sahneler çöp doluyor. İkisi de "daha az, daha
// büyük chunk" diyor.
//
// Karşı risk (büyük chunk'ta `not_in_text` artışı) TEK gözleme dayanıyordu ve
// bu projede tek gözlemden örüntü çıkarılmaz — aynı hata enum ihlali
// iddiasında yapıldı ve çürüdü.
//
// 🔴 SABİT KODLANMADI: chunk boyutu konsoldan verilebiliyor
// (`__reelvocabTest({ chunkSize: 10 })`), hem karşılaştırmalı ölçüm build
// gerektirmesin, hem eval repo'su ölçtüğünde sayı tek yerden güncellenebilsin.
const DEFAULT_CHUNK_SIZE = 20;

/**
 * Chunk'lar arasındaki bekleme.
 *
 * Çağrılar SIRAYLA gidiyor ve aralarında kısa bir boşluk var: kullanıcının
 * Mistral anahtarının kendi hız sınırı var ve paralel çağrı 429 üretir —
 * kendi anahtarıyla kendi hesabını bloke etmek eklentinin yapabileceği en
 * kötü şey.
 */
const CHUNK_DELAY_MS = 1000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function chunkSegments(
  segments: BridgeSegment[],
  size: number,
): BridgeSegment[][] {
  const chunks: BridgeSegment[][] = [];
  for (let at = 0; at < segments.length; at += size) {
    chunks.push(segments.slice(at, at + size));
  }
  return chunks;
}

interface BridgeSegment {
  start: number;
  end: number;
  text: string;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/**
 * Köprü yükünden segment listesini çıkarır.
 *
 * Yük MAIN ortamından geldi, yani güvenilmez: `ok` bayrağı da, içindeki her
 * alan da burada yeniden doğrulanıyor. Başarısız sonuç (`ok: false`) ya da
 * bozuk biçim → `undefined`, yani background'a hiçbir şey gitmiyor.
 */
function readSegments(payload: unknown): BridgeSegment[] | undefined {
  const record = asRecord(payload);
  if (!record || record.ok !== true) return undefined;

  const rawSegments = asRecord(record.data)?.segments;
  if (!Array.isArray(rawSegments)) return undefined;

  const segments: BridgeSegment[] = [];
  for (const candidate of rawSegments) {
    const segment = asRecord(candidate);
    if (!segment) return undefined;

    const start = asNumber(segment.start);
    const end = asNumber(segment.end);
    const text = asString(segment.text);
    if (start === undefined || end === undefined || text === undefined) {
      return undefined;
    }

    segments.push({ start, end, text });
  }

  return segments;
}

/**
 * Kapı listesinin ölçülebilir olması için eleme kaydını özetler.
 *
 * Kapı listesinin ölçülebilir çalışması gerekiyor:
 * kaç madde üretildi, kaçı elendi, hangi kapıda. Yanıt güvenilmez bir kanaldan
 * geldiği için burada da daraltılarak okunuyor.
 */
interface ChunkReport {
  chunkIndex: number;
  segmentCount: number;
  /** Modelin ürettiği madde sayısı; hata durumunda `undefined`. */
  totalItems: number | undefined;
  rejected: number;
  /** Elenmedi, yalnız doğru segmente taşındı. */
  corrected: number;
  kept: number;
  error: string | undefined;
}

interface RunSummary {
  /** Koşumun kullandığı model — ölçüm karşılaştırmasında ayırt edici. */
  model: ModelId;
  segmentCount: number;
  chunkSize: number;
  /** Videodaki toplam chunk sayısı (`maxChunks` uygulanmadan önce). */
  chunkCount: number;
  /** Gerçekten yapılan çağrı sayısı. */
  calls: number;
  totalItems: number;
  totalRejected: number;
  /** Doğru segmente taşınan madde sayısı — eleme DEĞİL. */
  totalCorrected: number;
  totalKept: number;
  /** Kapı adı → elenen madde sayısı. */
  gateCounts: Record<string, number>;
  /**
   * Panelde gizlenen bölümler arası tekrarlar. 🔴 KAPI DEĞİL, sunum kararı:
   * `gateCounts`'a karışmıyor — model maddeyi üretti ve kapılardan geçti,
   * yalnız aynı yüzey biçimi daha önce gösterildiği için tekrar gösterilmiyor.
   */
  duplicatesHidden: number;
  failures: { chunkIndex: number; error: string }[];
  /**
   * Koşumu durduran ölümcül hata sınıfı (`FATAL_ERRORS`); yoksa `undefined`.
   * Doluysa kalan bölümler DENENMEDİ.
   */
  fatalError: string | undefined;
  durationMs: number;
  /** Chunk başına ayrıntı. */
  chunks: ChunkReport[];
}

// ── Panel ───────────────────────────────────────────────────────────────────

let panel: Panel | undefined;

/** Bu koşumda panelde biriken maddeler — "kopyala" ve önbellek için. */
let shownItems: PanelItem[] = [];

/** Sıradaki koşum önbelleği ATLASIN mı? ("yeniden işle" düğmesi kurar.) */
let bypassCache = false;

/**
 * 🔴 DURUM MAKİNESİ. Her durumun panelde bir karşılığı var; panel hiçbir
 * durumda boş/anlamsız görünmüyor.
 *
 *   idle      → panel yok ya da henüz hiçbir şey istenmedi
 *   fetching  → altyazı çekiliyor (ucuz, API çağrısı DEĞİL)
 *   ready     → altyazı elde, önizleme görünüyor, "Başlat" bekliyor
 *   running   → chunk'lar işleniyor (pahalı: ~$0.04, ~60 sn)
 *   done      → bitti (sonuç dolu, boş ya da kısmi olabilir)
 *   error     → altyazı çekme başarısız; başlatılacak bir şey YOK
 *   prepare   → vitrinde/önbellekte yok, anahtar var; altyazı ÇEKİLMEDİ,
 *               "Bu videoyu hazırla" bekliyor
 *   noperm    → anahtar var, Mistral izni yok; ayar sayfasına yönlendirme
 */
type Phase =
  | "idle"
  | "fetching"
  | "ready"
  | "running"
  | "done"
  | "error"
  // Vitrin videosu: gözden geçirilmiş liste, işleme YOK (karar 8).
  | "showcase"
  // Anahtar yok, vitrin dışı video: işlenecek bir şey yok, yönlendirme var.
  | "nokey"
  // Başka bir video işleniyor; bu videoda Başlat bekliyor (video bazında tek
  // koşum — paralel koşum kullanıcının anahtarının hız sınırına takılır).
  | "busy"
  // Yerel aramalar (vitrin, önbellek) boş döndü; YouTube'a istek atılmadı.
  // Altyazı yalnız kullanıcı "Bu videoyu hazırla"ya basınca çekiliyor.
  | "prepare"
  // Anahtar var ama Mistral kökenine izin yok: Başlat yerine izin mesajı ve
  // ayar sayfası bağlantısı. Altyazı çekilmiyor — işlenemeyecek.
  | "noperm";

let phase: Phase = "idle";

/** Panelde gösterilen son durum metni — panel yeniden kurulursa geri yazılır. */
let statusLine = { text: msg("statusIdle"), code: undefined as string | undefined };
let previewLine: string | undefined;
let sourceNoteLine: string | undefined;
let summaryLine: string | undefined;
let emptyLine: { title: string; detail: string } | undefined;
let failureLines: { chunkIndex: number; error: string }[] = [];
let failureNote: string | undefined;
let cachedResult = false;

/** Gösterilen liste gözden geçirilmiş vitrin verisi mi? (rozet) */
let reviewedResult = false;

/** Anahtar kayıtlı mı? Yalnız evet/hayır — anahtar buraya gelmiyor. */
let keyAvailable = false;

/** Panelde "ayar sayfasını aç" bağlantısı görünsün mü (izin/anahtar hatası)? */
let settingsLinkShown = false;

/** Sıradaki akış vitrini ATLASIN mı? ("kendi anahtarınızla yeniden işleyin") */
let bypassShowcase = false;

/** "nokey" durumunda gösterilen vitrin listesi. */
let noKeyShowcases: ShowcaseEntry[] | undefined;

/**
 * 🔴 PANEL DURUMU BİR VİDEOYA BAĞLI.
 *
 * GÖZLENDİ: vitrin videosundan kenar önerisiyle başka bir videoya geçilince
 * panel yeni videonun durumunu gösterdi ama listenin altında ÖNCEKİ videonun
 * maddeleri kaldı. Sonuçları: senkron takip yeni videonun zamanıyla eski
 * maddeleri vurgular, "sahneye git" yanlış yere atlar, süren bir işlemin
 * sonucu yeni videonun paneline yazılabilir. Bayat `ytInitialPlayerResponse`
 * hatasının kardeşi (captions.ts → readPlayerResponse).
 *
 * `activeVideoId`: panelde gösterilen her şeyin ait olduğu video. Her panel
 * yazımı sonucun videosunu bununla karşılaştırıyor.
 */
let activeVideoId: string | undefined;

/**
 * İşlenmekte olan video. Tek koşum kuralı VİDEO BAZINDA değil GLOBAL: A
 * işlenirken B'de Başlat engelleniyor — paralel koşum kullanıcının anahtarının
 * hız sınırına takılır.
 */
let runningVideoId: string | undefined;

/** SPA gezinmesi algılama için son görülen video. */
let lastSeenVideoId: string | undefined;

/** "Başlat" ile işlenmeyi bekleyen, çekilmiş altyazı. */
interface PendingRun {
  /** Altyazının ait olduğu video — sonuç bu videonun önbelleğine yazılır. */
  videoId: string;
  segments: BridgeSegment[];
  chunkSize: number;
  maxChunks: number | undefined;
  requestId: string | undefined;
  model: ModelId;
  isAsr: boolean;
  /** Seçilen parçanın görünen adı (captions.ts); yoksa `undefined`. */
  trackName: string | undefined;
}

let pending: PendingRun | undefined;

/** Videonun kimliği — önbellek anahtarı ve hata kaydı için. */
function currentVideoId(): string | undefined {
  try {
    const value = new URL(window.location.href).searchParams.get("v");
    return value !== null && value !== "" ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Panel yoksa kurar; varsa aynısını kullanır (tek panel kuralı).
 *
 * 🔴 ÖLÇÜLMÜŞ HATA: panel X ile kapatıldıktan sonra eklenti ikonu hiçbir şey
 * yapmıyordu. Sebep buradaki bayraktı — `destroy()` paneli DOM'dan
 * kaldırıyordu ama `panel` değişkeni dolu kalıyordu, yani `ensurePanel()`
 * artık var olmayan bir panele referans döndürüyordu. Çözüm: kapanma geri
 * bildirimi (`onClose`) bayrağı temizliyor.
 */
function ensurePanel(): Panel {
  if (panel) return panel;

  panel = mountPanel({
    onClose: () => {
      panel = undefined;
      // 🔴 Koşum arka planda DEVAM EDİYOR: panel kapatmak iptal değil
      // (iptal kapsam dışı). İkona tekrar basınca panel mevcut durumuyla
      // geri geliyor — `renderState()`.
    },

    onReport: async (item) => {
      await saveReport(item);
    },

    onCopy: async () => {
      await copyToClipboard();
    },

    onPrimary: () => {
      // Tek ana düğme iki iş yapıyor: "Başlat" (ready) ve "Yeniden işle"
      // (done/error sonrası). İkisi de aynı yere çıkıyor; fark, önbelleğin
      // atlanıp atlanmaması.
      if (phase === "running" || phase === "fetching" || phase === "busy") return;

      if (phase === "ready" && pending) {
        void startRun(pending);
        return;
      }

      // "Bu videoyu hazırla": altyazı ancak burada çekiliyor. Önbellek
      // atlanmıyor — yerel aramalar zaten boş döndü, yeniden bakmak ucuz.
      if (phase === "prepare") {
        void openPanelFlow(true);
        return;
      }

      // "Yeniden işle": vitrin ve önbellek atlanıp gerçek işleme.
      bypassShowcase = true;
      bypassCache = true;
      requestRunFromMain();
    },

    onSecondary: () => {
      // Vitrin videosunda "kendi anahtarınızla yeniden işleyin": normal akış. Sonuç
      // vitrin rozetini TAŞIMAZ — insan kapısından geçmedi.
      if (phase === "running" || phase === "fetching" || phase === "busy") return;
      bypassShowcase = true;
      bypassCache = true;
      requestRunFromMain();
    },

    onOpenOptions: () => {
      void chrome.runtime.sendMessage({ type: "open-options" }).catch(() => {
        console.warn(`${LOG_PREFIX} ayar sayfası açılamadı`);
      });
    },

    onMove: (next) => {
      void savePanelPosition(next);
    },

    onSeek: (seconds) => {
      // Liste başka bir videoya aitse (gezinme algılanmadan önceki kısa aralık)
      // atlanmıyor: eski videonun zaman damgası yeni videoda anlamsız.
      if (activeVideoId !== currentVideoId()) {
        console.warn(`${LOG_PREFIX} liste başka bir videoya ait, atlanmadı`);
        return;
      }
      // Video elementi sayfanın DOM'unda; izole ortamdan erişilebiliyor
      // (sayfanın JS değişkenleri erişilemez, DOM erişilebilir).
      const video = document.querySelector("video");
      if (!(video instanceof HTMLVideoElement)) {
        console.warn(`${LOG_PREFIX} video elementi bulunamadı, atlanamadı`);
        return;
      }

      // 🔴 2 saniye GERİ sarılıyor: ifade segmentin başında geçiyorsa tam o
      // ana atlamak kelimeyi kaçırtıyor; biraz öncesi bağlamı da veriyor.
      //
      // ⚠️ REKLAM DURUMU ELE ALINMADI: reklam oynarken `currentTime` reklamın
      // zamanını gösteriyor, yani atlama yanlış yere gider (`.ad-showing`).
      video.currentTime = Math.max(0, seconds - SEEK_BACK_SECONDS);
    },
  });

  // Panel yeni kuruldu: bilinen durumu geri yaz. Koşum sürerken panel
  // kapatılıp ikona tekrar basıldığında liste ve durum kaybolmasın.
  renderState();
  void restorePanelPosition();
  startSyncTracking();

  return panel;
}

/** Bilinen durumu panele yazar — ilk kurulumda ve yeniden kurulumda. */
function renderState(): void {
  const view = panel;
  if (!view) return;

  view.setStatus(statusLine.text, statusLine.code);
  view.setSourceNote(sourceNoteLine);
  view.setPreview(previewLine);
  view.setCached(cachedResult);
  view.setReviewed(reviewedResult);
  view.setNoKeyInfo(phase === "nokey" ? noKeyShowcases ?? [] : undefined);
  view.setSettingsLink(settingsLinkShown ? msg("buttonOpenSettings") : undefined);
  view.setSecondary(undefined);
  view.setSummary(summaryLine);
  view.setFailures(failureLines, failureNote);
  view.setEmptyMessage(emptyLine?.title, emptyLine?.detail);

  if (shownItems.length > 0) {
    view.clearItems();
    view.addItems(shownItems);
    // `clearItems` özeti de gizliyor; sırayı bozmamak için yeniden yaz.
    view.setSummary(summaryLine);
    view.setFailures(failureLines, failureNote);
  }

  switch (phase) {
    case "fetching":
    case "running":
      // Çift tetikleme koruması: koşum sürerken düğme devre dışı.
      view.setPrimary(phase === "running" ? msg("buttonProcessing") : undefined, false);
      break;
    case "ready":
      view.setPrimary(msg("buttonStart"), true);
      break;
    case "done":
      // Anahtar yoksa "Yeniden işle" bir işe yaramaz (önbellekten gelen sonuç):
      // düğme gizli.
      view.setPrimary(keyAvailable ? msg("buttonReprocess") : undefined, keyAvailable);
      break;
    case "showcase":
      // Vitrin: Başlat YOK. Anahtar varsa yalnız küçük ikincil seçenek.
      view.setPrimary(undefined, false);
      view.setSecondary(keyAvailable ? msg("buttonReprocessOwnKey") : undefined);
      break;
    case "nokey":
      view.setPrimary(undefined, false);
      break;
    case "busy":
      // Başka video işleniyor: düğme görünür ama devre dışı — neden başlatılamadığı
      // durum satırında yazıyor.
      view.setPrimary(msg("buttonStart"), false);
      break;
    case "prepare":
      view.setPrimary(msg("buttonPrepare"), true);
      break;
    case "noperm":
      // Başlat YOK: izin olmadan her bölüm `PERMISSION_MISSING` ile düşerdi.
      view.setPrimary(undefined, false);
      break;
    case "error":
      // Başlatılacak bir şey yok: düğme HİÇ görünmüyor.
      view.setPrimary(undefined, false);
      break;
    case "idle":
      view.setPrimary(undefined, false);
      break;
  }
}

function setStatus(text: string, code?: string): void {
  statusLine = { text, code };
  panel?.setStatus(text, code);
}

/** Maddeye atlarken geri sarılan süre. */
const SEEK_BACK_SECONDS = 2;

// ── Panel konumu ────────────────────────────────────────────────────────────

const STORAGE_KEY_POSITION = "rv-panel-position";

async function savePanelPosition(
  position: PanelPosition | undefined,
): Promise<void> {
  try {
    if (position === undefined) {
      await chrome.storage.local.remove(STORAGE_KEY_POSITION);
      return;
    }
    await chrome.storage.local.set({ [STORAGE_KEY_POSITION]: position });
  } catch (error) {
    console.warn(`${LOG_PREFIX} panel konumu kaydedilemedi:`, error);
  }
}

async function restorePanelPosition(): Promise<void> {
  try {
    const stored = asRecord(await readStored(STORAGE_KEY_POSITION));
    const left = asNumber(stored?.left);
    const top = asNumber(stored?.top);
    if (left === undefined || top === undefined) return;
    // Sınır kontrolü panelde: kaydedilen konum artık ekran dışında olabilir
    // (küçük pencere, farklı ekran).
    panel?.setPosition({ left, top });
  } catch (error) {
    console.warn(`${LOG_PREFIX} panel konumu okunamadı:`, error);
  }
}

// ── Senkron takip ───────────────────────────────────────────────────────────
//
// 🔴 ZORLAMASIZ: aktif madde vurgulanır, ama kullanıcı listeyi elle
// kaydırırsa takip durur (panelin içindeki kural). Aktif madde yoksa hiçbir
// şey vurgulanmaz.

let syncTrackingStarted = false;

/** Reklam oynuyor mu? Player'da `.ad-showing` sınıfı. */
function isAdShowing(): boolean {
  const player = document.querySelector("#movie_player");
  return player instanceof HTMLElement && player.classList.contains("ad-showing");
}

function activeItemIndex(time: number): number | undefined {
  for (let at = 0; at < shownItems.length; at++) {
    const item = shownItems[at];
    if (!item) continue;
    if (time >= item.start && time < item.end) return at;
  }
  return undefined;
}

/**
 * Video zamanını izleyip aktif maddeyi panele bildirir.
 *
 * Ele alınan durumlar:
 *  · Reklam: `currentTime` REKLAMIN zamanı, yani vurgu yanlış maddeye giderdi.
 *    Reklam sırasında takip DURUR ve vurgu kalkar; reklam bitince kaldığı
 *    yerden devam eder.
 *  · İleri/geri sarma: `timeupdate` yetmiyor, `seeked` de dinleniyor.
 *  · Duraklatma: vurgu kalır, `timeupdate` gelmediği için kaydırma da
 *    kendiliğinden tetiklenmez.
 *  · Panel küçültülmüş: kaydırma panelin içinde engelleniyor (görünmeyen
 *    liste kaydırılmaz), vurgu yine güncel kalıyor.
 *  · Video elementi yok: takip SESSİZCE devre dışı, hata gösterilmiyor.
 */
function startSyncTracking(): void {
  if (syncTrackingStarted) return;
  syncTrackingStarted = true;

  const update = (): void => {
    if (!panel) return;
    if (shownItems.length === 0) return;

    // Liste başka bir videoya aitse vurgulama yok: yeni videonun zamanıyla eski
    // maddeleri vurgulamak, gözlenen bayat panel hatasının bir yüzüydü.
    if (activeVideoId !== currentVideoId()) {
      panel.setActiveItem(undefined);
      return;
    }

    const video = document.querySelector("video");
    if (!(video instanceof HTMLVideoElement)) return;

    if (isAdShowing()) {
      panel.setActiveItem(undefined);
      return;
    }

    panel.setActiveItem(activeItemIndex(video.currentTime));
  };

  // Dinleyiciler `document` üzerinde ve yakalama fazında: YouTube SPA'da
  // `video` elementi değişiyor, her değişimde yeniden bağlanmak gerekmesin.
  document.addEventListener("timeupdate", update, true);
  document.addEventListener("seeked", update, true);
  document.addEventListener("seeking", update, true);
}

// ── Kullanıcıya görünen hata metinleri ──────────────────────────────────────
//
// Ham sınıf adları (SOURCE_NOT_ENGLISH) kullanıcıya bir şey söylemiyor; panel
// bunları küçük puntoyla ikincil bilgi olarak gösteriyor, asıl metin burada.

// Metinler `_locales`'ta. Tablo FONKSİYON tutuyor, anahtar değil: her
// `msg("…")` çağrısı dize sabitiyle yazılı kalsın ki build.mjs onu kaynakta
// bulup dil dosyalarıyla karşılaştırabilsin.
const CAPTION_ERROR_TEXT: Record<string, () => string> = {
  NO_PLAYER_RESPONSE: () => msg("captionErrNoPlayerResponse"),
  NO_CAPTION_TRACKS: () => msg("captionErrNoCaptionTracks"),
  SOURCE_NOT_ENGLISH: () => msg("captionErrSourceNotEnglish"),
  TRIGGER_FAILED: () => msg("captionErrTriggerFailed"),
  EMPTY_BODY: () => msg("captionErrEmptyBody"),
  FETCH_FAILED: () => msg("captionErrFetchFailed"),
  PARSE_FAILED: () => msg("captionErrParseFailed"),
  RATE_LIMITED: () => msg("captionErrRateLimited"),
  STALE_PLAYER_RESPONSE: () => msg("captionErrStalePlayerResponse"),
  // MAIN tarafı /watch kontrolünü istek anında yapıyor (main-world.ts).
  NOT_WATCH_PAGE: () => msg("captionErrNotWatchPage"),
};

const ANNOTATE_ERROR_TEXT: Record<string, () => string> = {
  NO_API_KEY: () => msg("annotateErrNoApiKey"),
  API_ERROR: () => msg("annotateErrApiError"),
  RATE_LIMITED: () => msg("annotateErrRateLimited"),
  INVALID_RESPONSE: () => msg("annotateErrInvalidResponse"),
  // Ölçüldü (21 Eyl 2026): kartsız hesapta `mistral-large-2512` → 403
  // `tier_not_allowed`. Sorun anahtar değil, anahtarın PLANI.
  MODEL_NOT_IN_TIER: () => msg("annotateErrModelNotInTier"),
  UNKNOWN_MODEL: () => msg("annotateErrUnknownModel"),
  // Background'ın kendi sınıfı: Mistral kökeni isteğe bağlı izin ve kullanıcı
  // anahtarı kaydederken veriliyor.
  PERMISSION_MISSING: () => msg("annotateErrPermissionMissing"),
};

function captionErrorText(code: string): string {
  return CAPTION_ERROR_TEXT[code]?.() ?? msg("captionErrGeneric");
}

function annotateErrorText(code: string): string {
  return ANNOTATE_ERROR_TEXT[code]?.() ?? msg("annotateErrGeneric");
}

// ── Yerel depolama: önbellek, hata bildirimleri, dışa aktarma ───────────────

interface CachedRun {
  videoId: string;
  chunkSize: number;
  savedAt: string;
  items: PanelItem[];
  summary: RunSummary;
  /**
   * 🔴 ZORUNLU. Önbellekten açılan ASR videoda turuncu uyarı kayboluyordu
   * (gözlendi) — uyarı kanıtlanmış kusur sınıfına karşı kullanıcıya verilen
   * TEK bilgi ve önbellekten gelen sonuç daha güvenilir görünmemeli.
   */
  isAsr: boolean;
  trackName: string | undefined;
}

/** Bildirilen hata kaydı — sunucuya GİTMİYOR, yalnız bu tarayıcıda. */
interface ReportRecord {
  videoId: string;
  term: string;
  senseHere: string;
  segmentText: string;
  start: number;
  reportedAt: string;
}

/** `chrome.storage` tipleri değeri `any` veriyor; `unknown` üzerinden okunur. */
async function readStored(key: string): Promise<unknown> {
  const stored: unknown = await chrome.storage.local.get(key);
  return asRecord(stored)?.[key];
}

function readCachedRun(value: unknown): CachedRun | undefined {
  const record = asRecord(value);
  if (!record) return undefined;

  const videoId = asString(record.videoId);
  const chunkSize = asNumber(record.chunkSize);
  const savedAt = asString(record.savedAt);
  const summary = asRecord(record.summary);
  if (
    videoId === undefined ||
    chunkSize === undefined ||
    savedAt === undefined ||
    !summary ||
    !Array.isArray(record.items)
  ) {
    return undefined;
  }

  // `isAsr` yoksa (beklenmedik — v2 anahtarı ama alan eksik) kayıt ISKA
  // sayılıyor: uyarısız göstermek, sonucu olduğundan güvenilir gösterirdi.
  if (typeof record.isAsr !== "boolean") return undefined;
  const isAsr = record.isAsr;
  const trackName = asString(record.trackName);

  const items: PanelItem[] = [];
  for (const candidate of record.items) {
    const item = asRecord(candidate);
    if (!item) continue;

    const term = asString(item.term);
    const senseHere = asString(item.senseHere);
    const start = asNumber(item.start);
    const end = asNumber(item.end);
    const segmentText = asString(item.segmentText);
    if (
      term === undefined ||
      senseHere === undefined ||
      start === undefined ||
      end === undefined ||
      segmentText === undefined
    ) {
      continue;
    }

    const panelItem: PanelItem = { term, senseHere, start, end, segmentText };
    const nuance = asString(item.nuance);
    if (nuance !== undefined) panelItem.nuance = nuance;
    copyExportFields(item, panelItem);
    items.push(panelItem);
  }

  // `summary` yalnız gösterim için: biçimini burada zorlamıyoruz, panelde
  // metne çevrilirken eksik alanlar `?? 0` ile karşılanıyor.
  return {
    videoId,
    chunkSize,
    savedAt,
    items,
    summary: summary as unknown as RunSummary,
    isAsr,
    trackName,
  };
}

/** Maddeyi yerel hata listesine ekler ("yanlış" düğmesi). */
async function saveReport(item: PanelItem): Promise<void> {
  const existing = await readStored(STORAGE_KEY_REPORTS);
  const list = Array.isArray(existing) ? existing : [];

  const record: ReportRecord = {
    videoId: activeVideoId ?? currentVideoId() ?? "",
    term: item.term,
    senseHere: item.senseHere,
    segmentText: item.segmentText,
    start: item.start,
    reportedAt: new Date().toISOString(),
  };

  await chrome.storage.local.set({ [STORAGE_KEY_REPORTS]: [...list, record] });
  // Kayıt altyazı satırını taşıyor: içeriği yalnız geliştirme derlemesinde.
  if (__DEV__) console.log(`${LOG_PREFIX} hata bildirildi:`, record);
  else console.log(`${LOG_PREFIX} hata bildirildi`);
}

/**
 * Maddeleri ve bildirilen hataları panoya JSON olarak yazar.
 *
 * Karar 7'nin TEK istisnası bu: SRS motoru değil, tek düğme. Bildirilen
 * hataların aynı JSON'a girmesi bilinçli — gerçek koşulardan gelen çıktıları
 * eval setine taşıyan kanal bu.
 */
async function copyToClipboard(): Promise<void> {
  const reports = await readStored(STORAGE_KEY_REPORTS);

  const payload = {
    videoId: activeVideoId ?? currentVideoId() ?? "",
    exportedAt: new Date().toISOString(),
    items: shownItems,
    reports: Array.isArray(reports) ? reports : [],
  };

  await navigator.clipboard.writeText(JSON.stringify(payload, null, 2));
  console.log(`${LOG_PREFIX} ${shownItems.length} madde panoya kopyalandı`);
}

/**
 * Dışa aktarım alanlarını (type, difficulty, register, confidence) kopyalar.
 *
 * Kaynak `unknown` ve yalnız TİP kontrolünden geçiyor; enum üyeliği burada
 * yeniden doğrulanmıyor. Sebep: canlı yanıtta şema doğrulaması zaten
 * background'da yapıldı, önbellekte ise veri bizim yazdığımız kayıt. Vitrin
 * dosyasına dönüşürken `parseShowcase()` enum'ları ayrıca doğruluyor.
 */
function copyExportFields(source: UnknownRecord, target: PanelItem): void {
  const type = asString(source.type);
  const difficulty = asString(source.difficulty);
  const register = asString(source.register);
  const confidence = asNumber(source.confidence);
  if (type !== undefined) target.type = type;
  if (difficulty !== undefined) target.difficulty = difficulty;
  if (register !== undefined) target.register = register;
  if (confidence !== undefined) target.confidence = confidence;
}

/**
 * Yanıttan panelde gösterilecek maddeleri çıkarır.
 *
 * Yanıt güvenilmez kanaldan geldiği için burada da daraltılıyor. Zaman
 * damgası segmentin kendisinden geliyor: madde `segmentIndex` ile chunk
 * içindeki segmente bağlı, o segmentin `start` değeri panelde görünen zaman.
 */
function readKeptItems(response: unknown, chunk: BridgeSegment[]): PanelItem[] {
  const record = asRecord(response);
  if (!record || record.ok !== true) return [];

  const segments = asRecord(record.data)?.segments;
  if (!Array.isArray(segments)) return [];

  const items: PanelItem[] = [];

  for (const rawSegment of segments) {
    const segment = asRecord(rawSegment);
    if (!segment) continue;

    const index = asNumber(segment.index);
    if (index === undefined) continue;

    const source = chunk[index];
    if (!source) continue;

    const teach = segment.teach;
    if (!Array.isArray(teach)) continue;

    for (const rawItem of teach) {
      const item = asRecord(rawItem);
      if (!item) continue;

      const term = asString(item.term);
      const senseHere = asString(item.senseHere);
      if (term === undefined || senseHere === undefined) continue;

      const nuance = asString(item.nuance);
      const panelItem: PanelItem = {
        term,
        senseHere,
        start: source.start,
        // Aktif aralık: senkron takibi bu ikiliyle çalışıyor.
        end: source.end,
        // Hata bildiriminde bağlam: terimin geçtiği ham segment metni.
        segmentText: source.text,
      };
      if (nuance !== undefined) panelItem.nuance = nuance;
      copyExportFields(item, panelItem);

      items.push(panelItem);
    }
  }

  return items;
}

/**
 * Bir chunk'ın yanıtını okur.
 *
 * Kapı listesinin ölçülebilir çalışması gerekiyor:
 * kaç madde üretildi, kaçı elendi, hangi kapıda. Yanıt güvenilmez bir kanaldan
 * geldiği için burada da daraltılarak okunuyor.
 */
function readChunkResponse(
  response: unknown,
  chunkIndex: number,
  segmentCount: number,
): { report: ChunkReport; rejections: unknown[]; corrections: unknown[] } {
  const record = asRecord(response);

  if (!record || record.ok !== true) {
    // Hata kodları dil bağımsız, İngilizce (arayüz iki dilli; kod parantez
    // içinde ve dışa aktarılan özette görünüyor). Eski adı `BİLİNMEYEN_YANIT`
    // — okuma tarafında eşleme GEREKMİYOR: bu kod yalnız başarısız bölüm
    // raporuna giriyor, başarısız bölüm taşıyan koşum önbelleğe yazılmıyor ve
    // eski yarım kayıtlar okunurken siliniyor (`isIncompleteRecord`); kodu
    // yorumlayan başka okuyucu yok (compare-models dizeyi olduğu gibi basıyor).
    const error = asString(record?.error) ?? "UNKNOWN_RESPONSE";
    return {
      report: {
        chunkIndex,
        segmentCount,
        totalItems: undefined,
        rejected: 0,
        corrected: 0,
        kept: 0,
        error,
      },
      rejections: [],
      corrections: [],
    };
  }

  const totalItems = asNumber(record.totalItems);
  const rejections = Array.isArray(record.rejections) ? record.rejections : [];
  // Düzeltmeler ELEME DEĞİL: `kept` hesabından düşülmüyorlar, yalnız
  // sayılıyorlar. Karıştırılırsa "kaç madde kaldı" yanlış çıkar.
  const corrections = Array.isArray(record.corrections) ? record.corrections : [];

  return {
    report: {
      chunkIndex,
      segmentCount,
      totalItems,
      rejected: rejections.length,
      corrected: corrections.length,
      kept: totalItems !== undefined ? totalItems - rejections.length : 0,
      error: undefined,
    },
    rejections,
    corrections,
  };
}

/**
 * Kaynak uyarısı — otomatik altyazıda metnin kendisi bozuk olabilir.
 * Ölçümde doğaçlama/ASR içerikte tek seferlik aday oranı %31,
 * senaryolu içerikte %23. Canlı, önbellek ve vitrin yolu AYNI metni kullanıyor.
 */
function asrNote(): string {
  return msg("asrNote");
}

/**
 * Hangi altyazı metni işlendi — "Kaynak: İngilizce (ABD) · manuel".
 *
 * GÖZLENDİ: kullanıcı ekranda otomatik İngilizce altyazıyı izlerken eklenti
 * "İngilizce (ABD)" manuel parçayı işledi. Zaman damgaları tutar ama kelimeler
 * farklı olabilir; kullanıcı hangi metnin işlendiğini bilmeli. Parça adı yoksa
 * (vitrin, ya da YouTube adı vermediyse) yalnız tür yazılıyor.
 */
function sourceLabel(isAsr: boolean, trackName: string | undefined): string {
  // Dört ayrı anahtar: "otomatik"/"manuel" kelimesini cümleye yapıştırmak
  // İngilizcede ("auto-generated captions") sözdizimini bozuyordu. Parça adı
  // YouTube'un verisi, çevrilmiyor.
  if (trackName !== undefined) {
    return isAsr ? msg("sourceTrackAuto", trackName) : msg("sourceTrackManual", trackName);
  }
  return isAsr ? msg("sourceAuto") : msg("sourceManual");
}

/** Özet satırının metni — canlı koşumda ve önbellekten yüklemede aynı. */
function summaryText(summary: RunSummary): string {
  // Görünen madde sayısı listedekiyle aynı olsun: kapılardan geçen ama tekrar
  // olduğu için gizlenen maddeler "N madde"ye sayılmıyor, ayrıca yazılıyor.
  const kept = (summary.totalKept ?? 0) - (summary.duplicatesHidden ?? 0);
  const rejected = summary.totalRejected ?? 0;
  const corrected = summary.totalCorrected ?? 0;
  const calls = summary.calls ?? 0;
  const seconds = Math.round((summary.durationMs ?? 0) / 1000);

  // "Etiket: sayı" biçimi bilinçli: chrome.i18n'de çoğul kuralı yok,
  // "1 items" gibi hatalar ancak sayıdan bağımsız kurulumla önleniyor.
  const parts = [msg("summaryItems", kept), msg("summaryRejected", rejected)];
  if (corrected > 0) parts.push(msg("summaryMoved", corrected));
  const duplicates = summary.duplicatesHidden ?? 0;
  if (duplicates > 0) parts.push(msg("summaryDuplicates", duplicates));
  parts.push(msg("summaryCalls", calls), msg("summarySeconds", seconds));
  // Hangi model: özetin sonunda, küçük ama her zaman görünür. Önbellekten
  // gelen eski kayıtta alan olmayabilir.
  if (summary.model !== undefined) parts.push(summary.model);
  return parts.join(" · ");
}

/**
 * 🔴 ÖLÜMCÜL HATALAR — bölüme değil KOŞUMA ait.
 *
 * GÖZLENDİ (22 Eyl 2026): Mistral izni yokken koşum 5 bölümün 5'ini de denedi,
 * hepsi `PERMISSION_MISSING` ile düştü ve panel aynı satırı beş kez listeledi.
 * Bu sınıflar bölümün içeriğinden bağımsız: biri gelince sıradaki bölüm de
 * aynı sebeple düşecek. Koşum ilk ölümcül hatada duruyor.
 *
 * `RATE_LIMITED` ölümcül DEĞİL: geçici. `API_ERROR` / `INVALID_RESPONSE`
 * bölüme özgü olabilir (bir yanıtın biçimi bozuk), onlar da değil.
 */
const FATAL_ERRORS: ReadonlySet<string> = new Set([
  "NO_API_KEY",
  "PERMISSION_MISSING",
  "MODEL_NOT_IN_TIER",
  "UNKNOWN_MODEL",
]);

/** Panelde ayar sayfası bağlantısı gerektiren sınıflar — çözüm orada. */
const SETTINGS_ERRORS: ReadonlySet<string> = new Set(["NO_API_KEY", "PERMISSION_MISSING"]);

/**
 * Tüm videoyu chunk chunk annotate eder ve toplu özet döndürür.
 *
 * 🔴 SIRAYLA, paralel DEĞİL (yukarıdaki `CHUNK_DELAY_MS` notu).
 *
 * 🔴 Bir chunk başarısız olursa KOŞUM DURMAZ — ölümcül sınıflar (yukarıda)
 * hariç: hata kaydedilir ve sıradaki chunk'a geçilir. Gerekçe: tek bir geçici hatanın 20 dakikalık bir koşumu
 * çöpe atması, kısmi sonuçtan kötüdür — ve hangi chunk'ların düştüğü özette
 * duruyor. Yeniden deneme YOK.
 *
 * ⚠️ Buradan çıkan maddeler KULLANICIYA GÖSTERİLEMEZ: kapılar hacim eliyor
 * ama kanıtlanmış kusur sınıfını elemiyor.
 */
async function runAnnotationPass(
  run: PendingRun,
): Promise<{ summary: RunSummary; items: PanelItem[] }> {
  const { segments, chunkSize, maxChunks, model } = run;
  const startedAt = Date.now();

  // 🔴 Bu koşumun sonuçları YALNIZ kendi videosu hâlâ aktifse panele yazılıyor.
  // Kullanıcı işlem sürerken başka videoya geçerse koşum arka planda bitiyor
  // ve önbelleğe yazılıyor, ama yeni videonun paneline tek satır düşmüyor.
  const isActive = (): boolean => run.videoId === activeVideoId;

  const allChunks = chunkSegments(segments, chunkSize);
  const chunks =
    maxChunks !== undefined ? allChunks.slice(0, maxChunks) : allChunks;

  console.log(
    `${LOG_PREFIX} ${segments.length} segment → ${allChunks.length} chunk ` +
      `(chunkSize ${chunkSize}, video ${run.videoId})` +
      (maxChunks !== undefined ? `, ilk ${chunks.length} tanesi işlenecek` : ""),
  );

  if (isActive()) {
    const view = ensurePanel();
    view.setCached(false);
    view.clearItems();
    view.setEmptyMessage(undefined);
    shownItems = [];
    setStatus(msg("statusProcessing", 0, chunks.length));
  }

  // Koşumun KENDİ listesi — panel listesinden (`shownItems`) ayrı. Önbelleğe
  // bu yazılıyor; panel yalnız aktifken bunun kopyasını gösteriyor.
  let items: PanelItem[] = [];

  // Video genelinde tekrar gizleme. 6. kapı yalnız bölüm İÇİNDE tekilleştiriyor
  // (`madam Speaker` vakası). Kural vitrin dönüştürücüsüyle AYNI fonksiyon
  // (`surfaceKey`); ilk geçiş kalıyor.
  const seenSurfaces = new Set<string>();
  let duplicatesHidden = 0;

  const reports: ChunkReport[] = [];
  const gateCounts: Record<string, number> = {};
  const failures: { chunkIndex: number; error: string }[] = [];
  let fatalError: string | undefined;

  for (let index = 0; index < chunks.length; index++) {
    const chunk = chunks[index];
    if (!chunk) continue;

    console.log(
      `${LOG_PREFIX} chunk ${index + 1}/${chunks.length} — ${chunk.length} segment gönderiliyor…`,
    );
    if (isActive()) setStatus(msg("statusProcessing", index + 1, chunks.length));

    let response: unknown;
    try {
      response = await chrome.runtime.sendMessage({
        type: "annotate",
        segments: chunk,
        model,
      });
    } catch (error) {
      // Kanal hiç kurulamadı (service worker uyandırılamadı, mesaj reddedildi).
      const message = error instanceof Error ? error.message : String(error);
      console.error(`${LOG_PREFIX} chunk ${index + 1} gönderilemedi:`, message);
      reports.push({
        chunkIndex: index,
        segmentCount: chunk.length,
        // Kanal kurulamadığı için çağrı hiç YAPILMADI: model bu chunk'ta
        // gerçekten 0 madde üretti. `undefined` ("bilinmiyor") demek, toplam
        // hesaplarında sessizce farklı davranır.
        totalItems: 0,
        rejected: 0,
        corrected: 0,
        kept: 0,
        // Eski adı `KANAL_HATASI` — eşleme gerekmiyor, gerekçe
        // `readChunkResponse`'taki `UNKNOWN_RESPONSE` notunda.
        error: `CHANNEL_ERROR: ${message}`,
      });
      // Panelde görünen metin çevrilmiş; ham ayrıntı parantezde (rapor ve
      // özetteki `CHANNEL_ERROR` kaydı yukarıda değişmeden duruyor).
      failures.push({ chunkIndex: index, error: `${msg("failureChannel")} (${message})` });
      if (index < chunks.length - 1) await sleep(CHUNK_DELAY_MS);
      continue;
    }

    const { report, rejections, corrections } = readChunkResponse(
      response,
      index,
      chunk.length,
    );
    reports.push(report);

    if (report.error !== undefined) {
      console.warn(
        `${LOG_PREFIX} chunk ${index + 1} başarısız — ${report.error}`,
      );
      // Kullanıcıya görünen metin Türkçe; ham sınıf parantez içinde ikincil.
      failures.push({
        chunkIndex: index,
        error: `${annotateErrorText(report.error)} (${report.error})`,
      });
      if (FATAL_ERRORS.has(report.error)) {
        fatalError = report.error;
        console.warn(
          `${LOG_PREFIX} ölümcül hata (${report.error}) — kalan ${chunks.length - index - 1} bölüm denenmedi`,
        );
        break;
      }
    } else {
      // Kapı başına sayım: hangi kapının gerçekten iş yaptığı buradan görünüyor.
      for (const entry of rejections) {
        // Kapı adı dışa aktarılan özete (`gateCounts`) giriyor: diğer kapı
        // adları gibi fallback değeri de İngilizce.
        const gate = asString(asRecord(entry)?.gate) ?? "unknown";
        gateCounts[gate] = (gateCounts[gate] ?? 0) + 1;
      }

      console.log(
        `${LOG_PREFIX} chunk ${index + 1}: üretilen ${report.totalItems ?? "?"}, ` +
          `elenen ${report.rejected}, taşınan ${report.corrected}, ` +
          `kalan ${report.kept}`,
      );
      // Madde içerikleri (yanıtın tamamı, taşınan ve elenen maddeler) yalnız
      // geliştirme derlemesinde: kullanıcının izlediği videonun metnini taşıyor.
      if (__DEV__) {
        console.log(`${LOG_PREFIX} chunk ${index + 1} yanıtı:`, response);
        // Taşınan maddeler: model index'i yanlış verdi ama ifade chunk'ta vardı.
        if (corrections.length > 0) console.table(corrections);
        // Elenen maddelerin kendisi de basılıyor: sayı neyin elendiğini
        // söylemiyor. `segmentIndex` CHUNK İÇİ konumdur, videodaki segment
        // numarası değil.
        if (rejections.length > 0) console.table(rejections);
      }

      const visible: PanelItem[] = [];
      for (const item of readKeptItems(response, chunk)) {
        const surface = surfaceKey(item.term);
        if (seenSurfaces.has(surface)) {
          duplicatesHidden += 1;
          continue;
        }
        seenSurfaces.add(surface);
        visible.push(item);
      }
      items = [...items, ...visible];

      // 🔴 Maddeler CHUNK CHUNK panele ekleniyor: koşumun tamamını beklemek,
      // uzun bir videoda kullanıcıyı dakikalarca boş listeye baktırırdı.
      // Panel kapalıysa da `shownItems` güncelleniyor: yeniden açılınca liste
      // oradan çiziliyor.
      if (isActive()) {
        shownItems = items;
        panel?.addItems(visible);
      }
    }

    if (index < chunks.length - 1) await sleep(CHUNK_DELAY_MS);
  }

  const summary: RunSummary = {
    model,
    segmentCount: segments.length,
    chunkSize,
    chunkCount: allChunks.length,
    calls: reports.length,
    totalItems: reports.reduce((total, report) => total + (report.totalItems ?? 0), 0),
    totalRejected: reports.reduce((total, report) => total + report.rejected, 0),
    totalCorrected: reports.reduce((total, report) => total + report.corrected, 0),
    totalKept: reports.reduce((total, report) => total + report.kept, 0),
    gateCounts,
    duplicatesHidden,
    failures,
    fatalError,
    durationMs: Date.now() - startedAt,
    chunks: reports,
  };

  console.log(`${LOG_PREFIX} KOŞUM ÖZETİ`, summary);
  if (failures.length > 0) {
    console.warn(
      `${LOG_PREFIX} ${failures.length}/${reports.length} chunk başarısız:`,
      failures,
    );
  }

  return { summary, items };
}

/** Özeti MAIN tarafına geri yollar; `__reelvocabTest` onu döndürüyor. */
function postSummary(requestId: string, summary: unknown): void {
  window.postMessage(
    { source: MESSAGE_SOURCE, type: SUMMARY_TYPE, requestId, summary },
    window.location.origin,
  );
}

/**
 * 🔴 İKİ ADIMLI TETİKLEME — altyazı geldi, işleme BAŞLAMIYOR.
 *
 * Eski akışta ikona tıklamak doğrudan ~$0.04 ve ~60 saniyelik bir işlem
 * başlatıyordu; yanlışlıkla tıklama pahalıydı. Şimdi bu mesaj yalnız
 * önizlemeyi dolduruyor ve "Başlat" düğmesini açıyor. Altyazı çekmenin kendisi
 * ucuz (model çağrısı değil), o yüzden önizleme için yapılabiliyor.
 *
 * Konsol yolu (`__reelvocabTest`) `autoStart` ile geliyor ve eski davranışı
 * koruyor: fetch + hemen koş.
 */
function onBridgeMessage(event: MessageEvent<unknown>): void {
  const message = readBridgeMessage(event);
  if (!message) return;

  // Yük altyazının tamamını taşıyor: içeriği yalnız geliştirme derlemesinde.
  if (__DEV__) console.log(`${LOG_PREFIX} köprüden mesaj alındı:`, message.payload);

  // İzleme sayfası değil: sonuç hiçbir videoya ait değil, bayatlık kontrolü
  // (aşağıda) onu sessizce atardı. Kullanıcıya ne yapacağı söyleniyor.
  if (asString(asRecord(message.payload)?.error) === "NOT_WATCH_PAGE") {
    // Panel bir videoya aitse o durum artık geçersiz. Süren koşum etkilenmiyor.
    if (activeVideoId !== undefined) resetPanelState();
    ensurePanel();
    phase = "error";
    setStatus(captionErrorText("NOT_WATCH_PAGE"), "NOT_WATCH_PAGE");
    renderState();
    return;
  }

  // 🔴 Sonuç HANGİ videoya ait? MAIN çekme başladığındaki adresi yazıyor. Kullanıcı
  // o arada başka videoya geçtiyse bu sonuç bayat: panele yazılmıyor.
  const videoId = message.videoId ?? currentVideoId();
  if (videoId === undefined || videoId !== currentVideoId()) {
    console.log(`${LOG_PREFIX} bayat altyazı sonucu atıldı (video ${videoId ?? "?"})`);
    return;
  }

  // Konsol yolu `openPanelFlow`'dan geçmiyor: panel başka bir videoya aitse
  // önce temizleniyor.
  if (activeVideoId !== videoId) {
    resetPanelState();
    activeVideoId = videoId;
  }

  const view = ensurePanel();

  const segments = readSegments(message.payload);
  if (!segments || segments.length === 0) {
    // Altyazı çekme başarısız: başlatılacak bir şey YOK, düğme çıkmıyor.
    const code = asString(asRecord(message.payload)?.error);
    phase = "error";
    pending = undefined;
    previewLine = undefined;
    setStatus(code !== undefined ? captionErrorText(code) : msg("statusNoCaptions"), code);
    renderState();
    console.log(`${LOG_PREFIX} altyazı yok/başarısız:`, code);
    return;
  }

  const data = asRecord(asRecord(message.payload)?.data);
  const isAsr = data?.isAsr === true;
  const trackName = asString(data?.trackName);
  sourceNoteLine = isAsr ? asrNote() : undefined;
  view.setSourceNote(sourceNoteLine);

  // Geçersiz model: başlatılacak bir şey yok, açık hata. (MAIN tarafı konsolda
  // zaten reddediyor; bu, güvenilmez kanaldan gelen mesaj için ikinci kapı.)
  const model = message.model;
  if (model === undefined) {
    phase = "error";
    pending = undefined;
    previewLine = undefined;
    setStatus(msg("annotateErrUnknownModelAllowed", ALLOWED_MODELS.join(", ")), "UNKNOWN_MODEL");
    renderState();
    return;
  }

  const chunkCount = Math.ceil(segments.length / message.chunkSize);
  const limited =
    message.maxChunks !== undefined
      ? Math.min(message.maxChunks, chunkCount)
      : chunkCount;

  const run: PendingRun = {
    videoId,
    segments,
    chunkSize: message.chunkSize,
    maxChunks: message.maxChunks,
    requestId: message.requestId,
    model,
    isAsr,
    trackName,
  };
  pending = run;

  void (async () => {
    // "Yeniden işle" bayrağı BURADA tüketiliyor: bir kez atlanıyor, sonra
    // önbellek yine geçerli. Sıfırlanmazsa sekme ömrü boyunca atlanırdı.
    const skipCache = bypassCache;
    bypassCache = false;

    // ── Önbellek: doluysa panel doğrudan dolu açılıyor ──
    const cached = skipCache
      ? undefined
      : await loadCachedRun(videoId, message.chunkSize, model);
    if (activeVideoId !== videoId) return; // beklerken video değişti
    if (cached) {
      applyCachedRun(cached);
      if (message.requestId !== undefined) postSummary(message.requestId, cached.summary);
      return;
    }

    if (message.autoStart) {
      // Konsol yolu: onay beklemeden koş.
      await startRun(run);
      return;
    }

    // ── Hazır: önizleme + "Başlat" ──
    phase = "ready";
    cachedResult = false;
    previewLine = [
      sourceLabel(isAsr, trackName),
      msg("previewSegments", segments.length),
      msg("previewSections", limited),
      model,
    ].join(" · ");
    summaryLine = undefined;
    emptyLine = undefined;
    failureLines = [];
    failureNote = undefined;

    // Başka bir video işleniyorsa Başlat engelli (tek koşum).
    if (runningVideoId !== undefined && runningVideoId !== videoId) {
      phase = "busy";
      setStatus(msg("statusBusy"));
    } else {
      setStatus(msg("statusReady"));
    }
    renderState();
  })();
}

/**
 * Kayıt tam başarılı bir koşumun mu? Başarısız bölüm, ölümcül hata ya da
 * `maxChunks` ile kısaltılmış koşum (çağrı sayısı < bölüm sayısı) → yarım.
 */
function isIncompleteRecord(value: unknown): boolean {
  const summary = asRecord(asRecord(value)?.summary);
  if (!summary) return false;
  const failures = summary.failures;
  if (Array.isArray(failures) && failures.length > 0) return true;
  if (asString(summary.fatalError) !== undefined) return true;
  const calls = asNumber(summary.calls);
  const chunkCount = asNumber(summary.chunkCount);
  return calls !== undefined && chunkCount !== undefined && calls < chunkCount;
}

/** Tam başarılı koşum: her bölüm denendi ve hiçbiri düşmedi. */
function isCompleteRun(summary: RunSummary): boolean {
  return (
    summary.failures.length === 0 &&
    summary.fatalError === undefined &&
    summary.calls === summary.chunkCount
  );
}

/** Önbellekteki koşumu okur; yoksa ya da okunamazsa `undefined`. */
async function loadCachedRun(
  videoId: string,
  chunkSize: number,
  model: ModelId,
): Promise<CachedRun | undefined> {
  const key = cacheKey(videoId, chunkSize, model);
  try {
    const stored = await readStored(key);
    // Bu kural öncesinde yazılmış yarım kayıtlar: ISKA ve silinir. Bırakılsa
    // video her açılışta eksik (ya da boş) listeyle "işlenmiş" görünürdü.
    if (isIncompleteRecord(stored)) {
      await chrome.storage.local.remove(key);
      console.log(`${LOG_PREFIX} yarım önbellek kaydı silindi (${videoId})`);
      return undefined;
    }
    return readCachedRun(stored);
  } catch (error) {
    console.warn(`${LOG_PREFIX} önbellek okunamadı:`, error);
    return undefined;
  }
}

/**
 * "Başlat" — pahalı kısım burada başlıyor.
 *
 * 🔴 TEK KOŞUM: `runningVideoId` doluyken yeni koşum BAŞLAMIYOR — aynı video
 * da olsa, başka video da olsa. Başka video için panel "başka bir video
 * işleniyor" diyor. Gerekçe: paralel koşum kullanıcının anahtarının hız
 * sınırına takılır.
 *
 * 🔴 VİDEO BAĞI: sonuç HER ZAMAN kendi videosunun önbelleğine yazılıyor; panele
 * ise yalnız o video hâlâ aktifse. Kullanıcı işlem sürerken başka videoya
 * geçtiyse sonuç arka planda bitip önbellekte bekliyor.
 */
async function startRun(run: PendingRun): Promise<void> {
  if (runningVideoId !== undefined) {
    if (runningVideoId !== run.videoId && run.videoId === activeVideoId) {
      phase = "busy";
      setStatus(msg("statusBusy"));
      renderState();
    }
    return;
  }

  runningVideoId = run.videoId;

  if (run.videoId === activeVideoId) {
    phase = "running";
    cachedResult = false;
    settingsLinkShown = false;
    // BYOK sonucu insan kapısından geçmedi: vitrin rozeti TAŞINMAZ.
    reviewedResult = false;
    previewLine = undefined;
    emptyLine = undefined;
    failureLines = [];
    failureNote = undefined;
    summaryLine = undefined;
    renderState();
  }

  let result: { summary: RunSummary; items: PanelItem[] } | undefined;
  try {
    result = await runAnnotationPass(run);
  } finally {
    runningVideoId = undefined;
  }
  const { summary, items } = result;

  // ── Önbellek yazma: kendi videosunun anahtarına, panel durumundan bağımsız ──
  //
  // 🔴 YALNIZ TAM BAŞARILI KOŞUM YAZILIYOR. GÖZLENDİ (22 Eyl 2026): bölümlerin
  // tamamı düşen bir koşum "kısmi sonuç önbelleğe yazıldı" diye kaydedildi;
  // video sonraki açılışta önbellekten BOŞ liste gösterecekti. Kısmi sonuç
  // panelde kalıyor ama kalıcı değil. Önceki tam bir kayıt varsa
  // dokunulmuyor — hâlâ geçerli.
  const complete = isCompleteRun(summary);
  if (complete) {
    const key = cacheKey(run.videoId, run.chunkSize, run.model);
    const record: CachedRun = {
      videoId: run.videoId,
      chunkSize: run.chunkSize,
      savedAt: new Date().toISOString(),
      items,
      summary,
      isAsr: run.isAsr,
      trackName: run.trackName,
    };
    try {
      await chrome.storage.local.set({ [key]: record });
    } catch (error) {
      console.warn(`${LOG_PREFIX} önbelleğe yazılamadı:`, error);
    }
  }

  if (run.requestId !== undefined) postSummary(run.requestId, summary);

  if (run.videoId !== activeVideoId) {
    console.log(
      `${LOG_PREFIX} ${run.videoId} arka planda bitti, ` +
        (complete ? "önbelleğe yazıldı" : "yarım olduğu için önbelleğe YAZILMADI") +
        " — aktif panele yazılmadı",
    );
    // Bekleyen ("busy") bir video varsa artık başlatılabilir: durum yeniden
    // değerlendiriliyor.
    if (phase === "busy" && panel) void openPanelFlow(false);
    return;
  }

  phase = "done";
  shownItems = items;
  summaryLine = `${summaryText(summary)} · ${sourceLabel(run.isAsr, run.trackName)}`;
  sourceNoteLine = run.isAsr ? asrNote() : undefined;

  // ── Ölümcül hata: TEK mesaj, bölüm listesi yok ──
  // Aynı sebep beş satırda tekrar etmiyor; ne yapılacağı durum satırında.
  // "Yeniden işle" yok: sebep giderilmeden aynı yere düşer.
  if (summary.fatalError !== undefined) {
    phase = "error";
    emptyLine = undefined;
    failureLines = [];
    failureNote = undefined;
    settingsLinkShown = SETTINGS_ERRORS.has(summary.fatalError);
    setStatus(
      annotateErrorText(summary.fatalError) +
        (items.length > 0 ? ` ${msg("statusFatalPartial")}` : ""),
      summary.fatalError,
    );
    renderState();
    return;
  }

  // ── Boş sonuç: boş liste hata gibi görünür, o yüzden açıklanıyor ──
  emptyLine = undefined;
  if (items.length === 0) {
    const produced = summary.totalItems;
    const rejected = summary.totalRejected;

    emptyLine = {
      title: msg("emptyTitle"),
      detail:
        produced > 0 ? msg("emptyDetailRejected", produced, rejected) : msg("emptyDetail"),
    };
  }

  // ── Kısmi başarısızlık: özete gömülü kalmasın ──
  failureLines = summary.failures.map((failure) => ({
    chunkIndex: failure.chunkIndex,
    error: failure.error,
  }));

  if (failureLines.length > 0) {
    setStatus(msg("statusDonePartial", failureLines.length, summary.calls));
    // 🔴 Kısmi sonuç önbelleğe YAZILMIYOR: kullanıcı bunu bilmeli — sayfayı
    // yenileyince listenin kaybolması şaşırtmasın.
    failureNote = msg("failureNotePartial");
  } else {
    setStatus(msg("statusDone"));
    failureNote = undefined;
  }

  renderState();
}

/** Önbellekten gelen koşumu panele yazar (ikon yolu ve konsol yolu ortak). */
function applyCachedRun(cached: CachedRun): void {
  phase = "done";
  cachedResult = true;
  reviewedResult = false;
  shownItems = cached.items;
  // 🔴 ASR uyarısı önbellekten de geliyor: önbellekten açılan sonuç, canlı
  // işlemeden daha güvenilir görünmemeli (gözlenen hata).
  sourceNoteLine = cached.isAsr ? asrNote() : undefined;
  summaryLine = `${summaryText(cached.summary)} · ${sourceLabel(cached.isAsr, cached.trackName)}`;
  previewLine = undefined;
  failureLines = [];
  failureNote = undefined;
  emptyLine =
    cached.items.length === 0
      ? { title: msg("emptyTitle"), detail: msg("emptyDetail") }
      : undefined;
  setStatus(msg("statusFromCache"));
  renderState();
  console.log(`${LOG_PREFIX} önbellekten ${cached.items.length} madde (${cached.savedAt})`);
}

// ── Background'a sorular ────────────────────────────────────────────────────
// Vitrin verisi background bundle'ında gömülü (web_accessible_resources YOK —
// karar 8 / scripts/build.mjs). Burada mesajla isteniyor ve yanıt yine
// `unknown` olarak daraltılıyor.

async function requestShowcase(videoId: string): Promise<ShowcaseVideo | undefined> {
  try {
    const response: unknown = await chrome.runtime.sendMessage({
      type: "showcase-get",
      videoId,
    });
    if (response === null || response === undefined) return undefined;
    const result = parseShowcase(response, `vitrin:${videoId}`);
    if (!result.ok) {
      console.warn(`${LOG_PREFIX} vitrin yanıtı reddedildi: ${result.reason}`);
      return undefined;
    }
    return result.video;
  } catch (error) {
    console.warn(`${LOG_PREFIX} vitrin sorgulanamadı:`, error);
    return undefined;
  }
}

async function requestShowcaseList(): Promise<ShowcaseEntry[]> {
  try {
    const response: unknown = await chrome.runtime.sendMessage({ type: "showcase-list" });
    return readShowcaseEntries(response);
  } catch {
    return [];
  }
}

/**
 * Anahtar ve Mistral izni durumu. İzin içerik betiğinden sorulamıyor
 * (`chrome.permissions` yok); background cevaplıyor.
 */
async function requestKeyStatus(): Promise<{ hasKey: boolean; permitted: boolean }> {
  try {
    const response = asRecord(await chrome.runtime.sendMessage({ type: "key-status" }));
    return { hasKey: response?.hasKey === true, permitted: response?.permitted === true };
  } catch {
    return { hasKey: false, permitted: false };
  }
}

/** Vitrin verisini panele yazar — işleme yok, API çağrısı yok. */
function applyShowcase(video: ShowcaseVideo): void {
  phase = "showcase";
  cachedResult = false;
  reviewedResult = true;
  previewLine = undefined;
  failureLines = [];
  failureNote = undefined;
  noKeyShowcases = undefined;

  // Vitrinde altyazı satırı YOK (karar 8, telif yüzeyi). `segmentText` bu
  // yüzden boş: "yanlış" bildirimi yine çalışır, yalnız bağlam satırı taşımaz.
  shownItems = video.items.map((item) => {
    const panelItem: PanelItem = {
      term: item.term,
      senseHere: item.senseHere,
      start: item.start,
      end: item.end,
      segmentText: "",
      type: item.type,
      difficulty: item.difficulty,
      register: item.register,
    };
    if (item.nuance !== undefined) panelItem.nuance = item.nuance;
    return panelItem;
  });

  const isAsr = video.sourceKind === "asr";
  sourceNoteLine = isAsr ? asrNote() : undefined;

  // Vitrinde parça adı yok (şemada tutulmuyor): yalnız tür.
  summaryLine = [
    msg("summaryItems", shownItems.length),
    msg("summaryReviewRemoved", video.review.removed.length),
    video.model,
    sourceLabel(isAsr, undefined),
  ].join(" · ");

  emptyLine =
    shownItems.length === 0
      ? { title: msg("emptyTitle"), detail: msg("emptyDetail") }
      : undefined;

  setStatus(video.title);
  renderState();
  console.log(`${LOG_PREFIX} vitrin: ${video.videoId} (${shownItems.length} madde)`);
}

/**
 * Panel açılışı — ARAMA SIRASI: vitrin → önbellek → (anahtar varsa) işleme.
 *
 * 🔴 `fetchAllowed` YouTube'a istek atılıp atılamayacağını söylüyor. Yalnız
 * kullanıcının bu video için yaptığı bir eylemde `true`: ikon tıklaması,
 * "Bu videoyu hazırla", "Yeniden işle". Gezinme, anahtar değişimi ve başka
 * videonun bitmesi `false` ile çağırıyor — yalnız YEREL aramalar (vitrin,
 * önbellek); ikisi de boşsa panel "Bu videoyu hazırla" düğmesini gösteriyor.
 * Önceden gezinmede altyazı kendiliğinden çekiliyordu: kullanıcı panel açıkken
 * beş video gezse beş `timedtext` isteği, ve sınır IP bazlı (karar 5 → 429).
 *
 * 🔴 Anahtarsız kullanım birinci sınıf: vitrin videosunda hiçbir şey
 * istenmeden dolu liste; vitrin dışı videoda boş panel değil, nereye
 * gidilebileceği. Anahtar yoksa hiçbir API çağrısı yapılmıyor — altyazı bile
 * çekilmiyor (YouTube'a gereksiz istek).
 */
async function openPanelFlow(fetchAllowed: boolean): Promise<void> {
  const videoId = currentVideoId();

  // 🔴 ÇİFT TETİKLEME KORUMASI. Bu video işleniyor ya da altyazısı çekiliyorsa
  // ikon yeni koşum BAŞLATMAZ; yalnız paneli geri getirir (panel kapatılmışsa
  // `ensurePanel` mevcut durumu yeniden çiziyor). Koşum arka planda sürüyor.
  if (
    videoId !== undefined &&
    videoId === activeVideoId &&
    (phase === "running" || phase === "fetching")
  ) {
    ensurePanel();
    console.log(`${LOG_PREFIX} bu video işleniyor, yeni koşum başlatılmadı`);
    return;
  }

  // Panel bu akışta HANGİ videoya ait — başka bir videonun durumu kalmışsa
  // önce temizleniyor.
  if (activeVideoId !== videoId) resetPanelState();
  activeVideoId = videoId;

  const skipShowcase = bypassShowcase;
  bypassShowcase = false;

  ensurePanel();

  if (videoId === undefined) {
    phase = "idle";
    setStatus(captionErrorText("NOT_WATCH_PAGE"));
    renderState();
    return;
  }

  setStatus(msg("statusLoading"));

  const [showcase, { hasKey, permitted }] = await Promise.all([
    skipShowcase ? undefined : requestShowcase(videoId),
    requestKeyStatus(),
  ]);
  // Beklerken video değiştiyse bu akış bayat: yeni videonun akışı onu ezer.
  if (activeVideoId !== videoId) return;
  keyAvailable = hasKey;
  settingsLinkShown = false;

  // 1) Vitrin — anahtar olsa da olmasa da ilk bakılan yer.
  if (showcase) {
    applyShowcase(showcase);
    return;
  }

  // 2) Önbellek — ikon yolu varsayılan chunk boyutu ve modelle koşuyor.
  // "Yeniden işle" bayrağı burada TÜKETİLMİYOR; altyazı geldiğinde köprü
  // dinleyicisi tüketiyor (konsol yolu da oradan geçiyor).
  if (!bypassCache) {
    const cached = await loadCachedRun(videoId, DEFAULT_CHUNK_SIZE, DEFAULT_MODEL);
    if (activeVideoId !== videoId) return;
    if (cached) {
      applyCachedRun(cached);
      return;
    }
  }

  // 3) Anahtar yoksa: işleme YOK. Nereye gidilebileceği söyleniyor.
  if (!hasKey) {
    phase = "nokey";
    cachedResult = false;
    reviewedResult = false;
    shownItems = [];
    previewLine = undefined;
    summaryLine = undefined;
    emptyLine = undefined;
    failureLines = [];
    failureNote = undefined;
    const showcases = await requestShowcaseList();
    if (activeVideoId !== videoId) return;
    noKeyShowcases = showcases;
    setStatus(msg("statusNeedsKey"));
    renderState();
    return;
  }

  // 4) Anahtar var ama Mistral izni yok: işleme YOK, sebebi ve çözüm yeri
  // söyleniyor. Önceden panel önizleme + Başlat gösteriyor, hata ancak
  // Başlat'tan sonra geliyordu.
  if (!permitted) {
    phase = "noperm";
    reviewedResult = false;
    previewLine = undefined;
    settingsLinkShown = true;
    setStatus(annotateErrorText("PERMISSION_MISSING"), "PERMISSION_MISSING");
    renderState();
    return;
  }

  // 5) Anahtar var ama başka bir video işleniyor: tek koşum, bu video bekler.
  if (runningVideoId !== undefined && runningVideoId !== videoId) {
    phase = "busy";
    reviewedResult = false;
    previewLine = undefined;
    setStatus(msg("statusBusy"));
    renderState();
    return;
  }

  reviewedResult = false;

  // 6) Kullanıcı bu video için bir şey istemedi (gezinme vb.): altyazı
  // ÇEKİLMİYOR, düğme bekliyor.
  if (!fetchAllowed) {
    phase = "prepare";
    previewLine = undefined;
    setStatus(msg("statusNotPrepared"));
    renderState();
    return;
  }

  // 7) Kullanıcı istedi: altyazıyı çek, önizleme + "Başlat".
  phase = "fetching";
  previewLine = undefined;
  setStatus(msg("statusFetchingCaptions"));
  renderState();

  window.postMessage(
    { source: MESSAGE_SOURCE, type: START_TYPE, options: {} },
    window.location.origin,
  );
}

/** Eklenti ikonu ve "yeniden işle" tetikleyicisi — kullanıcı eylemi. */
function requestRunFromMain(): void {
  void openPanelFlow(true);
}

/**
 * Anahtar değişince panel durumunu yeniden değerlendirir (nokey ↔ anahtarlı).
 *
 * Önceden `key-status` yalnız panel açılışında soruluyordu: ayarlardan anahtar
 * ekleyip panele dönen kullanıcı hâlâ "anahtar gerekiyor" görüyordu.
 *
 * Değerin KENDİSİNE bakılmıyor: `changes[...].newValue` kullanılmıyor, varlık
 * background'a soruluyor (`key-status`, yalnız evet/hayır). Olay değeri bu
 * bağlama taşısa da kod onu okumuyor ve hiçbir yere yazmıyor.
 *
 * Koşum sürerken hiçbir şey yapılmıyor — çift tetikleme korumasıyla aynı
 * kural. Panel kapalıysa da: sonraki açılış zaten yeniden soruyor.
 */
function onStorageChanged(
  changes: Record<string, chrome.storage.StorageChange>,
  areaName: string,
): void {
  if (areaName !== "local") return;
  if (!Object.prototype.hasOwnProperty.call(changes, STORAGE_KEY_MISTRAL)) return;
  if (!panel) return;
  if (phase === "running" || phase === "fetching") return;

  void (async () => {
    const { hasKey } = await requestKeyStatus();
    if (hasKey === keyAvailable) return;
    keyAvailable = hasKey;
    console.log(`${LOG_PREFIX} anahtar ${hasKey ? "eklendi" : "kaldırıldı"}, panel yenileniyor`);

    // "nokey" (anahtar geldi) ya da "ready" (anahtar gitti): akış baştan
    // değerlendiriliyor — vitrin → önbellek → anahtar. Vitrin ve bitmiş
    // sonuçlarda yalnız düğmeler değişiyor ("kendi anahtarınızla yeniden işleyin",
    // "Yeniden işle"); liste yerinde kalıyor.
    if (
      phase === "nokey" ||
      phase === "ready" ||
      phase === "busy" ||
      phase === "prepare" ||
      phase === "noperm"
    ) {
      await openPanelFlow(false);
      return;
    }
    renderState();
  })();
}

/**
 * İzin bekleyen panel sekmeye dönülünce yeniden değerlendiriliyor.
 *
 * İzin değişimi içerik betiğine olay olarak GELMİYOR (`chrome.permissions`
 * burada yok) ve aynı anahtarı yeniden kaydetmek depolamada değişiklik
 * üretmeyebilir. Kullanıcı izni ayar sayfasında (başka sekme) veriyor; bu
 * sekmeye dönüşü yakalamak yetiyor. Yalnız yerel sorgular — altyazı çekilmiyor.
 */
function onVisibilityChange(): void {
  if (document.visibilityState !== "visible") return;
  if (!panel) return;
  if (phase === "noperm" || (phase === "error" && settingsLinkShown)) {
    void openPanelFlow(false);
  }
}

// ── SPA gezinmesi ───────────────────────────────────────────────────────────
//
// 🔴 Video değişince panel durumu TAMAMEN temizleniyor ve panel açıksa yeni
// video için baştan değerlendiriliyor (vitrin → önbellek → anahtar) — YALNIZ
// yerel aramalarla; altyazı çekilmiyor, "Bu videoyu hazırla" bekliyor. Süren bir
// koşum ETKİLENMİYOR: arka planda bitiyor, kendi videosunun önbelleğine
// yazılıyor, aktif panele yazılmıyor (`startRun`).

/** Panel durumunu sıfırlar — liste, özet, önizleme, hatalar, rozetler. */
function resetPanelState(): void {
  phase = "idle";
  activeVideoId = undefined;
  pending = undefined;
  shownItems = [];
  statusLine = { text: msg("statusIdle"), code: undefined };
  previewLine = undefined;
  sourceNoteLine = undefined;
  summaryLine = undefined;
  emptyLine = undefined;
  failureLines = [];
  failureNote = undefined;
  cachedResult = false;
  reviewedResult = false;
  noKeyShowcases = undefined;
  settingsLinkShown = false;
  bypassCache = false;
  bypassShowcase = false;

  // Senkron takip durdu: liste boş, vurgu yok.
  panel?.clearItems();
  panel?.setActiveItem(undefined);
}

function handleVideoChange(): void {
  const next = currentVideoId();
  if (next === lastSeenVideoId) return;
  lastSeenVideoId = next;

  console.log(`${LOG_PREFIX} video değişti → ${next ?? "(izleme sayfası değil)"}`);
  resetPanelState();

  if (!panel) return;
  if (next === undefined) {
    setStatus(captionErrorText("NOT_WATCH_PAGE"));
    renderState();
    return;
  }
  // Yalnız yerel aramalar — gezinme bir kullanıcı isteği değil.
  void openPanelFlow(false);
}

// ── Kayıt: yalnız bir kez ──────────────────────────────────────────────────
//
// Betik ikon tıklamasında enjekte ediliyor. Background önce bu işarete bakıp
// betik zaten varsa yeniden enjekte etmiyor; ama iki hızlı tıklama iki
// kontrolü de "yok" görebilir. İkinci kopya dinleyici KURMUYOR — yoksa her
// mesaj iki panel akışı, her gezinme iki değerlendirme demekti.
//
// İşaret İZOLE ortamın global'inde: sayfanın JS'i onu göremiyor, yani sayfaya
// eklentinin varlığını sızdırmıyor. Adı background.ts ile paylaşılan sabitten
// (src/lib/injection.ts).
const isolatedGlobal = globalThis as unknown as Record<string, unknown>;

if (isolatedGlobal[ISOLATED_READY_FLAG] !== true) {
  isolatedGlobal[ISOLATED_READY_FLAG] = true;

  window.addEventListener("message", onBridgeMessage);
  chrome.storage.onChanged.addListener(onStorageChanged);
  document.addEventListener("visibilitychange", onVisibilityChange);

  lastSeenVideoId = currentVideoId();

  // Birincil sinyal: YouTube'un kendi SPA olayı. DOM olayı olduğu için izole
  // ortamdan da dinlenebiliyor.
  document.addEventListener("yt-navigate-finish", handleVideoChange);

  // YEDEK: adres çubuğundaki `v`'nin değişimi. Olay adı YouTube'un iç ayrıntısı
  // ve haber verilmeden değişebilir; kaçırılırsa bayat panel sessizce geri
  // gelirdi. Saniyede bir karşılaştırma ucuz.
  setInterval(handleVideoChange, 1000);

  // Eklenti ikonu → background → burası. Konsol tetikleyicisi
  // (`window.__reelvocabTest()`) de çalışmaya devam ediyor.
  chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
    // Yalnız bu eklentinin kendi bağlamlarından gelen mesaj kabul edilir.
    if (sender.id !== chrome.runtime.id) return false;
    if (asRecord(message)?.type !== "run") return false;

    requestRunFromMain();
    sendResponse({ ok: true });
    return false;
  });

  console.log(`${LOG_PREFIX} dinleyici kuruldu`);
}

export {};
