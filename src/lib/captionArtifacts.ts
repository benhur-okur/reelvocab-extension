// Altyazı artefaktı temizliği.
//
// TAŞINAN KURAL, KEŞFEDİLECEK KOD DEĞİL. Regex'ler ve ÖZELLİKLE ÇALIŞMA SIRASI
// ölçümle belirlendi. Sırayı değiştirmek sessiz veri bozulması üretir.
//
// SORUN: altyazı yapımcısının notu KONUŞMA sanılıyor. Ölçülmüş vaka
// (2026-09-08, `ted_lasso_mom`): `[MUTED] you` bir madde olarak kabul edildi ve
// anlamı TERSİNE öğretildi ("here means 'thank you'") — sansürlenen kelime
// küfürdü. `mild time` / `mile time` ile aynı aile: transkript artefaktını
// içerik sanmak. Hiçbir üretim sonrası kapı yakalayamadı, çünkü `[MUTED]`
// metinde GERÇEKTEN geçiyor. Kusur üretimde değil, KAYNAKTA.
//
// Bu yüzden temizlik ingest'te durur: modelin anlamasına güvenmez, tek yerdedir.
// Altyazı çekildikten hemen sonra, chunk'lanmadan ve annotate edilmeden önce
// her segment metni buradan geçer.
//
// ── ÜÇ SINIF, ÜÇ FARKLI KURAL ───────────────────────────────────────────────
//
//  A · SAHNE NOTU   `[Music]` `[Applause]` `(SCOFFS)` `♪` `*theme plays*`
//                   Etiket HİÇBİR kelimenin yerinde değil → SİL.
//  B · SANSÜRLENMİŞ `[MUTED]` `[&nbsp;__&nbsp;]` `f***`
//      KELİME       Etiket BİR KELİMENİN yerinde → `[CENSORED]` YER TUTUCU.
//  C · KONUŞMACI    `(Chandler)` `KENDALL ROY:`
//                   Konuşanın adı → SİL.
//
// B'yi silmek NEDEN yanlış — ölçülmüş vaka:
//   ham        : "[MUTED] you for not wanting to talk. Excuse me? Thank you…"
//   naif silme : " you for not wanting to talk. Excuse me? Thank you…"
// Cümle dilbilgisel olarak BOZULMUYOR; daha kötüsü, bir kelimenin eksik olduğu
// GİZLENİYOR ve model tam cümle sanıp üstünde çıkarım yapıyor. Yer tutucu
// eksikliği GÖRÜNÜR tutar, aşağı akıştaki kapı onu yakalar.

/**
 * Sansürlenmiş kelimenin yerine konan kanonik işaret.
 *
 * Annotasyon kapısı bunu içeren TERİMLERİ eler. Değeri değişirse o kapı da
 * güncellenmeli — tek doğruluk kaynağı burası.
 */
export const CENSORED_MARKER = '[CENSORED]';

// ── B sınıfı ────────────────────────────────────────────────────────────────
// Köşeli parantezli sansür işaretleri. `&nbsp;` BİLEREK burada: YouTube'un
// otomatik sansürü `[&nbsp;__&nbsp;]` üretiyor ve HTML çözücü `&nbsp;`i
// çözmüyor, yani metne düz yazı olarak giriyor.
const B_CENSOR_BRACKET =
  /\[\s*(?:&nbsp;)?\s*(?:_+|MUTED|BLEEP(?:ED)?|CENSORED|EXPLETIVE(?:\s+DELETED)?)\s*(?:&nbsp;)?\s*\]/gi;

/**
 * Yıldızla sansürlenmiş kelime: `f***`, `sh**`, `****`.
 *
 * 🔴 AYIRT EDİCİ ÖLÇÜT YILDIZ SAYISI — harfe bitişiklik DEĞİL. Sahne notları
 * TEK yıldız çifti kullanıyor (`*theme plays*`); sansür 2+ yıldız kullanıyor
 * (`f***`). `plays*` gibi bir A-notu kapanışı tek yıldız olduğu için buraya
 * düşmez. 980 segmentte ölçüldü: **0 yanlış pozitif**.
 *
 * ⚠️ BİLİNEN YANLIŞ NEGATİF: tek yıldızlı sansür (`sh*t`, `f*ck`) görülmez.
 * Ölçülen korpusta bu biçim YOK. Yön bilinçli seçildi — kaçırmak, metni
 * bozmaktan iyidir: kaçırılan sansür bugünkü durumu korur, yanlış pozitif ise
 * sağlam metni bozar.
 * 🔵 YENİ KAYNAK EKLENDİĞİNDE (YouTube'un farklı altyazı sağlayıcıları dahil)
 * BU TARAMA TEKRARLANIR.
 */
const B_CENSOR_STAR = /[A-Za-z]*\*{2,}[A-Za-z]*/g;

// ── A sınıfı ────────────────────────────────────────────────────────────────
/** Yıldızla sınırlanmış sahne notu: `*theme plays*`. */
const A_STAR_NOTE = /\*[^*\n]{2,40}\*/g;

/** Köşeli parantezli sahne notu — ama YER TUTUCUYU YEME. */
const A_BRACKET = /\[(?!CENSORED\])[^\]\n]{0,60}\]/g;

/** Parantezli sahne notu ve konuşmacı etiketi (A ve C aynı biçimi paylaşıyor). */
const AC_PAREN = /\([^)\n]{0,60}\)/g;

/** Müzik simgeleri. */
const A_MUSIC = /[♪♫♬]/g;

// ── C sınıfı ────────────────────────────────────────────────────────────────
/**
 * Satır başındaki ya da tire sonrasındaki BÜYÜK HARFLİ konuşmacı etiketi:
 * `KENDALL ROY:` · `SHIV ROY:`. En az iki büyük harf ister ki `I:` gibi şeyler
 * yakalanmasın.
 */
const C_SPEAKER = /(?:^|(?<=[\s\-]))[A-Z][A-Z.' ]{1,23}:/g;

/**
 * Bir altyazı segmentinin metnini temizler.
 *
 * 🔴 SIRA BAĞLAYICI ve ölçümle belirlendi. İlk denenen sıra — "önce yıldızlı
 * A notlarını maskele, kalanda B ara" — KENDİ KENDİNE ÇARPTI:
 *
 *   ham       : "What the f*** was that? What the f*** is that?"
 *   A maskesi : "f[*** was that? What the f*]** is that?"   ← ARAYI yedi
 *   B bulur   : 'f**'                                       ← sakatlanmış
 *
 * Aynı segmentte iki sansürlü kelime olduğunda A'nın çift-yıldız maskesi
 * onların arasını eşleştiriyor. Bu yüzden **B ÖNCE** çalışır: sansür işaretleri
 * yer tutucuya dönüşünce ortada eşleşecek yıldız kalmaz.
 */
export function stripCaptionArtifacts(text: string): string {
  let t = text;

  // 1) B — sansür ÖNCE yer tutucuya döner (yukarıdaki çarpışma notu).
  t = t.replace(B_CENSOR_BRACKET, CENSORED_MARKER);
  t = t.replace(B_CENSOR_STAR, CENSORED_MARKER);

  // 2) A — yıldızlı notlar. Artık güvenli: B'nin yıldızları kalmadı.
  t = t.replace(A_STAR_NOTE, ' ');

  // 3) A + C — köşeli/parantezli notlar ve konuşmacı etiketleri.
  t = t.replace(A_BRACKET, ' ');
  t = t.replace(AC_PAREN, ' ');
  t = t.replace(C_SPEAKER, ' ');
  t = t.replace(A_MUSIC, ' ');

  // 4) Boşluk toparlama. Etiket silinince önünde kalan boşluk noktalamadan
  //    ayrılmasın ("word ." → "word.").
  //
  // ⚠️ KAYNAKTAN TEK BİLİNÇLİ SAPMA: Dart özgünü bu satırda
  // `replaceAll(RegExp(...), r'$1')` kullanıyor; Dart'ta `replaceAll` grup
  // referansını çözmez (bunu yapan `replaceAllMapped`), yani orada metne düz
  // yazı olarak `$1` giriyor ("later ?" → "later$1"). Yorumun beyan ettiği
  // niyet açık, davranış hatalı. Buradaki JS `replace` $1'i çözer ve niyeti
  // uygular. Diğer 16 karşılaştırma vakasında iki uygulama birebir aynı.
  t = t.replace(/\s+/g, ' ');
  t = t.replace(/\s+([,.!?;:])/g, '$1');
  return t.trim();
}

/**
 * Terim bir sansür yer tutucusu taşıyor mu?
 *
 * Annotasyon kapısı bunu kullanır: yer tutucu eksikliği GÖRÜNÜR tutmak içindir,
 * öğretilecek bir ifade değildir.
 */
export function containsCensoredMarker(term: string): boolean {
  return term.includes(CENSORED_MARKER);
}
