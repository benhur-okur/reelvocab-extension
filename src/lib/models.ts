// İzinli modeller — TEK doğruluk kaynağı.
//
// Neden ayrı dosya: liste üç katmanda gerekiyor (MAIN'de konsol parametresi,
// ISOLATED'da önbellek anahtarı ve panel, background'da çağrı). `annotate.ts`
// ise derleme sırasında gömülen `annotate_v6` promptunu taşıyor; o dosyayı
// içerik betiklerine import etmek promptu da onların içine sürükleme riski
// taşırdı. Liste burada, `annotate.ts` buradan okuyor.
//
// 🔴 SERBEST DİZE KABUL EDİLMEZ. Model adı yalnız bu listeden gelebilir;
// listede olmayan her şey reddedilir — varsayılana sessizce düşülmez.
//
// 🔴 TAKMA AD LİSTEYE GİRMEZ (`-latest`, `-3.5` gibi). Takma ad, sağlayıcı yeni
// sürüm yayınladığında SESSİZCE başka bir modele çözülür: kod değişmez, çıktı
// değişir ve ölçümlerin karşılaştırılabilirliği kaybolur. Bu nedenle sabit sürüm
// adı zorunlu.

/**
 * İzinli modeller.
 *
 * · `mistral-large-2512` — VARSAYILAN. `annotate_v6` bu modelle kalibre edildi.
 *   ⚠️ Ölçüldü (21 Eyl 2026): ücretsiz katmanda YOK (403, `tier_not_allowed`).
 * · `mistral-medium-2604`, `mistral-small-2603` — kalibre EDİLMEDİ. Listede
 *   olmaları ölçüme hazırlık içindir (eval repo'su aynı seti farklı modellerle
 *   koşacak), varsayılan yapılmaları için değil.
 * · `ministral-14b-2512`, `ministral-8b-2512` — kalibre EDİLMEDİ, ücretsiz
 *   katman adayı olarak ölçüme eklendi. ÖLÇÜLDÜ: kartsız ücretsiz Mistral
 *   hesabında `medium` ve `small` için `x-ratelimit-limit-req-minute: 0`
 *   (listede görünüyor ama çağrılamıyor); `ministral-8b-2512` için 188/dk.
 *   Ücretsiz katmanın annotasyon için YETERLİ olup olmadığı ölçülecek —
 *   çağrılabilir olmak, kaliteli madde üretmek demek değil.
 */
export const ALLOWED_MODELS = [
  "mistral-large-2512",
  "mistral-medium-2604",
  "mistral-small-2603",
  "ministral-14b-2512",
  "ministral-8b-2512",
] as const;

export type ModelId = (typeof ALLOWED_MODELS)[number];

/** Kalibre edilmiş model. Parametre verilmezse bu kullanılır. */
export const DEFAULT_MODEL: ModelId = "mistral-large-2512";

/**
 * Değeri izinli model kimliğine daraltır. Listede yoksa `undefined` —
 * çağıran reddetmek zorunda, varsayılana düşmek değil.
 */
export function asModelId(value: unknown): ModelId | undefined {
  if (typeof value !== "string") return undefined;
  return ALLOWED_MODELS.find((candidate) => candidate === value);
}
