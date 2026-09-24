// 🔴 EN KIRILGAN MODÜL. YouTube'un altyazı endpoint'i zaman zaman değişiyor.
//
// İZOLASYON KURALI: endpoint bilgisi, URL'nin yakalanması ve yanıt ayrıştırma
// YALNIZ bu dosyada durur. URL İNŞA EDİLMEZ, player'dan yakalanır — imza ya da
// parametre üretmeye çalışılmaz, çünkü üretilemez (aşağıdaki `pot` notu).
// Başka hiçbir dosya YouTube'un altyazı biçimini bilmez; dışarıya sadece
// normalize edilmiş segment listesi verilir. Kırıldığında düzeltme tek yerde
// yapılır.
//
// Çıkan her segmentin metni, buradan dönmeden ÖNCE stripCaptionArtifacts()'ten
// geçmelidir (temizlik ingest'te durur — captionArtifacts.ts başlığındaki not).
//
// ÇALIŞMA ORTAMI: bu modül sayfa ortamında (`"world": "MAIN"`) çalışır, izole
// content script ortamında değil. Sebebi ölçüldü: `ytInitialPlayerResponse`
// global'i ve `#movie_player` metodları izole ortamdan görünmez. Bunun bedeli
// şu: MAIN ortamda `chrome.*` API'leri YOK. Bu yüzden modül depolama,
// mesajlaşma ve önbellek işine hiç girmez; sonucu çağırana döndürür, köprüleme
// başka dosyanın işidir.
//
// Seçim kuralı: kaynak dil `audioTracks` üzerinden bulunur ve İngilizce
// değilse modül devre dışı kalır (SOURCE_NOT_ENGLISH). Çeviri altyazı üstüne
// annotate edilmez — metin sahnede söylenmedi.

import { stripCaptionArtifacts } from "./captionArtifacts";

declare global {
  interface Window {
    // Sayfa ortamının global'i. Biçimi YouTube'un kontrolünde ve videodan
    // videoya değişiyor; bu yüzden `unknown` girer ve aşağıda daraltılır.
    ytInitialPlayerResponse?: unknown;
  }
}

export interface CaptionSegment {
  start: number; // saniye
  end: number; // saniye
  text: string; // stripCaptionArtifacts()'ten geçmiş

  /**
   * ASR güven skoru — parçaların EN DÜŞÜĞÜ (0-255). Alan yoksa `undefined`
   * (manuel altyazıda muhtemelen hiç gelmiyor). Bkz. aşağıdaki uyarı.
   */
  asrConfMin?: number;

  /** ASR güven skoru — parçaların ORTALAMASI (0-255). Bkz. aşağıdaki uyarı. */
  asrConfAvg?: number;
}

// 🔴 ASR GÜVEN SKORU: VERİ TAŞINIR, KARAR VERİLMEZ.
//
// ÖLÇÜLDÜ (18 Eyl 2026): her `segs` parçası `acAsrConf` alanı taşıyor (0-255).
//   "almost 70 members and"                → 200, 133, 131, 111  (düşük)
//   "the Democrats show didn't disappoint" → 255, 207, 210, 228, 238 (yüksek)
//
// ⚠️ HİÇBİR KARAR BU SKORA DAYANMIYOR. Bu modül skorla filtreleme, eşikleme
// ya da eleme YAPMAZ; alanı yalnız dışarı taşır. Sebebi:
//   · eşik ÖLÇÜLMEDİ — hangi değerin altı "güvenilmez" bilinmiyor,
//   · 255'in gerçek bir skor mu yoksa varsayılan/dolgu değer mi olduğu
//     bilinmiyor.
//
// Bu alan, kanıtlanmış kusur sınıfı için ilk OTOMATİK sinyal adayı: bugüne
// kadar hiçbir kapı "ASR yanlış duydu" durumunu yakalayamadı, çünkü terim
// metinde gerçekten geçiyor. Skor, bozukluğun kaynakta olduğunu söyleyebilecek
// ilk ölçülebilir ipucu. Ama kapı olarak kullanılmadan önce ölçüm gerekiyor.

export interface CaptionResult {
  segments: CaptionSegment[];
  isAsr: boolean;
  languageCode: string;
  /**
   * Seçilen parçanın YouTube'da görünen adı (`captionTracks[i].name.simpleText`,
   * ör. "İngilizce (ABD)"). Panel "hangi metin işlendi" sorusunu cevaplasın
   * diye: kullanıcı ekranda otomatik altyazıyı izlerken eklenti manuel parçayı
   * işleyebiliyor (gözlendi) — zaman damgaları tutar ama kelimeler farklı
   * olabilir. Alan yoksa `undefined`; uydurulmuyor.
   *
   * İzolasyon kuralı gereği burada: YouTube'un parça biçimini bilen tek dosya
   * bu. Seçim mantığı DEĞİŞMEDİ — yalnız seçilen parçanın adı okunuyor.
   */
  trackName?: string;
  /**
   * Kullanıcı biz tetiklemeden ÖNCE YouTube'un altyazısını açık tutuyor muydu?
   *
   * Altyazı tetikleme için geçici olarak kapatılıyor ve bu modül dönmeden
   * ÖNCE, `true` ise geri açılıyor (`captureStrategy` → `finally`). Alan
   * yalnız bilgi olarak dışarı veriliyor (konsol/teşhis); geri yüklemeyi
   * çağıranın yapması GEREKMİYOR. Tespit edilemediğinde `false` — varsayım
   * üretilmez; `false` iken altyazıya geri dokunulmaz.
   */
  nativeCaptionsWereOn: boolean;
}

// 🔴 Sınıflar birbirine KARIŞTIRILMAZ. Özellikle NO_CAPTION_TRACKS (altyazı
// yok — normal bir video hali) ile EMPTY_BODY (istek 200 döndü, gövde boş —
// YouTube tarafında sessiz başarısızlık) farklı durumlar ve kullanıcıya farklı
// mesaj gerektiriyor.
export type CaptionError =
  | "NO_PLAYER_RESPONSE"
  | "NO_CAPTION_TRACKS"
  | "SOURCE_NOT_ENGLISH"
  | "TRIGGER_FAILED"
  | "EMPTY_BODY"
  | "FETCH_FAILED"
  | "PARSE_FAILED"
  | "RATE_LIMITED"
  // Okunan player response başka bir videoya ait (SPA gezinmesinde bayat
  // kalıyor — bkz. readPlayerResponse). Sessizce yanlış sonuç üretmek yerine
  // açıkça başarısız olunur.
  | "STALE_PLAYER_RESPONSE";

type Fail = { ok: false; error: CaptionError };
type Ok<T> = { ok: true; data: T };
type Attempt<T> = Ok<T> | Fail;

function fail(error: CaptionError): Fail {
  return { ok: false, error };
}

// ── unknown daraltma yardımcıları ───────────────────────────────────────────
// Sayfadan okunan hiçbir şey `any` değil: her alan varlık + tip kontrolünden
// geçer. Kontroller tören değil — `captionTracks`'in yapısı ölçümde videodan
// videoya değişti (bir videoda 65 eleman, başka videoda 3 eleman + ayrı
// `translationLanguages`).

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  return value as UnknownRecord;
}

function asArray(value: unknown): unknown[] | undefined {
  return Array.isArray(value) ? value : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** Sonlu sayı. `0` geçerli bir değerdir; "yok" ile karıştırılmaz. */
function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

// ── 1-3. adım: track listesi, kaynak dil, track seçimi ──────────────────────

interface SelectedTrack {
  languageCode: string;
  isAsr: boolean;
  trackName: string | undefined;
}

/**
 * Parçanın görünen adı: `name.simpleText`.
 *
 * ⚠️ Yalnız `simpleText` biçimi okunuyor. YouTube bazı yanıtlarda adı
 * `name.runs[].text` biçiminde veriyor olabilir — bu ölçülmedi; o durumda ad
 * `undefined` kalıyor ve panel parça adı yerine yalnız türü gösteriyor.
 */
function trackDisplayName(track: UnknownRecord): string | undefined {
  const name = asString(asRecord(track.name)?.simpleText);
  return name !== undefined && name.trim() !== "" ? name : undefined;
}

/**
 * Sayfanın GERÇEKTE izlediği videonun kimliği — adres çubuğundan.
 *
 * 🔴 Tek güvenilir kaynak bu. `ytInitialPlayerResponse` SPA gezinmesinde
 * bayat kalıyor (aşağıdaki ölçüm), adres ise güncel.
 */
function readPageVideoId(): string | undefined {
  let value: string | null = null;
  try {
    value = new URL(window.location.href).searchParams.get("v");
  } catch {
    return undefined;
  }
  return value !== null && value !== "" ? value : undefined;
}

/**
 * Player response — TAZE kaynaktan.
 *
 * 🔴 ÖLÇÜLDÜ (18 Eyl 2026): `window.ytInitialPlayerResponse` SPA gezinmesinde
 * (ana sayfadan ya da başka bir videodan tıklayarak geçişte) ÖNCEKİ videonun
 * verisini taşımaya devam ediyor:
 *
 *   izlenen video                              : QHYL-uiLJ14
 *   yakalanan timedtext URL'sindeki `v`         : QHYL-uiLJ14  (doğru)
 *   ytInitialPlayerResponse…videoDetails.videoId: uvX4k_3Cmvs  (BAYAT)
 *
 * Bunun görünen sonucu URL filtresinin doğru URL'yi yanlış referansla elemesi
 * (TRIGGER_FAILED) idi. Görünmeyen ve daha ağır sonucu: `selectTrack` de aynı
 * bayat veriyi okuyor, yani filtre olmasaydı modül SESSİZCE önceki videonun
 * track seçimini yapardı — dil, `kind`, `audioTracks` hepsi yanlış videodan
 * gelir ve kimse fark etmezdi.
 *
 * Bu yüzden önce player'ın kendi metodu denenir:
 *  1. `#movie_player.getPlayerResponse()` — ⚠️ bu metodun SPA gezinmesinde
 *     GÜNCELLENDİĞİ ÖLÇÜLMEDİ; taze olmasını bekliyoruz, doğrulanmadı.
 *  2. Yoksa `window.ytInitialPlayerResponse` — eski davranış, bayat olabilir.
 *
 * Hangi kaynaktan okunduğu konsola BASILMIYOR; ayrım yalnız burada belgeli.
 * Her iki durumda tazelik kapısı `selectTrack` içinde ayrıca uygulanıyor.
 */
function readPlayerResponse(): UnknownRecord | undefined {
  const player = asCaptionPlayer(document.querySelector("#movie_player"));
  if (player?.getPlayerResponse) {
    let fresh: unknown;
    try {
      fresh = player.getPlayerResponse();
    } catch {
      fresh = undefined;
    }
    const record = asRecord(fresh);
    if (record) return record;
  }

  return asRecord(window.ytInitialPlayerResponse);
}

/** Player response'un beyan ettiği video kimliği. */
function readResponseVideoId(playerResponse: UnknownRecord): string | undefined {
  const videoDetails = asRecord(playerResponse.videoDetails);
  const videoId = asString(videoDetails?.videoId);
  return videoId !== undefined && videoId !== "" ? videoId : undefined;
}

/**
 * Yakalanan URL'yi karşılaştırmak için kullanılacak video kimliği.
 *
 * Önce adres çubuğu (her zaman güncel), yoksa player response (bayat
 * olabilir). Hiçbiri okunamazsa `undefined` ve URL kontrolü atlanır —
 * güvenlik ağı, zorunlu kapı değil.
 */
function readVideoId(): string | undefined {
  const fromPage = readPageVideoId();
  if (fromPage !== undefined) return fromPage;

  const playerResponse = readPlayerResponse();
  return playerResponse ? readResponseVideoId(playerResponse) : undefined;
}

/**
 * Seçilecek track'i belirler (spesifikasyon adım 1-3).
 *
 * Kaynak dil sinyali `audioTracks[0]` içindedir. ÖLÇÜLDÜ:
 * `defaultCaptionTrackIndex`, `playerCaptionsTracklistRenderer` seviyesinde
 * `undefined`'dır; alan `streamingData` altında da DEĞİL — orada arayan kod
 * her videoda "altyazı yok" sonucuna varır.
 *
 * `kind` kaynak dil sinyali olarak KULLANILAMAZ: ölçümde manuel altyazı ile
 * makine çevirisini ayırmadı (ikisinde de `undefined`). `isTranslatable` de
 * ayırmıyor (her track'te `true`). Bu yüzden dil filtresi 2. adımdan gelir.
 */
function selectTrack(): Attempt<SelectedTrack> {
  const playerResponse = readPlayerResponse();
  if (!playerResponse) return fail("NO_PLAYER_RESPONSE");

  // 🔴 TAZELİK KAPISI. Okunan player response başka bir videoya aitse devam
  // ETME. Bayat veriyle üretilen sonuç sessizce yanlış olur: dil ve `kind`
  // önceki videodan gelir, hata hiçbir yerde görünmez. Bu, kanıtlanmış kusur
  // sınıfının aynı mantığı — sessiz yanlış, gürültülü hatadan kötüdür.
  //
  // Karşılaştırma ancak iki kimlik de okunabiliyorsa yapılır; biri yoksa kapı
  // atlanır (kıyaslanacak şey yok).
  const pageVideoId = readPageVideoId();
  const responseVideoId = readResponseVideoId(playerResponse);
  if (
    pageVideoId !== undefined &&
    responseVideoId !== undefined &&
    pageVideoId !== responseVideoId
  ) {
    return fail("STALE_PLAYER_RESPONSE");
  }

  // 🔴 BURADA NO_PLAYER_RESPONSE DÖNÜLMEZ — ölçülmüş bir hata sınıfı
  // karışmasıydı.
  //
  // ÖLÇÜLDÜ (18 Eyl 2026, gerçek koşul): altyazısız bir videoda
  // `NO_PLAYER_RESPONSE` döndü, oysa `NO_CAPTION_TRACKS` dönmeliydi. Sebep:
  // altyazısız videoda player response VAR ve okunuyor, yalnız `captions`
  // alanı yok. Eski kod iki farklı durumu tek sınıfa çöküyordu:
  //   · player response gerçekten okunamıyor → TEKNİK ARIZA
  //   · video var ama altyazısı yok          → NORMAL DURUM
  //
  // İkisi kullanıcıya taban tabana zıt mesaj gerektiriyor ("bir şeyler bozuldu"
  // vs. "bu videoda altyazı yok"), bu yüzden karıştırmak yasak. Response nesnesinin varlığı
  // yukarıda kontrol edildi; buradan sonrası altyazının yokluğudur.
  const captions = asRecord(playerResponse.captions);
  const tracklist = asRecord(captions?.playerCaptionsTracklistRenderer);
  if (!tracklist) return fail("NO_CAPTION_TRACKS");

  const captionTracks = asArray(tracklist.captionTracks);
  if (!captionTracks || captionTracks.length === 0) {
    return fail("NO_CAPTION_TRACKS");
  }

  // 2. adım — kaynak dil. Tam yol:
  // ytInitialPlayerResponse.captions.playerCaptionsTracklistRenderer
  //   .audioTracks[0].defaultCaptionTrackIndex
  const audioTracks = asArray(tracklist.audioTracks);
  const primaryAudio = asRecord(audioTracks?.[0]);
  if (!primaryAudio) return fail("NO_CAPTION_TRACKS");

  let sourceIndex = asNumber(primaryAudio.defaultCaptionTrackIndex);
  if (sourceIndex === undefined) {
    const indices = asArray(primaryAudio.captionTrackIndices);
    sourceIndex = asNumber(indices?.[0]);
  }
  if (sourceIndex === undefined) return fail("NO_CAPTION_TRACKS");

  const sourceTrack = asRecord(captionTracks[sourceIndex]);
  const sourceLanguage = asString(sourceTrack?.languageCode);
  if (!sourceLanguage) return fail("NO_CAPTION_TRACKS");

  // Kaynak dil İngilizce değilse modül devre dışı: çeviri altyazı üstüne
  // annotate etmek, metin sahnede söylenmediği için "bu sahnede ne demek"
  // önermesini çökertir.
  if (!sourceLanguage.startsWith("en")) return fail("SOURCE_NOT_ENGLISH");

  // 3. adım — kaynak dille AYNI languageCode'a sahip track'ler arasından seç.
  const sameLanguage = captionTracks
    .map((track) => asRecord(track))
    .filter((track): track is UnknownRecord => track !== undefined)
    .filter((track) => asString(track.languageCode) === sourceLanguage);

  // `kind` tanımsız → manuel. En iyi seçenek.
  const manual = sameLanguage.find((track) => track.kind === undefined);
  if (manual) {
    return {
      ok: true,
      data: { languageCode: sourceLanguage, isAsr: false, trackName: trackDisplayName(manual) },
    };
  }

  const asr = sameLanguage.find((track) => asString(track.kind) === "asr");
  if (asr) {
    return {
      ok: true,
      data: { languageCode: sourceLanguage, isAsr: true, trackName: trackDisplayName(asr) },
    };
  }

  // Başarısız ol. "Son çare olarak ilk track'i al" YASAK: makine çevirisine
  // düşmek, kanıtlanmış kusur sınıfını doğrudan besler.
  return fail("NO_CAPTION_TRACKS");
}

// ── Player köprüsü ──────────────────────────────────────────────────────────

interface CaptionPlayer {
  loadModule(name: string): void;
  setOption(module: string, option: string, value: unknown): void;
  /** Player'da varsa okunur; yoksa `undefined` ve DOM yedeğine düşülür. */
  getOption?: (module: string, option: string) => unknown;
  /** Taze player response kaynağı; yoksa sayfa global'ine düşülür. */
  getPlayerResponse?: () => unknown;
}

/**
 * `#movie_player` üzerindeki iki metodu doğrular.
 *
 * Metodlar `Reflect.apply` ile çağrılıyor: `typeof` kontrolü değeri `Function`
 * olarak daraltıyor, böylece player nesnesi hiç `any` olmadan kullanılabiliyor.
 */
function asCaptionPlayer(node: unknown): CaptionPlayer | undefined {
  const player = asRecord(node);
  if (!player) return undefined;

  const loadModule = player.loadModule;
  const setOption = player.setOption;
  if (typeof loadModule !== "function" || typeof setOption !== "function") {
    return undefined;
  }

  const getOption = player.getOption;
  const getPlayerResponse = player.getPlayerResponse;

  return {
    loadModule: (name) => {
      Reflect.apply(loadModule, node, [name]);
    },
    setOption: (module, option, value) => {
      Reflect.apply(setOption, node, [module, option, value]);
    },
    getOption:
      typeof getOption === "function"
        ? (module, option) => Reflect.apply(getOption, node, [module, option])
        : undefined,
    getPlayerResponse:
      typeof getPlayerResponse === "function"
        ? () => Reflect.apply(getPlayerResponse, node, [])
        : undefined,
  };
}

/**
 * Kullanıcı altyazıyı ZATEN açık mı tutuyordu? Tetiklemeden ÖNCE çağrılır.
 *
 * Altyazıyı tetikleme için kapatıyoruz (kapalı durumdan başlamak zorunlu —
 * aşağıdaki idempotentlik ölçümü). Kullanıcının kendi açtığı altyazıyı
 * kapattıysak işimiz bitince GERİ AÇMALIYIZ; hiç açık olmayanı açmamalıyız.
 * Bu fonksiyon hangisi olduğunu söylüyor.
 *
 * Tespit edilemezse `false` döner. Uydurulmaz: yanılıp kullanıcının kapalı
 * tuttuğu altyazıyı açmak, onu kapalı bırakmaktan daha görünür bir bozulma.
 */
function detectNativeCaptionsOn(player: CaptionPlayer): boolean {
  // 1) Player'ın kendi durumu. Seçili track varsa altyazı açık demektir.
  if (player.getOption) {
    let option: unknown;
    try {
      option = player.getOption("captions", "track");
    } catch {
      option = undefined;
    }
    const track = asRecord(option);
    if (track) {
      const languageCode = asString(track.languageCode);
      return languageCode !== undefined && languageCode !== "";
    }
  }

  // 2) DOM yedeği: altyazı kabında görünür içerik var mı?
  //    ⚠️ Bu yedek, altyazı açık olsa bile o anda konuşma yoksa `false`
  //    verebilir (kap boş durur). Yön bilinçli: eksik not, yanlış nottan iyi.
  const container = document.querySelector(".ytp-caption-window-container");
  if (container) {
    const text = container.textContent;
    return text !== null && text.trim() !== "";
  }

  return false;
}

/**
 * Kullanıcının o an açık tuttuğu parça — `getOption("captions", "track")`
 * nesnesinin TAMAMI. Tetiklemeden ÖNCE okunur; geri yüklemede aynen verilir.
 *
 * Neden dil kodu değil nesnenin tamamı: ÖLÇÜLDÜ — kullanıcı otomatik
 * İngilizce izlerken eklenti manuel "İngilizce (ABD)" parçasını seçti; geri
 * yükleme seçilen dille yapıldığında işlem sonunda kullanıcının altyazısı
 * DEĞİŞTİ. İki parçanın dil kodu aynı (`en`); ayıran şey nesnenin diğer
 * alanları (ör. `kind`, `vssId`). İlke: eklenti ekranı işlem öncesindeki
 * haliyle bırakır.
 *
 * Kopya döndürülüyor: player sonradan kendi nesnesini değiştirse bile
 * sakladığımız durum etkilenmesin. Okunamıyorsa ya da parça kapalıysa
 * (`languageCode` boş) `undefined`.
 */
function readUserTrack(player: CaptionPlayer): UnknownRecord | undefined {
  if (!player.getOption) return undefined;
  let option: unknown;
  try {
    option = player.getOption("captions", "track");
  } catch {
    return undefined;
  }
  const track = asRecord(option);
  if (!track) return undefined;
  const languageCode = asString(track.languageCode);
  if (languageCode === undefined || languageCode === "") return undefined;
  return { ...track };
}

/**
 * Native altyazıyı yeniden AÇAR — kullanıcının durumunu geri yüklemek için.
 *
 * 🔴 ÖLÇÜLDÜ (19 Eyl 2026, gerçek kullanım): kullanıcı altyazıyla video
 * izliyordu, eklentiyi çalıştırdı, altyazısı kayboldu ve geri gelmedi.
 * Kapatma tetikleme için hâlâ ZORUNLU (`setOption` idempotent: altyazı açıkken
 * tetikleme yeni istek doğurmuyor), ama iş bitince durum geri yüklenmeli.
 *
 * YALNIZ `captureStrategy`'nin `finally`'sinden çağrılıyor — kapatan yer ile
 * geri açan yer aynı fonksiyonda. Önceden dışa aktarılıyor ve `main-world.ts`
 * yalnız BAŞARILI çekmeden sonra çağırıyordu: hata yolunda (TRIGGER_FAILED,
 * EMPTY_BODY, RATE_LIMITED…) kullanıcının altyazısı kapalı kalıyordu (22 Eyl
 * 2026 belge denetiminde koddan okundu).
 *
 * Player ya da metodlar yoksa sessizce hiçbir şey yapılmaz — geri yükleme bir
 * "en iyi çaba", sonucu etkilemez.
 */
function restoreNativeCaptions(
  userTrack: UnknownRecord | undefined,
  languageCode: string,
): void {
  const player = asCaptionPlayer(document.querySelector("#movie_player"));
  if (!player) return;

  // Kullanıcının parçası okunabildiyse TAM O parça geri açılıyor. Okunamadıysa
  // (player'da `getOption` yok ya da değer dönmedi — `nativeCaptionsWereOn`
  // o zaman DOM yedeğinden gelmiş olabilir) eski davranışa düşülüyor:
  // eklentinin seçtiği dil. Bu yedekte kullanıcı aynı dilin başka bir
  // parçasını izliyorduysa (otomatik ↔ manuel) geri açılan parça farklı olur.
  const track: unknown = userTrack ?? { languageCode };

  try {
    player.loadModule("captions");
    player.setOption("captions", "track", track);
  } catch {
    // Player iç durumu beklenmedik haldeyse sorun etmiyoruz.
  }
}

// ── 4-8. adım: yakalama stratejisi ──────────────────────────────────────────
//
// 🔴 Bu strateji YouTube'un `pot` (proof-of-origin token) davranışına bağımlı
// ve o davranış bizim kontrolümüzde değil. `baseUrl`'i doğrudan fetch etmek
// ÇALIŞMIYOR: 200 dönüyor, gövde BOŞ geliyor (tüm `fmt` varyantlarında).
// Sebep ölçüldü: player'ın kendi isteğinde `pot` ve `potc=1` var, okuduğumuz
// `baseUrl`'de yok; token'ı player üretiyor, biz üretemeyiz.
//
// Tetikleme ya da token şeması değişirse bu yol kapanır. O gün ikinci bir
// strateji (DOM'dan canlı okuma) bu imzayla yazılır ve fetchCaptions'ın
// gövdesi değişmez: strateji ham segment verir, normalize etmek fetchCaptions'
// ın işidir.

/** Temizlikten ÖNCEKİ segment. Metni hâlâ YouTube'un ham metni. */
interface RawSegment {
  start: number;
  end: number;
  text: string;
  asrConfMin?: number;
  asrConfAvg?: number;
}

interface StrategyOutput {
  segments: RawSegment[];
  /** Tetiklemeden önceki native altyazı durumu; yalnız strateji görebilir. */
  nativeCaptionsWereOn: boolean;
}

type CaptionStrategy = (languageCode: string) => Promise<Attempt<StrategyOutput>>;

const POLL_INTERVAL_MS = 200;
const POLL_MAX_ATTEMPTS = 25; // ~5 sn

/**
 * Tetiklemeden önceki kapatmanın oturması için beklenen süre.
 *
 * Player'ın altyazı durumu senkron değişmiyor; hemen tetiklersek YouTube
 * hâlâ "açık" durumunda olabilir ve idempotent `setOption` yeni istek
 * doğurmaz (aşağıdaki kısır döngü notu). ⚠️ 300 ms ölçülmüş bir eşik değil,
 * ölçülene kadar tutulan bir tahmin.
 */
const PRE_TRIGGER_CLOSE_MS = 300;

// ── Hız sınırı geri çekilmesi ───────────────────────────────────────────────
//
// 🔴 ÖLÇÜLDÜ (17 Eyl 2026): aynı `timedtext` URL'sine kısa sürede tekrarlanan
// istekler 429 döndürüyor. Sınır IP bazlı ve endpoint'in TAMAMINI kapsıyor —
// YouTube'un KENDİ player'ının altyazıları da çalışmaz hale geliyor.
//
// Bu yüzden ayrı bir hata sınıfı: FETCH_FAILED "bir kez denedik, olmadı"
// demek ve tekrar denemeyi makul gösterir. Burada tekrar denemek zararın
// kendisi — kullanıcının YouTube deneyimini biz bozuyoruz, hem de eklentiyle
// ilgisi olmayan yerde. Sınıfın ayrı olması çağıranın tekrar denememesini ve
// kullanıcıya doğru şeyi söylemesini sağlar.
//
// Geri çekilme kasıtlı olarak APTAL: tek zaman damgası. Damga geçene kadar
// hiç istek yapılmaz, hatta player tetiklenmez. Backoff, kuyruk ya da
// yeniden deneme zamanlayıcısı YOK — onlar sınırı aşmayı optimize etmeye
// çalışır; burada istenen tam tersi, bir süre tamamen susmak.
const RATE_LIMIT_COOLDOWN_MS = 60_000;

// Boş gövde de aynı damgayı kurar, ama DAHA KISA süreyle.
//
// Gerekçe: 429 ile 200 + boş gövde ikisi de "YouTube bize kızgın" sinyali ve
// ikisinde de ısrar etmek zarar veriyor. Fark, sebebin kesinliğinde: 429
// açıkça hız sınırı derken, boş gövdenin sebebi BELİRSİZ — `pot` engelinde de
// tam bu davranışı gördük (200 / uzunluk 0), yani boş gövde hız sınırı
// olmadan da gelebiliyor. Sebep belirsiz olduğu için susma süresi kısa: hız
// sınırıysa yeterince bekliyoruz, başka bir şeyse kullanıcıyı gereksiz
// süre boyunca altyazısız bırakmıyoruz.
const EMPTY_BODY_COOLDOWN_MS = 20_000;

// Modül düzeyinde durum. Sayfa ömrü boyunca yaşar; bu modül MAIN ortamda
// sayfa başına bir kez yüklendiği için kapsam doğru yerde.
let cooldownUntilMs = 0;

// Geri çekilmeyi hangi sinyal kurdu? Pencere içinde gelen çağrıya AYNI sınıf
// döner: geri çekilme paylaşılıyor, hata sınıfları karışmıyor.
let cooldownError: CaptionError = "RATE_LIMITED";

/**
 * Geri çekilme penceresini kurar — ama yalnız İLERİYE.
 *
 * 🔴 PENCERE UZAR, KISALMAZ. Damgayı koşulsuz üzerine yazmak gerçek bir hata
 * üretiyordu: 429'dan (60 sn) hemen sonra gelen bir boş gövde (20 sn) pencereyi
 * 20 saniyeye İNDİRİYOR, yani daha ciddi sinyal daha hafifi tarafından
 * eziliyordu. Sonuç ters yöne çalışıyor: YouTube bize en kızgın olduğu anda
 * susma süresini kısaltıyoruz.
 *
 * Geriye çeken damga tamamen yok sayılır; `cooldownError` de değişmez, çünkü
 * pencere hâlâ eski ve daha ciddi sinyalin penceresidir — çağıran o sinyalin
 * sınıfını görmeye devam etmeli.
 */
function extendCooldown(durationMs: number, error: CaptionError): void {
  const until = Date.now() + durationMs;
  if (until <= cooldownUntilMs) return;

  cooldownUntilMs = until;
  cooldownError = error;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * `timedtext` isteğinin URL'sini kaynak kayıtlarından okur.
 *
 * ÖLÇÜLDÜ: bu istek altyazı kapalıyken hiç yapılmıyor (0 kayıt), açıkken 1
 * kayıt geliyor. Yani `pot=` içeren kayıt tetiklemenin kanıtı.
 *
 * 🔴 En YENİ kayıt alınır (`startTime` en büyük). İlk eşleşmeyi almak yanlış:
 * SPA gezinmesinden sonra listede önceki videonun URL'si durabilir ve o
 * yakalanırsa yanlış videonun altyazısı çekilir.
 *
 * 🔴 İKİNCİ SÜZGEÇ — video kimliği: "en yeni kayıt" tek başına yetmez, çünkü
 * SPA gezinmesinde önceki videonun kaydı listede kalabiliyor ve bizim
 * tetiklememiz gecikirse o kayıt bir süre "en yeni" olur. Bu yüzden URL'deki
 * `v=` parametresi sayfadaki videoId ile karşılaştırılır.
 *
 * Kontrol GÜVENLİK AĞI, zorunlu kapı değil: videoId okunamıyorsa ya da URL'de
 * `v=` yoksa kayıt reddedilmez. Yanlış videoyu elemek için var; doğru videoyu
 * elemek için değil.
 */
function findCaptureUrl(
  exclude: string | undefined,
  videoId: string | undefined,
): string | undefined {
  let newest: PerformanceEntry | undefined;

  for (const entry of performance.getEntriesByType("resource")) {
    if (!entry.name.includes("timedtext") || !entry.name.includes("pot=")) continue;
    if (exclude !== undefined && entry.name === exclude) continue;
    if (!belongsToVideo(entry.name, videoId)) continue;
    if (!newest || entry.startTime > newest.startTime) newest = entry;
  }

  return newest?.name;
}

/** URL bu videoya mı ait? Karşılaştırma yapılamıyorsa `true` (bkz. güvenlik ağı). */
function belongsToVideo(url: string, videoId: string | undefined): boolean {
  if (videoId === undefined) return true;

  let urlVideoId: string | null = null;
  try {
    urlVideoId = new URL(url).searchParams.get("v");
  } catch {
    return true;
  }
  if (urlVideoId === null) return true;

  return urlVideoId === videoId;
}

/** URL'nin `expire` damgası geçmiş mi? Damga okunamıyorsa geçmemiş sayılır. */
function isExpired(url: string): boolean {
  let expire: string | null = null;
  try {
    expire = new URL(url).searchParams.get("expire");
  } catch {
    return false;
  }
  if (expire === null) return false;

  const stamp = Number.parseInt(expire, 10);
  if (!Number.isFinite(stamp)) return false;

  return stamp < Math.floor(Date.now() / 1000);
}

/**
 * Ham json3 gövdesini segment listesine çevirir (spesifikasyon adım 8).
 *
 * Yakalanan URL zaten `fmt=json3` içeriyor; parametre EKLENMEZ.
 *
 * 🔴 AYNI ASR İÇERİĞİNİN EN AZ İKİ SUNUM MODU VAR (ölçüldü, 18 Eyl 2026) ve
 * ayrıştırıcı ikisini de kaldırmak zorunda:
 *
 *   · mod 1 (`l2NxH4hke_I`): çok parçalı `segs`, `tOffsetMs` geliyor,
 *     `aAppend` YOK, `acAsrConf` gerçek değerler taşıyor.
 *   · mod 2 (`uvX4k_3Cmvs`): tek parçalı `segs`, `aAppend` geliyor,
 *     `acAsrConf` 0.
 *
 * Yani biçim videodan videoya değişiyor — tek bir moda göre yazılmış
 * ayrıştırıcı diğerinde sessizce yanlış çıktı üretir (mod 2'de yinelenen
 * satırlar, mod 1'de kayıp zamanlama). Alan varlığı kontrol edilir, mod
 * tahmin EDİLMEZ.
 */
function parseJson3(body: string): Attempt<RawSegment[]> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return fail("PARSE_FAILED");
  }

  const events = asArray(asRecord(parsed)?.events);
  if (!events) return fail("PARSE_FAILED");

  const segments: RawSegment[] = [];

  for (let i = 0; i < events.length; i++) {
    const event = asRecord(events[i]);
    if (!event) continue;

    // 🔴 `aAppend` — ROLL-UP SUNUM MODU, bağımsız satır DEĞİL.
    //
    // ÖLÇÜM (18 Eyl 2026): json3 event'lerinde `aAppend` alanı gelebiliyor:
    //
    //   { "tStartMs": 2550, "dDurationMs": 3690, "aAppend": 1,
    //     "segs": [{ "utf8": "\n" }] }
    //
    // `aAppend: 1`, o event'in metninin ÖNCEKİ metne EKLENDİĞİ anlamına
    // geliyor — ASR'nin "roll-up" sunumu, yani satırın ekranda büyümesi.
    // Bağımsız bir altyazı satırı değil.
    //
    // Modül bunu bilmediğinde aAppend event'lerini bağımsız segment saydı ve
    // gerçek koşuda aynı metin İKİ KEZ döndü:
    //   1  2.56   6.23   'I wish to confess.'
    //   2  6.24  11.08   'I wish to confess.'
    //
    // SEÇİM: (a) tamamen ATLA. (b) "metnini önceki segmente ekle" seçeneği
    // REDDEDİLDİ, çünkü yukarıdaki yinelenme aAppend event'lerinin önceki
    // satırı TEKRAR taşıdığını gösteriyor; eklemek aynı hatayı tek segmentin
    // içine gömerdi ("I wish to confess. I wish to confess.") ve fark etmek
    // zorlaşırdı. Atlamak hiçbir koşulda yinelenme üretmiyor ve baz event'in
    // zaman damgalarını bozmuyor.
    //
    // ⚠️ ÖLÇÜLMEDİ: bir aAppend event'i GERÇEKTEN yeni kelime taşıyor mu?
    // Taşıyorsa o kelimeleri kaybediyoruz. Ölçülen iki vakada taşımıyordu
    // (biri yalnız "\n", diğeri önceki satırın tekrarı).
    if (asNumber(event.aAppend) === 1) continue;

    // `segs` alanı olmayan kayıtlar var (biçimlendirme olayları) → atlanır.
    const segs = asArray(event.segs);
    if (!segs) continue;

    // 🔴 `tStartMs` 0 OLABİLİR (videonun ilk saniyesinde başlayan altyazı);
    // bu geçerli bir değer, "yok" ile karıştırılmaz. Bu yüzden doğruluk
    // kontrolü değil, tip kontrolü yapılıyor.
    const startMs = asNumber(event.tStartMs);
    if (startMs === undefined) continue;

    // ÖLÇÜLDÜ (18 Eyl 2026): `segs` parçaları kendi boşluklarını TAŞIYOR —
    // ["the", " Democrats", " show", " didn't", " disappoint"]. Bu yüzden
    // ayırıcısız birleştirme doğru; araya boşluk koymak çift boşluk üretirdi.
    let text = "";
    const confidences: number[] = [];
    for (const seg of segs) {
      const part = asRecord(seg);
      const utf8 = asString(part?.utf8);
      if (utf8 !== undefined) text += utf8;

      // 🔴 SIFIR DA TOPLANIR — filtrelenmez.
      //
      // ÖLÇÜM (18 Eyl 2026): bir videoda TÜM parçalar `acAsrConf: 0` döndü;
      // başka bir videoda 255 / 207 / 133 gibi değerler geldi. 0'ın "gerçek
      // düşük skor" mu "skor üretilmedi" mi olduğu ⚠️ ÖLÇÜLMEDİ.
      //
      // Bir ara 0'lar "bilgi yok" sayılıp filtrelendi; o filtre GERİ ALINDI.
      // İki sebep:
      //  · 0, skalanın en düşük ucu olabilir — yani "bu kelimeden hiç emin
      //    değilim". Kusur sınıfı için aradığımız sinyal tam olarak bu;
      //    filtrelemek en değerli veriyi atma riski taşıyor.
      //  · Daha önemlisi ilke: karar "veri taşınır, hiçbir karar buna
      //    dayanmaz". Eşik koymak bir karardır ve ölçüme dayanmıyordu.
      //
      // Alan taşıyan TÜM parçalar sayılır, 0 dahil. Alan hiç yoksa aşağıdaki
      // uzunluk kontrolü iki alanı da `undefined` bırakır.
      //
      // ÖLÇÜLDÜ (18 Eyl 2026, `QHYL-uiLJ14`, taze player response,
      // `isAsr: false`): manuel altyazıda `acAsrConf` alanı HİÇ YOK ve iki
      // alan da `undefined` geldi. Yani alan ASR'ye özel; manuel altyazıda
      // yokluğu NORMAL, hata değil.
      const conf = asNumber(part?.acAsrConf);
      if (conf !== undefined) confidences.push(conf);
    }
    // Ardışık boşluk temizliği güvenlik ağı olarak kalıyor: biçim değişir ve
    // parçalar boşluklarını taşımayı bırakırsa metin en azından bozulmuyor.
    text = text.replace(/\s+/g, " ").trim();
    if (text === "") continue;

    // Süre eksikse event ATLANMAZ: sonraki event'in başlangıcı kullanılır,
    // o da yoksa 2 saniye varsayılır.
    const durationMs = asNumber(event.dDurationMs);

    // Sonraki event'in başlangıcı: hem süre eksikken yerine geçiyor, hem de
    // süre varken kırpma sınırı oluyor (aşağıdaki çakışma notu).
    //
    // 🔴 `aAppend` event'leri bu aramada ATLANIR. Onlar bağımsız segment
    // olarak listeye girmiyor (yukarıdaki roll-up notu), dolayısıyla
    // başlangıçlarını sınır saymak segmenti HİÇ VAR OLMAYACAK bir satırın
    // başlangıcına kırpar ve haksız yere kısaltır. Sınır, gerçekten
    // üretilecek olan sonraki segmentin başlangıcı olmalı.
    let nextStartMs: number | undefined;
    for (let next = i + 1; next < events.length; next++) {
      const candidateEvent = asRecord(events[next]);
      if (asNumber(candidateEvent?.aAppend) === 1) continue;

      const candidate = asNumber(candidateEvent?.tStartMs);
      if (candidate !== undefined) {
        nextStartMs = candidate;
        break;
      }
    }

    let endMs: number;
    if (durationMs !== undefined) {
      endMs = startMs + durationMs;
    } else {
      endMs = startMs + 2000;
      // Bozuk veri koruması: sonraki event geriye gidiyorsa (end < start)
      // o değer kullanılmaz, 2 saniyelik varsayım korunur.
      if (nextStartMs !== undefined && nextStartMs >= startMs) endMs = nextStartMs;
    }

    // 🔴 ÖLÇÜLDÜ (18 Eyl 2026): ASR event'leri ÇAKIŞIYOR — kayan pencere
    // davranışı. Gerçek veri:
    //   event 1: tStartMs 14410 + dDurationMs 7020 → 21430
    //   event 2: tStartMs 17170   ← birincisi bitmeden başlıyor
    //
    // Çakışan segmentler overlay'de üst üste biner: aynı anda iki satır
    // görünür, hangisi okunacağı belirsizleşir ve oynatma kafasına göre satır
    // seçmek imkânsızlaşır. Bu yüzden bitiş, sonraki event'in başlangıcını
    // GEÇEMEZ. Süre alanı silinmiyor, yalnız kırpılıyor.
    //
    // Sonraki başlangıç startMs'e eşit ya da küçükse kırpma YAPILMAZ: orada
    // veri zaten bozuk ve kırpmak end < start üretir.
    if (nextStartMs !== undefined && nextStartMs > startMs && nextStartMs < endMs) {
      endMs = nextStartMs;
    }

    const segment: RawSegment = { start: startMs / 1000, end: endMs / 1000, text };

    // ASR güven skoru yalnız DIŞARI TAŞINIYOR (aşağıdaki alan notu).
    if (confidences.length > 0) {
      segment.asrConfMin = Math.min(...confidences);
      segment.asrConfAvg =
        confidences.reduce((total, value) => total + value, 0) / confidences.length;
    }

    segments.push(segment);
  }

  return { ok: true, data: segments };
}

/**
 * Birinci strateji: player'a altyazıyı açtır, onun ürettiği URL'yi yakala,
 * fetch et, ayrıştır (spesifikasyon adım 4-8).
 *
 * `expire` damgası geçmiş bir URL yakalanırsa 4. adımdan itibaren BİR KEZ daha
 * denenir; ikinci denemede de taze URL gelmezse FETCH_FAILED. ÖLÇÜLDÜ: tipik
 * ömür ~419 dakika, yani bu dal normal akışta hiç çalışmaz — ucuz güvenlik ağı.
 */
const captureStrategy: CaptionStrategy = async (languageCode) => {
  // Geri çekilme penceresi: hiç istek YAPILMAZ, player bile tetiklenmez.
  if (Date.now() < cooldownUntilMs) return fail(cooldownError);

  const videoId = readVideoId();
  let expiredUrl: string | undefined;
  let nativeCaptionsWereOn = false;
  // Altyazıya dokunduk mu? Player bulunamadan dönülürse hiçbir şey
  // kapatılmamıştır; geri açmak da gerekmez.
  let touchedCaptions = false;
  // Kullanıcının açık parçası — geri yüklemede aynen verilecek (`readUserTrack`).
  let userTrack: UnknownRecord | undefined;

  // 🔴 GERİ YÜKLEME GARANTİSİ — başarı, her hata dönüşü ve istisna aynı
  // `finally`'den geçiyor. Altyazıyı kapatan bu fonksiyon, dönmeden önce
  // kullanıcının durumunu geri kuruyor: `nativeCaptionsWereOn` true ise geri
  // açılıyor, false ise dokunulmuyor.
  try {
    for (let round = 0; round < 2; round++) {
      const player = asCaptionPlayer(document.querySelector("#movie_player"));
      if (!player) return fail("TRIGGER_FAILED");

      // 🔴 SIRA BAĞLAYICI: tespit, aşağıdaki kapatmadan ÖNCE yapılmalı. Sonra
      // bakılsa altyazıyı biz kapatmış oluruz ve sonuç her videoda `false`
      // çıkar. İkinci turda tekrar okunmaz — o noktada durum zaten bizim
      // elimizde.
      if (round === 0) {
        nativeCaptionsWereOn = detectNativeCaptionsOn(player);
        userTrack = readUserTrack(player);
      }

      let url: string | undefined;
      touchedCaptions = true;
      try {
        // 🔴 4. adım — TETİKLEME, ama önce KAPATMA. ÖLÇÜLDÜ (18 Eyl 2026):
        // `setOption` idempotent. Altyazı zaten o dilde AÇIKSA YouTube yeni bir
        // `timedtext` isteği doğurmuyor:
        //   · altyazı kapalıyken tetikleme → 1 kayıt
        //   · altyazı açıkken tetikleme    → 10 saniye boyunca 0 kayıt
        //   · altyazı elle kapatıldıktan sonra çağrı → BAŞARILI
        //
        // Bu, modülü KALICI olarak kilitliyordu: tetikle → yakalayamadı →
        // TRIGGER_FAILED ile çık → kapatma adımına hiç gelme → altyazı açık kal
        // → sonraki deneme aynı duvara çarp. Kilidi kıran şey, tetiklemeden önce
        // kapatıp kapalı durumdan başlamak.
        player.setOption("captions", "track", {});
        await sleep(PRE_TRIGGER_CLOSE_MS);

        // Eski kayıtlar silinir: "en yeni kayıt" seçimi böylece kesinleşiyor,
        // çünkü listede yalnız bu tetiklemenin doğurduğu kayıt kalıyor. Ayrıca
        // kaynak zamanlama tamponunun dolu olması riskini de azaltıyor.
        //
        // ⚠️ YAN ETKİ: tampon sayfanın TAMAMI için ortak. Sayfadaki başka kod
        // (YouTube'un kendi ölçümleri dahil) kaynak zamanlamalarını okuyorsa
        // onların kayıtlarını da siliyoruz. Kabul edilen takas: alternatif,
        // yanlış URL yakalamak — yani yanlış videonun altyazısını çekmek.
        performance.clearResourceTimings();

        player.loadModule("captions");
        player.setOption("captions", "track", { languageCode });

        // 5. adım — yakalama. Tetikleme ile kayıt arasında gecikme var.
        for (let attempt = 0; attempt < POLL_MAX_ATTEMPTS && url === undefined; attempt++) {
          url = findCaptureUrl(expiredUrl, videoId);
          if (url === undefined) await sleep(POLL_INTERVAL_MS);
        }
      } finally {
        // 🔴 6. adım — native altyazıyı KAPAT, her yolda. `finally` içinde,
        // çünkü aşağıdaki erken dönüşlerin ya da beklenmedik bir hatanın
        // altyazıyı TETİKLEMEDEN KALMA durumda açık bırakması modülü yukarıdaki
        // kısır döngüye sokuyor. ÖLÇÜLDÜ: tetikleme YouTube'un kendi altyazısını
        // GÖRÜNÜR açıyor. Kullanıcının kendi durumu fonksiyon sonundaki
        // `finally`'de geri kuruluyor (varsa ikinci tur da kapalı durumdan
        // başlasın diye burada değil). Eski CSS güvencesi
        // (`.ytp-caption-window-container { display: none }`) 19 Eyl 2026'da
        // kaldırıldı: kendi altyazı katmanımız yok, çakışacak bir şey kalmadı.
        player.setOption("captions", "track", {});
      }

      if (url === undefined) {
        // İlk turda hiç kayıt yok → tetikleme başarısız. İkinci turda ise
        // tetikleme zaten bir kez çalışmıştı; taze URL gelmemesi süre
        // sorunudur.
        return fail(expiredUrl === undefined ? "TRIGGER_FAILED" : "FETCH_FAILED");
      }

      // 7. adım — expire kontrolü.
      if (isExpired(url)) {
        if (expiredUrl !== undefined) return fail("FETCH_FAILED");
        expiredUrl = url;
        continue;
      }

      // 8. adım — fetch ve ayrıştırma. URL aynen kullanılır.
      let response: Response;
      try {
        response = await fetch(url);
      } catch {
        return fail("FETCH_FAILED");
      }

      // 🔴 429 ayrı sınıf: sınır IP bazlı ve endpoint'in tamamını kapsıyor,
      // yani ısrar YouTube'un kendi altyazılarını da bozuyor. Damgayı kur ve sus.
      if (response.status === 429) {
        extendCooldown(RATE_LIMIT_COOLDOWN_MS, "RATE_LIMITED");
        return fail("RATE_LIMITED");
      }

      if (!response.ok) return fail("FETCH_FAILED");

      let body: string;
      try {
        body = await response.text();
      } catch {
        return fail("FETCH_FAILED");
      }

      // 🔴 Boş gövde "altyazı yok" DEĞİL: YouTube 403 vermiyor, 200 + boş gövde
      // veriyor. Sessiz başarısızlık ayrı bir hata sınıfı.
      // Hata sınıfı EMPTY_BODY olarak KALIYOR — sınıflar karışmaz, yalnız geri
      // çekilme paylaşılıyor (yukarıdaki süre notu).
      if (body.length === 0) {
        extendCooldown(EMPTY_BODY_COOLDOWN_MS, "EMPTY_BODY");
        return fail("EMPTY_BODY");
      }

      const parsed = parseJson3(body);
      if (!parsed.ok) return parsed;

      return { ok: true, data: { segments: parsed.data, nativeCaptionsWereOn } };
    }

    return fail("FETCH_FAILED");
  } finally {
    if (touchedCaptions && nativeCaptionsWereOn) {
      restoreNativeCaptions(userTrack, languageCode);
    }
  }
};

// ── Dış arayüz ──────────────────────────────────────────────────────────────

/**
 * Bu videonun altyazı segmentlerini verir.
 *
 * Gövdesi bilinçli olarak ince: track seçimi (adım 1-3), stratejiyi çağırmak
 * ve normalize etmek (adım 9). Yakalama/fetch/ayrıştırma mantığı stratejinin
 * içinde durur, böylece ikinci bir strateji eklendiğinde burası değişmez.
 */
export async function fetchCaptions(): Promise<
  { ok: true; data: CaptionResult } | { ok: false; error: CaptionError }
> {
  const selected = selectTrack();
  if (!selected.ok) return selected;

  const captured = await captureStrategy(selected.data.languageCode);
  if (!captured.ok) return captured;

  // 9. adım — temizlik. Her segment metni dönmeden ÖNCE buradan geçer:
  // temizlik ingest'te durur, aşağı akış YouTube'un biçimini bilmez. Metni
  // boşalan segment listeden çıkarılır (sahne notundan ibaret satırlar).
  const segments: CaptionSegment[] = [];
  for (const segment of captured.data.segments) {
    const text = stripCaptionArtifacts(segment.text);
    if (text === "") continue;
    // Zaman damgaları ve ASR skorları olduğu gibi taşınır; değişen tek şey
    // metnin temizlenmiş hali.
    segments.push({ ...segment, text });
  }

  return {
    ok: true,
    data: {
      segments,
      isAsr: selected.data.isAsr,
      languageCode: selected.data.languageCode,
      nativeCaptionsWereOn: captured.data.nativeCaptionsWereOn,
      ...(selected.data.trackName !== undefined
        ? { trackName: selected.data.trackName }
        : {}),
    },
  };
}
