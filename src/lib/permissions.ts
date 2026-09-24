// İsteğe bağlı host izinleri — TEK doğruluk kaynağı.
//
// Aynı köken dizesi ayar sayfasında (istenirken), background'da (çağrıdan önce
// kontrol edilirken) ve manifest'te (`optional_host_permissions`) geçiyor. İlk
// ikisi buradan okuyor; biri değişip diğeri kalırsa izin istenir ama kontrol
// başka bir kökene bakar ve her çağrı sessizce `PERMISSION_MISSING` olur.
//
// ⚠️ manifest.json yorum kabul etmediği için oradaki değer elle eşleşiyor.

/**
 * Mistral API kökeni. Kurulumda İSTENMİYOR: yalnız kullanıcı kendi anahtarını
 * kaydederken `chrome.permissions.request` ile isteniyor.
 */
export const MISTRAL_ORIGINS = ["https://api.mistral.ai/*"];
