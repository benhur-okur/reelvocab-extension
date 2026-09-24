// Arayüz metinleri — chrome.i18n, tek giriş noktası.
//
// Dil tarayıcının arayüz diline göre seçiliyor (chrome.i18n varsayılanı);
// uygulama içi dil seçici yok. Metinler `_locales/{en,tr}/messages.json`'da.
//
// 🔴 ANAHTAR TİPİ İNGİLİZCE DOSYADAN TÜRETİLİYOR. `chrome.i18n.getMessage`
// olmayan bir anahtar için SESSİZCE boş dize döndürüyor: yazım hatası panelde
// boş bir düğme olur ve fark edilmez. `MessageKey` sayesinde yanlış anahtar
// typecheck'te düşüyor; build.mjs ayrıca iki dil dosyasını ve kaynaktaki her
// `msg("…")` çağrısını karşılaştırıyor. Bu yüzden anahtar HER ZAMAN dize
// sabiti olarak yazılır — değişkenden gelen anahtarı build reddediyor.
//
// Tür yalnız tip konumunda içe aktarılıyor; JSON pakete girmiyor.
//
// ⚠️ Çoğul kuralı yok (chrome.i18n desteklemiyor): sayı içeren metinler
// sayıdan bağımsız kuruldu ("Items: 3"), "1 items" hatası çıkmasın.

export type MessageKey = keyof typeof import("../../_locales/en/messages.json");

/**
 * Anahtarın metni; `substitutions` sırayla `$1`, `$2`… yer tutucularına.
 *
 * Boş dönerse (build kontrolüne rağmen anahtar yoksa) anahtarın KENDİSİ
 * gösteriliyor: boş bir düğmeden çok daha kolay fark edilir.
 */
export function msg(key: MessageKey, ...substitutions: (string | number)[]): string {
  const text = chrome.i18n.getMessage(key, substitutions.map(String));
  return text !== "" ? text : key;
}
