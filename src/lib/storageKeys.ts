// `chrome.storage.local` anahtar adları — TEK doğruluk kaynağı.
//
// Aynı dize iki dosyada elle yazıldığında (ayar sayfası yazıyor, background
// okuyor) biri değişip diğeri kalırsa hiçbir hata görünmez: kullanıcı anahtarı
// kaydeder, background "anahtar yok" der. Sessiz hata, gürültülü hatadan
// kötüdür.
//
// 🔴 `local`, `sync` DEĞİL: `sync` kullanıcının hesabıyla bulut üzerinden
// eşitlenir ve API anahtarı için yanlış yer.

/** Kullanıcının Mistral API anahtarı. Yalnız bu tarayıcıda durur. */
export const STORAGE_KEY_MISTRAL = "mistralApiKey";

/**
 * Yerel koşum önbelleği — `rv-cache:v2:<videoId>:<chunkSize>:<model>`.
 *
 * 🔴 MODEL ANAHTARDA. Olmasaydı `medium` ile üretilmiş sonuç `large` sonucu
 * gibi önbellekten gelir ve karşılaştırmalı ölçüm sessizce bozulurdu: iki
 * farklı modeli ölçtüğünü sanan kişi aynı çıktıyı iki kez görürdü.
 *
 * 🔴 Bu, karar 2'deki paylaşımlı önbelleğin DAR bir alt kümesi, tamamı değil.
 * Amacı tek: demo sırasında aynı videoyu tekrar tekrar işleyip her seferinde
 * ~$0.04 ve ~60 sn harcamamak. YOK olanlar: paylaşımlı katman, TTL,
 * `promptVersion` anahtarı, boyut yönetimi, LRU. Tek anahtar, üzerine yazılır.
 * Bu ek önbellek özellikleri henüz uygulanmadı.
 */
export function cacheKey(videoId: string, chunkSize: number, model: string): string {
  return `${CACHE_KEY_PREFIX}${CACHE_KEY_VERSION}:${videoId}:${chunkSize}:${model}`;
}

/**
 * 🔴 SÜRÜM ÖNEKİ. Önbellek kaydının biçimi değiştiğinde sürüm artıyor ve eski
 * kayıtlar okunmaz olmak yerine SİLİNİYOR (background → onInstalled /
 * onStartup). v2: kayıt `isAsr` ve seçilen parçanın adını taşıyor; v1 kayıtları
 * ikisini de taşımıyordu — önbellekten açılan ASR videoda turuncu uyarı
 * kayboluyordu (gözlendi). Okunamayan yetim kayıtlar birikmesin.
 */
export const CACHE_KEY_PREFIX = "rv-cache:";
export const CACHE_KEY_VERSION = "v2";

/** Bu anahtar ESKİ sürüm bir önbellek kaydı mı? (silinecek) */
export function isStaleCacheKey(key: string): boolean {
  return (
    key.startsWith(CACHE_KEY_PREFIX) &&
    !key.startsWith(`${CACHE_KEY_PREFIX}${CACHE_KEY_VERSION}:`)
  );
}

/**
 * Kullanıcının "yanlış" diye işaretlediği maddeler.
 *
 * Sunucu YOK: kayıt yalnız bu tarayıcıda durur ve "kopyala" düğmesiyle dışa
 * aktarılır. Eklentide uzman insan kapısı olmadığı için bu, kusur sınıfına
 * karşı tek geri besleme kanalıdır.
 */
export const STORAGE_KEY_REPORTS = "rv-reports";
