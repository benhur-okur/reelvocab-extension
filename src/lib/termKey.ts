// Terim normalizasyonu.
//
// TAŞINAN KURAL, KEŞFEDİLECEK KOD DEĞİL. Bu algoritma mobil hatta aylarca
// ölçümle oturdu. Davranışı birebir korunuyor; "iyileştirme" yapılmaz —
// değişiklik, ölçülmüş bir vakayla gerekçelendirilmedikçe regresyondur.
//
// İki iş yapar:
//  · normText  — "terim metinde gerçekten geçiyor mu" karşılaştırmasının zemini
//  · termKey   — tekrar kontrolü ve yasaklı liste eşleşmesi için kanonik anahtar
//
// Dosya sisteminden harici yasaklı terim listesi yüklenmez. Yasaklı örnekler
// prompttan türetilir ve üretim sonrası kapıda uygulanır.

/** Noktalama/boşluk normalize eder; metinde-geçiyor-mu karşılaştırması bunun üstünde yapılır. */
export function normText(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9'\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Kanonik anahtar. Yüzey formu farkları ("cook" vs "the cook") aynı maddeyi
 * iki kez geçirmesin: artikel atılır, iyelik ve basit çekim ekleri düşürülür.
 *
 * 🔴 4 HARF EŞİĞİ BİLİNÇLİ: kısa kelimeler budanmaz, yoksa `was → wa`,
 * `his → hi` gibi bozulmalar oluşur. Ek listesi sırası da bağlayıcı
 * (`ies` önce, yoksa `ing`… ), ilk eşleşmede durulur.
 */
export function termKey(term: string): string {
  let t = normText(term);
  t = t.replace(/^(a|an|the) /, '');
  const words = t
    .split(' ')
    .filter((w) => w.length > 0)
    .map((w) => {
      let x = w.replace(/'s$/, ''); // iyelik: gideon's → gideon
      if (x.length > 4) {
        for (const suf of ['ies', 'ing', 'es', 'ed', 's'] as const) {
          if (x.endsWith(suf) && x.length - suf.length >= 3) {
            x = x.slice(0, x.length - suf.length);
            if (suf === 'ies') x = `${x}y`;
            break;
          }
        }
      }
      return x;
    });
  return words.join(' ');
}
